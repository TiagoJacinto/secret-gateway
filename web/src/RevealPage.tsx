import { Fragment, useEffect, useState } from 'react';
import { fetchContexts, type Context } from './api';

type Loaded = { state: 'loading' } | { state: 'missing' } | { state: 'found'; contexts: Context[] } | { state: 'error'; message: string };

export function RevealPage({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    let current = true;
    fetchContexts(id)
      .then((contexts) => {
        if (!current) return;
        setLoaded(contexts === undefined ? { state: 'missing' } : { state: 'found', contexts });
      })
      .catch((failure: unknown) => { if (current) setLoaded({ state: 'error', message: String(failure) }); });
    return () => { current = false; };
  }, [id]);

  return (
    <main>
      <h1>Secret value</h1>
      {loaded.state === 'loading' && <p>Loading…</p>}
      {loaded.state === 'error' && <p role="alert">{loaded.message}</p>}
      {loaded.state === 'missing' && (
        <p>No value is stored for this identity. It was forgotten, or it was seen before values were stored.</p>
      )}
      {loaded.state === 'found' && (
        <>
          <p>Stored on this machine. Close this page when you are done.</p>
          <h2>Where it appears</h2>
          {loaded.contexts.length === 0 && <p>No line was recorded for this value.</p>}
          {loaded.contexts.map((context, index) => (
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
      <p><a href="/review">Back to review</a></p>
    </main>
  );
}
