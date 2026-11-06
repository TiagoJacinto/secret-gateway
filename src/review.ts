// Review surface on the gateway's own port: a local page and JSON endpoints.
// Items show status, source, length, the last line where the value was referenced, and timestamps.
// The reveal page shows a value from the value store, and only with the review token.
import { timingSafeEqual } from 'node:crypto';
import type { AnswerStore, Item } from './store.ts';
import type { Context, SecretVault } from './vault.ts';

const IDENTITY = /^[0-9a-f]{64}$/;
const ANSWERS = new Set(['secret', 'not_secret']);
const FILTERS = ['pending', 'secret', 'not_secret', 'all'];
const PAGE_SIZE = 100;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// Each appearance: where it sits in the session, then its lines with the value highlighted.
function revealBody(contexts: Context[]): string {
  const appearances = contexts.map((context) => {
    const line = `${escapeHtml(context.before)}<mark>${escapeHtml(context.value)}</mark>${escapeHtml(context.after)}`;
    const above = context.above.map(escapeHtml);
    const below = context.below.map(escapeHtml);
    return `<p>${escapeHtml(context.location)}</p>\n<pre>${[...above, line, ...below].join('\n')}</pre>`;
  });
  return `<p>Stored on this machine. Close this page when you are done.</p>
<h2>Where it appears</h2>
${appearances.join('\n') || '<p>No line was recorded for this value.</p>'}`;
}

