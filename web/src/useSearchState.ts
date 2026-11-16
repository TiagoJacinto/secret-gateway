// The list state lives in the URL query (status, q, page), so a reload or a back step shows the same rows.
import { useEffect, useState } from 'react';

export function useSearchState(): [string, (search: string) => void] {
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const onPop = () => setSearch(window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (next: string) => {
    window.history.pushState(null, '', `/review${next}`);
    setSearch(next);
  };
  return [search, navigate];
}
