import { useCallback, useEffect, useState } from 'react';
import { Check, Newspaper, X } from 'lucide-react';
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
