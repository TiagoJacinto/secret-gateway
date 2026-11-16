// Review surface on the gateway's own port: the React page (built by Vite into web/dist) and JSON endpoints.
// Items show status, source, length, the last line where the value was referenced, and timestamps.
// The reveal endpoint returns a value from the value store, and only with the review token.
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { AnswerStore, Item } from './store.ts';
import type { SecretVault } from './vault.ts';

const IDENTITY = /^[0-9a-f]{64}$/;
const ASSET = /^[A-Za-z0-9._-]+$/;
const ANSWERS = new Set(['secret', 'not_secret']);
const FILTERS = ['pending', 'secret', 'not_secret', 'all'];
const PAGE_SIZE = 100;
const DIST = join(import.meta.dir, '..', 'web', 'dist');
const SENSITIVE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

export type ReviewRow = {
  id: string;
  status: Item['status'];
  source: string;
  length: number;
  firstSeen: string;
  lastLine: string | null;
  stored: boolean;
};

export class ReviewSurface {
  readonly #store: AnswerStore;
  readonly #vault: SecretVault;
  readonly #now: () => string;
  readonly #hosts: Set<string>;
  readonly #origin: string;
  readonly #onAnswer: (id: string, status: 'secret' | 'not_secret') => void;
  // Kept in the data directory. Only a page served by this gateway can read it, so other sites cannot answer, forget or reveal.
  readonly #token: string;

