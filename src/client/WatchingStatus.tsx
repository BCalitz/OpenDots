import { useEffect, useState } from 'react';
import type { Account } from '../shared/connection-types';
import type { DiscoveryState } from '../shared/inbox-types';
import { api } from './api';

interface Watched {
  accounts: Account[];
  /** Discovery errors, by account id. */
  errors: Record<string, string>;
}

/** Why watching is not working as it should, or null when it is. */
export function watchingProblem(watched: Watched, paused: boolean) {
  if (paused) return 'OpenDots is paused.';
  for (const account of watched.accounts) {
    const error = account.error ?? watched.errors[account.id];
    if (error) return `${account.name}: ${error}`;
  }
  return null;
}

/** The connected accounts OpenDots watches. Amber, with why, when it can't. */
export function WatchingStatus({
  paused,
  onAccounts,
}: {
  paused: boolean;
  onAccounts: () => void;
}) {
  const [watched, setWatched] = useState<Watched>();
  useEffect(() => {
    let current = true;
    const load = () =>
      void Promise.all([
        api<Account[]>('/accounts'),
        api<DiscoveryState>('/discovery').catch(() => undefined),
      ])
        .then(([accounts, discovery]) => {
          if (!current) return;
          const errors: Record<string, string> = {};
          for (const source of discovery?.accounts ?? [])
            if (source.enabled && source.lastError)
              errors[source.accountId] = source.lastError;
          setWatched({ accounts, errors });
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  if (!watched) return null;
  const problem = watchingProblem(watched, paused);
  const count = watched.accounts.length;
  return (
    <details className={`watching ${problem ? 'warning' : ''}`}>
      <summary>
        <span className="watching-dot" aria-hidden="true" />
        {problem
          ? paused
            ? 'Paused'
            : 'Needs a look'
          : count
            ? `Watching ${count} ${count === 1 ? 'account' : 'accounts'}`
            : 'No accounts'}
      </summary>
      <div className="watching-panel">
        {problem && <p className="watching-reason">{problem}</p>}
        {count ? (
          <ul>
            {watched.accounts.map((account) => (
              <li key={account.id}>
                {account.name}
                {(account.error ?? watched.errors[account.id]) && (
                  <small>
                    {' '}
                    · {account.error ?? watched.errors[account.id]}
                  </small>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>Connect an account so OpenDots can watch it.</p>
        )}
        <button className="text-button" onClick={onAccounts}>
          Accounts
        </button>
      </div>
    </details>
  );
}
