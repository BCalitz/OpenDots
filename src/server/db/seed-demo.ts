// Loads made-up inbox items so the links view has something to show.
// Usage: npm run seed-demo            adds three "Demo ·" sources and items
//        npm run seed-demo -- --remove removes them and their tags
// Every company, person and address here is fictional.
import { databaseUrl, openDatabase } from './index.js';
import { InboxStore } from '../inbox/store.js';
import type { InboxEvent } from '../inbox/source.js';
import type { SourceKind } from '../../shared/inbox-types.js';

const PREFIX = 'Demo · ';
const DAY = 86_400_000;
const sources: { key: string; name: string; kind: SourceKind }[] = [
  { key: 'mail', name: `${PREFIX}Mail`, kind: 'mail' },
  { key: 'teams', name: `${PREFIX}Teams`, kind: 'message' },
  { key: 'tickets', name: `${PREFIX}Tickets`, kind: 'ticket' },
];
const thandi = 'Thandi Nkosi <thandi@acme-supplies.co.za>';
const lerato = 'Lerato Mokoena <lerato@brightlane.co.za>';
const pieter = 'Pieter van Wyk <pieter@globex.com>';
const sam = 'Sam Carter <sam.carter@initech.io>';
type Item = Omit<
  InboxEvent,
  'sourceId' | 'externalId' | 'occurredAt' | 'raw'
