import { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  FileSpreadsheet,
  HardDrive,
  Link2,
  Mail,
  MessageSquare,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ConnectedAccount, Dot } from '../shared/types';
import {
  DISCOVERY_TOOLKITS,
  type DiscoveryAccountView,
  type DiscoveryState,
} from '../shared/inbox-types';
import { api } from './api';
import { DiscoverySettingsForm } from './DiscoverySettings';

/** Common apps, offered as one-click buttons. Any Composio app slug works. */
const SUGGESTED = [
  { toolkit: 'gmail', name: 'Gmail', icon: Mail },
  { toolkit: 'outlook', name: 'Outlook', icon: Mail },
  { toolkit: 'googlecalendar', name: 'Google Calendar', icon: Calendar },
  { toolkit: 'quickbooks', name: 'QuickBooks', icon: FileSpreadsheet },
  { toolkit: 'microsoft_teams', name: 'Microsoft Teams', icon: MessageSquare },
  { toolkit: 'googledrive', name: 'Google Drive', icon: HardDrive },
];
const statusText: Record<string, string> = {
  ACTIVE: 'Connected',
  INITIALIZING: 'Waiting for sign-in',
  INITIATED: 'Waiting for sign-in',
  FAILED: 'Sign-in failed',
  EXPIRED: 'Sign-in expired',
  INACTIVE: 'Turned off',
};
const statusClass: Record<string, string> = {
  ACTIVE: 'completed',
  INITIALIZING: 'running',
  INITIATED: 'running',
  FAILED: 'failed',
  EXPIRED: 'failed',
  INACTIVE: 'paused',
};

function iconFor(toolkit: string) {
  return SUGGESTED.find((app) => app.toolkit === toolkit)?.icon ?? Plug;
}

