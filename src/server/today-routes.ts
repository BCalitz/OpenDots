import { Hono } from 'hono';
import { sql } from './db/index.js';
import type { AccountSourceConfig } from '../shared/inbox-types.js';
import type { TodayStatus, TodayView } from '../shared/today-types.js';
import { senderName } from '../shared/discovery-message.js';
import type { Platform } from './platform.js';
import { localTime } from './discovery/delivery.js';
import { DISMISSALS_TO_QUIET } from './discovery/proposals.js';
import { matchedOf } from './discovery/service.js';
import { buildToday, type TodayProposal } from './today.js';

/** The last local midnight in a time zone, as a timestamp. */
export function localMidnight(now: number, timeZone: string) {
  const { minutes } = localTime(now, timeZone);
  return now - minutes * 60_000 - (now % 60_000);
}

/** Which of the states on the home screen applies, most pressing first. */
async function statusOf(platform: Platform): Promise<TodayStatus> {
  if ((await platform.store.settings()).paused) return 'paused';
  const sources = (await platform.inbox.store.accountSources()).filter(
    (source) => source.enabled,
  );
  if (!sources.length) return 'no_accounts';
  if (!platform.config.typesafeApiKey) return 'no_judge';
  for (const source of sources) {
    if (source.lastError) return 'account_error';
    const account = await platform.connectors.accounts.get(
      platform.workspace.ownerId,
      (source.config as AccountSourceConfig).accountId,
    );
    if (account?.error) return 'account_error';
  }
  return 'ok';
}

/**
 * Everything `buildToday` needs, read from what discovery stored. No model
 * is called.
 */
export async function loadToday(
  platform: Platform,
  now = Date.now(),
): Promise<TodayView> {
  const store = platform.inbox.store;
  const db = platform.workspace.db;
  const settings = await store.discovery.settings();
  const midnight = localMidnight(now, settings.timeZone);
  const proposals = await store.discovery.proposals.list();
  const threadIds = proposals.map((proposal) => proposal.threadId);
  const eventIds = proposals.map((proposal) => proposal.eventId);
  // Earlier asks in the same conversation: a follow-up item continues the
  // conversation of the item it follows up on.
  const asks = new Map(
    (
      await db.rows<{ threadId: string; asks: number }>(
        sql`SELECT thread_id, COUNT(*)::int AS asks FROM discovery_findings
          WHERE thread_id = ANY(${threadIds}) AND attention
            AND asked IN ('reply','information','action')
          GROUP BY thread_id`,
      )
    ).map((row) => [row.threadId, row.asks]),
  );
  // The company memory says each sender works at.
  const orgs = new Map(
    (
      await db.rows<{ eventId: string; name: string }>(
        sql`SELECT DISTINCT ON (l.event_id) l.event_id, o.name
          FROM event_entity_links l
          JOIN entity_edges g ON g.entity_id=l.entity_id AND g.relation='works_at'
          JOIN entities o ON o.id=g.other_entity_id
          WHERE l.event_id = ANY(${eventIds})
          ORDER BY l.event_id, g.weight DESC`,
      )
    ).map((row) => [row.eventId, row.name]),
  );
  // Senders the owner kept dismissing are quiet, as discovery treats them.
  const quieted = new Set(
    (await store.discovery.proposals.rules(DISMISSALS_TO_QUIET, now)).map(
      (rule) => rule.sender,
    ),
  );
  const entries: TodayProposal[] = [];
  for (const proposal of proposals) {
    const finding = await store.finding(proposal.findingId);
    const event = await store.event(proposal.eventId);
    const matched = matchedOf(await store.findingAnswers(proposal.findingId));
    const name = event?.from
      ? senderName(event.from)
      : (proposal.sender ?? null);
    entries.push({
      proposal,
      name,
      org: orgs.get(proposal.eventId) ?? null,
      asked: finding?.asked ?? null,
      asks: asks.get(proposal.threadId) ?? 0,
      focus: matched.focus[0] ?? null,
      muted:
        finding?.attention === false ||
        (!!proposal.sender && quieted.has(proposal.sender)),
    });
  }
  const quiet = await db.row<{ read: number; kept: number }>(
    sql`SELECT COUNT(*)::int AS read,
        COUNT(*) FILTER (WHERE f.attention = false)::int AS kept
      FROM inbox_events e
      JOIN inbox_sources s ON s.id=e.source_id AND s.type='account'
      LEFT JOIN discovery_findings f ON f.event_id=e.id
      WHERE e.received_at >= ${midnight}`,
  );
  // TODO(1.2): count only tools whose risk is `send` once tools have a
  // risk, and only the assistant Dot's. Until then every completed action
  // that changed something counts.
  const sent = await db.row<{ sent: number }>(
    sql`SELECT COUNT(*)::int AS sent FROM action_log
      WHERE NOT read_only AND outcome='succeeded' AND created_at >= ${midnight}`,
  );
  return buildToday(
    {
      date: localTime(now, settings.timeZone).date,
      proposals: entries,
      approvals: await platform.approvals.pending(),
      waiting: await platform.workspace.inbox.discovery.waiting.list(),
      quiet: {
        read: quiet?.read ?? 0,
        kept: quiet?.kept ?? 0,
        sent: sent?.sent ?? 0,
      },
      status: await statusOf(platform),
    },
    now,
  );
}

/** The home screen's list: GET /api/today. */
export function todayRoutes(platform: Platform) {
  const app = new Hono();
  app.get('/today', async (c) => c.json(await loadToday(platform)));
  return app;
}
