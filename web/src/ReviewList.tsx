import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { answer, fetchPage, forget, type Filter, type ReviewPage, type ReviewRow, revealHref } from './api';
import { useSearchState } from './useSearchState';

const TABS: [Filter, string][] = [
  ['pending', 'Pending'],
  ['secret', 'Secret'],
  ['not_secret', 'Not a secret'],
  ['all', 'All'],
];

function reviewSearch(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== '');
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

// Anchor that changes the list in place. The address bar follows, so the state can be shared or reloaded.
function ListLink({ search, navigate, children, ...rest }: {
  search: string;
  navigate: (search: string) => void;
  children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(search);
  };
  return <a href={`/review${search}`} onClick={onClick} {...rest}>{children}</a>;
}

export function ReviewList() {
  const [search, navigate] = useSearchState();
  const [data, setData] = useState<ReviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setError(null);
    fetchPage(search)
      .then((page) => { if (current) setData(page); })
      .catch((failure: unknown) => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [search, version]);

  const refresh = () => setVersion((value) => value + 1);
  const act = (work: () => Promise<void>) => {
    work().then(refresh).catch((failure: unknown) => setError(String(failure)));
  };

  if (data === null) return <main>{error ? <p role="alert">{error}</p> : <p>Loading…</p>}</main>;

  const { filter, query, counts, total, page, pages, start, rows } = data;
  const pageSearch = (target: number) => reviewSearch({ status: filter, page: target, q: query || undefined });

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    navigate(reviewSearch({ status: filter, q: text || undefined }));
  };

  const emptyText = query === '' ? 'Nothing to show.' : `No items match "${query}".`;

  return (
    <main>
      <h1>Secret review</h1>
      <p>
        Pending and masked items stay masked. &quot;Not a secret&quot; shows the value from the next request onward.
        Earlier parts of each conversation keep their placeholders.
        &quot;Last line&quot; is the last line that referenced the value, with the value shown as its placeholder.
        &quot;Show value&quot; opens a new page with the value highlighted in the line it came from.
        Values and lines are stored on this machine, in values.sqlite. &quot;Forget value&quot; deletes the stored value
        and its lines and keeps the status.
      </p>
      {error && <p role="alert">{error}</p>}

      <nav>
        {TABS.map(([status, label], index) => (
          <span key={status}>
            {index > 0 && ' · '}
            <ListLink
              search={reviewSearch({ status, page: 1, q: query || undefined })}
              navigate={navigate}
              aria-current={status === filter ? 'page' : undefined}
            >
              {label} ({counts[status]})
            </ListLink>
          </span>
        ))}
      </nav>

      <form key={query} method="get" action="/review" role="search" onSubmit={onSearch}>
        <label htmlFor="search">Search</label>
        <input id="search" type="search" name="q" defaultValue={query} placeholder="ID, source, status or last line" />
        <button type="submit">Search</button>
        {query !== '' && <ListLink search={reviewSearch({ status: filter })} navigate={navigate}>Clear</ListLink>}
      </form>

      <p>{total === 0 ? (query === '' ? 'No items.' : `No items match "${query}".`) : `Showing ${start + 1}-${start + rows.length} of ${total}.`}</p>
      {pages > 1 && (
        <p>
          {page > 1 && <><ListLink search={pageSearch(page - 1)} navigate={navigate}>Previous</ListLink>{' '}</>}
          Page {page} of {pages}
          {page < pages && <>{' '}<ListLink search={pageSearch(page + 1)} navigate={navigate}>Next</ListLink></>}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>ID</th><th>Status</th><th>Source</th><th>Last line</th><th>Length</th><th>First seen</th><th>Answer</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7}>{emptyText}</td></tr>}
          {rows.map((row) => (
            <ReviewRowView key={row.id} row={row} onAnswer={(status) => act(() => answer(row.id, status))}
              onForget={() => {
                if (confirm('Delete the stored value and its lines? The status stays.')) act(() => forget(row.id));
              }} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

function ReviewRowView({ row, onAnswer, onForget }: {
  row: ReviewRow;
  onAnswer: (status: 'secret' | 'not_secret') => void;
  onForget: () => void;
}) {
  return (
    <tr>
      <td><code>{row.id.slice(0, 12)}</code></td>
      <td>{row.status}</td>
      <td>{row.source}</td>
      <td className="line">{row.lastLine === null ? <span>not stored</span> : row.lastLine}</td>
      <td>{row.length}</td>
      <td>{row.firstSeen}</td>
      <td>
        <button onClick={() => onAnswer('secret')}>Secret</button>
        <button onClick={() => onAnswer('not_secret')}>Not a secret</button>
        {row.stored ? (
          <>
            <a href={revealHref(row.id)} target="_blank" rel="noopener noreferrer">Show value</a>
            <button onClick={onForget}>Forget value</button>
          </>
        ) : (
          <span>value not stored</span>
        )}
      </td>
    </tr>
  );
}
