import { useEffect, useState, type KeyboardEvent } from 'react';
import { PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import type { Account, Grant, ToolPolicy } from '../shared/connection-types';
import { api } from './api';
// Lives inside the Dot form, so it saves immediately through its own
// requests and keeps Enter from submitting the surrounding form.
const stayInSection = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};
const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask first' },
  { value: 'block', label: 'Block' },
];
const dotPath = (dotId: string, accountId: string) =>
  `/dots/${encodeURIComponent(dotId)}/grants/${encodeURIComponent(accountId)}`;
export function ConnectionsSection({ dotId }: { dotId: string }) {
  const [accounts, setAccounts] = useState<Account[]>();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Account[]>('/accounts'),
      api<Grant[]>(`/dots/${encodeURIComponent(dotId)}/grants`),
    ])
      .then(([list, granted]) => {
        if (!active) return;
        setAccounts(list);
        setGrants(granted);
      })
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load connections.',
          ),
      );
    return () => {
      active = false;
    };
  }, [dotId]);
  const run = async <T,>(key: string, request: () => Promise<T>) => {
    setBusy(key);
    setError('');
    try {
      return await request();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy('');
    }
  };
  const replaceAccount = (next: Account) =>
    setAccounts((list) =>
      list?.map((item) => (item.id === next.id ? next : item)),
    );
  const replaceGrant = (next: Grant) =>
    setGrants((list) => [
      ...list.filter((item) => item.accountId !== next.accountId),
      next,
    ]);
  const add = async () => {
    const created = await run('add', async () => {
      const account = await api<Account>('/accounts', 'POST', {
        connector: 'mcp',
        name: name.trim(),
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      // Connecting from a Dot's settings means this Dot is meant to use it.
      return {
        account,
        grant: await api<Grant>(dotPath(dotId, account.id), 'PUT', {}),
      };
    });
    if (!created) return;
    setAccounts((list) => [...(list ?? []), created.account]);
    replaceGrant(created.grant);
    setName('');
    setUrl('');
    setToken('');
  };
  return (
    <fieldset className="space-access-fields connections-fields">
      <legend>Connections</legend>
      <p className="muted">
        Connect a service once, then choose which Dots may use it. For each
        tool, choose whether it runs on its own, asks you in chat first, or is
        blocked. Secrets stay on the server.
      </p>
      {accounts?.map((account) => {
        const grant = grants.find((item) => item.accountId === account.id);
        return (
          <div className="connection" key={account.id}>
            <div className="connection-head">
              <PlugZap size={15} />
              <span>
                <strong>{account.name}</strong>
                <small>
                  {account.detail}
                  {account.hasSecret ? ' · token saved' : ''}
                </small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Refresh ${account.name} tools`}
                disabled={!!busy}
                onClick={async () => {
                  const next = await run(account.id, () =>
                    api<Account>(
                      `/accounts/${encodeURIComponent(account.id)}/refresh`,
                      'POST',
                      {},
                    ),
                  );
                  if (!next) return;
                  replaceAccount(next);
                  // New tools get a default policy on this Dot's grant.
                  setGrants(
                    await api<Grant[]>(
                      `/dots/${encodeURIComponent(dotId)}/grants`,
                    ),
                  );
                }}
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${account.name} from every Dot`}
                disabled={!!busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Remove ${account.name}? Every Dot that uses it loses access.`,
                    )
                  )
                    return;
                  const done = await run(account.id, () =>
                    api(
                      `/accounts/${encodeURIComponent(account.id)}`,
                      'DELETE',
                    ),
                  );
                  if (done) {
                    setAccounts((list) =>
                      list?.filter((item) => item.id !== account.id),
                    );
                    setGrants((list) =>
                      list.filter((item) => item.accountId !== account.id),
                    );
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {account.error && (
              <p className="chat-error" role="alert">
                {account.error}
              </p>
            )}
            <label className="permission-row">
              <input
                type="checkbox"
                checked={!!grant}
                disabled={!!busy}
                onChange={async (event) => {
                  if (event.target.checked) {
                    const next = await run(account.id, () =>
                      api<Grant>(dotPath(dotId, account.id), 'PUT', {}),
                    );
                    if (next) replaceGrant(next);
                  } else {
                    const done = await run(account.id, () =>
                      api(dotPath(dotId, account.id), 'DELETE'),
                    );
                    if (done)
                      setGrants((list) =>
                        list.filter((item) => item.accountId !== account.id),
                      );
                  }
                }}
              />
              <span>
                <strong>Use in this Dot</strong>
              </span>
            </label>
            {grant && !grant.tools.length && (
              <p className="muted">This service offers no tools.</p>
            )}
            {grant && (
              <ul className="connection-tools">
                {grant.tools.map((tool) => (
                  <li key={tool.name}>
                    <span className="permission-row">
                      <span>
                        <strong>
                          {tool.title}
                          {tool.readOnly && <em>read-only</em>}
                        </strong>
                        {tool.description && <small>{tool.description}</small>}
                      </span>
                    </span>
                    <label className="connection-approval">
                      <select
                        aria-label={`${tool.title} access`}
                        value={tool.policy}
                        disabled={!!busy}
                        onChange={async (event) => {
                          const next = await run(account.id, () =>
                            api<Grant>(
                              `${dotPath(dotId, account.id)}/tools/${encodeURIComponent(tool.name)}`,
                              'PATCH',
                              { policy: event.target.value },
                            ),
                          );
                          if (next) replaceGrant(next);
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
            )}
          </div>
        );
      })}
      <div className="connection-add">
        <label className="field-label" htmlFor="connection-name">
          Add an MCP server
        </label>
        <input
          id="connection-name"
          placeholder="Name, e.g. GitHub"
          maxLength={40}
          value={name}
          onKeyDown={stayInSection}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label="MCP server URL"
          placeholder="https://example.com/mcp"
          type="url"
          value={url}
          onKeyDown={stayInSection}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          aria-label="Bearer token (optional)"
          placeholder="Bearer token (optional)"
          type="password"
          autoComplete="off"
          value={token}
          onKeyDown={stayInSection}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="button"
          className="connection-connect"
          disabled={!!busy || !name.trim() || !url.trim()}
          onClick={() => void add()}
        >
          {busy === 'add' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
