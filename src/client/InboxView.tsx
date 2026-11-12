import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bell,
  Calendar,
  Check,
  Copy,
  Hand,
  Inbox,
  KeyRound,
  Link2,
  List,
  Mail,
  Newspaper,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Ticket,
  Trash2,
  X,
} from 'lucide-react';
import type { Dot } from '../shared/types';
import type { Account, Grant } from '../shared/connection-types';
import type {
  InboxEventView,
  InboxNotify,
  InboxSourceView,
  InboxState,
  SourceKind,
} from '../shared/inbox-types';
import { api } from './api';
import { InboxLinks } from './InboxLinks';
import { InboxProposals } from './InboxProposals';
import {
  EventLinks,
  InboxBrief,
  deliveryText,
  routeText,
  urgencyText,
} from './InboxBrief';
import { relative } from './TaskPresentation';

const kindIcon = {
  ticket: Ticket,
  mail: Mail,
  message: MessageSquare,
  calendar: Calendar,
};
const kindName: Record<SourceKind, string> = {
  ticket: 'Tickets',
  mail: 'Mail',
  message: 'Messages',
  calendar: 'Calendar',
};
const notifyName: Record<InboxNotify, string> = {
  off: 'No notifications',
  urgent: 'Notify for urgent',
  high: 'Notify for high and urgent',
  all: 'Notify for everything',
};
const priorityClass = {
  urgent: 'failed',
  high: 'paused',
  normal: 'running',
  low: '',
};

const findingText: Record<string, string> = {
  flagged: 'Needs you',
  investigating: 'Looking into it…',
  ready: 'Findings ready',
  failed: 'Could not finish',
  resolved: 'No longer needed',
};

