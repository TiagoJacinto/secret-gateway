// Review surface on the gateway's own port: a local page and JSON endpoints.
// Items show status, source, length and timestamps. Values are never shown or stored.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AnswerStore, Item } from './store.ts';

const IDENTITY = /^[0-9a-f]{64}$/;
const ANSWERS = new Set(['secret', 'not_secret']);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export class ReviewSurface {
  readonly #store: AnswerStore;
  readonly #now: () => string;
  readonly #hosts: Set<string>;
  readonly #origin: string;
  // Per-process token. Only a page served by this gateway can read it, so other sites cannot answer.
  readonly #token = randomBytes(16).toString('hex');

  constructor(options: { store: AnswerStore; now: () => string; port: number }) {
    this.#store = options.store;
    this.#now = options.now;
    this.#hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
    this.#origin = `http://127.0.0.1:${options.port}`;
  }

  get url(): string {
    return `${this.#origin}/review`;
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
    return new Response('not found', { status: 404 });
  }

  // Shared with notification actions, which bypass HTTP and call this directly.
  answer(id: string, status: 'secret' | 'not_secret'): boolean {
    return this.#store.answer(id, status, this.#now());
  }

  async #answer(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.#origin) return new Response('forbidden origin', { status: 403 });
    const supplied = Buffer.from(request.headers.get('x-review-token') ?? '');
    const expected = Buffer.from(this.#token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
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

  #page(): string {
    const items = this.#store.list();
    const rows = items
      .map((item) => {
        const short = item.id.slice(0, 12);
        return `<tr>
  <td><code>${short}</code></td>
  <td>${item.status}</td>
  <td>${escapeHtml(item.source)}</td>
  <td>${item.length}</td>
  <td>${escapeHtml(item.firstSeen)}</td>
  <td>
    <button onclick="answer('${item.id}', 'secret')">Secret</button>
    <button onclick="answer('${item.id}', 'not_secret')">Not a secret</button>
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
<p>Pending and masked items stay masked. "Not a secret" shows the value from the next request onward.</p>
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
