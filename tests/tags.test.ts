import { expect, it } from 'vitest';
import { extractTags } from '../src/server/inbox/tags.js';
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
