import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Account, Grant } from '../shared/connection-types';
import type { Dot } from '../shared/types';
import { api } from './api';
import { POLICIES, policyChange } from './policy';

/**
 * Every action each Dot can take through a connected service, with what
 * happens when it tries: allow, ask first or block. Choices made with
 * "Always allow" on an approval card show up here and can be undone here.
 */
export function RulesSection({
  dots,
  accounts,
}: {
  dots: Dot[];
  accounts: Account[];
}) {
  const [grants, setGrants] = useState<Record<string, Grant[]>>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const entries = await Promise.all(
        dots.map(
          async (dot) =>
            [dot.id, await api<Grant[]>(`/dots/${dot.id}/grants`)] as const,
        ),
      );
      setGrants(Object.fromEntries(entries));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load rules.',
      );
    }
  }, [dots]);
  useEffect(() => {
    void load();
  }, [load, accounts]);
  const rows = dots.flatMap((dot) =>
    (grants?.[dot.id] ?? []).map((grant) => ({
      dot,
      grant,
      account: accounts.find((item) => item.id === grant.accountId),
    })),
  );
  return (
    <section className="rules" aria-label="Rules">
      <h2>
        <ShieldCheck size={18} /> Rules
      </h2>
      <p className="muted">
        What each Dot may do with your connected accounts. Anything that sends,
        pays or deletes asks first unless you type a confirmation.
      </p>
      {error && <p role="alert">{error}</p>}
      {grants && rows.length === 0 && (
        <p className="muted">No Dot uses a connected account yet.</p>
      )}
      {rows.map(({ dot, grant, account }) => (
        <div key={grant.id} className="rules-group">
          <h3>
            {dot.name} · {account?.name ?? 'Account'}
          </h3>
          <ul className="connection-tools">
            {grant.tools.map((tool) => (
              <li key={tool.name}>
                <span className="permission-row">
                  <strong>{tool.title}</strong>
                </span>
                <label className="connection-approval">
                  <select
                    aria-label={`${dot.name}: ${tool.title} access`}
                    value={tool.policy}
                    onChange={async (event) => {
                      const body = policyChange(
                        tool,
                        event.target.value as typeof tool.policy,
                      );
                      if (!body) return;
                      setError('');
                      try {
                        await api(
                          `/dots/${encodeURIComponent(dot.id)}/grants/${encodeURIComponent(grant.accountId)}/tools/${encodeURIComponent(tool.name)}`,
                          'PATCH',
                          body,
                        );
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : 'Could not save.',
                        );
                      }
                      await load();
                    }}
                  >
                    {POLICIES.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
