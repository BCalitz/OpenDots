import {
  DISCOVERY_APPS,
  type AccountSourceConfig,
  type SourceKind,
} from '../../shared/inbox-types.js';
import type { ConnectorService } from '../connectors/service.js';
import {
  defaultEventKind,
  normalizePriority,
  parseTime,
  type InboxEvent,
  type Source,
} from './source.js';

/** How far back the first check of a new source looks. */
const FIRST_LOOKBACK_MS = 24 * 3_600_000;
const MAX_ITEMS = 25;

type Item = Record<string, unknown>;
/** Runs one read-only tool of the account and returns what it said. */
type Read = (tool: string, args: Item) => Promise<unknown>;
type Reader = (
  read: Read,
  since: Date,
  source: { id: string; kind: SourceKind },
) => Promise<InboxEvent[]>;

const isItem = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const items = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter(isItem) : [];
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const httpUrl = (value: unknown) => {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
};
/** Plain text from an HTML body, for previews only. */
export function plainText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const gmail: Reader = async (read, since, source) =>
  items(
    await read('search_messages', {
      // Gmail's after: takes seconds since the epoch.
      query: `in:inbox after:${Math.floor(since.getTime() / 1000)}`,
      limit: MAX_ITEMS,
    }),
  ).flatMap((item): InboxEvent[] => {
    const id = text(item.id);
    if (!id) return [];
    const thread = text(item.threadId) ?? id;
    return [
      {
        sourceId: source.id,
        externalId: id,
        kind: defaultEventKind[source.kind],
        title: text(item.subject) ?? '(no subject)',
        summary: plainText(text(item.snippet) ?? '').slice(0, 2000),
        priority: item.important === true ? 'high' : 'normal',
        from: text(item.from),
        url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(thread)}`,
        raw: item,
        occurredAt: parseTime(item.at) ?? parseTime(item.date) ?? Date.now(),
      },
    ];
  });

const outlook: Reader = async (read, since, source) =>
  items(await read('search_messages', { query: '', limit: MAX_ITEMS })).flatMap(
    (item): InboxEvent[] => {
      const id = text(item.id);
      const occurredAt = parseTime(item.received);
      // The newest messages come back whatever their age.
      if (!id || (occurredAt && occurredAt <= since.getTime())) return [];
      return [
        {
          sourceId: source.id,
          externalId: id,
          kind: defaultEventKind[source.kind],
          title: text(item.subject) ?? '(no subject)',
          summary: plainText(text(item.snippet) ?? '').slice(0, 2000),
          priority: normalizePriority(item.importance),
          from: text(item.from),
          url: httpUrl(item.link),
          raw: item,
          occurredAt: occurredAt ?? Date.now(),
        },
      ];
    },
  );

/**
 * Teams has no "all my messages" call: list recent chats, then read the
 * newest messages of each chat that changed since the last check.
 */
const teams: Reader = async (read, since, source) => {
  const chats = items(await read('list_chats', { limit: 20 }))
    .filter((chat) => (parseTime(chat.updated) ?? Infinity) > since.getTime())
    .slice(0, 8);
  const events: InboxEvent[] = [];
  for (const chat of chats) {
    const chatId = text(chat.id);
    if (!chatId) continue;
    for (const item of items(
      await read('list_chat_messages', { chatId, limit: 10 }),
    )) {
      const id = text(item.id);
      const occurredAt = parseTime(item.at);
      const body = text(item.text);
      if (!id || !body || !occurredAt || occurredAt <= since.getTime())
        continue;
      const from = text(item.from);
      events.push({
        sourceId: source.id,
        externalId: `${chatId}:${id}`,
        kind: defaultEventKind[source.kind],
        title: `${from ?? 'Someone'}${text(chat.topic) ? ` in ${text(chat.topic)}` : ''}: ${body.replace(/\s+/g, ' ').slice(0, 80)}`,
        summary: body.slice(0, 2000),
        from,
        raw: { chat: { id: chatId, topic: chat.topic ?? null }, message: item },
        occurredAt,
      });
    }
  }
  return events;
};

const READERS: Record<string, Reader> = { gmail, outlook, teams };

/**
 * Discovery's source: new mail or messages on one connected account, read
 * on a timer with that account's read-only tools. Each item becomes an inbox
 * event that the discovery model then judges.
 */
export class AccountListSource implements Source {
  readonly kind: SourceKind;
  constructor(
    readonly id: string,
    private config: AccountSourceConfig,
    private connectors: ConnectorService,
  ) {
    const app = DISCOVERY_APPS[config.app];
    if (!app || !READERS[config.app])
      throw new Error(`Discovery cannot read ${config.app} yet.`);
    this.kind = app.kind;
  }
  async poll(since: Date | null, signal: AbortSignal) {
    const from = since ?? new Date(Date.now() - FIRST_LOOKBACK_MS);
    const events = await READERS[this.config.app](
      (tool, args) =>
        this.connectors.read(
          this.config.userId,
          this.config.accountId,
          tool,
          args,
          signal,
        ),
      from,
      { id: this.id, kind: this.kind },
    );
    return events.slice(0, MAX_ITEMS * 2);
  }
}
