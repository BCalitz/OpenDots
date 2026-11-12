import { describe, expect, it } from 'vitest';
import { InboxStore } from '../src/server/inbox/store.js';
import type { InboxEvent } from '../src/server/inbox/source.js';
import type { Judge, Verdict } from '../src/server/discovery/classifier.js';
import { DiscoveryService } from '../src/server/discovery/service.js';
import {
  DeliveryService,
  proposalCategory,
} from '../src/server/discovery/delivery.js';
import {
  DISMISSALS_TO_QUIET,
  ProposalClosedError,
  ProposalService,
  importanceOf,
  nextLocal,
  proposalOptions,
  quietedBySender,
} from '../src/server/discovery/proposals.js';
import type { PushMessage } from '../src/server/push.js';
import type { ApprovalView } from '../src/shared/approvals.js';
import { testDb } from './fixtures/db.js';

describe('proposal rules', () => {
  it('offers "Handle it" only where the Dot may act', () => {
    expect(proposalOptions('draft')).toEqual(['prepare', 'handle', 'not_now']);
    expect(proposalOptions('propose')).toEqual([
      'prepare',
      'handle',
      'not_now',
    ]);
    expect(proposalOptions('inform')).toEqual(['prepare', 'not_now']);
    expect(proposalOptions('decide')).toEqual(['prepare', 'not_now']);
    expect(proposalOptions(null)).toEqual(['prepare', 'not_now']);
  });

  it('sorts by urgency, then confidence', () => {
    expect(importanceOf('hours', 0.6)).toBeGreaterThan(
      importanceOf('today', 0.99),
    );
    expect(importanceOf('today', 0.9)).toBeGreaterThan(
      importanceOf('today', 0.7),
    );
  });

  it('quiets a sender the owner keeps dismissing, but never urgent or injected items', () => {
    const plain = { urgency: 'today' as const, injection: false };
    expect(quietedBySender({ dismissed: 1, acted: 0 }, plain)).toBe(false);
    expect(
      quietedBySender({ dismissed: DISMISSALS_TO_QUIET, acted: 0 }, plain),
    ).toBe(true);
    expect(quietedBySender({ dismissed: 5, acted: 1 }, plain)).toBe(false);
    expect(
      quietedBySender(
        { dismissed: 5, acted: 0 },
        { ...plain, urgency: 'hours' },
      ),
    ).toBe(false);
    expect(
      quietedBySender(
        { dismissed: 5, acted: 0 },
        { ...plain, injection: true },
      ),
    ).toBe(false);
  });

  it('snoozes until the next local brief time', () => {
    // 2026-01-15 10:00 UTC is 12:00 in Johannesburg; 07:30 is tomorrow.
    const at = Date.UTC(2026, 0, 15, 10, 0);
    expect(nextLocal(at, '07:30', 'Africa/Johannesburg')).toBe(
      Date.UTC(2026, 0, 16, 5, 30),
    );
    expect(nextLocal(at, '14:00', 'Africa/Johannesburg')).toBe(
      Date.UTC(2026, 0, 15, 12, 0),
    );
  });

  it('shows buttons only while the owner can still choose', () => {
    const options = proposalOptions('draft');
    expect(proposalCategory({ state: 'open', options })).toBe('proposal');
    expect(
      proposalCategory({ state: 'open', options: proposalOptions('decide') }),
    ).toBe('proposal_prepare');
    expect(proposalCategory({ state: 'prepared', options })).toBe(
      'proposal_prepared',
    );
    expect(
      proposalCategory({
        state: 'prepared',
        options: proposalOptions('decide'),
      }),
    ).toBeUndefined();
    expect(proposalCategory({ state: 'dismissed', options })).toBeUndefined();
    expect(proposalCategory({ state: 'handling', options })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  attention: true,
  category: 'ticket',
  confidence: 0.9,
  reason: 'A high-priority ticket.',
  urgency: 'hours',
  asked: 'reply',
  injection: false,
  related: [],
  ...overrides,
});

async function setup(script: (title: string) => Verdict) {
  const store = new InboxStore(await testDb());
  const { source } = await store.create({
    name: 'Gmail',
    kind: 'mail',
    type: 'account',
    config: {
      dotId: 'ops',
      userId: 'owner',
      accountId: 'ca_gmail',
      app: 'gmail',
    },
    notify: 'off',
    intervalSeconds: 300,
  });
  const judge: Judge = {
    name: 'scripted',
    judge: async (item) => script(item.title),
  };
  const sent: PushMessage[] = [];
  let clock = Date.UTC(2026, 0, 15, 10, 0);
  const now = () => clock;
  const send = async (message: PushMessage) => {
    sent.push(message);
  };
  const delivery = new DeliveryService(store.discovery, send, { now });
  const runs: { threadId: string; prompt: string; source: unknown }[] = [];
  let gate: Promise<void> | undefined;
  const proposals = new ProposalService(store.discovery.proposals, {
    run: async (threadId, prompt, metadata) => {
      runs.push({ threadId, prompt, source: metadata.opendotsSource });
      await gate;
      return `${String(metadata.opendotsSource)} done for ${threadId}`;
    },
    notify: send,
    cancelPushes: (findingId) => store.discovery.cancelPushes(findingId),
    settings: () => store.discovery.settings(),
    now,
  });
  const discovery = new DiscoveryService(store, {
    judge: () => judge,
    investigate: async ({ event }) => ({
      threadId: `thread-${event.externalId}`,
      reply: `What came in: ${event.title}. What I suggest: reply today.`,
    }),
    delivery,
    proposals,
    dotName: async () => 'Ops',
  });
  let n = 0;
  const item = (
    title: string,
    extra: Partial<InboxEvent> = {},
  ): InboxEvent => ({
    sourceId: source.id,
    externalId: `m${++n}`,
    kind: 'mail.received',
    title,
    summary: '',
    from: 'Client X <ops@clientx.example>',
    raw: {},
    occurredAt: Date.now() - 1000 + n,
    ...extra,
  });
  const deliver = async (events: InboxEvent[]) => {
    const fresh = await store.ingest(events);
    discovery.listener({ source, events: fresh, initial: false });
    await discovery.idle();
    return fresh;
  };
  const finding = async (title: string) =>
    (await store.events({})).find((event) => event.title === title)!.finding!;
  const proposal = async (title: string) =>
    (await store.discovery.proposals.forFinding((await finding(title)).id))!;
  return {
    store,
    sent,
    runs,
    proposals,
    delivery,
    item,
    deliver,
    finding,
    proposal,
    advance: (ms: number) => {
      clock += ms;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('proposals', () => {
  it('turns an investigated item into a proposal and asks from the push', async () => {
    const f = await setup(() => verdict());
    await f.deliver([f.item('Payment export failing for client X')]);
    const proposal = await f.proposal('Payment export failing for client X');
    expect(proposal).toMatchObject({
      state: 'open',
      title: 'Gmail: Payment export failing for client X',
      options: ['prepare', 'handle', 'not_now'],
      urgency: 'hours',
      route: 'draft',
      sender: 'ops@clientx.example',
      threadId: 'thread-m1',
    });
    expect(proposal.summary).toContain('What I suggest');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      title: 'Urgent: Ops: a draft reply is ready',
      body: 'Want me to prepare it for you, or handle it?',
      data: { threadId: 'thread-m1', proposalId: proposal.id },
      categoryId: 'proposal',
    });
    expect(await f.store.discovery.proposals.list()).toHaveLength(1);
  });

  it('prepares, then handles, in the proposal’s own conversation', async () => {
    const f = await setup(() => verdict());
    await f.deliver([f.item('Payment export failing')]);
    const { id } = await f.proposal('Payment export failing');
    expect((await f.proposals.decide(id, 'prepare')).state).toBe('preparing');
    // A second choice while it runs is refused.
    await expect(f.proposals.decide(id, 'prepare')).rejects.toThrow(
      ProposalClosedError,
    );
    await f.proposals.idle();
    expect(f.runs[0]).toMatchObject({
      threadId: 'thread-m1',
      source: 'prepare',
    });
    expect(f.runs[0].prompt).toContain('Nothing may leave OpenDots');
    const prepared = (await f.store.discovery.proposals.get(id))!;
    expect(prepared).toMatchObject({ state: 'prepared', decision: 'prepare' });
    expect(f.sent.at(-1)).toMatchObject({
      title: 'Ready: plan and drafts to review',
      data: { threadId: 'thread-m1', proposalId: id },
      categoryId: 'proposal_prepared',
    });

    await f.proposals.decide(id, 'handle');
    await f.proposals.idle();
    expect(f.runs[1]).toMatchObject({ source: 'handle' });
    expect(f.runs[1].prompt).toContain('the plan you prepared');
    expect((await f.store.discovery.proposals.get(id))!.state).toBe('handled');
    expect(f.sent.at(-1)?.title).toBe('Done: see what was handled');
  });

  it('pushes when handling needs an approval', async () => {
    const f = await setup(() => verdict());
    await f.deliver([f.item('Grant app access to Lerato')]);
    const { id, threadId } = await f.proposal('Grant app access to Lerato');
    const release = f.hold();
    await f.proposals.decide(id, 'handle');
    await f.proposals.approvalRequested({ threadId } as ApprovalView);
    expect(f.sent.at(-1)).toMatchObject({
      title: 'Approval needed',
      data: { threadId },
    });
    release();
    await f.proposals.idle();
    // Once handled, approvals in that conversation are ordinary chat.
    const before = f.sent.length;
    await f.proposals.approvalRequested({ threadId } as ApprovalView);
    expect(f.sent.length).toBe(before);
  });

  it('offers no "Handle it" where the Dot may not act', async () => {
    const f = await setup(() => verdict({ asked: 'decision' }));
    await f.deliver([f.item('Contract terms for renewal')]);
    const proposal = await f.proposal('Contract terms for renewal');
    expect(proposal.options).toEqual(['prepare', 'not_now']);
    expect(f.sent[0]).toMatchObject({
      body: 'Want me to prepare it for you?',
      categoryId: 'proposal_prepare',
    });
    await expect(f.proposals.decide(proposal.id, 'handle')).rejects.toThrow(
      'no action',
    );
  });

  it('snoozes, cancels the waiting push, and asks again later', async () => {
    const f = await setup(() => verdict({ urgency: 'today' }));
    await f.deliver([f.item('Quote for the new site')]);
    const { id } = await f.proposal('Quote for the new site');
    // "Today" waits for the hold window; snoozing inside it cancels the push.
    expect(f.sent).toHaveLength(0);
    const snoozed = await f.proposals.decide(id, 'snooze', 'later');
    expect(snoozed.state).toBe('snoozed');
    expect(snoozed.snoozeUntil).toBe(Date.UTC(2026, 0, 15, 13, 0));
    f.advance(10 * 60_000);
    await f.delivery.tick();
    expect(f.sent).toHaveLength(0);
    f.advance(3 * 60 * 60_000);
    await f.delivery.tick();
    expect((await f.store.discovery.proposals.get(id))!.state).toBe('open');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      title: 'Back from snooze',
      data: { proposalId: id },
      categoryId: 'proposal',
    });
  });

  it('does not ask from a push once the owner chose in the app', async () => {
    const f = await setup(() => verdict({ urgency: 'today' }));
    await f.deliver([f.item('Lunch order for Friday')]);
    const { id } = await f.proposal('Lunch order for Friday');
    // Decided between queueing and sending, bypassing the cancel.
    await f.store.discovery.proposals.transition(id, ['open'], 'dismissed', {
      decision: 'dismiss',
    });
    f.advance(10 * 60_000);
    await f.delivery.tick();
    expect(f.sent).toHaveLength(0);
  });

  it('stops flagging a sender the owner keeps dismissing, until the rule is forgotten', async () => {
    const f = await setup((title) =>
      verdict({ urgency: title.includes('down') ? 'hours' : 'today' }),
    );
    for (const title of ['Newsletter one', 'Newsletter two']) {
      await f.deliver([f.item(title)]);
      await f.proposals.decide((await f.proposal(title)).id, 'dismiss');
    }
    expect(
      await f.store.discovery.proposals.rules(DISMISSALS_TO_QUIET),
    ).toMatchObject([{ sender: 'ops@clientx.example', dismissed: 2 }]);

    await f.deliver([f.item('Newsletter three')]);
    const quiet = await f.finding('Newsletter three');
    expect(quiet).toMatchObject({ attention: false, state: 'ignored' });
    expect(quiet.reason).toContain('you dismissed recent items');
    // Within hours still gets through.
    await f.deliver([f.item('Site is down')]);
    expect((await f.finding('Site is down')).attention).toBe(true);
    // Another sender is not affected.
    await f.deliver([
      f.item('Newsletter from elsewhere', { from: 'news@other.example' }),
    ]);
    expect((await f.finding('Newsletter from elsewhere')).attention).toBe(true);

    await f.store.discovery.proposals.forgetRule('ops@clientx.example');
    expect(
      await f.store.discovery.proposals.rules(DISMISSALS_TO_QUIET),
    ).toEqual([]);
    await f.deliver([f.item('Newsletter four')]);
    expect((await f.finding('Newsletter four')).attention).toBe(true);
  });

  it('brings a dismissed proposal back when its conversation gets a follow-up', async () => {
    const f = await setup(() => verdict());
    await f.deliver([f.item('Invoice INV-77')]);
    const first = await f.proposal('Invoice INV-77');
    await f.proposals.decide(first.id, 'dismiss');
    const again = await f.store.discovery.proposals.save({
      findingId: first.findingId,
      eventId: first.eventId,
      dotId: first.dotId,
      threadId: first.threadId,
      title: 'Gmail: Reminder: invoice INV-77 overdue',
      summary: 'Now overdue.',
      options: first.options,
      importance: 1,
      urgency: 'today',
      route: 'draft',
      sender: first.sender,
    });
    expect(again).toMatchObject({
      id: first.id,
      state: 'open',
      decision: null,
      title: 'Gmail: Reminder: invoice INV-77 overdue',
      // Importance never drops on a follow-up.
      importance: first.importance,
    });
  });

  it('marks work a restart interrupted as failed, so it can be chosen again', async () => {
    const f = await setup(() => verdict());
    await f.deliver([f.item('Payment export failing')]);
    const { id } = await f.proposal('Payment export failing');
    await f.store.discovery.proposals.transition(id, ['open'], 'preparing');
    await f.proposals.start();
    expect((await f.store.discovery.proposals.get(id))!.state).toBe('failed');
    expect((await f.proposals.decide(id, 'prepare')).state).toBe('preparing');
    await f.proposals.idle();
  });
});
