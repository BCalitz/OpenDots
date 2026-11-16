import { useCallback, useEffect, useState } from 'react';
import { Check, Newspaper, X } from 'lucide-react';
import type { ApprovalView } from '../shared/approvals';
import type {
  BriefEntry,
  Delivery,
  EventLinkView,
  Route,
  Urgency,
} from '../shared/inbox-types';
import { api } from './api';
import { relative } from './TaskPresentation';

export const urgencyText: Record<Urgency, string> = {
  days: 'Can wait days',
  tomorrow: 'By tomorrow',
  today: 'Today',
  hours: 'Within hours',
};
export const routeText: Record<Route, string> = {
  tell: 'For your information',
  draft: 'Drafting a reply',
  propose: 'Proposing an action',
  inform: 'Needs an action',
  decide: 'Your decision',
};
export const deliveryText: Record<Delivery, string> = {
  now: 'pushed now',
  held: 'pushed after a short hold',
  brief: 'in the morning brief',
  none: 'not pushed',
};
const sectionText: Record<BriefEntry['section'], string> = {
  decisions: 'Decisions',
  drafts: 'Drafts to approve',
  updates: 'Updates',
};
const linkText: Record<EventLinkView['status'], string> = {
  linked: 'Same thing',
  review: 'Possibly the same',
  confirmed: 'Confirmed',
  rejected: 'Not related',
};

interface BriefState {
  next: BriefEntry[];
  last: { sentAt: number; entries: BriefEntry[] } | null;
}

/** Confirm or reject a link; the owner's answer is kept for tuning. */
function LinkActions({
  link,
  onDone,
}: {
  link: EventLinkView;
  onDone: () => unknown;
}) {
  const decide = (status: 'confirmed' | 'rejected') =>
    void api('/discovery/links', 'POST', {
      eventId: link.eventId,
      otherEventId: link.otherEventId,
      status,
    }).then(onDone);
  if (link.status === 'confirmed' || link.status === 'rejected') return null;
  return (
    <span className="brief-link-actions">
      <button
        className="icon-button"
        aria-label={`Confirm the link to ${link.other?.title ?? 'this item'}`}
        title="Same thing"
        onClick={() => decide('confirmed')}
      >
        <Check size={14} />
      </button>
      <button
        className="icon-button"
        aria-label={`Reject the link to ${link.other?.title ?? 'this item'}`}
        title="Not related"
        onClick={() => decide('rejected')}
      >
        <X size={14} />
      </button>
    </span>
  );
}

/** Earlier items found to be about the same thing as one item. */
export function EventLinks({ eventId }: { eventId: string }) {
  const [links, setLinks] = useState<EventLinkView[]>();
  const load = useCallback(
    () =>
      api<EventLinkView[]>(`/inbox/events/${eventId}/links`)
        .then(setLinks)
        .catch(() => setLinks([])),
    [eventId],
  );
  useEffect(() => void load(), [load]);
  if (!links) return <p className="muted">Loading…</p>;
  if (!links.length)
    return <p className="muted">No other item found to be about this.</p>;
  return (
    <ul className="brief-links">
      {links.map((link) => (
        <li key={link.otherEventId}>
          <span className={`brief-link-status ${link.status}`}>
            {linkText[link.status]} · {Math.round(link.score * 100)}%
          </span>
          <span>
            {link.other?.title ?? '(no longer in the inbox)'}
            {link.other?.from ? ` · from ${link.other.from}` : ''}
          </span>
          <LinkActions link={link} onDone={load} />
        </li>
      ))}
    </ul>
  );
}