> & {
  source: string;
  daysAgo: number;
};
const items: Item[] = [
  // An invoice, its reminder, a "never mind" in Teams and the payment.
  {
    source: 'mail',
    daysAgo: 13,
    kind: 'email',
    title: 'Invoice INV-2041 for March stationery',
    summary:
      'Please find attached invoice INV-2041 for R12,500.00, due in 30 days. Our reference: PO 7781.',
    from: thandi,
  },
  {
    source: 'mail',
    daysAgo: 6,
    kind: 'email',
    title: 'Payment reminder: Invoice #2041',
    summary:
      'A friendly reminder that invoice #2041 (R 12 500.00) is now overdue. Questions to accounts@acme-supplies.co.za.',
    from: 'Acme Accounts <accounts@acme-supplies.co.za>',
    priority: 'high',
  },
  {
    source: 'teams',
    daysAgo: 5,
    kind: 'chat',
    title: 'Ignore the Acme reminder about inv 2041',
    summary: 'Finance paid it on Friday, I will send Thandi the proof.',
    from: lerato,
  },
  {
    source: 'mail',
    daysAgo: 4,
    kind: 'email',
    title: 'Payment received: R12,500.00 to Acme Supplies',
    summary:
      'Your payment of R12,500.00 to Acme Supplies was successful. Reference: INV-2041.',
    from: 'PayNotify <no-reply@paynotify.example>',
  },
  {
    source: 'teams',
    daysAgo: 3,
    kind: 'chat',
    title: 'Thandi from Acme called',
    summary: 'She wants to confirm INV-2041 was paid. Can someone reply?',
    from: lerato,
  },
  {
    source: 'mail',
    daysAgo: 3,
    kind: 'email',
    title: 'Credit note for Invoice INV-2014',
    summary: 'Credit of R 1,250.00 against INV-2014 for the damaged boxes.',
    from: thandi,
  },
  // A delivery for the same purchase order, from another company.
  {
    source: 'mail',
    daysAgo: 10,
    kind: 'email',
    title: 'Umbrella Logistics: delivery scheduled',
    summary:
      'Delivery for purchase order 7781 is scheduled for Tuesday between 09:00 and 12:00.',
    from: 'Dispatch <dispatch@umbrella-logistics.com>',
  },
  {
    source: 'mail',
    daysAgo: 9,
    kind: 'email',
    title: 'Invoice INV-3307 from Umbrella Logistics',
    summary: 'Transport for PO 7781: R2,180.00. Pay by EFT within 14 days.',
    from: 'Billing <billing@umbrella-logistics.com>',
  },
  // A ticket that also arrives by mail and in Teams.
  {
    source: 'tickets',
    daysAgo: 16,
    kind: 'issue',
    title: 'OPS-298 CSV export times out for large clients',
    summary: 'Globex export took 4 minutes and the request timed out.',
    from: pieter,
  },
  {
    source: 'tickets',
    daysAgo: 2,
    kind: 'issue',
    title: 'OPS-311 Payment export failing for client Globex',
    summary: 'The nightly payment export to Globex failed with a 500.',
    from: pieter,
    priority: 'urgent',
  },
  {
    source: 'mail',
    daysAgo: 2,
    kind: 'email',
    title: 'Export still broken, see OPS-311',
    summary:
      'Our finance team cannot reconcile without it. Details on https://status.globex.com/incidents/77',
    from: pieter,
    priority: 'high',
  },
  {
    source: 'teams',
    daysAgo: 1,
    kind: 'chat',
    title: 'Looking at OPS-311 now',
    summary: 'Same root cause as OPS-298 last month?',
    from: lerato,
  },
  {
    source: 'tickets',
    daysAgo: 1,
    kind: 'issue',
    title: 'OPS-312 Globex asks for a refund of $480.00',
    summary: 'Credit for the missed exports this week, per pieter@globex.com.',
    from: 'Support Bot <support@brightlane.co.za>',
  },
  // A purchase order from a person who also writes from a personal address.
  {
    source: 'mail',
    daysAgo: 9,
    kind: 'email',
    title: 'Purchase order 9120 for 40 licences',
    summary: 'PO 9120, total USD 3,600.00. Please confirm delivery dates.',
    from: sam,
  },
  {
    source: 'mail',
    daysAgo: 8,
    kind: 'email',
    title: 'Re: PO-9120 quote attached',
    summary: 'Updated quote with the education discount.',
    from: sam,
  },
  {
    source: 'tickets',
    daysAgo: 7,
    kind: 'issue',
    title: 'SALES-77 Initech licence upgrade (PO 9120)',
    summary: 'Provision 40 seats once the PO is countersigned.',
    from: 'Lerato Mokoena <lerato@brightlane.co.za>',
  },
  {
    source: 'teams',
    daysAgo: 7,
    kind: 'chat',
    title: 'Following up on the licence order',
    summary: 'Hi, writing from my personal account. Any news on the 40 seats?',
    from: 'Sam Carter <scarter@gmail.com>',
  },
  // Things that link to nothing.
  {
    source: 'mail',
    daysAgo: 4,
    kind: 'email',
    title: 'Your weekly digest',
    summary: 'Five articles picked for you this week.',
    from: 'Digest <news@digest.example>',
    priority: 'low',
  },
  {
    source: 'teams',
    daysAgo: 2,
    kind: 'chat',
    title: 'Lunch on Thursday?',
    summary: 'The new place on the corner.',
    from: 'Jo Daniels <jo@brightlane.co.za>',
    priority: 'low',
  },
  {
    source: 'tickets',
    daysAgo: 11,
    kind: 'issue',
    title: 'OPS-305 Renew the certificate for the status page',
    summary: 'Expires at the end of the month.',
    from: 'Jo Daniels <jo@brightlane.co.za>',
  },
];

const db = await openDatabase(databaseUrl());
const store = new InboxStore(db);
try {
  for (const source of await store.sources())
    if (source.name.startsWith(PREFIX)) await store.remove(source.id);
  if (process.argv.includes('--remove')) {
    console.log('Removed the demo sources, their items and their tags.');
  } else {
    const ids = new Map<string, string>();
    for (const source of sources) {
      const { source: created } = await store.create({
        name: source.name,
        kind: source.kind,
        type: 'webhook',
        config: {},
        notify: 'off',
        intervalSeconds: 0,
      });
      ids.set(source.key, created.id);
    }
    const now = Date.now();
    const events = items.map(
      ({ source, daysAgo, ...item }, index): InboxEvent => ({
        ...item,
        raw: null,
        sourceId: ids.get(source)!,
        externalId: `demo-${index + 1}`,
        // Spread within the day so items on one day do not overlap.
        occurredAt: now - daysAgo * DAY - ((index * 37) % 9) * 3_600_000,
      }),
    );
    const added = await store.ingest(events);
    console.log(
      `Added ${added.length} made-up items in ${sources.length} "${PREFIX}" sources. Remove them with npm run seed-demo -- --remove.`,
    );
  }
} finally {
  await db.close();
}
