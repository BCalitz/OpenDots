import { expect, it } from 'vitest';
import { extractNames, extractTags } from '../src/server/inbox/tags.js';
import { InboxStore } from '../src/server/inbox/store.js';
import { testDb } from './fixtures/db.js';

const keys = (item: Parameters<typeof extractTags>[0]) =>
  extractTags(item).map((tag) => `${tag.kind}:${tag.normalized}`);

it('gives every spelling of an invoice number one key', () => {
  for (const title of [
    'Invoice INV-2041 attached',
    'ignore the reminder about inv 2041',
    'Payment reminder: Invoice #2041',
    'Invoice no. 2041',
  ])
    expect(keys({ title })).toContain('invoice:INV-2041');
});

it('finds orders, tickets, amounts, addresses, domains and senders', () => {
  expect(
    keys({
      title: 'OPS-311 Payment export failing',
      summary:
        'PO 7781 for R12,500.00, see https://status.globex.com/x or mail ops@globex.com. Refund $480.',
      from: 'Pieter van Wyk <pieter@globex.com>',
    }).sort(),
  ).toEqual(
    [
      'amount:USD 480.00',
      'amount:ZAR 12500.00',
      'domain:globex.com',
      'domain:status.globex.com',
      'email:ops@globex.com',
      'email:pieter@globex.com',
      'order:PO-7781',
      'person:pieter van wyk',
      'ticket:OPS-311',
    ].sort(),
  );
});

it('skips mailbox-provider domains and invoice keys posing as tickets', () => {
  const tags = keys({
    title: 'INV-2041 again',
    from: 'Sam Carter <scarter@gmail.com>',
  });
  expect(tags).toContain('person:sam carter');
  expect(tags).not.toContain('domain:gmail.com');
  expect(tags.filter((tag) => tag.startsWith('ticket:'))).toEqual([]);
  // A word ending in R is not an amount.
  expect(keys({ title: 'PR 2024 review' })).toEqual([]);
});

it('tags items on ingest, links them, finds similar keys and drops tags with the source', async () => {
  const store = new InboxStore(await testDb());
  const { source } = await store.create({
    name: 'Mail',
    kind: 'mail',
    type: 'webhook',
    config: {},
    notify: 'off',
    intervalSeconds: 0,
  });
  const now = Date.now();
  await store.ingest([
    {
      sourceId: source.id,
      externalId: '1',
      kind: 'email',
      summary: '',
      raw: null,
      title: 'Invoice INV-2041',
      occurredAt: now - 2000,
    },
    {
      sourceId: source.id,
      externalId: '2',
      kind: 'email',
      summary: '',
      raw: null,
      title: 'Reminder: invoice #2041',
      occurredAt: now - 1000,
    },
    {
      sourceId: source.id,
      externalId: '3',
      kind: 'email',
      summary: '',
      raw: null,
      title: 'Credit for INV-2014',
      occurredAt: now,
    },
  ]);
  const links = await store.links();
  expect(links.items).toHaveLength(3);
  const invoice = links.tags.find((tag) => tag.normalized === 'INV-2041');
  expect(invoice).toMatchObject({ kind: 'invoice', value: 'Invoice INV-2041' });
  expect(invoice?.itemIds).toHaveLength(2);
  expect(links.similar).toEqual([
    expect.objectContaining({ kind: 'invoice', a: 'INV-2014', b: 'INV-2041' }),
  ]);
  expect(await store.backfillTags()).toBe(0);
  await store.remove(source.id);
  expect((await store.links()).items).toEqual([]);
});

const names = (text: string) =>
  extractNames(text).map((tag) => `${tag.kind}:${tag.normalized}`);

it('finds projects and places by their cue words, and other names', () => {
  expect(
    names(
      'Project Falcon kickoff\nWe met the Initech team at the Cape Town office about the Orion project.',
    ).sort(),
  ).toEqual(
    [
      'project:falcon',
      'project:orion',
      'place:cape town',
      'name:initech',
    ].sort(),
  );
  expect(names('The building in Durban is closed; ping #falcon-team.')).toEqual(
    ['place:durban', 'name:falcon team'],
  );
  expect(names('Pieter van Wyk asked about Acme Supplies')).toEqual([
    'name:pieter van wyk',
    'name:acme supplies',
  ]);
});

it('skips capitals that say nothing', () => {
  // Sentence starts, codes, weekdays, months, greetings and common words.
  expect(
    names(
      'Payment reminder: Invoice #2041 for March. Finance paid on Friday.\nHi, see OPS-311 and pay by EFT. Our team meets on Monday.',
    ),
  ).toEqual([]);
  // An app after "in" is a name, not a place.
  expect(names('We talked in Teams.')).toEqual(['name:teams']);
  // A name at the start of a sentence still counts when it has two words.
  expect(names('Umbrella Logistics: delivery scheduled')).toEqual([
    'name:umbrella logistics',
  ]);
});

it('keeps names out of the sender and gives one name one key', () => {
  const tags = keys({
    title: "Thandi Nkosi's note about Acme's order",
    from: 'Thandi Nkosi <thandi@acme-supplies.co.za>',
  });
  expect(tags).toContain('person:thandi nkosi');
  expect(tags).not.toContain('name:thandi nkosi');
  expect(tags).toContain('name:acme');
});

it('links a name only once two items carry it, under its most specific kind', async () => {
  const store = new InboxStore(await testDb());
  const { source } = await store.create({
    name: 'Mail',
    kind: 'mail',
    type: 'webhook',
    config: {},
    notify: 'off',
    intervalSeconds: 0,
  });
  const item = (externalId: string, title: string) => ({
    sourceId: source.id,
    externalId,
    kind: 'email',
    summary: '',
    raw: null,
    title,
    occurredAt: Date.now() - Number(externalId),
  });
  await store.ingest([
    item('3', 'Project Falcon kickoff'),
    item('2', 'Notes on the #falcon designs'),
    item('1', 'Lunch with the Globex people'),
  ]);
  const { tags } = await store.links();
  const falcon = tags.filter((tag) => tag.normalized === 'falcon');
  expect(falcon).toEqual([
    expect.objectContaining({ kind: 'project', value: 'Falcon' }),
  ]);
  expect(falcon[0].itemIds).toHaveLength(2);
  expect(tags.some((tag) => tag.normalized === 'globex')).toBe(false);
});
