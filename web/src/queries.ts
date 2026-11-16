// TanStack Query keys and hooks for the review endpoints. Answers and forgets refresh every review page.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, fetchContexts, fetchPage, fetchSessionToken, forget } from './api';

export const reviewPageKey = (search: string) => ['review-page', search] as const;
const reviewPagesKey = ['review-page'] as const;

export function useReviewPage(search: string) {
  return useQuery({ queryKey: reviewPageKey(search), queryFn: () => fetchPage(search) });
}

// The review token. It does not change while the gateway runs, so it is fetched once.
export function useSessionToken() {
  return useQuery({ queryKey: ['session'], queryFn: fetchSessionToken, staleTime: Infinity, retry: false });
}

export function useAnswer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'secret' | 'not_secret' }) => answer(id, status),
    onSuccess: () => client.invalidateQueries({ queryKey: reviewPagesKey }),
  });
}

// A forget also clears the value queries, so an open reveal page shows that no value is stored.
export function useForget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => forget(id),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: reviewPagesKey }),
      client.invalidateQueries({ queryKey: ['values'] }),
    ]),
  });
}

// Null data means no value is stored for the identity (the gateway answers 404).
export function useContexts(id: string, token: string) {
  return useQuery({ queryKey: ['values', id, token], queryFn: () => fetchContexts(id, token), retry: false, enabled: token !== '' });
}
