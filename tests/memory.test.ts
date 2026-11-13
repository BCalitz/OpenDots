import { expect, it, vi } from 'vitest';
import { sql } from '../src/server/db/index.js';
import type { Judge } from '../src/server/discovery/classifier.js';
import { InboxStore } from '../src/server/inbox/store.js';
import type { InboxEvent } from '../src/server/inbox/source.js';
import { MemoryService } from '../src/server/memory/service.js';
import { testDb } from './fixtures/db.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 9);

async function setup(options: { judge?: Judge } = {}) {
  const db = await testDb();
  const store = new InboxStore(db);
  const { source } = await store.create({
    name: 'Mail',
    kind: 'mail',
    type: 'webhook',
    config: {},
    notify: 'off',
    intervalSeconds: 0,
  });
  await store.discovery.updateSettings({
    trusted: ['brightlane.example'],
    timeZone: 'UTC',
  });
  let now = NOW;
  const memory = new MemoryService(store, {
    ownerId: 'owner',
    judge: () => options.judge,
    now: () => now,
  });
  let n = 0;
  const ingest = async (
    event: Partial<InboxEvent> & { title: string },
    receivedAt = now,
  ) => {
    const [view] = await store.ingest(
      [
        {
          sourceId: source.id,
          externalId: `m${++n}`,
          kind: 'mail.received',
          summary: '',
          raw: null,
          occurredAt: receivedAt,
          ...event,
        },
      ],
      receivedAt,
    );
    return view;
  };
  const find = async (query: string) => {
    const [entity] = await store.memory.search('owner', { query });
    return entity && (await store.memory.entity('owner', entity.id));
  };
  return {
    db,
    store,
    memory,
    source,
    ingest,
    find,
    distill: async () => memory.distill(await store.discovery.settings()),
    setNow: (value: number) => (now = value),
  };
}

it('distills items into people, companies, invoices and projects', async () => {
  const { store, ingest, distill, find } = await setup();
  const first = await ingest({
    title: 'Invoice INV-2041 for Project Falcon',
    summary: 'Amount due: R 1,200.00 by Friday.',
    from: 'Thandi Nkosi <thandi@acme.example>',
  });
  await ingest({
    title: 'Re: inv 2041 paid',
    from: 'thandi@acme.example',
  });
  // The owner's own mail adds facts, never an entity for the owner.
  await ingest({
    title: 'Chasing INV-2041',
    from: 'Me <me@brightlane.example>',
  });
  expect(await distill()).toBe(3);
  expect(await distill()).toBe(0);

  const thandi = (await find('Thandi'))!;
  expect(thandi).toMatchObject({ kind: 'person', name: 'Thandi Nkosi' });
  expect(thandi.mentions).toBe(2);
  expect(thandi.aliases.map((alias) => alias.family).sort()).toEqual([
    'email',
    'person',
  ]);
  expect(thandi.related).toContainEqual(
    expect.objectContaining({ name: 'acme.example', relation: 'works_at' }),
  );

  const invoice = (await find('INV-2041'))!;
  expect(invoice.kind).toBe('invoice');
  expect(invoice.facts.map((fact) => fact.title)).toEqual([
    'Chasing INV-2041',
    'Re: inv 2041 paid',
    'Invoice INV-2041 for Project Falcon',
  ]);
  expect(invoice.facts[2]).toMatchObject({
    eventId: first.id,
    amounts: ['ZAR 1200.00'],
    app: 'Mail',
  });
  expect((await find('Falcon'))?.kind).toBe('project');
  expect(await store.memory.search('owner', { query: 'brightlane' })).toEqual(
    [],
  );
  expect(await store.memory.search('owner', { kind: 'person' })).toHaveLength(
    1,
  );
  // Another owner sees none of it.
  expect(await store.memory.search('someone-else')).toEqual([]);
});

it('asks Jev only about spellings code cannot settle, and only for recent items', async () => {
  const match = vi.fn<NonNullable<Judge['match']>>(async (entity) =>
    entity.candidates.some((c) => c.normalized === 'thandi nkosi')
      ? 'thandi nkosi'
      : null,
  );
  const judge = { name: 'jev', judge: vi.fn(), match } as unknown as Judge;
  const { ingest, distill, find, setNow } = await setup({ judge });
  await ingest({ title: 'Hello', from: 'Thandi Nkosi <thandi@acme.example>' });
  await distill();
  // A new address under a near spelling of a known name.
  await ingest({ title: 'From my phone', from: 'Thandi N <tn@mail.example>' });
  await distill();
  expect(match).toHaveBeenCalledOnce();
  expect(match.mock.calls[0][0]).toMatchObject({
    kind: 'person',
    value: 'Thandi N',
  });
  const thandi = (await find('Thandi'))!;
  expect(thandi.mentions).toBe(2);
  expect(thandi.aliases.map((alias) => alias.normalized)).toContain(
    'tn@mail.example',
  );
  // An old item (a first backfill) is matched by code alone.
  setNow(NOW + 3 * DAY);
  await ingest(
    { title: 'Old note', from: 'Thandi K <tk@mail.example>' },
    NOW - 30 * DAY,
  );
  await distill();
  expect(match).toHaveBeenCalledOnce();
});

