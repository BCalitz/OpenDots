import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxStore } from '../src/server/inbox/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { attentionTools } from '../src/server/attention-tools.js';
import { detachedContext } from '../src/server/engine/tools.js';
import { DiscoveryService } from '../src/server/discovery/service.js';
import { DeliveryService } from '../src/server/discovery/delivery.js';
import { jevJudge, type Judge } from '../src/server/discovery/classifier.js';
import type { Urgency } from '../src/shared/inbox-types.js';
import type { PushMessage } from '../src/server/push.js';
import { testDb } from './fixtures/db.js';

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;

async function fixture() {
  const store = new InboxStore(await testDb());
  const { source } = await store.create({
    name: 'Gmail',
    kind: 'mail',
    type: 'account',
    config: {
      dotId: 'books',
      userId: 'owner',
      accountId: 'ca_gmail',
      app: 'gmail',
    },
    notify: 'off',
    intervalSeconds: 300,
  });
  return { store, source };
}

/** Says an item is about a subject when its title names it. */
const judgeBy = (
  options: { urgency?: Urgency; fraud?: boolean } = {},
): Judge => ({
  name: 'fake-jev',
  async judge(item) {
    const named = (subjects: string[] = []) =>
      subjects.filter((subject) =>
        item.title.toLowerCase().includes(subject.toLowerCase()),
      );
    return {
      attention: true,
      category: 'payment',
      confidence: 0.9,
      reason: 'A payment.',
      urgency: options.urgency ?? 'tomorrow',
      asked: 'reply',
      injection: false,
      fraud: options.fraud,
      matches: {
        focus: named(item.attention?.focus),
        mute: named(item.attention?.mute),
      },
      related: [],
    };
  },
});

async function judged(
  title: string,
  judge: Judge,
  setup: (store: InboxStore) => Promise<unknown>,
) {
  const { store, source } = await fixture();
  await setup(store);
  const discovery = new DiscoveryService(store, {
    judge: () => judge,
    investigate: async ({ event }) => ({ threadId: `thread-${event.id}` }),
    autoInvestigate: false,
  });
  const fresh = await store.ingest([
    {
      sourceId: source.id,
      externalId: title,
      kind: 'mail.received',
      title,
      summary: `${title} body`,
      from: 'sender@example.com',
      raw: {},
      occurredAt: Date.now(),
    },
  ]);
  discovery.listener({
    source: (await store.source(source.id))!,
    events: fresh,
    initial: false,
  });
  await discovery.idle();
  return (await store.findingForEvent(fresh[0].id))!;
}

describe('focus, mute and away entries', () => {
  it('saves, renews, lists and lifts them, and drops them when they end', async () => {
    const { store } = await fixture();
    const first = await store.attention.save({
      kind: 'focus',
      text: 'Focusing on GreenBasket',
      subject: 'GreenBasket',
      until: Date.now() + DAY,
    });
    const again = await store.attention.save({
      kind: 'focus',
      text: 'Still focusing on GreenBasket',
      subject: 'greenbasket',
      until: Date.now() + 2 * DAY,
    });
    expect(again.id).toBe(first.id);
    await store.attention.save({
      kind: 'note',
      text: 'I am not a business man',
    });
    await store.attention.save({
      kind: 'mute',
      text: 'Old mute',
      subject: 'receipts',
      until: Date.now() - 1000,
    });
    // Notes never reach discovery; ended entries are gone.
    expect((await store.attention.active()).map((e) => e.kind)).toEqual([
      'focus',
    ]);
    expect((await store.attention.list()).map((e) => e.kind).sort()).toEqual([
      'focus',
      'note',
    ]);
    expect(await store.attention.lift(first.id)).toBe(true);
    expect(await store.attention.active()).toEqual([]);
  });

  it('keeps a muted item out of the flags, but not fraud or anything needed within hours', async () => {
    const mute = (store: InboxStore) =>
      store.attention.save({
        kind: 'mute',
        text: 'Payment notices are not important',
        subject: 'payment',
      });
    const quiet = await judged('Payment received', judgeBy(), mute);
    expect(quiet).toMatchObject({ attention: false, state: 'ignored' });
    expect(quiet.reason).toMatch(/^Muted/);
    const fraud = await judged(
      'Payment details changed',
      judgeBy({ fraud: true }),
      mute,
    );
    expect(fraud.attention).toBe(true);
    const urgent = await judged(
      'Payment overdue',
      judgeBy({ urgency: 'hours' }),
      mute,
    );
    expect(urgent.attention).toBe(true);
  });

  it('raises the urgency of what the owner is focusing on, and it wins over a mute', async () => {
    const entries = (store: InboxStore) =>
      Promise.all([
        store.attention.save({
          kind: 'focus',
          text: 'Focusing on GreenBasket',
          subject: 'GreenBasket',
        }),
        store.attention.save({
          kind: 'mute',
          text: 'Payments are not important',
          subject: 'payment',
        }),
      ]);
    const focused = await judged(
      'GreenBasket payment',
      judgeBy({ urgency: 'tomorrow' }),
      entries,
    );
    expect(focused).toMatchObject({ attention: true, urgency: 'today' });
    expect(focused.reason).toMatch(/^Focus/);
    const plain = await judged('Other payment', judgeBy(), entries);
    expect(plain.attention).toBe(false);
  });
});

