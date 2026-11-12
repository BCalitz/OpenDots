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
