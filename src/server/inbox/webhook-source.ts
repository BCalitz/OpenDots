import { z } from 'zod';
import type { SourceKind } from '../../shared/inbox-types.js';
import {
  defaultEventKind,
  normalizePriority,
  parseTime,
  type InboxEvent,
  type Source,
} from './source.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.union([text(300), z.number().transform(String)]);
const item = z
  .object({
    externalId: id.optional(),
    id: id.optional(),
    kind: text(80).optional(),
    title: text(300),
    summary: z.string().max(5000).optional(),
    priority: z.unknown().optional(),
    from: text(200).optional(),
    url: z.string().url().max(2048).optional(),
    occurredAt: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()
  .refine((value) => value.externalId ?? value.id, {
    message: 'Each event needs an externalId (or id).',
  });
const body = z.union([
  z.array(item).min(1).max(100),
  z.object({ events: z.array(item).min(1).max(100) }).passthrough(),
  item,
]);
export const WEBHOOK_FORMAT =
  'Send JSON: one event or { "events": [...] }, each with externalId, title and optional kind, summary, priority, from, url and occurredAt.';

/**
 * A source that receives events by POST /api/inbox/hooks/:id. The body is a
 * small normalized format, so any service or automation tool (Zapier, n8n,
 * a ticket system's outgoing webhook through a mapper) can feed it.
 */
export class WebhookSource implements Source {
  constructor(
    readonly id: string,
    readonly kind: SourceKind,
  ) {}
  webhook(payload: unknown): InboxEvent[] {
    const parsed = body.safeParse(payload);
    if (!parsed.success) throw new Error(WEBHOOK_FORMAT);
    const items = Array.isArray(parsed.data)
      ? parsed.data
      : 'events' in parsed.data && Array.isArray(parsed.data.events)
        ? parsed.data.events
        : [parsed.data as z.infer<typeof item>];
    const now = Date.now();
    return items.map((entry) => ({
      sourceId: this.id,
      externalId: String(entry.externalId ?? entry.id),
      kind: entry.kind ?? defaultEventKind[this.kind],
      title: entry.title,
      summary: entry.summary ?? '',
      priority: normalizePriority(entry.priority),
      from: entry.from,
      url: entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : undefined,
      raw: entry,
      occurredAt: parseTime(entry.occurredAt) ?? now,
    }));
  }
}