function Entries({
  entries,
  onThread,
}: {
  entries: BriefEntry[];
  onThread: (threadId: string) => void;
}) {
  return (
    <>
      {(Object.keys(sectionText) as BriefEntry['section'][]).map((section) => {
        const list = entries.filter((entry) => entry.section === section);
        if (!list.length) return null;
        return (
          <div key={section} className="brief-section">
            <h3>
              {sectionText[section]}{' '}
              <span className="muted">{list.length}</span>
            </h3>
            <ul>
              {list.map((entry, index) => (
                <li key={`${entry.findingId ?? 'x'}-${index}`}>
                  <div>
                    <strong>{entry.title}</strong>
                    <span className="muted">
                      {entry.body} · {relative(entry.createdAt)}
                    </span>
                  </div>
                  {entry.threadId && (
                    <button
                      className="text-button"
                      onClick={() => onThread(entry.threadId!)}
                    >
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** One line saying what a waiting request will do. */
function approvalText(approval: ApprovalView) {
  const payload = (approval.payload ?? {}) as {
    title?: string;
    connection?: string;
    description?: string;
  };
  const what =
    approval.kind === 'connection_action' && payload.connection
      ? `${payload.connection} · ${payload.title ?? 'action'}`
      : (payload.title ??
        (approval.kind === 'page_review' ? 'Save a page' : 'An action'));
  return { what, detail: payload.description ?? '' };
}

/**
 * Requests Dots are waiting on you for, with a way to answer several at once.
 * Each answer applies to exactly what its row says; open one to read the
 * full text first.
 */
function WaitingApprovals({
  onThread,
}: {
  onThread: (threadId: string) => void;
}) {
  const [waiting, setWaiting] = useState<ApprovalView[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<ApprovalView[]>('/chat/approvals')
        .then((list) => {
          setWaiting(list);
          setPicked((current) => {
            const ids = new Set(list.map((item) => item.id));
            return new Set([...current].filter((id) => ids.has(id)));
          });
        })
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  if (!waiting.length) return null;
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const answer = async (approved: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ decided: string[]; failed: unknown[] }>(
        '/chat/approvals',
        'POST',
        { ids: [...picked], approved },
      );
      setMessage(
        `${result.decided.length} ${approved ? 'approved' : 'declined'}` +
          (result.failed.length
            ? `, ${result.failed.length} no longer waiting`
            : ''),
      );
      setPicked(new Set());
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="brief-section waiting-approvals">
      <h3>
        Waiting for your approval{' '}
        <span className="muted">{waiting.length}</span>
      </h3>
      <ul>
        {waiting.map((approval) => {
          const { what, detail } = approvalText(approval);
          return (
            <li key={approval.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(approval.id)}
                  onChange={() => toggle(approval.id)}
                  aria-label={`Select ${what}`}
                />
                <span>
                  <strong>{what}</strong>
                  {detail && <span className="muted"> {detail}</span>}
                  <span className="muted">
                    {' '}
                    · {relative(approval.createdAt)}
                  </span>
                </span>
              </label>
              <button
                className="text-button"
                onClick={() => onThread(approval.threadId)}
              >
                Open
              </button>
            </li>
          );
        })}
      </ul>
      <div className="brief-bulk">
        <button
          type="button"
          className="review-primary"
          disabled={busy || !picked.size}
          onClick={() => void answer(true)}
        >
          Approve selected{picked.size ? ` (${picked.size})` : ''}
        </button>
        <button
          type="button"
          disabled={busy || !picked.size}
          onClick={() => void answer(false)}
        >
          Decline selected
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setPicked(
              picked.size === waiting.length
                ? new Set()
                : new Set(waiting.map((item) => item.id)),
            )
          }
        >
          {picked.size === waiting.length ? 'Clear' : 'Select all'}
        </button>
        {message && <small role="status">{message}</small>}
      </div>
    </div>
  );
}

/**
 * The morning brief: what waits for it and what the last one held, plus
 * links between items Jev wasn't sure of, for the owner to confirm or
 * reject.
 */
export function InboxBrief({
  onThread,
}: {
  onThread: (threadId: string) => void;
}) {
  const [brief, setBrief] = useState<BriefState>();
  const [review, setReview] = useState<EventLinkView[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      Promise.all([
        api<BriefState>('/discovery/brief'),
        api<EventLinkView[]>('/discovery/links/review'),
      ])
        .then(([value, links]) => {
          setBrief(value);
          setReview(links);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  if (error) return <p className="chat-error">{error}</p>;
  if (!brief) return <p className="muted">Loading the brief…</p>;
  return (
    <section className="inbox-brief">
      <WaitingApprovals onThread={onThread} />
      <h2 className="insight-subhead">Next brief</h2>
      {brief.next.length ? (
        <Entries entries={brief.next} onThread={onThread} />
      ) : (
        <div className="large-empty small">
          <Newspaper size={28} />
          <p>
            Nothing waiting. Items that can wait until tomorrow, and anything
            that arrives in quiet hours, gather here for the morning brief.
          </p>
        </div>
      )}
      {brief.last && (
        <>
          <h2 className="insight-subhead">
            Last brief{' '}
            <span className="muted">{relative(brief.last.sentAt)}</span>
          </h2>
          {brief.last.entries.length ? (
            <Entries entries={brief.last.entries} onThread={onThread} />
          ) : (
            <p className="muted">Everything in it has been handled.</p>
          )}
        </>
      )}
      <h2 className="insight-subhead">Links to review</h2>
      {review.length ? (
        <ul className="brief-links">
          {review.map((link) => (
            <li key={`${link.eventId}-${link.otherEventId}`}>
              <span className="brief-link-status review">
                {Math.round(link.score * 100)}%
              </span>
              <span>
                Are <strong>{link.item?.title ?? 'a later item'}</strong> and{' '}
                <strong>{link.other?.title ?? 'an earlier item'}</strong> about
                the same thing?
              </span>
              <LinkActions link={link} onDone={load} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No links to review. When Jev isn’t sure two items are about the same
          thing, they wait here for you.
        </p>
      )}
    </section>
  );
}
