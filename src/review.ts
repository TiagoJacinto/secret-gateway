// Review surface on the gateway's own port: a local page and JSON endpoints.
// Items show status, source, length and timestamps. Values are never stored on disk.
// The reveal page shows a value only from the in-memory vault, and only with the review token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AnswerStore, Item } from './store.ts';
import type { Context, SecretVault } from './vault.ts';

const IDENTITY = /^[0-9a-f]{64}$/;
const ANSWERS = new Set(['secret', 'not_secret']);

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
  return `<p>Held in memory only. Close this page when you are done.</p>
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
  // Per-process token. Only a page served by this gateway can read it, so other sites cannot answer or reveal.
  readonly #token = randomBytes(16).toString('hex');

  constructor(options: {
    store: AnswerStore;
    vault: SecretVault;
    now: () => string;
    port: number;
    onAnswer: (id: string, status: 'secret' | 'not_secret') => void;
  }) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#now = options.now;
    this.#onAnswer = options.onAnswer;
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
      return new Response(this.#page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/review/items') {
      return Response.json(this.#store.list().map(publicItem));
    }
    if (request.method === 'POST' && url.pathname === '/review/answer') {
      return this.#answer(request);
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

  async #answer(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.#origin) return new Response('forbidden origin', { status: 403 });
    if (!this.#tokenMatches(request.headers.get('x-review-token'))) {
      return new Response('invalid review token', { status: 403 });
    }
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return new Response('expected application/json', { status: 415 });
    }
    let payload: { id?: unknown; status?: unknown };
    try {
      payload = await request.json();
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (typeof payload.id !== 'string' || !IDENTITY.test(payload.id)) return new Response('invalid id', { status: 400 });
    if (typeof payload.status !== 'string' || !ANSWERS.has(payload.status)) {
      return new Response('invalid status', { status: 400 });
    }
    const updated = this.answer(payload.id, payload.status as 'secret' | 'not_secret');
    return Response.json({ updated });
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
      const message = '<p>This value is not held in memory. It was lost when the gateway stopped.</p>';
      return new Response(revealPage(message), { status: 404, headers });
    }
    return new Response(revealPage(revealBody(this.#vault.contextsOf(id))), { headers });
  }

  #tokenMatches(supplied: string | null): boolean {
    const given = Buffer.from(supplied ?? '');
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #page(): string {
    const items = this.#store.list();
    const rows = items
      .map((item) => {
        const short = item.id.slice(0, 12);
        const reveal =
          this.#vault.valueOf(item.id) === undefined
            ? '<span>value not in memory</span>'
            : `<a href="/review/reveal/${item.id}?token=${this.#token}" target="_blank" rel="noopener noreferrer">Show value</a>`;
        return `<tr>
  <td><code>${short}</code></td>
  <td>${item.status}</td>
  <td>${escapeHtml(item.source)}</td>
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
@media (max-width: 640px) { th:nth-child(5), td:nth-child(5) { display: none; } }
</style>
</head>
<body>
<h1>Secret review</h1>
<p>Pending and masked items stay masked. "Not a secret" shows the value from the next request onward. Earlier parts of each conversation keep their placeholders.
"Show value" opens a new page with the value highlighted in the line it came from. Values are held in memory only and are lost when the gateway stops.</p>
<table>
<thead><tr><th>ID</th><th>Status</th><th>Source</th><th>Length</th><th>First seen</th><th>Answer</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No detections yet.</td></tr>'}
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