  constructor(options: {
    store: AnswerStore;
    vault: SecretVault;
    now: () => string;
    port: number;
    token: string;
    onAnswer: (id: string, status: 'secret' | 'not_secret') => void;
  }) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#now = options.now;
    this.#onAnswer = options.onAnswer;
    this.#token = options.token;
    this.#hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
    this.#origin = `http://127.0.0.1:${options.port}`;
  }

  get url(): string {
    return `${this.#origin}/review`;
  }

  // Reveal link for a masked identity. The review token is part of it, as the reveal page requires.
  revealUrl(identity: string): string {
    return `${this.#origin}/review/reveal/${identity}?token=${this.#token}`;
  }

  // Returns undefined for paths this surface does not own.
  async handle(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname !== '/review' && !url.pathname.startsWith('/review/')) return undefined;
    if (!this.#hosts.has(request.headers.get('host') ?? '')) return new Response('forbidden host', { status: 403 });

    if (request.method === 'GET' && url.pathname === '/review') {
      return this.#shell();
    }
    const asset = url.pathname.match(/^\/review\/assets\/([^/]+)$/);
    if (request.method === 'GET' && asset && ASSET.test(asset[1])) {
      return this.#asset(asset[1]);
    }
    if (request.method === 'GET' && url.pathname === '/review/items') {
      return Response.json(this.#store.list().map(publicItem));
    }
    if (request.method === 'GET' && url.pathname === '/review/page') {
      return Response.json(this.#page(url));
    }
    if (request.method === 'POST' && url.pathname === '/review/answer') {
      return this.#answer(request);
    }
    if (request.method === 'POST' && url.pathname === '/review/forget') {
      return this.#forget(request);
    }
    const reveal = url.pathname.match(/^\/review\/reveal\/([^/]+)$/);
    if (request.method === 'GET' && reveal) {
      return this.#revealPage(url, reveal[1]);
    }
    const values = url.pathname.match(/^\/review\/values\/([^/]+)$/);
    if (request.method === 'GET' && values) {
      return this.#values(request, values[1]);
    }
    return new Response('not found', { status: 404 });
  }

  // Shared with notification actions, which bypass HTTP and call this directly.
  answer(id: string, status: 'secret' | 'not_secret'): boolean {
    const updated = this.#store.answer(id, status, this.#now());
    if (updated) this.#onAnswer(id, status);
    return updated;
  }

  // The built React page. The review token goes into a meta tag, which the page reads for its POST and reveal requests.
  async #shell(): Promise<Response> {
    const file = Bun.file(join(DIST, 'index.html'));
    if (!(await file.exists())) return new Response('review page not built; run bun run build:web', { status: 503 });
    const html = (await file.text()).replace('</head>', `<meta name="review-token" content="${this.#token}">\n</head>`);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...SENSITIVE_HEADERS } });
  }

  async #asset(name: string): Promise<Response> {
    const file = Bun.file(join(DIST, 'assets', name));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file);
  }

  // Checks the origin, token and JSON body that every POST endpoint needs. Returns the body or the refusal.
  async #post(request: Request): Promise<Response | Record<string, unknown>> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.#origin) return new Response('forbidden origin', { status: 403 });
    if (!this.#tokenMatches(request.headers.get('x-review-token'))) {
      return new Response('invalid review token', { status: 403 });
    }
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return new Response('expected application/json', { status: 415 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (typeof body !== 'object' || body === null) return new Response('invalid JSON', { status: 400 });
    return body as Record<string, unknown>;
  }

  async #answer(request: Request): Promise<Response> {
    const body = await this.#post(request);
    if (body instanceof Response) return body;
    if (typeof body.id !== 'string' || !IDENTITY.test(body.id)) return new Response('invalid id', { status: 400 });
    if (typeof body.status !== 'string' || !ANSWERS.has(body.status)) {
      return new Response('invalid status', { status: 400 });
    }
    const updated = this.answer(body.id, body.status as 'secret' | 'not_secret');
    return Response.json({ updated });
  }

  // Deletes the stored value of an identity. Its status stays.
  async #forget(request: Request): Promise<Response> {
    const body = await this.#post(request);
    if (body instanceof Response) return body;
    if (typeof body.id !== 'string' || !IDENTITY.test(body.id)) return new Response('invalid id', { status: 400 });
    return Response.json({ deleted: this.#vault.forget(body.id) });
  }

  // The reveal page is served only with the token in the URL. Its data comes from #values, which needs the token header.
  async #revealPage(url: URL, id: string): Promise<Response> {
    if (!this.#tokenMatches(url.searchParams.get('token'))) return new Response('invalid review token', { status: 403 });
    if (!IDENTITY.test(id)) return new Response('invalid id', { status: 400 });
    return this.#shell();
  }

  // The stored value and its appearances for one identity. Returns 404 when no value is stored.
  #values(request: Request, id: string): Response {
    if (!this.#tokenMatches(request.headers.get('x-review-token'))) return new Response('invalid review token', { status: 403, headers: SENSITIVE_HEADERS });
    if (!IDENTITY.test(id)) return new Response('invalid id', { status: 400, headers: SENSITIVE_HEADERS });
    if (this.#vault.valueOf(id) === undefined) {
      return Response.json({ error: 'no value stored' }, { status: 404, headers: SENSITIVE_HEADERS });
    }
    return Response.json({ contexts: this.#vault.contextsOf(id) }, { headers: SENSITIVE_HEADERS });
  }

  #tokenMatches(supplied: string | null): boolean {
    const given = Buffer.from(supplied ?? '');
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // One page of rows for a status filter (pending by default), PAGE_SIZE rows per page.
  // The search text (q) matches ID, source, status and last line, case-insensitively, across all items before paging.
  #page(url: URL) {
    const requested = url.searchParams.get('status') ?? 'pending';
    const filter = FILTERS.includes(requested) ? requested : 'pending';
    const query = (url.searchParams.get('q') ?? '').trim();
    const needle = query.toLowerCase();
    const all = this.#store.list();
    const counts: Record<string, number> = { all: all.length, pending: 0, secret: 0, not_secret: 0 };
    for (const item of all) counts[item.status] += 1;
    const byStatus = filter === 'all' ? all : all.filter((item) => item.status === filter);
    const rowsOf = byStatus.map((item) => ({ item, lastLine: this.#vault.lastLineOf(item.id) ?? null }));
    const matching = needle === ''
      ? rowsOf
      : rowsOf.filter(({ item, lastLine }) =>
          [item.id, item.source, item.status, lastLine ?? ''].some((field) => field.toLowerCase().includes(needle)));
    const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    const asked = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
    const start = (page - 1) * PAGE_SIZE;
    const rows: ReviewRow[] = matching.slice(start, start + PAGE_SIZE).map(({ item, lastLine }) => ({
      id: item.id,
      status: item.status,
      source: item.source,
      length: item.length,
      firstSeen: item.firstSeen,
      lastLine,
      stored: this.#vault.valueOf(item.id) !== undefined,
    }));
    return { filter, query, counts, total: matching.length, page, pages, start, pageSize: PAGE_SIZE, rows };
  }
}

function publicItem(item: Item) {
  return {
    id: item.id,
    status: item.status,
    source: item.source,
    length: item.length,
    firstSeen: item.firstSeen,
    updatedAt: item.updatedAt,
  };
}
