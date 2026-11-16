// Calls to the gateway's JSON endpoints. The page runs on its own origin, so every request uses the gateway's absolute URL.
export type Status = 'pending' | 'secret' | 'not_secret';
export type Filter = Status | 'all';

export type ReviewRow = {
  id: string;
  status: Status;
  source: string;
  length: number;
  firstSeen: string;
  lastLine: string | null;
  stored: boolean;
};

export type ReviewPage = {
  filter: Filter;
  query: string;
  counts: Record<Filter, number>;
  total: number;
  page: number;
  pages: number;
  start: number;
  pageSize: number;
  rows: ReviewRow[];
};

// One appearance of a value: where it is in the session, and its line with the nearest non-empty lines around it.
export type Context = {
  location: string;
  above: string[];
  before: string;
  value: string;
  after: string;
  below: string[];
};

// Set at build time. The default matches the gateway's default PORT.
const GATEWAY = (import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

// The review token, read once from the gateway. The gateway answers only the page's origin.
let sessionToken: Promise<string> | undefined;
export function fetchSessionToken(): Promise<string> {
  sessionToken ??= fetch(`${GATEWAY}/review/session`)
    .then((response) => json<{ token: string }>(response))
    .then((body) => body.token)
    .catch((error: unknown) => {
      sessionToken = undefined;
      throw error;
    });
  return sessionToken;
}

export async function fetchPage(search: string): Promise<ReviewPage> {
  return json(await fetch(`${GATEWAY}/review/page${search}`));
}

export async function answer(id: string, status: 'secret' | 'not_secret'): Promise<void> {
  const token = await fetchSessionToken();
  await json(await fetch(`${GATEWAY}/review/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': token },
    body: JSON.stringify({ id, status }),
  }));
}

export async function forget(id: string): Promise<void> {
  const token = await fetchSessionToken();
  await json(await fetch(`${GATEWAY}/review/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': token },
    body: JSON.stringify({ id }),
  }));
}

// Returns null when no value is stored for the identity (the gateway answers 404).
export async function fetchContexts(id: string, token: string): Promise<Context[] | null> {
  const response = await fetch(`${GATEWAY}/review/values/${id}`, { headers: { 'x-review-token': token } });
  if (response.status === 404) return null;
  const body = await json<{ contexts: Context[] }>(response);
  return body.contexts;
}

// The reveal page is on this origin. Its token comes from the link, as the gateway's reveal links carry it.
export function revealHref(id: string, token: string): string {
  return `/review/reveal/${id}?token=${encodeURIComponent(token)}`;
}
