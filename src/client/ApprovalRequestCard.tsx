import { useState } from 'react';
import { Check, ExternalLink, ShieldQuestion } from 'lucide-react';
import type { ApprovalView } from '../shared/approvals';
import {
  safeApprovalLink,
  type ApprovalRequest,
} from '../shared/approval-request';
import { computerToolResult } from './ComputerToolCard';

/**
 * A Dot asking "may I?" with request_approval. Shows the server's record of
 * what the Dot said it will do, and a link to what it concerns.
 */
export function ApprovalRequestCard({
  result,
  approval,
  running,
  onDecide,
}: {
  args?: unknown;
  result?: unknown;
  approval?: ApprovalView;
  running: boolean;
  onDecide: (approvalId: string, approved: boolean) => Promise<unknown>;
}) {
  const request = (approval?.payload ?? {}) as Partial<ApprovalRequest>;
  const outcome = result === undefined ? undefined : computerToolResult(result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const waiting = !outcome && approval?.status === 'pending' && running;
  const approved =
    outcome?.approved === true || approval?.status === 'approved';
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';
  const link =
    request.link && safeApprovalLink(request.link.url) ? request.link : null;
  const external = !!link && !link.url.startsWith('/#/');
  const decide = async (approve: boolean) => {
    if (!approval || busy) return;
    setBusy(true);
    setError('');
    try {
      await onDecide(approval.id, approve);
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
      className="page-review-card connection-action-card approval-request-card"
      aria-label="Approval request"
    >
      <header>
        <ShieldQuestion size={17} />
        <strong>{request.title ?? 'Approval request'}</strong>
        <span>
          {approved
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
        {request.description && (
          <p className="approval-request-text">{request.description}</p>
        )}
        {request.output && (
          <pre className="approval-request-output">{request.output}</pre>
        )}
        {link && (
          <a
            className="approval-request-link"
            href={link.url}
            {...(external
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
          >
            <ExternalLink size={13} aria-hidden="true" />
            {link.label ?? link.url}
          </a>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
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
              {busy ? 'Sending…' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
          </>
        )}
        <small>
          {waiting
            ? 'The Dot waits for your answer before going ahead.'
            : !approved && !declined && !running
              ? 'Nothing was approved.'
              : ''}
        </small>
      </footer>
    </section>
  );
}
