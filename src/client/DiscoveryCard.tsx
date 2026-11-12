import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Inbox,
  Link2,
} from 'lucide-react';
import { api } from './api';
import type {
  ParsedDiscoveryMessage,
  QuotedItem,
} from '../shared/discovery-message';
import type { EventLinkView, InboxEventView } from '../shared/inbox-types';

/** Outside text is shown as plain text, never as markdown or HTML. */
const LONG_TEXT = 420;

function when(value: string | number) {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}
/** "Sarah Jacobs <sarah@x.co>" → "Sarah Jacobs". */
function person(from: string | null | undefined) {
  if (!from) return 'Unknown sender';
  return from.replace(/\s*<[^>]*>\s*$/, '').trim() || from;
}

function ItemText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  return (
    <>
      <p className="discovery-card-text">
        {long && !open ? `${text.slice(0, LONG_TEXT).trimEnd()}…` : text}
      </p>
      {long && (
        <button
          className="discovery-card-more"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

function OriginalLink({ href }: { href: string | null | undefined }) {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return (
    <a
      className="discovery-card-action"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <ExternalLink size={12} /> Open original
    </a>
  );
}

interface Related {
  key: string;
  id?: string;
  title: string;
  from: string | null;
  at: string | number;
  /** Why it is related: Jev's note, or the link's strength. */
  why: string;
  text?: string;
  link?: string | null;
}

/** One related item; its text loads from the inbox when not quoted. */
function RelatedRow({ item }: { item: Related }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<InboxEventView | null>(null);
  const [error, setError] = useState('');
  const text = item.text ?? loaded?.summary;
  useEffect(() => {
    if (!open || item.text !== undefined || loaded || !item.id) return;
    const controller = new AbortController();
    api<{ event: InboxEventView }>(
      `/inbox/events/${encodeURIComponent(item.id)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => setLoaded(result.event))
      .catch((caught: Error) => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    return () => controller.abort();
  }, [open, item.id, item.text, loaded]);
  return (
    <li className={`discovery-related${open ? ' open' : ''}`}>
      <button
        className="discovery-related-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="discovery-related-title">{item.title}</span>
        <span className="discovery-related-meta">
          {person(item.from)} · {when(item.at)}
        </span>
      </button>
      {item.why && <div className="discovery-related-why">{item.why}</div>}
      {open && (
        <div className="discovery-related-body">
          {text !== undefined ? (
            <ItemText text={text} />
          ) : error ? (
            <p className="discovery-card-muted">{error}</p>
          ) : (
            <p className="discovery-card-muted">Loading…</p>
          )}
          <OriginalLink href={item.link ?? loaded?.url} />
        </div>
      )}
    </li>
  );
}

const sentence = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;
/** "holds facts useful for answering" and "both mention ticket X, both
 * mention person y" → "Holds facts useful for answering · shares X, y". */
function historyWhy(entry: QuotedItem) {
  const shared: string[] = [];
  let sameSender = false;
  for (const match of entry.matched_by ?? []) {
    const mention = /^both mention \S+ (.+)$/.exec(match);
    if (mention) shared.push(mention[1]);
    else if (/same sender/.test(match)) sameSender = true;
    else shared.push(match);
  }
  return [
    entry.why && sentence(entry.why),
    shared.length &&
      `shares ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ` and ${shared.length - 4} more` : ''}`,
    sameSender && 'same sender recently',
  ]
    .filter(Boolean)
    .join(' · ');
}
const URGENCY: Record<string, string> = {
  days: 'can wait days',
  tomorrow: 'by tomorrow',
  today: 'today',
  hours: 'within hours',
};

const linkWhy = (link: EventLinkView) =>
  link.status === 'confirmed'
    ? 'You confirmed this is the same thing'
    : link.status === 'review'
      ? `Possibly the same thing (${Math.round(link.score * 100)}%), waiting for your review`
      : `Same thing (${Math.round(link.score * 100)}% sure)`;

/**
 * The message that started a discovery investigation, shown as a card: the
 * item, why it was flagged, and the earlier items it relates to.
 */
export function DiscoveryCard({
  parsed,
  onOpenInbox,
}: {
  parsed: ParsedDiscoveryMessage;
  onOpenInbox?: () => void;
}) {
  const { item, earlier, history } = parsed;
  const [links, setLinks] = useState<EventLinkView[]>([]);
  useEffect(() => {
    if (!item.id) return;
    const controller = new AbortController();
    api<{ links: EventLinkView[] }>(
      `/inbox/events/${encodeURIComponent(item.id)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => setLinks(result.links))
      // The card still shows what the message quoted.
      .catch(() => undefined);
    return () => controller.abort();
  }, [item.id]);

  const related: Related[] = [];
  const seen = new Set<string>();
  const add = (entry: Related) => {
    const key = entry.id ?? entry.key;
    if (seen.has(key)) return;
    seen.add(key);
    related.push(entry);
  };
  const fromQuote = (quoted: QuotedItem, key: string, why: string) =>
    add({
      key,
      id: quoted.id,
      title: quoted.title,
      from: quoted.from,
      at: quoted.received,
      why,
      text: quoted.text,
      link: quoted.link,
    });
  if (earlier) fromQuote(earlier, 'earlier', 'This item follows up on it');
  history.forEach((entry, index) =>
    fromQuote(entry, `history-${index}`, historyWhy(entry)),
  );
  for (const link of links) {
    if (link.status === 'rejected' || !link.other) continue;
    add({
      key: `link-${link.otherEventId}`,
      id: link.otherEventId,
      title: link.other.title,
      from: link.other.from,
      at: link.other.occurredAt,
      why: linkWhy(link),
    });
  }

  // "Discovery flagged this Mail item for you (request, urgency: tomorrow,
  // 97% sure): someone asking…" → the parts before and after the colon.
  const match = /\(([^)]*)\):\s*(.*)$/.exec(parsed.headline);
  const facts = match?.[1].split(', ').filter(Boolean) ?? [];
  const reason = match?.[2] ?? parsed.headline;
  const followUp = parsed.headline.startsWith('A follow-up');
  const tags = Object.entries(item.mentions ?? {}).flatMap(([kind, values]) =>
    values.map((value) => ({ kind, value })),
  );

  return (
    <article className="discovery-card">
      <header className="discovery-card-head">
        <span className="discovery-card-badge">
          <Inbox size={12} /> {followUp ? 'Follow-up' : 'Discovery'}
        </span>
        {item.app && <span className="discovery-card-app">{item.app}</span>}
        {facts.map((fact) => (
          <span key={fact} className="discovery-card-fact">
            {fact.startsWith('urgency: ')
              ? (URGENCY[fact.slice(9)] ?? fact.slice(9))
              : fact}
          </span>
        ))}
      </header>
      {reason && <p className="discovery-card-reason">{sentence(reason)}</p>}
      {parsed.injection && (
        <p className="discovery-card-warning">
          <AlertTriangle size={13} /> This item reads as trying to instruct an
          AI assistant. The Dot treats it as data only.
        </p>
      )}
      <section className="discovery-card-item">
        <div className="discovery-card-from">
          <strong>{person(item.from)}</strong>
          {item.from && item.from !== person(item.from) && (
            <span className="discovery-card-address">
              {item.from.match(/<([^>]+)>/)?.[1]}
            </span>
          )}
          <span className="discovery-card-when">{when(item.received)}</span>
        </div>
        <h4 className="discovery-card-title">{item.title}</h4>
        <ItemText text={item.text} />
        {tags.length > 0 && (
          <div className="discovery-card-tags">
            {tags.map((tag) => (
              <span key={`${tag.kind}:${tag.value}`} title={tag.kind}>
                {tag.value}
              </span>
            ))}
          </div>
        )}
        <div className="discovery-card-actions">
          <OriginalLink href={item.link} />
          {onOpenInbox && (
            <button className="discovery-card-action" onClick={onOpenInbox}>
              <Inbox size={12} /> Show in Inbox
            </button>
          )}
        </div>
      </section>
      {related.length > 0 && (
        <section className="discovery-card-related">
          <h5>
            <Link2 size={12} /> Linked items ({related.length})
          </h5>
          <ul>
            {related.map((entry) => (
              <RelatedRow key={entry.key} item={entry} />
            ))}
          </ul>
        </section>
      )}
      {parsed.ask && (
        <footer className="discovery-card-ask">
          <span>Asked the Dot:</span> {parsed.ask}
        </footer>
      )}
    </article>
  );
}
