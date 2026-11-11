import {
  DISCOVERY_TOOLKITS,
  type ComposioSourceConfig,
  type SourceKind,
} from '../../shared/inbox-types.js';
import {
  defaultEventKind,
  normalizePriority,
  parseTime,
  type InboxEvent,
  type Source,
} from './source.js';

/**
 * Runs one Composio tool on one connected account and returns its data.
 * The real one uses a read-only Tool Router session (see composio.ts).
 */
export type ComposioExecute = (
  call: {
    accountId: string;
    toolkit: string;
    tool: string;
    arguments: Record<string, unknown>;
  },
  signal: AbortSignal,
) => Promise<unknown>;

/** How far back the first check of a new source looks. */
const FIRST_LOOKBACK_MS = 24 * 3_600_000;
const MAX_ITEMS = 25;

type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : undefined;
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isItem(current)) return undefined;
    current = current[part];
  }
  return current;
}
/** Composio results sometimes arrive as JSON text, sometimes nested in data. */
function unwrap(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return unwrap(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
}
/** The first list found at one of `keys`, searching a few levels deep. */
function list(value: unknown, keys: string[], depth = 0): Item[] {
  const data = unwrap(value);
  if (Array.isArray(data)) return data.filter(isItem);
  if (!isItem(data) || depth > 3) return [];
  for (const key of keys)
    if (Array.isArray(data[key]))
      return (data[key] as unknown[]).filter(isItem);
  for (const key of ['data', 'response_data', 'result', 'results']) {
    const found = list(data[key], keys, depth + 1);
    if (found.length) return found;
  }
  return [];
}
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
const httpUrl = (value: unknown) => {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
};

/** Gmail through GMAIL_FETCH_EMAILS. */
async function gmail(
  run: (tool: string, args: Item) => Promise<unknown>,
  since: Date,
  source: { id: string; kind: SourceKind },
): Promise<InboxEvent[]> {
  const data = await run('GMAIL_FETCH_EMAILS', {
    // Gmail's after: takes seconds since the epoch.
    query: `in:inbox after:${Math.floor(since.getTime() / 1000)}`,
    max_results: MAX_ITEMS,
    verbose: true,
  });
  return list(data, ['messages', 'emails']).flatMap((item): InboxEvent[] => {
    const id = text(item.messageId ?? item.id);
    if (!id) return [];
    const thread = text(item.threadId) ?? id;
    const labels = Array.isArray(item.labelIds) ? item.labelIds : [];
    const body =
      text(item.messageText) ??
      text(at(item, 'preview.body')) ??
      text(item.snippet) ??
      '';
    return [
      {
        sourceId: source.id,
        externalId: id,
        kind: defaultEventKind[source.kind],
        title:
          text(item.subject) ??
          text(at(item, 'preview.subject')) ??
          '(no subject)',
        summary: plainText(body).slice(0, 2000),
        priority: labels.includes('IMPORTANT') ? 'high' : 'normal',
        from: text(item.sender) ?? text(item.from),
        url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(thread)}`,
        raw: item,
        occurredAt:
          parseTime(item.messageTimestamp ?? item.internalDate) ?? Date.now(),
      },
    ];
  });
}

/** Outlook through OUTLOOK_LIST_MESSAGES. */
async function outlook(
  run: (tool: string, args: Item) => Promise<unknown>,
  since: Date,
  source: { id: string; kind: SourceKind },
): Promise<InboxEvent[]> {
  const data = await run('OUTLOOK_LIST_MESSAGES', {
    folder: 'inbox',
    top: MAX_ITEMS,
    received_date_time_gt: since.toISOString(),
    response_detail: 'minimal',
  });
  return list(data, ['value', 'messages']).flatMap((item): InboxEvent[] => {
    const id = text(item.id);
    if (!id) return [];
    const sender = at(item, 'from.emailAddress');
    return [
      {
        sourceId: source.id,
        externalId: id,
        kind: defaultEventKind[source.kind],
        title: text(item.subject) ?? '(no subject)',
        summary: plainText(text(item.bodyPreview) ?? '').slice(0, 2000),
        priority: normalizePriority(item.importance),
        from: isItem(sender)
          ? (text(sender.name) ?? text(sender.address))
          : undefined,
        url: httpUrl(item.webLink),
        raw: item,
        occurredAt: parseTime(item.receivedDateTime) ?? Date.now(),
      },
    ];
  });
}

/**
 * Teams has no "all my messages" call: list recent chats, then read the
 * newest messages of each chat that changed since the last check.
 */
async function teams(
  run: (tool: string, args: Item) => Promise<unknown>,
  since: Date,
  source: { id: string; kind: SourceKind },
): Promise<InboxEvent[]> {
  const chats = list(
    await run('MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS', {
      user_id: 'me',
      top: 20,
    }),
    ['value', 'chats'],
  )
    .filter(
      (chat) =>
        (parseTime(chat.lastUpdatedDateTime) ?? Infinity) > since.getTime(),
    )
    .slice(0, 8);
  const events: InboxEvent[] = [];
  for (const chat of chats) {
    const chatId = text(chat.id);
    if (!chatId) continue;
    const messages = list(
      await run('MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES', {
        chat_id: chatId,
        top: 10,
      }),
      ['value', 'messages'],
    );
    for (const item of messages) {
      const id = text(item.id);
      const occurredAt = parseTime(item.createdDateTime);
      if (!id || !occurredAt || occurredAt <= since.getTime()) continue;
      // System events such as "member added" are not messages.
      if (item.messageType && item.messageType !== 'message') continue;
      const body = plainText(text(at(item, 'body.content')) ?? '');
      if (!body) continue;
      const from =
        text(at(item, 'from.user.displayName')) ??
        text(at(item, 'from.application.displayName'));
      events.push({
        sourceId: source.id,
        externalId: `${chatId}:${id}`,
        kind: defaultEventKind[source.kind],
        title: `${from ?? 'Someone'}${text(chat.topic) ? ` in ${text(chat.topic)}` : ''}: ${body.replace(/\s+/g, ' ').slice(0, 80)}`,
        summary: body.slice(0, 2000),
        priority: normalizePriority(item.importance),
        from,
        url: httpUrl(item.webUrl) ?? httpUrl(chat.webUrl),
        raw: { chat: { id: chatId, topic: chat.topic ?? null }, message: item },
        occurredAt,
      });
    }
  }
  return events;
}

const READERS: Record<string, typeof gmail> = {
  gmail,
  outlook,
  microsoft_teams: teams,
};

/**
 * Discovery's source: new mail or messages on one connected account, read
 * on a timer with read-only tools. Each item becomes an inbox event that the
 * discovery model then judges.
 */
export class ComposioListSource implements Source {
  readonly kind: SourceKind;
  constructor(
    readonly id: string,
    private config: ComposioSourceConfig,
    private execute: ComposioExecute,
  ) {
    const toolkit = DISCOVERY_TOOLKITS[config.toolkit];
    if (!toolkit || !READERS[config.toolkit])
      throw new Error(`Discovery cannot read ${config.toolkit} yet.`);
    this.kind = toolkit.kind;
  }
  async poll(since: Date | null, signal: AbortSignal) {
    const from = since ?? new Date(Date.now() - FIRST_LOOKBACK_MS);
    const run = (tool: string, args: Item) =>
      this.execute(
        {
          accountId: this.config.accountId,
          toolkit: this.config.toolkit,
          tool,
          arguments: args,
        },
        signal,
      );
    const events = await READERS[this.config.toolkit](run, from, {
      id: this.id,
      kind: this.kind,
    });
    return events.slice(0, MAX_ITEMS * 2);
  }
}
