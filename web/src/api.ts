// Calls to the gateway's review endpoints. The review token comes from the meta tag the gateway adds to the page.
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

export const token: string = document.querySelector<HTMLMetaElement>('meta[name="review-token"]')?.content ?? '';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function fetchPage(search: string): Promise<ReviewPage> {
  return json(await fetch(`/review/page${search}`));
}

export async function answer(id: string, status: 'secret' | 'not_secret'): Promise<void> {
  await json(await fetch('/review/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': token },
    body: JSON.stringify({ id, status }),
  }));
}

export async function forget(id: string): Promise<void> {
  await json(await fetch('/review/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-token': token },
    body: JSON.stringify({ id }),
  }));
}

// Returns undefined when no value is stored for the identity.
export async function fetchContexts(id: string): Promise<Context[] | undefined> {
  const response = await fetch(`/review/values/${id}`, { headers: { 'x-review-token': token } });
  if (response.status === 404) return undefined;
  const body = await json<{ contexts: Context[] }>(response);
  return body.contexts;
}

export function revealHref(id: string): string {
  return `/review/reveal/${id}?token=${encodeURIComponent(token)}`;
}