/** The event log and the sources that feed it (roadmap phase 3). */
export function InboxView({
  dots,
  onThread,
}: {
  dots: Dot[];
  onThread: (threadId: string) => void;
}) {
  const [state, setState] = useState<InboxState>();
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{
    name: string;
    url: string;
    secret: string;
  }>();
  const [showDismissed, setShowDismissed] = useState(false);
  const [tab, setTab] = useState<'choices' | 'items' | 'brief' | 'links'>(
    'choices',
  );
  const [open, setOpen] = useState<string>();
  const load = useCallback(
    () =>
      api<InboxState>(`/inbox${showDismissed ? '?all=1' : ''}`)
        .then((value) => {
          setState(value);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [showDismissed],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const setEventState = (
    event: InboxEventView,
    next: InboxEventView['state'],
  ) => act(() => api(`/inbox/events/${event.id}`, 'POST', { state: next }));
  return (
    <main className="main-content inbox">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WHEN SOMETHING HAPPENS</span>
          <h1>Inbox</h1>
          <p>
            Tickets, mail and messages your sources picked up, most important
            first. Outside content is shown as data. Accounts with discovery on
            are checked by a small model; what it flags, a Dot looks into
            read-only and suggests what to do.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          <Plus size={15} />
          Add source
        </button>
      </div>
      {error && <p className="chat-error">{error}</p>}
      <div className="insight-tabs" role="tablist" aria-label="Inbox">
        {(
          [
            ['choices', 'For you', Hand],
            ['items', 'Items', List],
            ['brief', 'Brief', Newspaper],
            ['links', 'Links', Link2],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'choices' && <InboxProposals onThread={onThread} />}
      {tab === 'links' && <InboxLinks />}
      {tab === 'brief' && <InboxBrief onThread={onThread} />}
      {tab === 'items' && (
        <>
          {secret && (
            <section className="task-detail-card webhook-secret" role="status">
              <h2>
                <KeyRound size={16} /> {secret.name} is ready
              </h2>
              <p>
                Send events to this address with the secret in an{' '}
                <code>X-OpenDots-Secret</code> header. The secret is shown once.
              </p>
              <CopyField
                label="Webhook URL"
                value={`${location.origin}${secret.url}`}
              />
              <CopyField label="Secret" value={secret.secret} />
              <pre>{`{ "events": [{ "externalId": "HD-9", "title": "Payment export failing", "priority": "urgent", "url": "https://…" }] }`}</pre>
              <button
                className="text-button"
                onClick={() => setSecret(undefined)}
              >
                Done
              </button>
            </section>
          )}
          {adding && (
            <AddSource
              dots={dots}
              onClose={() => setAdding(false)}
              onCreated={(created) => {
                setAdding(false);
                if (created.secret)
                  setSecret({
                    name: created.source.name,
                    url: created.url!,
                    secret: created.secret,
                  });
                void load();
              }}
            />
          )}
          <h2 className="insight-subhead">Sources</h2>
          <div className="inbox-sources">
            {state?.sources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                dots={dots}
                onAct={act}
                onSecret={(value) =>
                  setSecret({
                    name: source.name,
                    url: value.url,
                    secret: value.secret,
                  })
                }
              />
            ))}
            {state && !state.sources.length && (
              <p className="muted">
                No sources yet. Add a connection tool that lists your work, such
                as “tickets assigned to me”, or a webhook another service can
                post to.
              </p>
            )}
          </div>
          <div className="insight-toolbar">
            <h2 className="insight-subhead">Events</h2>
            <label className="permission-row inline">
              <input
                type="checkbox"
                checked={showDismissed}
                onChange={(e) => setShowDismissed(e.target.checked)}
              />
              <span>Show dismissed</span>
            </label>
          </div>
          <ul className="inbox-events">
            {state?.events.map((event) => (
              <li key={event.id} className={`inbox-event ${event.state}`}>
                <span className={`status ${priorityClass[event.priority]}`}>
                  <span />
                  {event.priority}
                </span>
                <div>
                  <strong>{event.title}</strong>
                  {event.summary && <p>{event.summary.slice(0, 280)}</p>}
                  <span>
                    {event.sourceName} · {event.kind}
                    {event.from ? ` · from ${event.from}` : ''} ·{' '}
                    {relative(event.occurredAt)}
                  </span>
                  {event.finding?.attention && (
                    <p className={`discovery-finding ${event.finding.state}`}>
                      <Sparkles size={13} aria-hidden />
                      <strong>{findingText[event.finding.state]}</strong> ·{' '}
                      {event.finding.category} ·{' '}
                      {Math.round(event.finding.confidence * 100)}% ·{' '}
                      {event.finding.reason}
                      {event.finding.state === 'failed' && event.finding.error
                        ? ` (${event.finding.error})`
                        : ''}
                    </p>
                  )}
                  {event.finding?.attention && (
                    <p className="discovery-detail">
                      {[
                        event.finding.urgency &&
                          urgencyText[event.finding.urgency],
                        event.finding.route && routeText[event.finding.route],
                        event.finding.delivery &&
                          deliveryText[event.finding.delivery],
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  {event.finding?.injection && (
                    <p className="discovery-warning">
                      This item reads as trying to instruct an AI assistant. It
                      is shown to you only; no Dot acts on it.
                    </p>
                  )}
                  {event.finding?.note && (
                    <p className="discovery-note">{event.finding.note}</p>
                  )}
                  {open === event.id && <EventLinks eventId={event.id} />}
                </div>
                <div className="inbox-event-actions">
                  {event.finding?.threadId && (
                    <button
                      className="text-button"
                      onClick={() => onThread(event.finding!.threadId!)}
                    >
                      Open findings
                    </button>
                  )}
                  {event.finding && (
                    <button
                      className="icon-button"
                      aria-label={`Items related to ${event.title}`}
                      aria-expanded={open === event.id}
                      title="Related items"
                      onClick={() =>
                        setOpen(open === event.id ? undefined : event.id)
                      }
                    >
                      <Link2 size={15} />
                    </button>
                  )}
                  {event.finding &&
                    ['flagged', 'failed', 'ignored'].includes(
                      event.finding.state,
                    ) && (
                      <button
                        className="icon-button"
                        aria-label={`Have a Dot look into ${event.title}`}
                        title="Have a Dot look into this (read-only)"
                        onClick={() =>
                          void act(() =>
                            api(
                              `/inbox/findings/${event.finding!.id}/investigate`,
                              'POST',
                            ),
                          )
                        }
                      >
                        <Search size={15} />
                      </button>
                    )}
                  {event.url && (
                    <a
                      className="icon-button"
                      href={event.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`Open ${event.title} in its service`}
                    >
                      <ArrowUpRight size={15} />
                    </a>
                  )}
                  {event.state === 'new' && (
                    <button
                      className="icon-button"
                      aria-label={`Mark ${event.title} as seen`}
                      onClick={() => void setEventState(event, 'seen')}
                    >
                      <Check size={15} />
                    </button>
                  )}
                  {event.state !== 'dismissed' ? (
                    <button
                      className="icon-button"
                      aria-label={`Dismiss ${event.title}`}
                      onClick={() => void setEventState(event, 'dismissed')}
                    >
                      <X size={15} />
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => void setEventState(event, 'seen')}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {state && !state.events.length && (
            <div className="large-empty">
              <Inbox size={32} />
              <h2>All quiet.</h2>
              <p>New tickets and messages from your sources will land here.</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span>{label}</span>
      <code>{value}</code>
      <button
        className="icon-button"
        aria-label={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => setCopied(true))
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function SourceCard({
  source,
  dots,
  onAct,
  onSecret,
}: {
  source: InboxSourceView;
  dots: Dot[];
  onAct: (work: () => Promise<unknown>) => Promise<void>;
  onSecret: (value: { url: string; secret: string }) => void;
}) {
  const Icon = kindIcon[source.kind];
  const dot =
    'dotId' in source.config
      ? dots.find((item) => item.id === source.config.dotId)
      : undefined;
  return (
    <article className={`inbox-source-card ${source.enabled ? '' : 'off'}`}>
      <header>
        <Icon size={16} aria-hidden />
        <strong>{source.name}</strong>
        <small>
          {source.type === 'mcp'
            ? `${'tool' in source.config ? source.config.tool : ''}${dot ? ` · ${dot.name}` : ''} · every ${Math.round(source.intervalSeconds / 60)} min`
            : source.type === 'composio'
              ? `Discovery${dot ? ` · ${dot.name}` : ''} · every ${Math.round(source.intervalSeconds / 60)} min`
              : 'Webhook'}
        </small>
      </header>
      <p className="muted">
        {source.eventCount} events · {source.newCount} new
        {source.lastPolledAt
          ? ` · checked ${relative(source.lastPolledAt)}`
          : ''}
      </p>
      {source.lastError && <p className="chat-error">{source.lastError}</p>}
      <div className="source-controls">
        <label className="permission-row inline">
          <input
            type="checkbox"
            checked={source.enabled}
            onChange={(e) =>
              void onAct(() =>
                api(`/inbox/sources/${source.id}`, 'PATCH', {
                  enabled: e.target.checked,
                }),
              )
            }
          />
          <span>On</span>
        </label>
        <label className="source-notify">
          <Bell size={13} aria-hidden />
          <select
            aria-label={`Notifications for ${source.name}`}
            value={source.notify}
            onChange={(e) =>
              void onAct(() =>
                api(`/inbox/sources/${source.id}`, 'PATCH', {
                  notify: e.target.value,
                }),
              )
            }
          >
            {(Object.keys(notifyName) as InboxNotify[]).map((value) => (
              <option key={value} value={value}>
                {notifyName[value]}
              </option>
            ))}
          </select>
        </label>
        {source.type !== 'webhook' ? (
          <button
            className="icon-button"
            aria-label={`Check ${source.name} now`}
            disabled={!source.enabled}
            onClick={() =>
              void onAct(() =>
                api(`/inbox/sources/${source.id}/poll`, 'POST', {}),
              )
            }
          >
            <RefreshCw size={14} />
          </button>
        ) : (
          <button
            className="icon-button"
            aria-label={`New secret for ${source.name}`}
            onClick={() =>
              void onAct(async () => {
                if (
                  !window.confirm(
                    'Make a new secret? The current one stops working right away.',
                  )
                )
                  return;
                onSecret(
                  await api<{ url: string; secret: string }>(
                    `/inbox/sources/${source.id}/secret`,
                    'POST',
                    {},
                  ),
                );
              })
            }
          >
            <KeyRound size={14} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={`Remove ${source.name}`}
          onClick={() =>
            void onAct(async () => {
              if (
                window.confirm(
                  `Remove ${source.name} and its ${source.eventCount} events?`,
                )
              )
                await api(`/inbox/sources/${source.id}`, 'DELETE', {});
            })
          }
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  );
}

type Created = { source: InboxSourceView; secret?: string; url?: string };
function AddSource({
  dots,
  onClose,
  onCreated,
}: {
  dots: Dot[];
  onClose: () => void;
  onCreated: (created: Created) => void;
}) {
  const [type, setType] = useState<'mcp' | 'webhook'>('mcp');
  const [name, setName] = useState('Tickets assigned to me');
  const [kind, setKind] = useState<SourceKind>('ticket');
  const [notify, setNotify] = useState<InboxNotify>('urgent');
  const [dotId, setDotId] = useState(dots[0]?.id ?? '');
  const [access, setAccess] = useState<{ account: Account; grant: Grant }[]>(
    [],
  );
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('{\n  "assignee": "me"\n}');
  const [minutes, setMinutes] = useState('5');
  const [itemsPath, setItemsPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dotId) return;
    let active = true;
    void Promise.all([
      api<Account[]>('/accounts'),
      api<Grant[]>(`/dots/${dotId}/grants`),
    ])
      .then(([accounts, grants]) => {
        if (!active) return;
        setAccess(
          grants.flatMap((grant) => {
            const account = accounts.find(
              (item) => item.id === grant.accountId,
            );
            return account ? [{ account, grant }] : [];
          }),
        );
      })
      .catch(() => active && setAccess([]));
    return () => {
      active = false;
    };
  }, [dotId]);
  const tools = access.flatMap(({ account, grant }) =>
    grant.tools
      .filter((tool) => tool.policy !== 'block')
      .map((tool) => ({ account, tool })),
  );
  const picked = tools.find(
    (item) => `${item.account.id}:${item.tool.name}` === target,
  );
  return (
    <section className="task-detail-card add-source">
      <h2>Add a source</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          let body: unknown;
          if (type === 'webhook') body = { type, name, kind, notify };
          else {
            if (!picked) {
              setError('Pick a connection tool.');
              return;
            }
            let parsed: unknown;
            try {
              parsed = args.trim() ? JSON.parse(args) : {};
            } catch {
              setError('Tool arguments must be valid JSON.');
              return;
            }
            body = {
              type,
              name,
              kind,
              notify,
              intervalSeconds: Math.max(1, Number(minutes) || 5) * 60,
              config: {
                dotId,
                accountId: picked.account.id,
                tool: picked.tool.name,
                arguments: parsed,
                ...(itemsPath.trim()
                  ? { fields: { items: itemsPath.trim() } }
                  : {}),
              },
            };
          }
          setBusy(true);
          try {
            onCreated(await api<Created>('/inbox/sources', 'POST', body));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="source-type" role="radiogroup" aria-label="Source type">
          {(
            [
              ['mcp', 'Connection tool', 'Checks a list tool on a timer.'],
              ['webhook', 'Webhook', 'Another service posts events here.'],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className={type === value ? 'active' : ''}>
              <input
                type="radio"
                name="source-type"
                checked={type === value}
                onChange={() => setType(value)}
              />
              <strong>{label}</strong>
              <small>{help}</small>
            </label>
          ))}
        </div>
        <label className="field-label" htmlFor="source-name">
          Name
        </label>
        <input
          id="source-name"
          value={name}
          maxLength={60}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <div className="field-pair">
          <label>
            <span className="field-label">It watches</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as SourceKind)}
            >
              {(Object.keys(kindName) as SourceKind[]).map((value) => (
                <option key={value} value={value}>
                  {kindName[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">Push notifications</span>
            <select
              value={notify}
              onChange={(e) => setNotify(e.target.value as InboxNotify)}
            >
              {(Object.keys(notifyName) as InboxNotify[]).map((value) => (
                <option key={value} value={value}>
                  {notifyName[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {type === 'mcp' && (
          <>
            <div className="field-pair">
              <label>
                <span className="field-label">Dot</span>
                <select
                  value={dotId}
                  onChange={(e) => {
                    setDotId(e.target.value);
                    setTarget('');
                  }}
                >
                  {dots.map((dot) => (
                    <option key={dot.id} value={dot.id}>
                      {dot.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="field-label">Check every (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
            </div>
            <label className="field-label" htmlFor="source-tool">
              List tool
            </label>
            <select
              id="source-tool"
              value={target}
              required
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">
                {tools.length
                  ? 'Choose a tool'
                  : 'This Dot has no connection tools. Add one in its settings.'}
              </option>
              {tools.map(({ account, tool }) => (
                <option
                  key={`${account.id}:${tool.name}`}
                  value={`${account.id}:${tool.name}`}
                  disabled={tool.policy === 'ask'}
                >
                  {account.name}: {tool.title}
                  {tool.policy === 'ask'
                    ? ' (asks first, cannot run on a timer)'
                    : ''}
                </option>
              ))}
            </select>
            {picked && <p className="muted">{picked.tool.description}</p>}
            <label className="field-label" htmlFor="source-args">
              Tool arguments (JSON)
            </label>
            <textarea
              id="source-args"
              rows={4}
              value={args}
              spellCheck={false}
              onChange={(e) => setArgs(e.target.value)}
            />
            <p className="muted">
              Use <code>"{'{{since}}'}"</code> as a value to pass the time of
              the last check.
            </p>
            <label className="field-label" htmlFor="source-items">
              Items path (optional)
            </label>
            <input
              id="source-items"
              value={itemsPath}
              placeholder="data.tasks"
              onChange={(e) => setItemsPath(e.target.value)}
            />
          </>
        )}
        {error && <p className="chat-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Add source
          </button>
        </div>
      </form>
    </section>
  );
}
