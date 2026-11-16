import { useCallback, useEffect, useState } from 'react';
import {
  Mail,
  MessageSquare,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Account } from '../shared/connection-types';
import type { Dot } from '../shared/types';
import {
  DISCOVERY_APPS,
  type DiscoveryAccountView,
  type DiscoveryState,
} from '../shared/inbox-types';
import { api } from './api';
import { DiscoverySettingsForm } from './DiscoverySettings';
import { RulesSection } from './RulesSection';

interface SignInProvider {
  kind: string;
  label: string;
  configured: boolean;
}
const ICONS: Record<string, typeof Mail> = {
  gmail: Mail,
  outlook: Mail,
  teams: MessageSquare,
};

/** Every account the owner has connected, and what discovery does with them. */
export function AccountsView({ dots }: { dots: Dot[] }) {
  const [accounts, setAccounts] = useState<Account[]>();
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryState>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const loadDiscovery = useCallback(
    () =>
      api<DiscoveryState>('/discovery')
        .then(setDiscovery)
        .catch(() => undefined),
    [],
  );
  const load = useCallback(
    () =>
      Promise.all([
        api<Account[]>('/accounts'),
        api<SignInProvider[]>('/accounts/providers'),
      ])
        .then(([list, signIn]) => {
          setAccounts(list);
          setProviders(signIn);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => {
    void load();
    void loadDiscovery();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, loadDiscovery]);

  // Signing in happens on the service's own page and returns to OpenDots.
  const connect = async (kind: string) => {
    setBusy(kind);
    try {
      const { url } = await api<{ url: string }>(
        `/accounts/sign-in/${kind}`,
        'POST',
        {},
      );
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  };
  const setDiscoveryFor = async (
    account: Account,
    value: { enabled: boolean },
  ) => {
    setBusy(account.id);
    try {
      const result = await api<{ warning?: string }>(
        `/discovery/accounts/${encodeURIComponent(account.id)}`,
        'PUT',
        value,
      );
      setNotice(result.warning ?? '');
      setError('');
      await loadDiscovery();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const disconnect = async (account: Account) => {
    if (
      !window.confirm(
        `Remove ${account.name}? Every Dot that uses it loses access.`,
      )
    )
      return;
    setBusy(account.id);
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}`, 'DELETE');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="main-content inbox">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR APPS</span>
          <h1>Accounts</h1>
          <p>
            Services you have connected, such as Gmail, Outlook, Teams or an MCP
            server. Choose which Dots may use each one, and what they may do
            with it, in the Dot’s settings under Connections.
          </p>
        </div>
        <button
          className="text-button"
          onClick={() => void load()}
          aria-label="Refresh accounts"
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {discovery && (
        <p className="muted discovery-model">
          <Sparkles size={14} aria-hidden />{' '}
          {discovery.model.configured ? (
            <>
              Discovery decides what needs you with <strong>Jev</strong>. A Dot
              then looks into what it flags with read-only access and suggests
              what to do. Nothing changes until you reply.
            </>
          ) : (
            <>
              Discovery needs a model. Set <code>TYPESAFE_API_KEY</code>.
            </>
          )}
        </p>
      )}

      <h2 className="insight-subhead">Connected</h2>
      <div className="inbox-sources">
        {accounts?.map((account) => {
          const Icon = ICONS[account.connector] ?? Plug;
          return (
            <article
              key={account.id}
              className={`inbox-source-card ${account.error ? 'off' : ''}`}
            >
              <header>
                <Icon size={16} aria-hidden />
                <strong>{account.name}</strong>
                <small>
                  {account.detail} · added{' '}
                  {new Date(account.createdAt).toLocaleDateString()}
                </small>
              </header>
              <div className="source-controls">
                <span className="account-actions">
                  <button
                    className="icon-button"
                    aria-label={`Remove ${account.name}`}
                    disabled={!!busy}
                    onClick={() => void disconnect(account)}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </div>
              {account.error && (
                <p className="chat-error" role="alert">
                  {account.error}
                </p>
              )}
              {DISCOVERY_APPS[account.connector] && !account.error && (
                <DiscoveryControls
                  account={account}
                  current={discovery?.accounts.find(
                    (item) => item.accountId === account.id,
                  )}
                  disabled={!!busy || !discovery}
                  onChange={(value) => void setDiscoveryFor(account, value)}
                />
              )}
            </article>
          );
        })}
        {accounts && !accounts.length && (
          <p className="muted">
            Nothing connected yet. Pick a service below to sign in.
          </p>
        )}
        {!accounts && !error && <p className="muted">Loading…</p>}
      </div>

      <h2 className="insight-subhead">Connect a service</h2>
      <div className="account-suggestions">
        {providers.map((provider) => {
          const Icon = ICONS[provider.kind] ?? Plug;
          return (
            <button
              key={provider.kind}
              className="account-suggestion"
              disabled={!!busy || !provider.configured}
              title={
                provider.configured
                  ? undefined
                  : 'Not set up on this server. See docs/CONNECTIONS.md.'
              }
              onClick={() => void connect(provider.kind)}
            >
              <Icon size={16} aria-hidden />
              <span>{provider.label}</span>
              {busy === provider.kind ? (
                <small>Opening…</small>
              ) : provider.configured ? (
                <Plus size={14} aria-hidden />
              ) : (
                <small>Not set up</small>
              )}
            </button>
          );
        })}
      </div>
      <p className="muted">
        To connect an MCP server, open a Dot’s settings and use Connections.
      </p>
      {discovery && (
        <DiscoverySettingsForm state={discovery} onSaved={loadDiscovery} />
      )}
      {accounts && <RulesSection dots={dots} accounts={accounts} />}
    </main>
  );
}

/** Turns discovery on or off for one account. The assistant looks into what it flags. */
function DiscoveryControls({
  account,
  current,
  disabled,
  onChange,
}: {
  account: Account;
  current?: DiscoveryAccountView;
  disabled: boolean;
  onChange: (value: { enabled: boolean }) => void;
}) {
  const enabled = !!current?.enabled;
  const id = `discovery-${account.id}`;
  return (
    <div className="discovery-controls">
      <label className="permission-row inline" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <span>Flag what needs me</span>
      </label>
      {current?.lastError && (
        <small className="chat-error" role="alert">
          {current.lastError}
        </small>
      )}
    </div>
  );
}