it('adds an item that closes an earlier one to the earlier item’s entities only', async () => {
  const { store, ingest, distill, find } = await setup();
  const earlier = await ingest({
    title: 'Please pay INV-3001',
    from: 'Ana <ana@vendor.example>',
  });
  await distill();
  const later = await ingest({
    title: 'Ignore my last mail, Project Heron covered it',
    from: 'Ana <ana@vendor.example>',
  });
  const finding = await store.saveFinding({
    eventId: earlier.id,
    attention: true,
    category: 'bill',
    confidence: 0.9,
    reason: 'A bill.',
    judgedBy: 'test',
    dotId: null,
  });
  await store.updateFinding(finding.id, {
    state: 'resolved',
    resolvedBy: later.id,
  });
  await distill();
  expect(await find('Heron')).toBeUndefined();
  const invoice = (await find('INV-3001'))!;
  expect(invoice.facts[0]).toMatchObject({
    eventId: later.id,
    status: 'closed an earlier item',
  });
  expect(invoice.mentions).toBe(1);
});

it('prunes only distilled items past the window, and nothing still waiting', async () => {
  const { db, store, memory, ingest, distill, setNow } = await setup();
  const old = NOW - 20 * DAY;
  const kept = await ingest({ title: 'Recent INV-1001' });
  const done = await ingest({ title: 'Old INV-1002' }, old);
  const waiting = await ingest({ title: 'Old INV-1003, needs you' }, old);
  await store.saveFinding({
    eventId: waiting.id,
    attention: true,
    category: 'bill',
    confidence: 0.9,
    reason: 'Needs the owner.',
    judgedBy: 'test',
    dotId: null,
  });
  await distill();
  const undistilled = await ingest({ title: 'Old INV-1004' }, old);

  expect(await memory.daily(await store.discovery.settings())).toBe(1);
  const left = (
    await db.rows<{ id: string }>(sql`SELECT id FROM inbox_events`)
  ).map((row) => row.id);
  expect(left.sort()).toEqual([kept.id, waiting.id, undistilled.id].sort());
  expect(
    await db.rows(
      sql`SELECT 1 FROM event_entity_links WHERE event_id=${done.id}`,
    ),
  ).toEqual([]);
  // Its facts stay.
  const [invoice] = await store.memory.search('owner', { query: 'INV-1002' });
  expect(invoice.facts[0].eventId).toBe(done.id);

  // Once a day, with a line for the brief.
  expect(await memory.daily(await store.discovery.settings())).toBe(0);
  expect(await store.memory.report('owner', '2026-11-13')).toBe(
    'Memory: 3 new items noted, 1 older item cleared, 3 things remembered.',
  );
  setNow(NOW + DAY);
  await memory.daily(await store.discovery.settings());
  expect((await store.memory.runs('owner')).map((run) => run.day)).toEqual([
    '2026-11-14',
    '2026-11-13',
  ]);
});

it('keeps a plain name once a second item mentions it', async () => {
  const { ingest, distill, find } = await setup();
  await ingest({ title: 'Lunch with the Globex people' });
  await distill();
  expect(await find('Globex')).toBeUndefined();
  await ingest({ title: 'Contract from Globex signed' });
  await distill();
  expect((await find('Globex'))?.kind).toBe('name');
});

it('merges two entities the owner says are one thing', async () => {
  const { store, ingest, distill } = await setup();
  await ingest({
    title: 'Kickoff for Project Osprey',
    from: 'Lee <lee@one.example>',
  });
  await ingest({
    title: 'Update on the Osprey Rollout project, OPS-12',
    from: 'Lee <lee@one.example>',
  });
  await distill();
  const projects = await store.memory.search('owner', { kind: 'project' });
  const project = projects.find((entity) => entity.name === 'Osprey')!;
  const rollout = projects.find((entity) => entity.name === 'Osprey Rollout');
  expect(project).toBeDefined();
  const merged = (await store.memory.merge('owner', rollout!.id, project.id))!;
  expect(merged.aliases.map((alias) => alias.normalized).sort()).toEqual([
    'osprey',
    'osprey rollout',
  ]);
  expect(merged.mentions).toBe(2);
  expect(merged.related.find((other) => other.name === 'OPS-12')).toBeDefined();
  expect(await store.memory.entity('owner', rollout!.id)).toBeUndefined();
  // Not someone else's, and not with itself.
  expect(await store.memory.merge('other', project.id, project.id)).toBe(
    undefined,
  );
});

it('forgets what a removed source taught', async () => {
  const { store, source, ingest, distill } = await setup();
  await ingest({ title: 'INV-77', from: 'Ana <ana@vendor.example>' });
  await distill();
  expect((await store.memory.search('owner')).length).toBeGreaterThan(0);
  await store.remove(source.id);
  expect(await store.memory.search('owner')).toEqual([]);
});
