// A made-up scenario for discovery with history: a client emails an app
// idea with no name, three colleagues discuss it in a Teams channel, then a
// proposal with a name and a solution goes back, and the client answers.
//
// Usage: npm run seed-app-idea              adds the items to the Inbox
//        npm run seed-app-idea -- --judge   also has Jev judge them, in order
//                                           (sends this made-up text to
//                                           TypeSafe with TYPESAFE_API_KEY)
//        npm run seed-app-idea -- --remove  removes them
// Every company, person and address here is fictional.
import { databaseUrl, openDatabase, sql } from './index.js';
import { InboxStore } from '../inbox/store.js';
import type { InboxEvent } from '../inbox/source.js';
import { DiscoveryService } from '../discovery/service.js';
import { jevJudge } from '../discovery/classifier.js';

const PREFIX = 'Scenario · ';
const DAY = 86_400_000;
const naledi = 'Naledi Dube <naledi@greenbasket.co.za>';
const lerato = 'Lerato Mokoena <lerato@brightlane.co.za>';
const sipho = 'Sipho Khumalo <sipho@brightlane.co.za>';
const jo = 'Jo Daniels <jo@brightlane.co.za>';
const items: {
  source: 'mail' | 'teams';
  at: number;
  title: string;
  summary: string;
  from: string;
}[] = [
  {
    source: 'mail',
    at: 9 * DAY,
    title: 'An idea for an app for our stores',
    summary:
      "Hi team, we'd love our customers to scan the label on a shelf and get a reorder list for next time, see recipes with what's on special, and collect points. We don't have a name for it yet; internally we just call it the shelf thing. Could you tell us if it's doable and roughly what it would cost? Kind regards, Naledi, GreenBasket Grocers",
    from: naledi,
  },
  {
    source: 'teams',
    at: 8 * DAY + 5 * 3_600_000,
    title: 'App idea from GreenBasket',
    summary:
      'Naledi from GreenBasket sent an app idea: customers scan shelf labels to build a reorder list, plus recipes and points. Worth doing? I think yes, they have 40 stores.',
    from: lerato,
  },
  {
    source: 'teams',
    at: 8 * DAY + 4 * 3_600_000,
    title: 'Re: App idea from GreenBasket',
    summary:
      'Doable. Scanning a barcode is the easy part; the hard part is their stock system. Do they have an API for prices and specials?',
    from: sipho,
  },
  {
    source: 'teams',
    at: 8 * DAY + 2 * 3_600_000,
    title: 'Re: App idea from GreenBasket',
    summary:
      "Careful with scope. I'd start with the reorder list only and do points later. They also need a name, the shelf thing won't do.",
    from: jo,
  },
  {
    source: 'teams',
    at: 7 * DAY + 6 * 3_600_000,
    title: 'Name ideas for the shelf app',
    summary:
      'Name ideas: ShelfLife, Restock, Basket Buddy. I like ShelfLife, it says what it does.',
    from: lerato,
  },
  {
    source: 'teams',
    at: 7 * DAY + 5 * 3_600_000,
    title: 'Re: Name ideas for the shelf app',
    summary:
      'ShelfLife +1. We could build a web app first, opened from a QR code on the shelf, so there is no app store wait. About six weeks.',
    from: sipho,
  },
  {
    source: 'teams',
    at: 6 * DAY,
    title: 'Decision on the GreenBasket app',
    summary:
      "Agreed, we do it. Proposal: ShelfLife as a web app, phase 1 the reorder list and specials, phase 2 points. I'll write it up and send it to Naledi.",
    from: jo,
  },
  {
    source: 'mail',
    at: 3 * DAY,
    title: 'Proposal for GreenBasket: ShelfLife',
    summary:
      "Hi Naledi, thank you for the idea. We'd like to propose a name: ShelfLife. The solution: a web app customers open by scanning a QR code on the shelf label, so nobody has to install anything. Phase 1 (six weeks, R180,000.00) builds the reorder list and this week's specials with recipes, using your stock system's prices. Phase 2 adds points. Let us know what you think. Jo, Brightlane",
    from: jo,
  },
  {
    source: 'mail',
    at: 1 * DAY,
    title: 'Re: Proposal for GreenBasket: ShelfLife',
    summary:
      'We love ShelfLife, the name and the QR code idea! Can we start next month? Please send the contract and the first invoice so I can get it approved.',
    from: naledi,
  },
];