describe('delivery while focusing or away', () => {
  async function deliveryFor(urgency: Urgency) {
    const { store, source } = await fixture();
    const [event] = await store.ingest([
      {
        sourceId: source.id,
        externalId: 'e1',
        kind: 'mail.received',
        title: 'Invoice',
        summary: 'Invoice body',
        from: 'sender@example.com',
        raw: {},
        occurredAt: Date.now(),
      },
    ]);
    const finding = await store.saveFinding({
      eventId: event.id,
      attention: true,
      category: 'invoice',
      confidence: 0.9,
      reason: 'An invoice.',
      judgedBy: 'fake',
      dotId: 'books',
      urgency,
      asked: 'reply',
      route: 'inform',
    });
    const sent: PushMessage[] = [];
    const delivery = new DeliveryService(
      store.discovery,
      async (message) => void sent.push(message),
    );
    const deliver = (attention: { focused?: boolean; away?: boolean }) =>
      delivery.deliver(
        finding,
        { ...event, sourceName: 'Gmail' } as never,
        'Dot',
        undefined,
        attention,
      );
    return { deliver };
  }

  it('holds pushes for the brief while away, except focus and urgent ones', async () => {
    const { deliver } = await deliveryFor('today');
    expect(await deliver({})).toBe('held');
    expect(await deliver({ away: true })).toBe('brief');
    expect(await deliver({ away: true, focused: true })).toBe('held');
    const urgent = await deliveryFor('hours');
    expect(await urgent.deliver({ away: true })).toBe('now');
  });

  it('pushes what the owner is focusing on instead of leaving it for the brief', async () => {
    const { deliver } = await deliveryFor('days');
    expect(await deliver({})).toBe('brief');
    expect(await deliver({ focused: true })).toBe('held');
  });
});

