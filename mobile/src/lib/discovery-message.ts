// mobile/src/lib has a copy; tests/thread-events.test.ts fails if the two
// drift apart.
import type { Message } from '@ag-ui/core';

// Message IDs survive history replay even when metadata does not.
export const discoveryMessagePrefix = 'opendots:discovery:';

/** The message that starts a discovery investigation. */
export function isDiscoveryMessage(
  message: Pick<Message, 'id' | 'role' | 'metadata'>,
): boolean {
  if (message.role !== 'user') return false;
  if (message.id.startsWith(discoveryMessagePrefix)) return true;
  const metadata = message.metadata;
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    'opendotsSource' in metadata &&
    metadata.opendotsSource === 'discovery'
  );
}

/** One quoted inbox item, as `investigationMessage` writes it. */
export interface QuotedItem {
  id?: string;
  app?: string;
  from: string | null;
  title: string;
  received: string;
  link: string | null;
  text: string;
  mentions?: Record<string, string[]>;
  /** Why an earlier item was included, for history entries. */
  why?: string;
  matched_by?: string[];
}
export interface ParsedDiscoveryMessage {
  /** The first line: what discovery flagged and why. */
  headline: string;
  item: QuotedItem;
  /** The earlier item this one is about, when there is one. */
  earlier?: QuotedItem;
  /** Earlier items that may help, with why each was included. */
  history: QuotedItem[];
  injection: boolean;
  /** What the Dot was asked to do. */
  ask: string;
}

const isItem = (value: unknown): value is QuotedItem =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as QuotedItem).title === 'string' &&
  typeof (value as QuotedItem).text === 'string';

/**
 * Reads back the parts of a discovery message for display, or null when it
 * does not have the expected shape (older messages render as text).
 */
export function parseDiscoveryMessage(
  content: string,
): ParsedDiscoveryMessage | null {
  const blocks = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)];
  if (!blocks.length) return null;
  const parse = (index: number): unknown => {
    try {
      return JSON.parse(blocks[index][1]);
    } catch {
      return undefined;
    }
  };
  const labelBefore = (index: number) => {
    const start = index
      ? blocks[index - 1].index! + blocks[index - 1][0].length
      : 0;
    const lines = content.slice(start, blocks[index].index).trim().split('\n');
    return lines[lines.length - 1] ?? '';
  };
  const item = parse(0);
  if (!isItem(item)) return null;
  let earlier: QuotedItem | undefined;
  let history: QuotedItem[] = [];
  for (let index = 1; index < blocks.length; index++) {
    const value = parse(index);
    const label = labelBefore(index);
    if (Array.isArray(value) && /earlier items/i.test(label))
      history = value.filter(isItem);
    else if (isItem(value) && /earlier item/i.test(label)) earlier = value;
  }
  const last = blocks[blocks.length - 1];
  const ask = content
    .slice(last.index! + last[0].length)
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('Warning:') &&
        !/search_inbox|read_inbox_item/.test(line),
    )
    .join(' ');
  return {
    headline: content.slice(0, blocks[0].index).trim().split('\n')[0] ?? '',
    item,
    earlier,
    history,
    injection: /\nWarning: this item reads as trying to instruct/.test(content),
    ask,
  };
}

/** A link from the inbox, as GET /api/inbox/events/:id returns it. */
export interface ItemLink {
  otherEventId: string;
  score: number;
  status: 'linked' | 'review' | 'confirmed' | 'rejected';
  other: { title: string; from: string | null; occurredAt: number } | null;
}
/** An earlier item shown under the card, with why it is related. */
export interface RelatedItem {
  key: string;
  id?: string;
  title: string;
  from: string | null;
  at: string | number;
  why: string;
  /** Quoted in the message; otherwise load it by id. */
  text?: string;
  link?: string | null;
}
export interface DiscoveryCardModel {
  followUp: boolean;
  /** Short facts: kind, urgency, confidence. */
  facts: string[];
  reason: string;
  sender: string;
  address: string | null;
  tags: { kind: string; value: string }[];
  related: RelatedItem[];
}

const URGENCY: Record<string, string> = {
  days: 'can wait days',
  tomorrow: 'by tomorrow',
  today: 'today',
  hours: 'within hours',
};
const sentence = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

/** "Sarah Jacobs <sarah@x.co>" → "Sarah Jacobs". */
export function senderName(from: string | null | undefined) {
  if (!from) return 'Unknown sender';
  return from.replace(/\s*<[^>]*>\s*$/, '').trim() || from;
}
/** "3 h ago", "12 d ago", or a date. */
export function timeAgo(value: string | number, now = Date.now()) {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}
/** "both mention ticket X" and "same sender…" → "shares X · same sender
 * recently", after Jev's note. */
function historyWhy(entry: QuotedItem) {
  const shared: string[] = [];
  let sameSender = false;
  for (const match of entry.matched_by ?? []) {
    const mention = /^both mention \S+ (.+)$/.exec(match);
    if (mention) shared.push(mention[1]);
    else if (/same sender/.test(match)) sameSender = true;
    else shared.push(match);
  }
  const more = shared.length > 4 ? ` and ${shared.length - 4} more` : '';
  return [
    entry.why && sentence(entry.why),
    shared.length && `shares ${shared.slice(0, 4).join(', ')}${more}`,
    sameSender && 'same sender recently',
  ]
    .filter(Boolean)
    .join(' · ');
}
function linkWhy(link: ItemLink) {
  const percent = Math.round(link.score * 100);
  return link.status === 'confirmed'
    ? 'You confirmed this is the same thing'
    : link.status === 'review'
      ? `Possibly the same thing (${percent}%), waiting for your review`
      : `Same thing (${percent}% sure)`;
}

/** What the web and mobile cards show, from the message and its links. */
export function discoveryCardModel(
  parsed: ParsedDiscoveryMessage,
  links: ItemLink[] = [],
): DiscoveryCardModel {
  const { item, earlier, history } = parsed;
  const related: RelatedItem[] = [];
  const seen = new Set<string>();
  const add = (entry: RelatedItem) => {
    const key = entry.id ?? entry.key;
    if (seen.has(key)) return;
    seen.add(key);
    related.push(entry);
  };
  const quoted = (entry: QuotedItem, key: string, why: string) =>
    add({
      key,
      id: entry.id,
      title: entry.title,
      from: entry.from,
      at: entry.received,
      why,
      text: entry.text,
      link: entry.link,
    });
  if (earlier) quoted(earlier, 'earlier', 'This item follows up on it');
  history.forEach((entry, index) =>
    quoted(entry, `history-${index}`, historyWhy(entry)),
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
  // 97% sure): someone asking…" → the facts and the reason.
  const match = /\(([^)]*)\):\s*(.*)$/.exec(parsed.headline);
  const facts = (match?.[1].split(', ').filter(Boolean) ?? []).map((fact) =>
    fact.startsWith('urgency: ')
      ? (URGENCY[fact.slice(9)] ?? fact.slice(9))
      : fact,
  );
  return {
    followUp: parsed.headline.startsWith('A follow-up'),
    facts: item.app ? [item.app, ...facts] : facts,
    reason: sentence(match?.[2] ?? parsed.headline),
    sender: senderName(item.from),
    address: /<([^>]+)>/.exec(item.from ?? '')?.[1] ?? null,
    tags: Object.entries(item.mentions ?? {}).flatMap(([kind, values]) =>
      values.map((value) => ({ kind, value })),
    ),
    related,
  };
}
