import { useState } from 'react';
import { Check, FileText, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { pageReviewSchema } from '../shared/page-review';
import type { ApprovalView } from '../shared/approvals';
import { openPageLink } from './page-navigation';
import { computerToolResult } from './ComputerToolCard';

/**
 * A page draft the Dot wants to save. The draft shown is the server's copy
 * from the approval request; nothing is saved until the owner approves, and
 * the server saves it, not this card.
 */
export function PageReviewCard({
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
  onDecide: (approvalId: string, approved: boolean) => Promise<unknown>;
}) {
  const draft = pageReviewSchema.safeParse(approval?.payload ?? args);
  const outcome = result === undefined ? undefined : computerToolResult(result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saved = outcome?.approved === true;
  const pageId = typeof outcome?.pageId === 'string' ? outcome.pageId : '';
  const spaceId = typeof outcome?.spaceId === 'string' ? outcome.spaceId : '';
  const waiting =
    !outcome && approval?.status === 'pending' && running && !!approval;
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';
  const decide = async (approved: boolean) => {
    if (!approval || busy) return;
    setBusy(true);
    setError('');
    try {
      await onDecide(approval.id, approved);
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
  const title = saved
    ? 'Saved to your Space'
    : waiting
      ? 'Ready for your review'
      : declined
        ? 'Declined'
        : outcome || !running
          ? 'Review ended'
          : 'Preparing your draft…';
  return (
    <section className="page-review-card" aria-label="Review page draft">
      <header>
        <FileText size={17} />
        <strong>{title}</strong>
        <span>
          {saved
            ? 'Approved'
            : waiting
              ? 'You decide'
              : declined
                ? 'Not saved'
                : outcome || !running
                  ? 'Not saved'
                  : 'Drafting'}
        </span>
      </header>
      <div className="page-review-body">
        <h3>{draft.success ? draft.data.title : 'Preparing your draft…'}</h3>
        {draft.success && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {draft.data.content}
          </ReactMarkdown>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!saved && typeof outcome?.error === 'string' && (
        <p role="alert">{outcome.error}</p>
      )}
      <footer>
        {saved && pageId && spaceId && (
          <button
            type="button"
            className="review-primary"
            onClick={() =>
              openPageLink(
                `/#/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`,
              )
            }
          >
            Open page <ArrowUpRight size={15} />
          </button>
        )}
        {waiting && (
          <>
            <button
              type="button"
              disabled={busy || !draft.success}
              className="review-primary"
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy ? 'Saving…' : 'Approve & save'}
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
        {!saved && (
          <small>
            {waiting
              ? 'Nothing is saved until you approve.'
              : 'No page was saved.'}
          </small>
        )}
      </footer>
    </section>
  );
}
