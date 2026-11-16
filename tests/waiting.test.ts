import { describe, expect, it } from 'vitest';
import { MemoryService } from '../src/server/memory/service.js';
import { InboxStore } from '../src/server/inbox/store.js';
import { DiscoveryService } from '../src/server/discovery/service.js';
import { DeliveryService } from '../src/server/discovery/delivery.js';
import { NUDGE_AFTER_MS } from '../src/server/discovery/waiting.js';
import {
  recipientOf,
  sentByOwner,
} from '../src/server/inbox/account-source.js';
import type { Judge } from '../src/server/discovery/classifier.js';
import type { InboxEvent } from '../src/server/inbox/source.js';
import type { PushMessage } from '../src/server/push.js';
import { testDb } from './fixtures/db.js';

const DAY = 86_400_000;

async function fixture(judge: Judge) {
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
  const discovery = new DiscoveryService(store, {
    judge: () => judge,
    investigate: async ({ event }) => ({ threadId: `t-${event.id}` }),
    autoInvestigate: false,
    memory: new MemoryService(store, { ownerId: 'owner' }),
  });
  const deliver = async (events: InboxEvent[]) => {
    const fresh = await store.ingest(events);
    discovery.listener({
      source: (await store.source(source.id))!,
      events: fresh,
      initial: false,
    });
    await discovery.idle();
    return fresh;
  };
  const mail = (
    id: string,
    title: string,
    labels: string[],
    at: number,
  ): InboxEvent => ({
    sourceId: source.id,
    externalId: id,
    kind: 'mail.received',
    title,
    summary: `${title} body`,
    from: labels.includes('SENT') ? 'me@example.com' : 'thandi@example.com',
    raw: { labelIds: labels, to: 'thandi@example.com' },
    occurredAt: at,
  });
  return { store, deliver, mail };
}

/** Sent mail asks for something when its title says "please"; a reply is the same thing. */
const judge: Judge = {
  name: 'fake',
  async awaiting(item) {
    return /please/i.test(item.title) ? 0.9 : 0.1;
  },
  async judge(item, history) {
    return {
      attention: true,
      category: 'request',
      confidence: 0.9,
      reason: 'A reply.',
      urgency: 'tomorrow',
      asked: 'reply',
      injection: false,
      related: history.map((entry) => ({
        eventId: entry.event.id,
        same: 1,
        resolves: 0,
        escalates: 0,
        useful: 0,
        contradicts: 0,
      })),
    };
  },
};

describe('waiting on others', () => {
  it('reads Gmail labels and recipients', () => {
    expect(sentByOwner({ labelIds: ['SENT'] })).toBe(true);
    expect(sentByOwner({ labelIds: ['SENT', 'INBOX'] })).toBe(false);
    expect(sentByOwner({})).toBe(false);
    expect(recipientOf({ to: ['a@x.co', 'b@x.co'] })).toBe('a@x.co, b@x.co');
    expect(recipientOf({})).toBeNull();
  });

  it('remembers what you sent that asks for something, without flagging it', async () => {
    const { store, deliver, mail } = await fixture(judge);
    const [asked, thanks] = await deliver([
      mail(
        's1',
        'Please send the signed quote',
        ['SENT'],
        Date.now() - 5 * DAY,
      ),
      mail('s2', 'Thanks, got it', ['SENT'], Date.now() - 5 * DAY),
    ]);
    const waiting = await store.discovery.waiting.list();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      eventId: asked.id,
      who: 'thandi@example.com',
      title: 'Please send the signed quote',
    });
    // Sent mail is never flagged for the owner.
    expect((await store.findingForEvent(asked.id))?.attention).toBe(false);
    expect((await store.findingForEvent(thanks.id))?.attention).toBe(false);
  });

  it('ends the wait when a reply arrives, and lets the owner stop waiting', async () => {
    const { store, deliver, mail } = await fixture(judge);
    const [asked] = await deliver([
      mail(
        's1',
        'Please send the signed quote for invoice INV-2041',
        ['SENT'],
        Date.now() - 4000,
      ),
    ]);
    await deliver([
      mail(
        'r1',
        'Re: quote for invoice INV-2041',
        ['INBOX'],
        Date.now() - 1000,
      ),
    ]);
    expect(await store.discovery.waiting.list()).toEqual([]);
    const [answered] = await store.discovery.waiting.list('answered');
    expect(answered.eventId).toBe(asked.id);

    await deliver([
      mail('s3', 'Please confirm the date', ['SENT'], Date.now()),
    ]);
    const [open] = await store.discovery.waiting.list();
    expect(await store.discovery.waiting.dismiss(open.id)).toBe(true);
    expect(await store.discovery.waiting.list()).toEqual([]);
  });

  it('mentions an overdue wait once, in the brief, and not before', async () => {
    const { store, deliver, mail } = await fixture(judge);
    await deliver([
      mail('s1', 'Please send the signed quote', ['SENT'], Date.now()),
    ]);
    const sent: PushMessage[] = [];
    let now = Date.now();
    const delivery = new DeliveryService(
      store.discovery,
      async (message) => void sent.push(message),
      { now: () => now },
    );
    await delivery.tick();
    expect(await store.discovery.pushes('brief')).toHaveLength(0);
    now += NUDGE_AFTER_MS + 1000;
    await delivery.tick();
    const held = await store.discovery.pushes('brief');
    expect(held.map((push) => push.title)).toEqual([
      'Still waiting on a reply',
    ]);
    // Told once only.
    await delivery.tick();
    expect(await store.discovery.pushes('brief')).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});
