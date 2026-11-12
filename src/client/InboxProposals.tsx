import { useCallback, useEffect, useState } from 'react';
import {
  BellOff,
  Clock,
  Hand,
  Inbox,
  MessageSquare,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ProposalState,
  ProposalView,
  TriageRuleView,
} from '../shared/inbox-types';
import { api } from './api';
import { routeText, urgencyText } from './InboxBrief';
import { relative } from './TaskPresentation';

const stateText: Record<ProposalState, string> = {
  open: 'Waiting for you',
  preparing: 'Preparing…',
  prepared: 'Prepared',
  handling: 'Handling…',
  handled: 'Handled',
  snoozed: 'Snoozed',
  dismissed: 'Dismissed',
  failed: 'Could not finish',
  closed: 'No longer needed',
};
type Choice = 'prepare' | 'handle' | 'snooze' | 'dismiss';

function ProposalCard({
  proposal,
  onThread,
  onDecide,
}: {
  proposal: ProposalView;
  onThread: (threadId: string) => void;
  onDecide: (choice: Choice, until?: 'later' | 'tomorrow') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [notNow, setNotNow] = useState(false);
  const choose = async (choice: Choice, until?: 'later' | 'tomorrow') => {
    setBusy(true);
    try {
      await onDecide(choice, until);
      setNotNow(false);
    } finally {
      setBusy(false);
    }
  };
  const running =
    proposal.state === 'preparing' || proposal.state === 'handling';
  const canChoose = ['open', 'prepared', 'failed', 'snoozed'].includes(
    proposal.state,
  );
  const canPrepare =
    proposal.options.includes('prepare') && proposal.state !== 'prepared';
  const canHandle = proposal.options.includes('handle');
  return (
    <li className={`inbox-event proposal-card ${proposal.state}`}>
      <div>
        <strong>{proposal.title}</strong>
        <span>
          {stateText[proposal.state]}
          {proposal.state === 'snoozed' && proposal.snoozeUntil
            ? ` until ${new Date(proposal.snoozeUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
            : ''}
          {proposal.urgency ? ` · ${urgencyText[proposal.urgency]}` : ''}
          {proposal.route ? ` · ${routeText[proposal.route]}` : ''}
          {proposal.sender ? ` · from ${proposal.sender}` : ''} ·{' '}
          {relative(proposal.updatedAt)}
        </span>
        <p className="proposal-summary">{proposal.summary}</p>
        {proposal.state === 'failed' && proposal.error && (
          <p className="discovery-warning">{proposal.error}</p>
        )}
        {canChoose && (
          <div className="proposal-choices">
            {canPrepare && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void choose('prepare')}
                title="Research it, write a plan page and draft replies. Nothing leaves OpenDots."
              >
                <Wand2 size={14} />
                Prepare it for me
              </button>
            )}
            {canHandle && (
              <button
                className={canPrepare ? '' : 'primary'}
                disabled={busy}
                onClick={() => void choose('handle')}
                title="Carry out the plan. Each change asks for your approval first."
              >
                <Hand size={14} />
                Handle it
              </button>
            )}
            {notNow ? (
              <span className="proposal-not-now">
                <button
                  disabled={busy}
                  onClick={() => void choose('snooze', 'later')}
                >
                  <Clock size={14} />3 hours
                </button>
                <button
                  disabled={busy}
                  onClick={() => void choose('snooze', 'tomorrow')}
                >
                  <Clock size={14} />
                  Tomorrow morning
                </button>
                <button
                  disabled={busy}
                  onClick={() => void choose('dismiss')}
                  title="Dismiss it. Dismissing a sender’s items twice stops them being flagged."
                >
                  <X size={14} />
                  Dismiss
                </button>
              </span>
            ) : (
              <button disabled={busy} onClick={() => setNotNow(true)}>
                Not now
              </button>
            )}
          </div>
        )}
        {running && (
          <p className="muted">
            {proposal.state === 'preparing'
              ? 'Working read-only; nothing leaves OpenDots.'
              : 'Each change asks for your approval in the conversation.'}
          </p>
        )}
      </div>
      <div className="inbox-event-actions">
        <button
          className="text-button"
          onClick={() => onThread(proposal.threadId)}
          title="Ask follow-up questions before deciding"
        >
          <MessageSquare size={14} />
          Conversation
        </button>
      </div>
    </li>
  );
}

/**
 * Proposals, most important first: what a Dot looked into, with the three
 * choices. Senders quieted by dismissals are listed below, to undo.
 */
export function InboxProposals({
  onThread,
}: {
  onThread: (threadId: string) => void;
}) {
  const [proposals, setProposals] = useState<ProposalView[]>();
  const [rules, setRules] = useState<TriageRuleView[]>([]);
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      Promise.all([
        api<ProposalView[]>(`/proposals${all ? '?all=1' : ''}`),
        api<TriageRuleView[]>('/discovery/rules'),
      ])
        .then(([list, quiet]) => {
          setProposals(list);
          setRules(quiet);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [all],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const decide =
    (proposal: ProposalView) =>
    async (choice: Choice, until?: 'later' | 'tomorrow') => {
      try {
        await api(`/proposals/${proposal.id}/decide`, 'POST', {
          choice,
          ...(until ? { until } : {}),
        });
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      await load();
    };
  const forget = async (sender: string) => {
    try {
      await api(`/discovery/rules/${encodeURIComponent(sender)}`, 'DELETE');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  };
  if (!proposals && !error) return <p className="muted">Loading…</p>;
  const waiting = (proposals ?? []).filter((p) => p.state !== 'snoozed');
  const snoozed = (proposals ?? []).filter((p) => p.state === 'snoozed');
  return (
    <section className="inbox-proposals">
      {error && <p className="chat-error">{error}</p>}
      <div className="insight-toolbar">
        <h2 className="insight-subhead">Needs your choice</h2>
        <label className="permission-row inline">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          <span>Show decided</span>
        </label>
      </div>
      {waiting.length ? (
        <ul className="inbox-events">
          {waiting.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onThread={onThread}
              onDecide={decide(proposal)}
            />
          ))}
        </ul>
      ) : (
        <div className="large-empty small">
          <Inbox size={28} />
          <p>
            Nothing waiting. When a Dot has looked into something that needs
            you, it lands here with three choices: prepare it, handle it, or not
            now.
          </p>
        </div>
      )}
      {!!snoozed.length && (
        <>
          <h2 className="insight-subhead">Snoozed</h2>
          <ul className="inbox-events">
            {snoozed.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                onThread={onThread}
                onDecide={decide(proposal)}
              />
            ))}
          </ul>
        </>
      )}
      {!!rules.length && (
        <>
          <h2 className="insight-subhead">Quieted senders</h2>
          <p className="muted">
            You dismissed these senders’ items, so new ones aren’t flagged
            unless they’re needed within hours.
          </p>
          <ul className="brief-links">
            {rules.map((rule) => (
              <li key={rule.sender}>
                <BellOff size={14} aria-hidden />
                <span>
                  {rule.sender}{' '}
                  <span className="muted">
                    · {rule.dismissed} dismissed · last{' '}
                    {relative(rule.lastDismissedAt)}
                  </span>
                </span>
                <button
                  className="text-button"
                  onClick={() => void forget(rule.sender)}
                >
                  Flag again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
