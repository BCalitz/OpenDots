import { useState } from 'react';
import { Check, PlugZap } from 'lucide-react';
import type { ApprovalView, DecideOptions } from '../shared/approvals';
import { ALLOW_CONFIRMATION } from '../shared/connection-types';
import { computerToolResult } from './ComputerToolCard';

const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

interface ActionPayload {
  connection?: string;
  title?: string;
  description?: string;
  arguments?: Record<string, unknown>;
  rule?: { risky?: boolean };
}

/**
 * A connected-service action waiting for the owner. It shows the server's
 * record of exactly what will run; approving lets the waiting tool run it
 * once on the server.
 */
export function ConnectionActionCard({
  args,
  result,
  approval,
  running,
  onDecide,
}: {
  args: unknown;
  result?: unknown;
  approval?: ApprovalView;
  running: boolean;
  onDecide: (
    approvalId: string,
    approved: boolean,
    options?: DecideOptions,
  ) => Promise<unknown>;
}) {
  const payload = (approval?.payload ?? {}) as ActionPayload;
  const outcome = result === undefined ? undefined : computerToolResult(result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [always, setAlways] = useState(false);
  const [typed, setTyped] = useState('');
  const waiting =
    !outcome && approval?.status === 'pending' && running && !!approval;
  const approved = outcome?.approved === true;
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';
  const failed = approved && outcome?.isError === true;
  // Threads from before server approvals passed a summary to a client tool.
  const legacy = computerToolResult(args);
  const summary =
    payload.description ??
    (typeof legacy.summary === 'string' ? legacy.summary : '');
  const entries = Object.entries(payload.arguments ?? {});
  const risky = payload.rule?.risky === true;
  const canAlways = !!payload.rule;
  const decide = async (approve: boolean, remember = false) => {
    if (!approval || busy) return;
    setBusy(true);
    setError('');
    try {
      if (approve && remember)
        await onDecide(approval.id, true, {
          always: true,
          ...(risky ? { confirm: typed } : {}),
        });
      else await onDecide(approval.id, approve);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not send your decision.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="page-review-card connection-action-card"
      aria-label="Approve connected-service action"
    >
      <header>
        <PlugZap size={17} />
        <strong>
          {payload.connection && payload.title
            ? `${payload.connection} · ${payload.title}`
            : 'Connected service'}
        </strong>
        <span>
          {failed
            ? 'Failed'
            : approved
              ? 'Approved'
              : declined
                ? 'Declined'
                : waiting
                  ? 'Needs your approval'
                  : outcome || !running
                    ? 'Ended'
                    : 'Preparing'}
        </span>
      </header>
      <div className="page-review-body">
        {summary && <h3>{summary}</h3>}
        {entries.length > 0 && (
          <dl className="connection-action-args">
            {entries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{display(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {approved && typeof outcome?.text === 'string' && (
          <div className={`connection-action-result ${failed ? 'failed' : ''}`}>
            <strong>{failed ? 'Service error' : 'Service response'}</strong>
            <pre>{outcome.text}</pre>
          </div>
        )}
        {typeof outcome?.error === 'string' && (
          <div className="connection-action-result failed">
            <strong>Cannot run</strong>
            <pre>{outcome.error}</pre>
          </div>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {waiting && always && (
        <div className="connection-always">
          <p>
            Run this and stop asking about <strong>{payload.title}</strong> from{' '}
            {payload.connection}. You can change it later under Rules.
          </p>
          {risky && (
            <label>
              This can send, pay or delete. Type “{ALLOW_CONFIRMATION}” to
              confirm:
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <button
            type="button"
            className="review-primary"
            disabled={
              busy ||
              (risky && typed.trim().toLowerCase() !== ALLOW_CONFIRMATION)
            }
            onClick={() => void decide(true, true)}
          >
            Approve & always allow
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setAlways(false)}
          >
            Cancel
          </button>
        </div>
      )}
      <footer>
        {waiting && (
          <>
            <button
              type="button"
              className="review-primary"
              disabled={busy}
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy ? 'Running…' : 'Approve & run'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
            {canAlways && !always && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setAlways(true)}
              >
                Always allow…
              </button>
            )}
          </>
        )}
        <small>
          {waiting
            ? 'Nothing runs until you approve. These are the exact arguments.'
            : !outcome && !approved && !declined && !running
              ? 'Nothing ran.'
              : ''}
        </small>
      </footer>
    </section>
  );
}
