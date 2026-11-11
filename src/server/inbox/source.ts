import type { InboxPriority, SourceKind } from '../../shared/inbox-types.js';

/**
 * A normalized piece of outside activity. Everything that happens elsewhere
 * is written to `inbox_events` as one of these before anything acts on it.
 */
export interface InboxEvent {
  sourceId: string;
  /** Dedupe key within the source. */
  externalId: string;
  kind:
    | 'ticket.assigned'
    | 'mail.received'
    | 'message.received'
    | 'calendar.changed'
    | (string & {});
  title: string;
  summary: string;
  priority?: InboxPriority;
  from?: string;
  url?: string;
  /** Treated as untrusted data, never as instructions. */
  raw: unknown;
  occurredAt: number;
}

/** Turns outside activity into events, by polling, by webhook, or both. */
export interface Source {
  id: string;
  kind: SourceKind;
  poll?(since: Date | null, signal: AbortSignal): Promise<InboxEvent[]>;
  /** POST /api/inbox/hooks/:sourceId, after the source secret was checked. */
  webhook?(body: unknown): InboxEvent[];
}

export const defaultEventKind: Record<SourceKind, InboxEvent['kind']> = {
  ticket: 'ticket.assigned',
  mail: 'mail.received',
  message: 'message.received',
  calendar: 'calendar.changed',
};

/** Maps the many ways services spell priority onto four levels. */
export function normalizePriority(value: unknown): InboxPriority {
  if (value && typeof value === 'object') {
    const named = value as Record<string, unknown>;
    return normalizePriority(
      named.name ?? named.label ?? named.value ?? named.id,
    );
  }
  if (typeof value === 'number')
    // Linear-style: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
    return value === 1
      ? 'urgent'
      : value === 2
        ? 'high'
        : value === 4
          ? 'low'
          : 'normal';
  if (typeof value !== 'string') return 'normal';
  const text = value.trim().toLowerCase();
  if (/^(urgent|critical|blocker|highest|emergency|p0|sev ?[01])$/.test(text))
    return 'urgent';
  if (/^(high|major|important|p1|sev ?2)$/.test(text)) return 'high';
  if (/^(low|lowest|minor|trivial|p[34]|sev ?[45])$/.test(text)) return 'low';
  return 'normal';
}

export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    // Seconds or milliseconds since the epoch.
    return value < 1e11 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