function revealPage(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secret value</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --line: #d0d0d5; --mark: #ffe066; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --fg: #f2f2f4; --bg: #161618; --line: #3a3a40; --mark: #7a6a1e; } }
:root[data-theme="dark"] { --fg: #f2f2f4; --bg: #161618; --line: #3a3a40; --mark: #7a6a1e; }
body { font-family: system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 16px; }
pre { border: 1px solid var(--line); padding: 12px; white-space: pre-wrap; word-break: break-all; }
mark { background: var(--mark); color: var(--fg); padding: 0 2px; }
</style>
</head>
<body>
<h1>Secret value</h1>
${body}
<p><a href="/review">Back to review</a></p>
</body>
</html>`;
}

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
      return new Response(this.#page(url), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/review/items') {
      return Response.json(this.#store.list().map(publicItem));
    }
    if (request.method === 'POST' && url.pathname === '/review/answer') {
      return this.#answer(request);
    }
    if (request.method === 'POST' && url.pathname === '/review/forget') {
      return this.#forget(request);
    }
    const reveal = url.pathname.match(/^\/review\/reveal\/([^/]+)$/);
    if (request.method === 'GET' && reveal) {
      return this.#reveal(url, reveal[1]);
    }
    return new Response('not found', { status: 404 });
  }

  // Shared with notification actions, which bypass HTTP and call this directly.
  answer(id: string, status: 'secret' | 'not_secret'): boolean {
    const updated = this.#store.answer(id, status, this.#now());
    if (updated) this.#onAnswer(id, status);
    return updated;
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

  #reveal(url: URL, id: string): Response {
    if (!this.#tokenMatches(url.searchParams.get('token'))) return new Response('invalid review token', { status: 403 });
    if (!IDENTITY.test(id)) return new Response('invalid id', { status: 400 });
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    };
    const value = this.#vault.valueOf(id);
    if (value === undefined) {
      const message = '<p>No value is stored for this identity. It was forgotten, or it was seen before values were stored.</p>';
      return new Response(revealPage(message), { status: 404, headers });
    }
    return new Response(revealPage(revealBody(this.#vault.contextsOf(id))), { headers });
  }

  #tokenMatches(supplied: string | null): boolean {
    const given = Buffer.from(supplied ?? '');
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // One page of items for a status filter (pending by default), PAGE_SIZE rows per page.
  #page(url: URL): string {
    const requested = url.searchParams.get('status') ?? 'pending';
    const filter = FILTERS.includes(requested) ? requested : 'pending';
    const all = this.#store.list();
    const counts: Record<string, number> = { all: all.length, pending: 0, secret: 0, not_secret: 0 };
    for (const item of all) counts[item.status] += 1;
    const matching = filter === 'all' ? all : all.filter((item) => item.status === filter);
    const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    const asked = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
    const start = (page - 1) * PAGE_SIZE;
    const shown = matching.slice(start, start + PAGE_SIZE);
    const link = (status: string, pageNumber: number) => `/review?status=${status}&page=${pageNumber}`;
    const tabs = [
      ['pending', 'Pending'],
      ['secret', 'Secret'],
      ['not_secret', 'Not a secret'],
      ['all', 'All'],
    ]
      .map(([status, label]) => `<a href="${link(status, 1)}"${status === filter ? ' aria-current="page"' : ''}>${label} (${counts[status]})</a>`)
      .join(' · ');
    const range = matching.length === 0 ? 'No items.' : `Showing ${start + 1}-${start + shown.length} of ${matching.length}.`;
    const pager = pages > 1
      ? `<p>${page > 1 ? `<a href="${link(filter, page - 1)}">Previous</a> ` : ''}Page ${page} of ${pages}${page < pages ? ` <a href="${link(filter, page + 1)}">Next</a>` : ''}</p>`
      : '';
    const rows = shown
      .map((item) => {
        const short = item.id.slice(0, 12);
        const line = this.#vault.lastLineOf(item.id);
        const stored = this.#vault.valueOf(item.id) !== undefined;
        const reveal = stored
          ? `<a href="/review/reveal/${item.id}?token=${this.#token}" target="_blank" rel="noopener noreferrer">Show value</a>
    <button onclick="forget('${item.id}')">Forget value</button>`
          : '<span>value not stored</span>';
        return `<tr>
  <td><code>${short}</code></td>
  <td>${item.status}</td>
  <td>${escapeHtml(item.source)}</td>
  <td class="line">${line === undefined ? '<span>not stored</span>' : escapeHtml(line)}</td>
  <td>${item.length}</td>
  <td>${escapeHtml(item.firstSeen)}</td>
  <td>
    <button onclick="answer('${item.id}', 'secret')">Secret</button>
    <button onclick="answer('${item.id}', 'not_secret')">Not a secret</button>
    ${reveal}
  </td>
</tr>`;
      })
      .join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secret review</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --line: #d0d0d5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --fg: #f2f2f4; --bg: #161618; --line: #3a3a40; } }
:root[data-theme="dark"] { --fg: #f2f2f4; --bg: #161618; --line: #3a3a40; }
body { font-family: system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 16px; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px; text-align: left; font-size: 14px; }
button { margin-right: 6px; }
td.line { overflow-wrap: anywhere; }
@media (max-width: 640px) { th:nth-child(6), td:nth-child(6) { display: none; } }
</style>
</head>
<body>
<h1>Secret review</h1>
<p>Pending and masked items stay masked. "Not a secret" shows the value from the next request onward. Earlier parts of each conversation keep their placeholders.
"Last line" is the last line that referenced the value, with the value shown as its placeholder. "Show value" opens a new page with the value highlighted in the line it came from. Values and lines are stored on this machine, in values.sqlite. "Forget value" deletes the stored value and its lines and keeps the status.</p>
${tabs}
<p>${range}</p>
${pager}
<table>
<thead><tr><th>ID</th><th>Status</th><th>Source</th><th>Last line</th><th>Length</th><th>First seen</th><th>Answer</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">Nothing to show.</td></tr>'}
</tbody>
</table>
<script>
const TOKEN = ${JSON.stringify(this.#token)};
async function answer(id, status) {
  const response = await fetch('/review/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': TOKEN },
    body: JSON.stringify({ id, status }),
  });
  if (response.ok) location.reload();
}
async function forget(id) {
  if (!confirm('Delete the stored value and its lines? The status stays.')) return;
  const response = await fetch('/review/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': TOKEN },
    body: JSON.stringify({ id }),
  });
  if (response.ok) location.reload();
}
</script>
</body>
</html>`;
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
