import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { type Filter, type ReviewRow, revealHref } from './api';
import { useAnswer, useForget, useReviewPage, useSessionToken } from './queries';

const TABS: [Filter, string][] = [
  ['pending', 'Pending'],
  ['secret', 'Secret'],
  ['not_secret', 'Not a secret'],
  ['all', 'All'],
];

// The list state (status, q, page) is the query string, so a reload or a back step shows the same rows.
function reviewSearch(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== '');
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

export function ReviewList() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const page = useReviewPage(search);
  const answer = useAnswer();
  const forget = useForget();
  const session = useSessionToken();
  const failure = page.error ?? answer.error ?? forget.error;

  if (page.data === undefined) {
    return <main>{page.error ? <p role="alert">{String(page.error)}</p> : <p>Loading…</p>}</main>;
  }

  const { filter, query, counts, total, page: current, pages, start, rows } = page.data;
  const pageSearch = (target: number) => reviewSearch({ status: filter, page: target, q: query || undefined });

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    navigate({ search: reviewSearch({ status: filter, q: text || undefined }) });
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
      {failure && <p role="alert">{String(failure)}</p>}

      <nav>
        {TABS.map(([status, label], index) => (
          <span key={status}>
            {index > 0 && ' · '}
            <Link
              to={{ search: reviewSearch({ status, page: 1, q: query || undefined }) }}
              aria-current={status === filter ? 'page' : undefined}
            >
              {label} ({counts[status]})
            </Link>
          </span>
        ))}
      </nav>

      <form key={query} method="get" action="/review" role="search" onSubmit={onSearch}>
        <label htmlFor="search">Search</label>
        <input id="search" type="search" name="q" defaultValue={query} placeholder="ID, source, status or last line" />
        <button type="submit">Search</button>
        {query !== '' && <Link to={{ search: reviewSearch({ status: filter }) }}>Clear</Link>}
      </form>

      <p>{total === 0 ? emptyText : `Showing ${start + 1}-${start + rows.length} of ${total}.`}</p>
      {pages > 1 && (
        <p>
          {current > 1 && <><Link to={{ search: pageSearch(current - 1) }}>Previous</Link>{' '}</>}
          Page {current} of {pages}
          {current < pages && <>{' '}<Link to={{ search: pageSearch(current + 1) }}>Next</Link></>}
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
            <ReviewRowView
              key={row.id}
              row={row}
              token={session.data}
              onAnswer={(status) => answer.mutate({ id: row.id, status })}
              onForget={() => {
                if (confirm('Delete the stored value and its lines? The status stays.')) forget.mutate(row.id);
              }}
            />
          ))}
        </tbody>
      </table>
    </main>
  );
}

function ReviewRowView({ row, token, onAnswer, onForget }: {
  row: ReviewRow;
  // Undefined until the gateway's token has loaded. Without it there is no reveal link.
  token: string | undefined;
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
            {token !== undefined && (
              <a href={revealHref(row.id, token)} target="_blank" rel="noopener noreferrer">Show value</a>
            )}
            <button onClick={onForget}>Forget value</button>
          </>
        ) : (
          <span>value not stored</span>
        )}
      </td>
    </tr>
  );
}
