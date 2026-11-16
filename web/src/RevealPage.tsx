import { Fragment } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAnswer, useContexts, useForget } from './queries';

export function RevealPage() {
  const { id = '' } = useParams();
  // The token comes from the reveal link's query string.
  const token = new URLSearchParams(useLocation().search).get('token') ?? '';
  const contexts = useContexts(id, token);
  const answer = useAnswer();
  const forget = useForget();
  const noValueStored = contexts.isSuccess && contexts.data === null;
  const failure = answer.error ?? forget.error;

  const onForget = () => {
    if (confirm('Delete the stored value and its lines? The status stays.')) forget.mutate(id);
  };

  return (
    <main>
      <h1>Secret value</h1>
      {token === '' && <p role="alert">This link has no review token. Open it from the review list.</p>}
      {failure && <p role="alert">{String(failure)}</p>}
      {token !== '' && (
        <div role="group" aria-label="Actions">
          <button onClick={() => answer.mutate({ id, status: 'secret' })}>Secret</button>{' '}
          <button onClick={() => answer.mutate({ id, status: 'not_secret' })}>Not a secret</button>{' '}
          <button onClick={onForget} disabled={noValueStored}>Forget value</button>
          {answer.isSuccess && answer.variables.id === id && (
            <p>{answer.variables.status === 'secret' ? 'Marked as secret.' : 'Marked as not a secret.'}</p>
          )}
          {forget.isSuccess && forget.variables === id && <p>Value deleted.</p>}
        </div>
      )}
      {token !== '' && contexts.isPending && <p>Loading…</p>}
      {contexts.isError && <p role="alert">{String(contexts.error)}</p>}
      {noValueStored && (
        <p>No value is stored for this identity. It was forgotten, or it was seen before values were stored.</p>
      )}
      {contexts.isSuccess && contexts.data !== null && (
        <>
          <p>Stored on this machine. Close this page when you are done.</p>
          <h2>Where it appears</h2>
          {contexts.data.length === 0 && <p>No line was recorded for this value.</p>}
          {contexts.data.map((context, index) => (
            <Fragment key={index}>
              <p>{context.location}</p>
              <pre>
                {context.above.map((text, line) => <Fragment key={`above-${line}`}>{text}{'\n'}</Fragment>)}
                {context.before}<mark>{context.value}</mark>{context.after}
                {context.below.map((text, line) => <Fragment key={`below-${line}`}>{'\n'}{text}</Fragment>)}
              </pre>
            </Fragment>
          ))}
        </>
      )}
      <p><Link to="/">Back to review</Link></p>
    </main>
  );
}
