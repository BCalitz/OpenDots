import { useEffect, useState } from 'react';
import type { EntityView } from '../server/memory/store';
import { api } from './api';

/** The people and things OpenDots remembers, as a plain list until 5.1. */
export function PeopleView() {
  const [entities, setEntities] = useState<EntityView[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api<EntityView[]>('/memory/entities?limit=100')
      .then((next) => {
        if (current) setEntities(next);
      })
      .catch((e) => {
        if (current)
          setError(e instanceof Error ? e.message : 'Could not load people.');
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <main className="main-content">
      <div className="page-heading">
        <div>
          <h1>People</h1>
          <p>The people and things OpenDots remembers from your mail.</p>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {entities && !entities.length && (
        <p className="muted">
          Nobody yet. People appear here once OpenDots has read some of your
          mail.
        </p>
      )}
      {!!entities?.length && (
        <ul className="settings-list">
          {entities.map((entity) => (
            <li key={entity.id}>
              <span>
                <strong>{entity.name}</strong>
                <small>
                  {entity.kind} · mentioned {entity.mentions}{' '}
                  {entity.mentions === 1 ? 'time' : 'times'} · last seen{' '}
                  {new Date(entity.lastSeenAt).toLocaleDateString()}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
