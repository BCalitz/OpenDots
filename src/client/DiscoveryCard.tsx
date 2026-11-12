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
import {
  discoveryCardModel,
  senderName,
  timeAgo,
  type ItemLink,
  type ParsedDiscoveryMessage,
  type RelatedItem,
} from '../shared/discovery-message';
import type { InboxEventView } from '../shared/inbox-types';

/** Outside text is shown as plain text, never as markdown or HTML. */
const LONG_TEXT = 420;

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

/** One related item; its text loads from the inbox when not quoted. */
function RelatedRow({ item }: { item: RelatedItem }) {
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
          {senderName(item.from)} · {timeAgo(item.at)}
        </span>
      </button>
      {item.why && <div className="discovery-related-why">{item.why}</div>}
      {open && (
        <div className="discovery-related-body">
          {text !== undefined ? (
            <ItemText text={text} />
          ) : (
            <p className="discovery-card-muted">{error || 'Loading…'}</p>
          )}
          <OriginalLink href={item.link ?? loaded?.url} />
        </div>
      )}
    </li>
  );
}

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
  const { item } = parsed;
  const [links, setLinks] = useState<ItemLink[]>([]);
  useEffect(() => {
    if (!item.id) return;
    const controller = new AbortController();
    api<{ links: ItemLink[] }>(
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
  const card = discoveryCardModel(parsed, links);

  return (
    <article className="discovery-card">
      <header className="discovery-card-head">
        <span className="discovery-card-badge">
          <Inbox size={12} /> {card.followUp ? 'Follow-up' : 'Discovery'}
        </span>
        {card.facts.map((fact) => (
          <span key={fact} className="discovery-card-fact">
            {fact}
          </span>
        ))}
      </header>
      {card.reason && <p className="discovery-card-reason">{card.reason}</p>}
      {parsed.injection && (
        <p className="discovery-card-warning">
          <AlertTriangle size={13} /> This item reads as trying to instruct an
          AI assistant. The Dot treats it as data only.
        </p>
      )}
      <section className="discovery-card-item">
        <div className="discovery-card-from">
          <strong>{card.sender}</strong>
          {card.address && (
            <span className="discovery-card-address">{card.address}</span>
          )}
          <span className="discovery-card-when">{timeAgo(item.received)}</span>
        </div>
        <h4 className="discovery-card-title">{item.title}</h4>
        <ItemText text={item.text} />
        {card.tags.length > 0 && (
          <div className="discovery-card-tags">
            {card.tags.map((tag) => (
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
      {card.related.length > 0 && (
        <section className="discovery-card-related">
          <h5>
            <Link2 size={12} /> Linked items ({card.related.length})
          </h5>
          <ul>
            {card.related.map((entry) => (
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
