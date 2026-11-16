import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { sql } from '../src/server/db/index.js';
import { localMidnight } from '../src/server/today-routes.js';
import { testWorkspace } from './fixtures/db.js';
import type { TodayView } from '../src/shared/today-types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function start(options: { typesafe?: boolean } = {}) {
  const { store, workspace } = await testWorkspace();
  const platform = await Platform.create(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
    ...(options.typesafe ? { typesafeApiKey: 'fixture' } : {}),
  });
  const config = {
    mode: 'live' as const,
    baseUrl: 'https://unused.invalid/v1',
  };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  cleanup.push(() => platform.stop());
  const today = async () => {
    const response = await app.request('/api/today');
    expect(response.status).toBe(200);
    return (await response.json()) as TodayView;
  };
  const addAccount = async () =>
    (
      await platform.inbox.store.create({
        name: 'Gmail',
        kind: 'mail',
        type: 'account',
        config: {
          dotId: 'dot',
          userId: 'owner',
          accountId: 'ca_gmail',
          app: 'gmail',
        },
        notify: 'off',
        intervalSeconds: 300,
      })
    ).source;
  return { app, platform, store, workspace, today, addAccount };
}

describe('GET /api/today', () => {
  it('returns each status', async () => {
    const { store, today, addAccount } = await start();
    expect((await today()).status).toBe('no_accounts');
    await addAccount();
    expect((await today()).status).toBe('no_judge');
    await store.updateSettings({ paused: true });
    expect((await today()).status).toBe('paused');

    const judged = await start({ typesafe: true });
    const other = await judged.addAccount();
    expect((await judged.today()).status).toBe('ok');
    await judged.workspace.db.run(
      sql`UPDATE inbox_sources SET last_error='Sign-in expired.' WHERE id=${other.id}`,
    );
    expect((await judged.today()).status).toBe('account_error');
  });

  it('counts an expired account sign-in as an account error', async () => {
    const { today, addAccount, workspace } = await start({ typesafe: true });
    await addAccount();
    await workspace.db.run(
      sql`INSERT INTO accounts (id, user_id, connector, name, config, tools, error, created_at, updated_at)
        VALUES ('ca_gmail', 'owner', 'gmail', 'me@example.com', '{}', '[]', 'Sign in again.', 1, 1)`,
    );
    expect((await today()).status).toBe('account_error');
  });

  it('builds the list from stored proposals, memory and counts', async () => {
    const { platform, today, addAccount, workspace } = await start({
      typesafe: true,
    });
    const source = await addAccount();
    const inbox = platform.inbox.store;
    const now = Date.now();
    const [first, second, quiet] = await inbox.ingest([
      {
        sourceId: source.id,
        externalId: 'm1',
        kind: 'mail.received',
        title: 'Invoice 114',
        summary: 'Can you confirm?',
        from: 'Thandi Nkosi <thandi@acme.example>',
        occurredAt: now,
        raw: {},
      },
      {
        sourceId: source.id,
        externalId: 'm2',
        kind: 'mail.received',
        title: 'Re: Invoice 114',
        summary: 'Following up.',
        from: 'Thandi Nkosi <thandi@acme.example>',
        occurredAt: now,
        raw: {},
      },
      {
        sourceId: source.id,
        externalId: 'm3',
        kind: 'mail.received',
        title: 'Newsletter',
        summary: 'News.',
        from: 'news@example.com',
        occurredAt: now,
        raw: {},
      },
    ]);
    const finding = async (eventId: string, attention: boolean) => {
      const saved = await inbox.saveFinding({
        eventId,
        attention,
        category: 'request',
        confidence: 0.9,
        reason: 'r',
        judgedBy: 'rules',
        dotId: 'dot',
        urgency: 'today',
        asked: attention ? 'reply' : 'nothing',
        route: attention ? 'draft' : null,
      });
      if (attention)
        await inbox.updateFinding(saved.id, {
          state: 'ready',
          threadId: 'thread-1',
        });
      return saved;
    };
    await finding(first.id, true);
    const later = await finding(second.id, true);
    await finding(quiet.id, false);
    await inbox.discovery.proposals.save({
      findingId: later.id,
      eventId: second.id,
      dotId: 'dot',
      threadId: 'thread-1',
      title: 'Confirm invoice 114',
      summary: 's',
      options: ['prepare', 'handle', 'not_now'],
      importance: 3,
      urgency: 'today',
      route: 'draft',
      sender: 'thandi@acme.example',
    });
    // Memory: Thandi works at Acme Ltd.
    await workspace.db.run(
      sql`INSERT INTO entities (id, owner_id, kind, name, first_seen_at, last_seen_at, created_at, updated_at) VALUES
        ('p1', 'owner', 'person', 'Thandi Nkosi', 1, 1, 1, 1),
        ('o1', 'owner', 'organization', 'Acme Ltd', 1, 1, 1, 1)`,
    );
    await workspace.db.run(
      sql`INSERT INTO entity_edges VALUES ('owner', 'p1', 'o1', 'works_at', 1, 1, 1)`,
    );
    await workspace.db.run(
      sql`INSERT INTO event_entity_links VALUES (${second.id}, 'p1', 'owner', 'sender', 1)`,
    );
    await workspace.db.run(
      sql`INSERT INTO action_log (id, dot_id, kind, target, action, read_only, outcome, created_at) VALUES
        ('a1', 'dot', 'connection', 'Gmail', 'send_email', false, 'succeeded', ${now}),
        ('a2', 'dot', 'connection', 'Gmail', 'search', true, 'succeeded', ${now}),
        ('a3', 'dot', 'connection', 'Gmail', 'send_email', false, 'succeeded', ${now - 3 * 86_400_000})`,
    );

    const view = await today();
    expect(view.now).toHaveLength(1);
    expect(view.now[0]).toMatchObject({
      kind: 'proposal',
      title: 'Confirm invoice 114',
      who: 'Thandi Nkosi, Acme Ltd',
      why: 'Thandi Nkosi has asked twice.',
      due: 'Due today',
      threadId: 'thread-1',
      eventId: second.id,
    });
    expect(view.decide).toEqual([]);
    expect(view.quiet).toEqual({ read: 3, kept: 1, sent: 1 });
    expect(view.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('localMidnight', () => {
  it('finds the last midnight in the time zone', () => {
    const now = Date.UTC(2026, 10, 16, 8, 30, 15);
    expect(localMidnight(now, 'UTC')).toBe(Date.UTC(2026, 10, 16));
    // Johannesburg is two hours ahead of UTC.
    expect(localMidnight(now, 'Africa/Johannesburg')).toBe(
      Date.UTC(2026, 10, 15, 22),
    );
  });
});
