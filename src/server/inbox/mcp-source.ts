import type { ConnectionService } from '../connections.js';
import type { McpSourceConfig, SourceKind } from '../../shared/inbox-types.js';
import {
  defaultEventKind,
  normalizePriority,
  parseTime,
  type InboxEvent,
  type Source,
} from './source.js';

type Fields = NonNullable<McpSourceConfig['fields']>;
const CANDIDATES: Record<Exclude<keyof Fields, 'items'>, string[]> = {
  id: ['id', 'key', 'identifier', 'number', 'short_code', 'shortCode', 'uuid'],
  title: ['title', 'name', 'subject', 'summary'],
  summary: ['description', 'body', 'snippet', 'preview', 'content', 'text'],
  priority: ['priority', 'priorityLabel', 'severity', 'urgency', 'importance'],
  url: ['url', 'html_url', 'webUrl', 'web_url', 'link', 'permalink', 'self'],
  from: [
    'assignedBy',
    'reporter',
    'creator',
    'createdBy',
    'author',
    'from',
    'sender',
    'owner',
  ],
  at: [
    'updatedAt',
    'updated_at',
    'updated',
    'createdAt',
    'created_at',
    'created',
    'date',
    'timestamp',
  ],
};
const LIST_KEYS = [
  'data',
  'items',
  'results',
  'tasks',
  'issues',
  'tickets',
  'records',
  'nodes',
  'values',
  'messages',
  'events',
];

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
const isItem = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Finds the list of records in a tool result, a few levels deep at most. */
function findItems(value: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isItem(value) || depth > 3) return undefined;
  for (const key of LIST_KEYS) {
    const found = findItems(value[key], depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && nested.some(isItem)) return nested;
  }
  return undefined;
}
const label = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (isItem(value))
    return label(
      value.displayName ??
        value.display_name ??
        value.name ??
        value.login ??
        value.email ??
        value.title,
    );
  return undefined;
};
function pick(
  item: Record<string, unknown>,
  field: keyof typeof CANDIDATES,
  fields: Fields,
) {
  const path = fields[field];
  if (path) return at(item, path);
  for (const key of CANDIDATES[field]) if (item[key] != null) return item[key];
  return undefined;
}

/** Normalizes a list tool's JSON result into inbox events. */
export function eventsFromResult(
  text: string,
  source: { id: string; kind: SourceKind; fields?: Fields },
  now = Date.now(),
): InboxEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'The tool returned text, not JSON. Pick a tool that returns a list of records.',
    );
  }
  const fields = source.fields ?? {};
  const items = fields.items ? at(parsed, fields.items) : findItems(parsed);
  if (!Array.isArray(items))
    throw new Error(
      'Could not find a list in the tool result. Set the items path for this source.',
    );
  const events: InboxEvent[] = [];
  for (const item of items.slice(0, 500)) {
    if (!isItem(item)) continue;
    const id = label(pick(item, 'id', fields));
    if (!id) continue;
    const url = label(pick(item, 'url', fields));
    events.push({
      sourceId: source.id,
      externalId: id,
      kind: defaultEventKind[source.kind],
      title: label(pick(item, 'title', fields)) ?? `Item ${id}`,
      summary: (label(pick(item, 'summary', fields)) ?? '').slice(0, 2000),
      priority: normalizePriority(pick(item, 'priority', fields)),
      from: label(pick(item, 'from', fields)),
      url: url && /^https?:\/\//i.test(url) ? url : undefined,
      raw: item,
      occurredAt: parseTime(pick(item, 'at', fields)) ?? now,
    });
  }
  return events;
}

/** Replaces any "{{since}}" string argument with the last poll time. */
export function withSince(args: unknown, since: Date | null): unknown {
  if (args === '{{since}}')
    return (since ?? new Date(Date.now() - 7 * 86_400_000)).toISOString();
  if (Array.isArray(args)) return args.map((value) => withSince(value, since));
  if (isItem(args))
    return Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        withSince(value, since),
      ]),
    );
  return args;
}

/**
 * A source backed by a read-only list tool on an MCP connection, such as
 * "tasks assigned to me" on a ticket system's MCP server. Called on a timer,
 * so it only runs tools the owner allowed to run without asking.
 */
export class McpListSource implements Source {
  constructor(
    readonly id: string,
    readonly kind: SourceKind,
    private config: McpSourceConfig,
    private connections: ConnectionService,
  ) {}
  async poll(since: Date | null, signal: AbortSignal) {
    const tool = this.connections.bound(
      this.config.dotId,
      this.config.connectionId,
      this.config.tool,
    );
    if (tool.tool.requiresApproval)
      throw new Error(
        'This tool asks for approval on every call, so it cannot run on a timer. Pick a read-only list tool, or let this one run without asking.',
      );
    const result = await this.connections.call(
      tool,
      withSince(this.config.arguments, since) as Record<string, unknown>,
      signal,
    );
    if (result.isError) throw new Error(result.text.slice(0, 300));
    return eventsFromResult(result.text, {
      id: this.id,
      kind: this.kind,
      fields: this.config.fields,
    });
  }
}
