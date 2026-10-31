// HTTP boundary: review routes, then the proxy. Message requests are masked before they leave and
// placeholders are restored in the response. Any failure refuses the request instead of forwarding raw.
import type { ReviewSurface } from './review.ts';
import type { Masker } from './masker.ts';
import { restoreJson, restoreSse, type Restore } from './unmask.ts';
import { addPromptNote, conversationOf } from './anthropic.ts';

const MESSAGE_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'content-encoding',
  'accept-encoding',
]);

export type GatewayDeps = {
  masker: Masker;
  review: ReviewSurface;
  upstreamBaseUrl: string;
  log: (line: string) => void;
  testControl?: (ms: number) => void;
};

// What the request log line reports. Counts and a session prefix only, never message text.
type RequestStats = { masked: number; degraded: boolean; session?: string };

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export function createHandler(deps: GatewayDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const review = await deps.review.handle(request, url);
    if (review) return review;
    if (deps.testControl && request.method === 'POST' && url.pathname === '/__test/advance') {
      deps.testControl(Number(url.searchParams.get('ms') ?? '0'));
      return Response.json({ advanced: true });
    }
    const started = performance.now();
    const stats: RequestStats = { masked: 0, degraded: false };
    const response = await proxy(request, url, deps, stats);
    const session = stats.session ? ` session=${stats.session}` : '';
    const degraded = stats.degraded ? ' degraded' : '';
    deps.log(`${request.method} ${url.pathname} ${response.status} ${Math.round(performance.now() - started)}ms masked=${stats.masked}${degraded}${session}`);
    return response;
  };
}

async function proxy(request: Request, url: URL, deps: GatewayDeps, stats: RequestStats): Promise<Response> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body: string | Uint8Array | null = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;
  let restore: Restore | undefined;
  const isMessages = MESSAGE_PATHS.has(url.pathname);

  if (body !== null && body.length > 0) {
    const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
    if (!isJson) {
      if (isMessages) return refuse(400, 'message requests must be JSON; not forwarded');
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return refuse(400, 'request body is not valid JSON; not forwarded');
      }
      const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      if (isMessages && !isObject) return refuse(400, 'message request must be a JSON object; not forwarded');
      const record = parsed as Record<string, any>;
      if (isObject && ('messages' in record || isMessages)) {
        try {
          const conversation = conversationOf(request.headers, record);
          const masked = await deps.masker.mask(record, conversation);
          if (isMessages) addPromptNote(masked.body);
          body = JSON.stringify(masked.body);
          restore = masked.restore;
          stats.masked = masked.masked;
          stats.degraded = masked.degraded;
          stats.session = conversation.key.split(':')[0].slice(0, 8);
          if (masked.degraded) deps.log('scanner unavailable: text withheld for this request');
        } catch (error) {
          deps.log(`masking failed (${(error as Error).name}); request not forwarded`);
          return refuse(503, 'secret masking failed; request not forwarded');
        }
      }
    }
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  headers.set('accept-encoding', 'identity');

  let upstream: Response;
  try {
    upstream = await fetch(`${deps.upstreamBaseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (error) {
    deps.log(`upstream unreachable (${(error as Error).name}); request not answered`);
    return refuse(502, 'upstream unreachable');
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders.set(name, value);
  let responseBody: ReadableStream<Uint8Array> | string | null = upstream.body;
  const contentType = upstream.headers.get('content-type') ?? '';
  if (restore && upstream.ok && contentType.includes('text/event-stream') && upstream.body) {
    responseBody = restoreSse(upstream.body, restore);
  } else if (restore && upstream.ok && contentType.includes('application/json')) {
    const text = await upstream.text();
    try {
      responseBody = await restoreJson(text, restore);
    } catch {
      responseBody = text;
    }
  }
  return new Response(responseBody, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}