/** Apps connected for the owner through Composio. */
export function AccountsView({
  configured,
  dots,
}: {
  configured: boolean;
  dots: Dot[];
}) {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>();
  const [discovery, setDiscovery] = useState<DiscoveryState>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [custom, setCustom] = useState('');
  const [waiting, setWaiting] = useState<string>();
  const loadDiscovery = useCallback(
    () =>
      api<DiscoveryState>('/discovery')
        .then(setDiscovery)
        .catch(() => undefined),
    [],
  );
  const load = useCallback(
    () =>
      api<ConnectedAccount[]>('/accounts')
        .then((value) => {
          setAccounts(value);
          setError('');
          return value;
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          return undefined;
        }),
    [],
  );
  useEffect(() => {
    if (!configured) return;
    void load();
    void loadDiscovery();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [configured, load, loadDiscovery]);
  // After opening a sign-in page, check back until the account shows up.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      void load().then((value) => {
        const done = value?.some(
          (account) =>
            account.toolkit === waiting && account.status === 'ACTIVE',
        );
        if (done || Date.now() - started > 3 * 60_000) setWaiting(undefined);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const connect = async (toolkit: string) => {
    const slug = toolkit.trim().toLowerCase();
    if (!slug) return;
    // Open the tab now, while the click still counts, so popup blockers allow it.
    const tab = window.open('', '_blank');
    setBusy(slug);
    try {
      const { redirectUrl } = await api<{ redirectUrl: string; name: string }>(
        '/accounts',
        'POST',
        { toolkit: slug },
      );
      const url = new URL(redirectUrl);
      if (url.protocol !== 'https:')
        throw new Error('The sign-in link was not a secure address.');
      if (tab) {
        tab.opener = null;
        tab.location.href = url.href;
      } else window.location.assign(url.href);
      setWaiting(slug);
      setCustom('');
      setError('');
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const setDiscoveryFor = async (
    account: ConnectedAccount,
    value: { enabled: boolean; dotId: string },
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
  const disconnect = async (account: ConnectedAccount) => {
    if (
      !window.confirm(
        `Disconnect ${account.name}? Dots will lose access until you connect it again.`,
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

  if (!configured)
    return (
      <main className="main-content inbox">
        <div className="page-heading">
          <div>
            <span className="eyebrow">YOUR APPS</span>
            <h1>Accounts</h1>
            <p>
              Connect mail, calendars, accounting and other apps so your Dots
              can work with them. Add <code>COMPOSIO_API_KEY</code> to{' '}
              <code>.env</code> and restart OpenDots to turn this on.
            </p>
          </div>
        </div>
      </main>
    );

  const connected = new Set(
    accounts
      ?.filter((account) => account.status === 'ACTIVE')
      .map((account) => account.toolkit),
  );
  return (
    <main className="main-content inbox">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR APPS</span>
          <h1>Accounts</h1>
          <p>
            Apps you have signed in to through Composio. A Dot can use them once
            Connected apps is on in Settings and in that Dot’s settings.
            Sign-ins are kept by Composio, not on this server.
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
      {waiting && (
        <p className="notice" role="status">
          Finish signing in on the page that opened. This list updates when
          you’re done.
        </p>
      )}

      <h2 className="insight-subhead">Connected</h2>
      <div className="inbox-sources">
        {accounts?.map((account) => {
          const Icon = iconFor(account.toolkit);
          return (
            <article
              key={account.id}
              className={`inbox-source-card ${account.status === 'ACTIVE' && !account.disabled ? '' : 'off'}`}
            >
              <header>
                <Icon size={16} aria-hidden />
                <strong>{account.name}</strong>
                <small>
                  {account.alias ? `${account.alias} · ` : ''}
                  {account.toolkit} · added{' '}
                  {new Date(account.createdAt).toLocaleDateString()}
                </small>
              </header>
              <div className="source-controls">
                <span
                  className={`status ${statusClass[account.status] ?? ''}`}
                  title={account.statusReason ?? undefined}
                >
                  <span />
                  {statusText[account.status] ?? account.status}
                </span>
                <span className="account-actions">
                  {account.status !== 'ACTIVE' && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => void connect(account.toolkit)}
                    >
                      <Link2 size={14} />
                      Reconnect
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`Disconnect ${account.name}`}
                    disabled={!!busy}
                    onClick={() => void disconnect(account)}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </div>
              {DISCOVERY_TOOLKITS[account.toolkit] &&
                account.status === 'ACTIVE' && (
                  <DiscoveryControls
                    account={account}
                    dots={dots}
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
            Nothing connected yet. Pick an app below to sign in.
          </p>
        )}
        {!accounts && !error && <p className="muted">Loading…</p>}
      </div>

      <h2 className="insight-subhead">Connect an app</h2>
      <div className="account-suggestions">
        {SUGGESTED.map((app) => (
          <button
            key={app.toolkit}
            className="account-suggestion"
            disabled={!!busy}
            onClick={() => void connect(app.toolkit)}
          >
            <app.icon size={16} aria-hidden />
            <span>{app.name}</span>
            {connected.has(app.toolkit) ? (
              <small>Add another</small>
            ) : busy === app.toolkit ? (
              <small>Opening…</small>
            ) : (
              <Plus size={14} aria-hidden />
            )}
          </button>
        ))}
      </div>
      <form
        className="account-custom"
        onSubmit={(event) => {
          event.preventDefault();
          void connect(custom);
        }}
      >
        <label className="field-label" htmlFor="account-toolkit">
          Another app
        </label>
        <div>
          <input
            id="account-toolkit"
            value={custom}
            pattern="[A-Za-z0-9_]+"
            placeholder="slack, hubspot, xero…"
            aria-describedby="account-toolkit-help"
            onChange={(event) => setCustom(event.target.value)}
          />
          <button className="primary" disabled={!custom.trim() || !!busy}>
            Connect
          </button>
        </div>
        <p className="muted" id="account-toolkit-help">
          Use the app’s Composio name, as listed at composio.dev/toolkits.
        </p>
      </form>
      {discovery && (
        <DiscoverySettingsForm state={discovery} onSaved={loadDiscovery} />
      )}
    </main>
  );
}

/** Turns discovery on or off for one account and picks the Dot that investigates. */
function DiscoveryControls({
  account,
  dots,
  current,
  disabled,
  onChange,
}: {
  account: ConnectedAccount;
  dots: Dot[];
  current?: DiscoveryAccountView;
  disabled: boolean;
  onChange: (value: { enabled: boolean; dotId: string }) => void;
}) {
  const dotId = current?.dotId ?? dots[0]?.id ?? '';
  const enabled = !!current?.enabled;
  const id = `discovery-${account.id}`;
  return (
    <div className="discovery-controls">
      <label className="permission-row inline" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={enabled}
          disabled={disabled || !dotId}
          onChange={(event) =>
            onChange({ enabled: event.target.checked, dotId })
          }
        />
        <span>Flag what needs me</span>
      </label>
      <label className="discovery-dot">
        <span>Looked into by</span>
        <select
          value={dotId}
          disabled={disabled || !dots.length}
          aria-label={`Dot that looks into what ${account.name} discovery flags`}
          onChange={(event) => onChange({ enabled, dotId: event.target.value })}
        >
          {dots.map((dot) => (
            <option key={dot.id} value={dot.id}>
              {dot.name}
            </option>
          ))}
        </select>
      </label>
      {current?.lastError && (
        <small className="chat-error" role="alert">
          {current.lastError}
        </small>
      )}
    </div>
  );
}