describe('asking Jev', () => {
  it('adds one yes/no question per focus and mute subject, and reads the answers', async () => {
    let body: { questions: Record<string, unknown> } | undefined;
    const answers: Record<string, unknown> = {
      attention: { type: 'noul', noul: 0.9 },
      category: { type: 'choice', choice: 'payment', probabilities: {} },
      urgency: { type: 'score', score: 1, probabilities: { 1: 1 } },
      asks_anything: { type: 'noul', noul: 0.9 },
      what_asked: { type: 'choice', choice: 'reply', probabilities: {} },
      fraud: { type: 'noul', noul: 0.8 },
      injection: { type: 'noul', noul: 0.1 },
      focus__0: { type: 'noul', noul: 0.95 },
      mute__0: { type: 'noul', noul: 0.1 },
      mute__1: { type: 'noul', noul: 0.9 },
    };
    const judge = jevJudge({
      apiKey: 'k',
      compression: false,
      fetch: (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ model: 'jev', answers, usage: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const verdict = await judge.judge(
      {
        title: 'Hello',
        summary: 'Hello',
        from: 'a@b.c',
        kind: 'mail.received',
        app: 'Gmail',
        attention: {
          focus: ['GreenBasket'],
          mute: ['newsletters', 'payment notices'],
        },
      },
      [],
      new AbortController().signal,
    );
    expect(Object.keys(body!.questions)).toEqual(
      expect.arrayContaining(['focus__0', 'mute__0', 'mute__1', 'fraud']),
    );
    expect(verdict.matches).toEqual({
      focus: ['GreenBasket'],
      mute: ['payment notices'],
    });
    expect(verdict.fraud).toBe(true);
  });
});

describe('chat tools', () => {
  it('save, list and lift entries, and link two inbox items', async () => {
    const workspace = await WorkspaceStore.open(await testDb(), 'owner');
    const inbox = workspace.inbox;
    const { source } = await inbox.create({
      type: 'webhook',
      name: 'Mail',
      kind: 'mail',
      notify: 'urgent',
      config: {},
      intervalSeconds: 0,
    });
    const [one, two] = await inbox.ingest(
      ['one', 'two'].map((id) => ({
        sourceId: source.id,
        externalId: id,
        kind: 'mail.received',
        title: `Invoice ${id}`,
        summary: 'Invoice',
        from: 'a@example.com',
        occurredAt: Date.now(),
        raw: null,
      })),
    );
    const [save, list, lift, link] = attentionTools(
      workspace,
      async () => undefined,
    );
    const run = (tool: typeof save, input: unknown) =>
      tool.execute(input, detachedContext()) as Promise<
        Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      >;

    expect(await run(save, { kind: 'mute', text: 'Not payments' })).toEqual({
      error: 'A mute needs a subject: what is it about?',
    });
    expect(await run(save, { kind: 'away', text: 'Away' })).toMatchObject({
      error: expect.stringMatching(/how long/i),
    });
    const focus = await run(save, {
      kind: 'focus',
      text: 'Focusing on GreenBasket',
      subject: 'GreenBasket',
    });
    // A focus lasts a week unless said otherwise.
    const until = new Date(focus.saved.until).getTime();
    expect(Math.abs(until - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    expect((await run(list, {})).entries).toHaveLength(1);
    expect(await run(lift, { id: focus.saved.id })).toEqual({ lifted: true });
    expect((await run(list, {})).entries).toHaveLength(0);

    expect(
      await run(link, { itemId: one.id, otherItemId: one.id }),
    ).toMatchObject({ error: expect.any(String) });
    expect(await run(link, { itemId: one.id, otherItemId: two.id })).toEqual({
      linked: ['Invoice one', 'Invoice two'],
    });
    const links = await inbox.discovery.links(one.id);
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe('confirmed');
  });
});

describe('learned mute suggestions', () => {
  async function dismissed(category: string, count: number, acted = 0) {
    const { store, source } = await fixture();
    const events = await store.ingest(
      Array.from({ length: count + acted }, (_, i) => ({
        sourceId: source.id,
        externalId: `${category}-${i}`,
        kind: 'mail.received',
        title: `${category} ${i}`,
        summary: 'body',
        from: `s${i}@example.com`,
        raw: {},
        occurredAt: Date.now(),
      })),
    );
    for (const [i, event] of events.entries()) {
      const finding = await store.saveFinding({
        eventId: event.id,
        attention: true,
        category,
        confidence: 0.9,
        reason: 'x',
        judgedBy: 'fake',
        dotId: 'books',
        route: 'inform',
      });
      const proposal = await store.discovery.proposals.save({
        findingId: finding.id,
        eventId: event.id,
        dotId: 'books',
        threadId: `thread-${category}-${i}`,
        title: event.title,
        summary: 's',
        options: ['prepare', 'not_now'],
        importance: 1,
        urgency: 'tomorrow',
        route: 'inform',
        sender: `s${i}@example.com`,
      });
      await store.discovery.proposals.transition(
        proposal.id,
        ['open'],
        'dismissed',
        { decision: i < count ? 'dismiss' : 'prepare' },
      );
    }
    return store;
  }

  it('offers a mute after three dismissals and no action, and mutes on yes', async () => {
    const store = await dismissed('payment', 3);
    const [offer] = await store.attention.suggestions();
    expect(offer).toMatchObject({
      category: 'payment',
      subject: 'payment notifications',
      dismissed: 3,
    });
    await store.attention.acceptSuggestion('payment');
    expect(await store.attention.suggestions()).toEqual([]);
    expect((await store.attention.active()).map((e) => e.subject)).toEqual([
      'payment notifications',
    ]);
  });

  it('stays quiet when the owner acted on one, after a no, and for security mail', async () => {
    expect(
      await (await dismissed('payment', 3, 1)).attention.suggestions(),
    ).toEqual([]);
    const declined = await dismissed('invoice', 3);
    await declined.attention.declineSuggestion('invoice');
    expect(await declined.attention.suggestions()).toEqual([]);
    expect(
      await (await dismissed('security', 5)).attention.suggestions(),
    ).toEqual([]);
  });
});
