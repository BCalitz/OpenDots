import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxStore } from '../src/server/inbox/store.js';
import { InboxEngine } from '../src/server/inbox/engine.js';
import {
  ComposioListSource,
  plainText,
  type ComposioExecute,
} from '../src/server/inbox/composio-source.js';
import {
  jevJudge,
  ruleVerdict,
  type Judge,
} from '../src/server/discovery/classifier.js';
import {
  DiscoveryService,
  type Investigate,
} from '../src/server/discovery/service.js';
import { investigationMessage } from '../src/server/discovery/investigation.js';
import { composioTools, toolSlugs } from '../src/server/composio-tools.js';
import { detachedContext } from '../src/server/engine/tools.js';
import type { ConnectorService } from '../src/server/connectors/service.js';
import type { InboxEvent } from '../src/server/inbox/source.js';
import type { InboxEventView } from '../src/shared/inbox-types.js';
import { DotEngine } from '../src/server/engine/index.js';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import { discoveryMessagePrefix } from '../src/shared/discovery-message.js';
import { completion } from './fixtures/model-stream.js';
import { testDb, testWorkspace } from './fixtures/db.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function inbox() {
  const store = new InboxStore(await testDb());
  const { source } = await store.create({
    name: 'Gmail',
    kind: 'mail',
    type: 'composio',
    config: { dotId: 'books', accountId: 'ca_gmail', toolkit: 'gmail' },
    notify: 'off',
    intervalSeconds: 300,
  });
  return { store, source };
}
const mail = (
  sourceId: string,
  id: string,
  title: string,
  raw: unknown = {},
): InboxEvent => ({
  sourceId,
  externalId: id,
  kind: 'mail.received',
  title,
  summary: `${title} body`,
  from: 'sender@example.com',
  raw,
  occurredAt: Date.now(),
});
/** Judges by title: anything mentioning PayFast needs the owner. */
const fakeJudge = (): Judge & { calls: string[] } => {
  const calls: string[] = [];
  return {
    name: 'fake-jev',
    calls,
    async judge(item) {
      calls.push(item.title);
      const payment = /payfast/i.test(item.title);
      return {
        attention: payment || /maybe/i.test(item.title),
        category: payment ? 'payment' : 'other',
        confidence: payment ? 0.93 : 0.4,
        reason: payment ? 'PayFast payment, ref 8812345.' : 'Unclear.',
        urgency: null,
        asked: payment ? 'reply' : 'nothing',
        injection: false,
        related: [],
      };
    },
  };
};
const candidateEvent = (
  overrides: Partial<InboxEventView> = {},
): InboxEventView => ({
  id: 'event-1',
  sourceId: 'src',
  sourceName: 'Gmail',
  externalId: 'ext-1',
  kind: 'mail.received',
  title: 'Invoice #4471',
  summary: 'Attaching invoice #4471 — total is $2,000.',
  priority: 'normal',
  from: 'jane@client.example.com',
  url: null,
  occurredAt: Date.now() - 60 * 60_000,
  receivedAt: Date.now() - 60 * 60_000,
  state: 'new',
  ...overrides,
});
/** Stubs the HTTP layer so `jevJudge` talks to a canned response, never the network. */
function stubFetch(answers: unknown) {
  let requestBody: { state: unknown; questions: Record<string, unknown> };
  const fetch = (async (_url: string, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ model: 'jev-latest', answers, usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, body: () => requestBody };
}
const signal = new AbortController().signal;

describe('discovery model', () => {
  it('skips mail the app filed as promotions without a model call', () => {
    expect(
      ruleVerdict({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
    ).toMatchObject({ attention: false, category: 'newsletter' });
    expect(ruleVerdict({ labelIds: ['INBOX'] })).toBeUndefined();
    expect(ruleVerdict(null)).toBeUndefined();
  });

  const baseAnswers = (overrides: Record<string, unknown> = {}) => ({
    attention: { type: 'noul', noul: 0.9 },
    category: {
      type: 'choice',
      choice: 'payment',
      confidence: 0.8,
      probabilities: {},
    },
    urgency: {
      type: 'score',
      // The expected score sits between levels; the most likely level wins.
      score: 1.4,
      confidence: 0.6,
      legend: {},
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 },
    },
    asks_anything: { type: 'noul', noul: 0.8 },
    what_asked: {
      type: 'choice',
      choice: 'reply',
      confidence: 0.7,
      probabilities: {},
    },
    injection: { type: 'noul', noul: 0.05 },
    ...overrides,
  });
  const earlierAnswers = (label: string, same: number, resolves = 0.1) => ({
    [`same__${label}`]: {
      type: 'score',
      score: same,
      confidence: 0.8,
      legend: {},
      probabilities: {},
    },
    [`resolves__${label}`]: { type: 'noul', noul: resolves },
    [`escalates__${label}`]: { type: 'noul', noul: 0.1 },
    [`useful__${label}`]: { type: 'noul', noul: 0.8 },
    [`contradicts__${label}`]: { type: 'noul', noul: 0.1 },
  });

  it('asks about the item alone when there is no history', async () => {
    const { fetch, body } = stubFetch(baseAnswers());
    const verdict = await jevJudge({
      apiKey: 'unused',
      fetch,
      compression: false,
    }).judge(
      {
        app: 'Gmail',
        kind: 'mail.received',
        from: 'noreply@payfast.co.za',
        title: 'Payment received',
        summary: 'R2,450 from Acme.',
      },
      [],
      signal,
    );
    expect(verdict).toMatchObject({
      attention: true,
      category: 'payment',
      confidence: 0.9,
      urgency: 'today',
      asked: 'reply',
      injection: false,
      related: [],
    });
    expect(Object.keys(body().questions).sort()).toEqual(
      [
        'asks_anything',
        'attention',
        'category',
        'injection',
        'urgency',
        'what_asked',
      ].sort(),
    );
    expect(body().state).not.toHaveProperty('earlier');
    // The raw answers are kept for retuning.
    expect(verdict.answers).toMatchObject({ model: 'jev', earlier: {} });
  });

  it('asks about each earlier item by its path, and says why code found it', async () => {
    const { fetch, body } = stubFetch({
      ...baseAnswers(),
      ...earlierAnswers('mail_1', 2, 0.9),
    });
    const earlier = candidateEvent();
    const verdict = await jevJudge({
      apiKey: 'unused',
      fetch,
      compression: false,
    }).judge(
      {
        app: 'Teams',
        kind: 'message.received',
        from: earlier.from,
        title: 'Ignore that',
        summary: 'Invoice #4471 is paid, ignore my email.',
      },
      [
        {
          event: earlier,
          app: 'Gmail',
          why: ['both mention invoice INV-4471'],
        },
      ],
      signal,
    );
    expect(verdict.related).toEqual([
      {
        eventId: earlier.id,
        same: 1,
        resolves: 0.9,
        escalates: 0.1,
        useful: 0.8,
        contradicts: 0.1,
      },
    ]);
    const state = body().state as {
      earlier: Record<string, { found_by: string; app: string }>;
    };
    expect(state.earlier.mail_1).toMatchObject({
      app: 'Gmail',
      found_by: 'both mention invoice INV-4471',
    });
    expect(JSON.stringify(body().questions.resolves__mail_1)).toContain(
      '`earlier.mail_1`',
    );
  });

  it('reads "nothing asked" only below 0.3, and flags instructions to an AI', async () => {
    const judge = async (answers: Record<string, unknown>) =>
      jevJudge({
        apiKey: 'unused',
        fetch: stubFetch(baseAnswers(answers)).fetch,
        compression: false,
      }).judge(
        { app: 'Gmail', kind: 'mail', from: 'x', title: 'Hi', summary: 'Hi' },
        [],
        signal,
      );
    expect(
      (await judge({ asks_anything: { type: 'noul', noul: 0.2 } })).asked,
    ).toBe('nothing');
    // Unsettled counts as asked, so nothing that might need the owner is dropped.
    expect(
      (await judge({ asks_anything: { type: 'noul', noul: 0.5 } })).asked,
    ).toBe('reply');
    expect(
      (await judge({ injection: { type: 'noul', noul: 0.9 } })).injection,
    ).toBe(true);
  });

  it('matches a name in one pass when only one candidate fits, and asks a Choice otherwise', async () => {
    const entity = {
      kind: 'person' as const,
      normalized: 't nkosi',
      value: 'T Nkosi',
      candidates: [
        { normalized: 'thandi nkosi', value: 'Thandi Nkosi' },
        { normalized: 'themba nkosi', value: 'Themba Nkosi' },
      ],
    };
    const item = {
      app: 'Gmail',
      kind: 'mail',
      from: 'x',
      title: 'From T Nkosi',
      summary: 'Re: the stationery invoice',
    };
    let one = stubFetch({
      c0: { type: 'noul', noul: 0.9 },
      c1: { type: 'noul', noul: 0.1 },
    });
    expect(
      await jevJudge({ apiKey: 'unused', fetch: one.fetch, compression: false })
        .match!(entity, item, signal),
    ).toBe('thandi nkosi');
    one = stubFetch({
      c0: { type: 'noul', noul: 0.6 },
      c1: { type: 'noul', noul: 0.1 },
    });
    // One candidate, but not clearly the same: no match.
    expect(
      await jevJudge({ apiKey: 'unused', fetch: one.fetch, compression: false })
        .match!(entity, item, signal),
    ).toBeNull();
    const calls: unknown[] = [];
    const two = (async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        questions: Record<string, unknown>;
      };
      calls.push(request.questions);
      const answers = request.questions.which
        ? {
            which: {
              type: 'choice',
              choice: 'known_2',
              confidence: 0.9,
              probabilities: { known_1: 0.1, known_2: 0.9 },
            },
          }
        : { c0: { type: 'noul', noul: 0.7 }, c1: { type: 'noul', noul: 0.8 } };
      return new Response(
        JSON.stringify({ model: 'jev', answers, usage: {} }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof globalThis.fetch;
    expect(
      await jevJudge({ apiKey: 'unused', fetch: two, compression: false })
        .match!(entity, item, signal),
    ).toBe('thandi nkosi');
    expect(calls).toHaveLength(2);
  });
});

describe('InboxStore.recentFrom', () => {
  const HOUR = 60 * 60_000;
  const event = (
    sourceId: string,
    id: string,
    from: string,
    occurredAt: number,
  ): InboxEvent => ({
    sourceId,
    externalId: id,
    kind: 'mail.received',
    title: id,
    summary: '',
    from,
    raw: {},
    occurredAt,
  });

  it('finds a prior event from the same sender within the window', async () => {
    const { store, source } = await inbox();
    const [earlier] = await store.ingest([
      event(source.id, 'm1', 'jane@client.com', 10 * HOUR),
    ]);
    const [later] = await store.ingest([
      event(source.id, 'm2', 'jane@client.com', 11 * HOUR),
    ]);
    expect(
      (
        await store.recentFrom(
          'jane@client.com',
          later.occurredAt,
          48 * HOUR,
          later.id,
        )
      ).map((e) => e.id),
    ).toEqual([earlier.id]);
  });

  it('excludes events outside the window', async () => {
    const { store, source } = await inbox();
    await store.ingest([event(source.id, 'm1', 'jane@client.com', 0)]);
    const [later] = await store.ingest([
      event(source.id, 'm2', 'jane@client.com', 100 * HOUR),
    ]);
    expect(
      await store.recentFrom(
        'jane@client.com',
        later.occurredAt,
        HOUR,
        later.id,
      ),
    ).toEqual([]);
  });

  it('does not match a different sender', async () => {
    const { store, source } = await inbox();
    await store.ingest([event(source.id, 'm1', 'jane@client.com', 0)]);
    const [later] = await store.ingest([
      event(source.id, 'm2', 'other@client.com', HOUR),
    ]);
    expect(
      await store.recentFrom(
        'other@client.com',
        later.occurredAt,
        48 * HOUR,
        later.id,
      ),
    ).toEqual([]);
  });

  it('never returns the event itself', async () => {
    const { store, source } = await inbox();
    const [only] = await store.ingest([
      event(source.id, 'm1', 'jane@client.com', 0),
    ]);
    expect(
      await store.recentFrom('jane@client.com', only.occurredAt, HOUR, only.id),
    ).toEqual([]);
  });
});

describe('discovery sources', () => {
  const run = (results: Record<string, unknown>) => {
    const calls: Parameters<ComposioExecute>[0][] = [];
    const execute: ComposioExecute = async (call) => {
      calls.push(call);
      return results[call.tool];
    };
    return { calls, execute };
  };

  it('reads new Gmail messages since the last check', async () => {
    const { calls, execute } = run({
      GMAIL_FETCH_EMAILS: {
        messages: [
          {
            messageId: 'm1',
            threadId: 't1',
            subject: 'Payment received',
            sender: 'PayFast <noreply@payfast.co.za>',
            messageText: '<p>R2,450.00 from Acme, ref 8812345</p>',
            messageTimestamp: '2026-11-11T08:00:00Z',
            labelIds: ['INBOX', 'IMPORTANT'],
          },
          { subject: 'no id, skipped' },
        ],
      },
    });
    const source = new ComposioListSource(
      's1',
      { dotId: 'd', accountId: 'ca_1', toolkit: 'gmail' },
      execute,
    );
    const since = new Date('2026-11-11T07:00:00Z');
    const events = await source.poll(since, new AbortController().signal);
    expect(calls[0]).toMatchObject({
      accountId: 'ca_1',
      toolkit: 'gmail',
      tool: 'GMAIL_FETCH_EMAILS',
      arguments: { query: `in:inbox after:${since.getTime() / 1000}` },
    });
    expect(events).toEqual([
      expect.objectContaining({
        externalId: 'm1',
        title: 'Payment received',
        summary: 'R2,450.00 from Acme, ref 8812345',
        priority: 'high',
        from: 'PayFast <noreply@payfast.co.za>',
        url: 'https://mail.google.com/mail/u/0/#all/t1',
      }),
    ]);
  });

  it('looks back a day on the first check', async () => {
    const { calls, execute } = run({ OUTLOOK_LIST_MESSAGES: { value: [] } });
    const source = new ComposioListSource(
      's1',
      { dotId: 'd', accountId: 'ca_1', toolkit: 'outlook' },
      execute,
    );
    await source.poll(null, new AbortController().signal);
    const after = Date.parse(String(calls[0].arguments.received_date_time_gt));
    expect(Date.now() - after).toBeGreaterThan(23 * 3_600_000);
    expect(Date.now() - after).toBeLessThan(25 * 3_600_000);
  });

  it('reads Outlook and Teams items, in Composio result wrappers', async () => {
    const outlook = new ComposioListSource(
      's1',
      { dotId: 'd', accountId: 'ca_1', toolkit: 'outlook' },
      run({
        OUTLOOK_LIST_MESSAGES: JSON.stringify({
          data: {
            value: [
              {
                id: 'o1',
                subject: 'Invoice 1043 overdue',
                bodyPreview: 'Please pay',
                importance: 'high',
                from: {
                  emailAddress: { name: 'Acme', address: 'a@acme.test' },
                },
                receivedDateTime: '2026-11-11T08:00:00Z',
                webLink: 'https://outlook.office.com/mail/o1',
              },
            ],
          },
        }),
      }).execute,
    );
    expect(
      await outlook.poll(new Date(0), new AbortController().signal),
    ).toEqual([
      expect.objectContaining({
        externalId: 'o1',
        from: 'Acme',
        priority: 'high',
        url: 'https://outlook.office.com/mail/o1',
      }),
    ]);

    const since = new Date('2026-11-11T07:00:00Z');
    const teams = new ComposioListSource(
      's2',
      { dotId: 'd', accountId: 'ca_2', toolkit: 'microsoft_teams' },
      run({
        MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS: {
          value: [
            {
              id: 'c1',
              topic: 'Finance',
              lastUpdatedDateTime: '2026-11-11T08:00:00Z',
            },
            { id: 'old', lastUpdatedDateTime: '2026-11-01T08:00:00Z' },
          ],
        },
        MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES: {
          value: [
            {
              id: 'n1',
              messageType: 'message',
              createdDateTime: '2026-11-11T08:00:00Z',
              from: { user: { displayName: 'Thandi' } },
              body: { content: '<p>Did the Acme payment land?</p>' },
            },
            {
              id: 'n0',
              messageType: 'message',
              createdDateTime: '2026-11-10T08:00:00Z',
              body: { content: 'old' },
            },
            {
              id: 'sys',
              messageType: 'systemEventMessage',
              createdDateTime: '2026-11-11T08:00:00Z',
              body: { content: 'added' },
            },
          ],
        },
      }).execute,
    );
    expect(await teams.poll(since, new AbortController().signal)).toEqual([
      expect.objectContaining({
        externalId: 'c1:n1',
        title: 'Thandi in Finance: Did the Acme payment land?',
        from: 'Thandi',
      }),
    ]);
  });

  it('refuses apps it cannot read', () => {
    expect(
      () =>
        new ComposioListSource(
          's',
          { dotId: 'd', accountId: 'a', toolkit: 'quickbooks' },
          vi.fn(),
        ),
    ).toThrow(/cannot read quickbooks/);
  });

  it('strips HTML for previews', () => {
    expect(plainText('<style>x{}</style><b>Hi</b>&nbsp;there<br>you')).toBe(
      'Hi there\nyou',
    );
  });

  it('polls discovery sources on the inbox timer and hands new items on', async () => {
    const { store, source } = await inbox();
    const execute = vi.fn<ComposioExecute>(async () => ({
      messages: [{ messageId: 'm1', subject: 'Hello' }],
    }));
    const engine = new InboxEngine(store, {} as ConnectorService, {
      paused: async () => false,
      composio: () => execute,
    });
    const batches: unknown[] = [];
    engine.onEvents((batch) => void batches.push(batch));
    await engine.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.events({ sourceId: source.id })).toHaveLength(1);
    expect(batches).toHaveLength(1);

    const noKey = new InboxEngine(store, {} as ConnectorService, {
      paused: async () => false,
    });
    await store.pollNow(source.id);
    await noKey.tick();
    expect((await store.source(source.id))?.lastError).toMatch(
      /COMPOSIO_API_KEY/,
    );
  });
});

describe('discovery service', () => {
  async function service(investigate?: Investigate, threshold?: number) {
    const { store, source } = await inbox();
    const judge = fakeJudge();
    const started: string[] = [];
    const discovery = new DiscoveryService(store, {
      judge: () => judge,
      investigate:
        investigate ??
        (async ({ event }) => {
          started.push(event.title);
          return { threadId: `thread-${event.externalId}` };
        }),
      threshold,
    });
    const deliver = async (events: InboxEvent[]) => {
      const fresh = await store.ingest(events);
      discovery.listener({
        source: (await store.source(source.id))!,
        events: fresh,
        initial: false,
      });
      return fresh;
    };
    return { store, source, judge, discovery, started, deliver };
  }

  it('flags what needs the owner, investigates it and reports when ready', async () => {
    const f = await service();
    const ready: string[] = [];
    f.discovery.onReady((finding, event) => {
      ready.push(`${event.title} -> ${finding.threadId}`);
    });
    await f.deliver([
      mail(f.source.id, 'm1', 'PayFast payment received'),
      mail(f.source.id, 'm2', 'Weekly newsletter'),
      mail(f.source.id, 'm3', 'Big sale', {
        labelIds: ['CATEGORY_PROMOTIONS'],
      }),
      mail(f.source.id, 'm4', 'Maybe important'),
    ]);
    await f.discovery.idle();

    // Promotions never reach the model.
    expect(f.judge.calls).toEqual([
      'PayFast payment received',
      'Weekly newsletter',
      'Maybe important',
    ]);
    // Below the confidence threshold counts as not needing the owner.
    expect(f.started).toEqual(['PayFast payment received']);
    expect(ready).toEqual(['PayFast payment received -> thread-m1']);
    const events = await f.store.events({ sourceId: f.source.id });
    const byTitle = (title: string) =>
      events.find((event) => event.title === title)!.finding!;
    expect(byTitle('PayFast payment received')).toMatchObject({
      attention: true,
      category: 'payment',
      state: 'ready',
      threadId: 'thread-m1',
      judgedBy: 'fake-jev',
      dotId: 'books',
    });
    expect(byTitle('Maybe important')).toMatchObject({
      attention: false,
      state: 'ignored',
    });
    expect(byTitle('Big sale')).toMatchObject({ judgedBy: 'rules' });
  });

  it('ignores other sources and judges each item once', async () => {
    const f = await service();
    const [event] = await f.deliver([
      mail(f.source.id, 'm1', 'PayFast payment'),
    ]);
    await f.discovery.idle();
    f.discovery.listener({
      source: (await f.store.source(f.source.id))!,
      events: [event],
      initial: false,
    });
    f.discovery.listener({
      source: { ...(await f.store.source(f.source.id))!, type: 'mcp' },
      events: [event],
      initial: false,
    });
    await f.discovery.idle();
    expect(f.judge.calls).toHaveLength(1);
    expect(f.started).toHaveLength(1);
  });

  it('continues the same conversation for a correlated follow-up instead of opening a second one', async () => {
    const { store, source } = await inbox();
    const calls: { title: string; existingThreadId?: string }[] = [];
    const investigate: Investigate = async ({ event, existingThreadId }) => {
      calls.push({ title: event.title, existingThreadId });
      return { threadId: existingThreadId ?? `thread-${event.externalId}` };
    };
    // Flags everything; the second item references the first's candidate.
    const judge = (): Judge => ({
      name: 'fake-jev',
      async judge(_item, history) {
        const reference = history[0]?.event;
        return {
          attention: true,
          category: reference ? 'request' : 'payment',
          confidence: 0.9,
          reason: reference
            ? 'Follow-up asking for a reply.'
            : 'Payment received.',
          urgency: 'today',
          asked: 'reply',
          injection: false,
          related: reference
            ? [
                {
                  eventId: reference.id,
                  same: 1,
                  resolves: 0,
                  escalates: 0,
                  useful: 0,
                  contradicts: 0,
                },
              ]
            : [],
        };
      },
    });
    const discovery = new DiscoveryService(store, { judge, investigate });
    const deliver = async (events: InboxEvent[]) => {
      const fresh = await store.ingest(events);
      discovery.listener({
        source: (await store.source(source.id))!,
        events: fresh,
        initial: false,
      });
      return fresh;
    };

    await deliver([mail(source.id, 'm1', 'Invoice reminder')]);
    await discovery.idle();
    await deliver([
      { ...mail(source.id, 'm2', 'Reply needed'), kind: 'message.received' },
    ]);
    await discovery.idle();

    expect(calls).toEqual([
      { title: 'Invoice reminder', existingThreadId: undefined },
      { title: 'Reply needed', existingThreadId: 'thread-m1' },
    ]);
    const events = await store.events({ sourceId: source.id });
    const byTitle = (title: string) =>
      events.find((event) => event.title === title)!.finding!;
    // Both items now point at the one conversation the follow-up continued.
    expect(byTitle('Invoice reminder')).toMatchObject({
      state: 'ready',
      threadId: 'thread-m1',
    });
    expect(byTitle('Reply needed')).toMatchObject({
      state: 'ready',
      threadId: 'thread-m1',
    });
  });

  it('keeps the conversation of a failed investigation and can retry it', async () => {
    let fail = true;
    const f = await service(async ({ event }) => {
      if (fail)
        throw Object.assign(new Error('The turn timed out.'), {
          threadId: 'thread-partial',
        });
      return { threadId: `thread-${event.externalId}` };
    });
    await f.deliver([mail(f.source.id, 'm1', 'PayFast payment')]);
    await f.discovery.idle();
    const [event] = await f.store.events({ sourceId: f.source.id });
    expect(event.finding).toMatchObject({
      state: 'failed',
      error: 'The turn timed out.',
      threadId: 'thread-partial',
    });
    fail = false;
    await f.discovery.investigate(event.finding!.id);
    await f.discovery.idle();
    expect((await f.store.event(event.id))?.finding).toMatchObject({
      state: 'ready',
      threadId: 'thread-m1',
      error: null,
    });
  });

  it('marks investigations a restart interrupted as failed', async () => {
    const f = await service();
    const [event] = await f.store.ingest([mail(f.source.id, 'm1', 'PayFast')]);
    const finding = await f.store.saveFinding({
      eventId: event.id,
      attention: true,
      category: 'payment',
      confidence: 0.9,
      reason: 'Payment.',
      judgedBy: 'fake-jev',
      dotId: 'books',
    });
    await f.store.updateFinding(finding.id, { state: 'investigating' });
    await f.discovery.start();
    expect(await f.store.finding(finding.id)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/restarted/),
    });
  });

  it('removes findings with their source', async () => {
    const f = await service();
    await f.deliver([mail(f.source.id, 'm1', 'PayFast payment')]);
    await f.discovery.idle();
    expect(await f.store.findings('ready')).toHaveLength(1);
    await f.store.remove(f.source.id);
    expect(await f.store.findings('ready')).toHaveLength(0);
  });

  it('quotes the item as data in the first message', async () => {
    const f = await service();
    const [event] = await f.store.ingest([
      mail(f.source.id, 'm1', 'PayFast ```payment'),
    ]);
    const text = investigationMessage({
      app: 'Gmail',
      event,
      finding: {
        id: 'f',
        eventId: event.id,
        attention: true,
        category: 'payment',
        confidence: 0.93,
        reason: 'PayFast payment.',
        judgedBy: 'fake-jev',
        state: 'flagged',
        dotId: 'books',
        threadId: null,
        referencedEventId: null,
        error: null,
        urgency: null,
        asked: 'reply',
        injection: false,
        route: 'draft',
        delivery: null,
        note: null,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(text).toMatch(/payment, 93% sure/);
    expect(text).toMatch(/draft a reply/);
    expect(text).toMatch(/untrusted data/);
    // The item cannot close the code block it is quoted in.
    expect(text.match(/```/g)).toHaveLength(2);
  });
});

describe('read-only tools', () => {
  it('names every app tool a call would run', () => {
    expect(toolSlugs('COMPOSIO_SEARCH_TOOLS', {})).toEqual([]);
    expect(toolSlugs('GMAIL_FETCH_EMAILS', {})).toEqual(['GMAIL_FETCH_EMAILS']);
    expect(
      toolSlugs('COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'A' }, { tool_slug: 'B' }],
      }),
    ).toEqual(['A', 'B']);
    // A malformed call is refused rather than waved through.
    expect(toolSlugs('COMPOSIO_MULTI_EXECUTE_TOOL', {})).toEqual(['']);
  });

  it('refuses Composio tools that can change things in read-only turns', async () => {
    const execute = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const session = {
      tools: async () =>
        [
          'COMPOSIO_SEARCH_TOOLS',
          'COMPOSIO_MULTI_EXECUTE_TOOL',
          'COMPOSIO_REMOTE_WORKBENCH',
          'COMPOSIO_MANAGE_CONNECTIONS',
        ].map((name) => ({
          type: 'function',
          function: { name, parameters: { type: 'object' } },
        })),
      execute,
    } as unknown as Parameters<typeof composioTools>[0];
    const tools = await composioTools(
      session,
      async () => {},
      undefined,
      undefined,
      async (slug) => /_(FETCH|LIST|GET)_/.test(slug),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'COMPOSIO_SEARCH_TOOLS',
      'COMPOSIO_MULTI_EXECUTE_TOOL',
    ]);
    const multi = tools[1];
    const refused = (await multi.execute(
      {
        tools: [
          { tool_slug: 'QUICKBOOKS_LIST_INVOICES', arguments: {} },
          { tool_slug: 'QUICKBOOKS_CREATE_PAYMENT', arguments: {} },
        ],
      },
      detachedContext(),
    )) as { error: string };
    expect(refused.error).toMatch(/read-only.*QUICKBOOKS_CREATE_PAYMENT/);
    expect(execute).not.toHaveBeenCalled();
    await multi.execute(
      { tools: [{ tool_slug: 'QUICKBOOKS_LIST_INVOICES', arguments: {} }] },
      detachedContext(),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('gives a discovery turn only tools that read, and says so', async () => {
    const { db, store, workspace } = await testWorkspace();
    const runner = new ThreadRunner(db, 'owner');
    cleanup.push(() => runner.close());
    const engine = new DotEngine({
      store,
      workspace,
      config: {
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://unused.invalid/v1',
        voiceName: 'marin',
        slackUsers: [],
      },
      runner,
      delegate: async () => ({ threadId: 't', reply: '' }),
    });
    const [dot] = await workspace.dots();
    const thread = await workspace.bindThread(
      'thread',
      dot.id,
      'Gmail: PayFast',
      'discovery',
    );
    await runner.createThread({ threadId: thread.id, agentId: dot.id });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        completion({ role: 'assistant', content: 'What came in: ...' }),
      );
    const run = await (
      await engine.start({
        threadId: thread.id,
        message: {
          content: 'Discovery flagged this.',
          metadata: { opendotsSource: 'discovery' },
        },
      })
    ).done;
    expect(run.status).toBe('finished');
    expect(run.messages[0].id.startsWith(discoveryMessagePrefix)).toBe(true);
    const request = JSON.parse(String(network.mock.calls[0][1]?.body));
    const names = (request.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['list_space_pages', 'read_space_page']),
    );
    for (const name of [
      'create_space_page',
      'edit_space_page',
      'ask_dot',
      'request_approval',
    ])
      expect(names).not.toContain(name);
    const system = request.messages.find(
      (message: { role: string }) => message.role === 'system',
    );
    expect(system.content).toMatch(/discovery investigation/);
    expect(system.content).toMatch(/read-only tools only/);
  });
});

describe('discovery routes', () => {
  async function routes(composioApiKey?: string) {
    const { Platform } = await import('../src/server/platform.js');
    const { discoveryRoutes } =
      await import('../src/server/discovery/routes.js');
    const { store, workspace } = await testWorkspace();
    const platform = await Platform.create(store, workspace, {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      composioApiKey,
      typesafeApiKey: 'unused',
    });
    cleanup.push(() => platform.stop());
    const account = (id: string, toolkit: string) => ({
      id,
      toolkit,
      name: toolkit,
      status: 'ACTIVE',
      statusReason: null,
      alias: null,
      disabled: false,
      createdAt: '2026-11-11T08:00:00.000Z',
    });
    const service = {
      list: vi.fn(async () => [
        account('ca_gmail', 'gmail'),
        account('ca_qb', 'quickbooks'),
      ]),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.spyOn(platform.inbox, 'tick').mockResolvedValue(undefined);
    const app = discoveryRoutes(platform, () => service);
    const put = (id: string, body: unknown) =>
      app.request(`/discovery/accounts/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { app, put, platform, dot: (await workspace.dots())[0] };
  }

  it('turns discovery on per account and reports whether Jev is configured', async () => {
    const f = await routes('key');
    const on = await f.put('ca_gmail', { dotId: f.dot.id, enabled: true });
    expect(on.status).toBe(200);
    // Apps are off by default, so the Dot could only read the item itself.
    expect((await on.json()).warning).toMatch(/Connected apps/);
    const state = await (await f.app.request('/discovery')).json();
    expect(state.model).toEqual({ configured: true });
    expect(state.accounts).toEqual([
      expect.objectContaining({
        accountId: 'ca_gmail',
        toolkit: 'gmail',
        dotId: f.dot.id,
        enabled: true,
      }),
    ]);
    // Turning it off keeps the one source, disabled.
    await f.put('ca_gmail', { dotId: f.dot.id, enabled: false });
    const after = await (await f.app.request('/discovery')).json();
    expect(after.accounts).toEqual([
      expect.objectContaining({ enabled: false }),
    ]);
    expect(await f.platform.inbox.store.sources()).toHaveLength(1);
    expect((await f.platform.inbox.store.sources())[0].notify).toBe('off');
  });

  it('refuses apps it cannot read, unknown accounts and unknown Dots', async () => {
    const f = await routes('key');
    expect(
      (await f.put('ca_qb', { dotId: f.dot.id, enabled: true })).status,
    ).toBe(400);
    expect(
      (await f.put('ca_other', { dotId: f.dot.id, enabled: true })).status,
    ).toBe(404);
    expect(
      (await f.put('ca_gmail', { dotId: 'nope', enabled: true })).status,
    ).toBe(400);
    expect(
      (
        await f.app.request('/inbox/findings/nope/investigate', {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
  });
});

describe('discovery history routes', () => {
  async function routes() {
    const { Platform } = await import('../src/server/platform.js');
    const { discoveryRoutes } =
      await import('../src/server/discovery/routes.js');
    const { store, workspace } = await testWorkspace();
    const platform = await Platform.create(store, workspace, {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      embeddingBaseUrl: 'http://127.0.0.1:1/v1',
    });
    cleanup.push(() => platform.stop());
    const app = discoveryRoutes(platform, () => undefined);
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { app, send, platform, inbox: workspace.inbox };
  }

  it('reads and validates delivery settings', async () => {
    const f = await routes();
    const state = await (await f.app.request('/discovery')).json();
    expect(state.embeddings).toEqual({
      configured: true,
      model: 'nomic-embed-text',
    });
    expect(state.settings).toMatchObject({
      briefTime: '07:30',
      holdMinutes: 5,
    });
    const saved = await f.send('PUT', '/discovery/settings', {
      briefTime: '08:15',
      quietHours: null,
      trusted: ['Brightlane.co.za', 'me@example.com'],
      allowedApps: ['jira'],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      briefTime: '08:15',
      quietHours: null,
      trusted: ['brightlane.co.za', 'me@example.com'],
      allowedApps: ['jira'],
    });
    for (const bad of [
      { briefTime: '25:00' },
      { timeZone: 'Mars/Olympus' },
      { trusted: ['not an address'] },
      { holdMinutes: 500 },
      { extra: true },
    ])
      expect((await f.send('PUT', '/discovery/settings', bad)).status).toBe(
        400,
      );
  });

  it('lists links to review and records the owner answer', async () => {
    const f = await routes();
    const { source } = await f.inbox.create({
      name: 'Mail',
      kind: 'mail',
      type: 'webhook',
      config: {},
      notify: 'off',
      intervalSeconds: 0,
    });
    const [a, b] = await f.inbox.ingest(
      ['Invoice INV-2041', 'Reminder INV-2041'].map((title, index) => ({
        sourceId: source.id,
        externalId: `e${index}`,
        kind: 'mail',
        title,
        summary: '',
        raw: null,
        occurredAt: Date.now() + index,
      })),
    );
    await f.inbox.discovery.link(b.id, a.id, 0.6, 'review');
    const review = await (
      await f.app.request('/discovery/links/review')
    ).json();
    expect(review).toEqual([
      expect.objectContaining({
        eventId: b.id,
        status: 'review',
        item: expect.objectContaining({ title: 'Reminder INV-2041' }),
        other: expect.objectContaining({ title: 'Invoice INV-2041' }),
      }),
    ]);
    // Seen from the earlier item, the later one is the other end.
    const fromA = await (
      await f.app.request(`/inbox/events/${a.id}/links`)
    ).json();
    expect(fromA[0]).toMatchObject({
      eventId: a.id,
      otherEventId: b.id,
      other: { title: 'Reminder INV-2041' },
    });
    expect(
      (
        await f.send('POST', '/discovery/links', {
          eventId: a.id,
          otherEventId: b.id,
          status: 'rejected',
        })
      ).status,
    ).toBe(200);
    expect(
      await (await f.app.request('/discovery/links/review')).json(),
    ).toEqual([]);
    // A later judgment never brings a rejected link back.
    await f.inbox.discovery.link(b.id, a.id, 0.9, 'linked');
    expect((await f.inbox.discovery.links(a.id))[0].status).toBe('rejected');
    expect(
      (
        await f.send('POST', '/discovery/links', {
          eventId: 'x',
          otherEventId: 'y',
          status: 'confirmed',
        })
      ).status,
    ).toBe(404);
    const brief = await (await f.app.request('/discovery/brief')).json();
    expect(brief).toEqual({ next: [], last: null });
  });
});

describe('owner organisation', () => {
  it('tells Jev a sender is a colleague only when the owner listed their domains', async () => {
    const { fromOwner } = await import('../src/server/discovery/service.js');
    expect(fromOwner('Jo <jo@brightlane.co.za>', ['brightlane.co.za'])).toBe(
      true,
    );
    expect(fromOwner('x@mail.brightlane.co.za', ['brightlane.co.za'])).toBe(
      true,
    );
    expect(fromOwner('me@gmail.com', ['me@gmail.com'])).toBe(true);
    expect(fromOwner('naledi@greenbasket.co.za', ['brightlane.co.za'])).toBe(
      false,
    );
    const states: unknown[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      states.push(JSON.parse(String(init?.body)).state);
      return new Response(
        JSON.stringify({
          model: 'jev',
          usage: {},
          answers: {
            attention: { type: 'noul', noul: 0.2 },
            category: {
              type: 'choice',
              choice: 'other',
              confidence: 1,
              probabilities: {},
            },
            urgency: {
              type: 'score',
              score: 0,
              confidence: 1,
              legend: {},
              probabilities: { 0: 1 },
            },
            asks_anything: { type: 'noul', noul: 0.1 },
            what_asked: {
              type: 'choice',
              choice: 'reply',
              confidence: 1,
              probabilities: {},
            },
            injection: { type: 'noul', noul: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    const judge = jevJudge({ apiKey: 'unused', fetch, compression: false });
    const item = {
      app: 'Teams',
      kind: 'message',
      from: 'jo@brightlane.co.za',
      title: 'Hi',
      summary: 'Hi',
    };
    await judge.judge({ ...item, fromOwner: true }, [], signal);
    await judge.judge(item, [], signal);
    expect(states).toEqual([
      { new_item: expect.objectContaining({ from_owner_organisation: true }) },
      {
        new_item: expect.not.objectContaining({
          from_owner_organisation: expect.anything(),
        }),
      },
    ]);
  });
});