const db = await openDatabase(databaseUrl());
const store = new InboxStore(db);
try {
  const existing = (await store.sources()).filter((source) =>
    source.name.startsWith(PREFIX),
  );
  const judge = process.argv.includes('--judge');
  if (process.argv.includes('--remove')) {
    for (const source of existing) await store.remove(source.id);
    console.log('Removed the scenario sources and their items.');
  } else if (judge && existing.length) {
    await judgeAll(existing.map((source) => source.id));
  } else {
    for (const source of existing) await store.remove(source.id);
    const ids = {
      mail: (
        await store.create({
          name: `${PREFIX}Mail`,
          kind: 'mail',
          type: 'webhook',
          config: {},
          notify: 'off',
          intervalSeconds: 0,
        })
      ).source.id,
      teams: (
        await store.create({
          name: `${PREFIX}Teams #client-ideas`,
          kind: 'message',
          type: 'webhook',
          config: {},
          notify: 'off',
          intervalSeconds: 0,
        })
      ).source.id,
    };
    const now = Date.now();
    const events: InboxEvent[] = items.map((item, index) => ({
      sourceId: ids[item.source],
      externalId: `app-idea-${index + 1}`,
      kind: item.source === 'mail' ? 'mail.received' : 'message.received',
      title: item.title,
      summary: item.summary,
      from: item.from,
      raw: null,
      occurredAt: now - item.at,
    }));
    const added = await store.ingest(events);
    console.log(
      `Added ${added.length} made-up items in "${PREFIX}Mail" and "${PREFIX}Teams #client-ideas".`,
    );
    if (judge) await judgeAll(Object.values(ids));
  }
} finally {
  await db.close();
}

/**
 * Judges the scenario items oldest first, as if each had just arrived from
 * Gmail or Teams, so each is judged with the history before it. No Dot
 * investigates; flagged items wait in the Inbox.
 */
async function judgeAll(sourceIds: string[]) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY to judge with Jev.');
  const dot = await db.row<{ id: string }>(
    sql`SELECT id FROM dots ORDER BY created_at LIMIT 1`,
  );
  const discovery = new DiscoveryService(store, {
    judge: () => jevJudge({ apiKey }),
    investigate: () => Promise.reject(new Error('Not run in this scenario.')),
    maxInvestigations: 0,
  });
  const events = (await store.events({ includeDismissed: true, limit: 500 }))
    .filter((event) => sourceIds.includes(event.sourceId))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  for (const event of events) {
    if (event.finding) continue;
    const source = (await store.source(event.sourceId))!;
    const toolkit = source.kind === 'mail' ? 'gmail' : 'microsoft_teams';
    discovery.listener({
      // Judged as if it came from a discovery account; the stored source
      // stays a webhook, so nothing is polled.
      source: {
        ...source,
        type: 'composio',
        config: { dotId: dot?.id ?? '', accountId: 'scenario', toolkit },
      },
      events: [event],
      initial: false,
    });
    await discovery.idle();
    const finding = await store.findingForEvent(event.id);
    console.log(
      `${event.title} -> ${finding ? `${finding.attention ? 'flagged' : 'not flagged'}, ${finding.category}, ${finding.urgency ?? '-'}, asks ${finding.asked ?? '-'}, route ${finding.route ?? '-'}${finding.note ? `; note: ${finding.note}` : ''}` : 'not judged'}`,
    );
  }
  const links = await db.rows<{
    a: string;
    b: string;
    score: number;
    status: string;
  }>(
    sql`SELECT ea.title AS a, eb.title AS b, l.score, l.status FROM event_links l
      JOIN inbox_events ea ON ea.id=l.event_id JOIN inbox_events eb ON eb.id=l.other_event_id
      WHERE ea.source_id = ANY(${sourceIds}) ORDER BY l.created_at`,
  );
  for (const link of links)
    console.log(`link ${link.status} ${link.score}: ${link.a} <-> ${link.b}`);
}
