import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { inboxTools } from '../src/server/inbox-tools.js';
import { detachedContext } from '../src/server/engine/tools.js';
import { testDb } from './fixtures/db.js';

async function fixture() {
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
  const now = Date.now();
  const [quote, receipt] = await inbox.ingest([
    {
      sourceId: source.id,
      externalId: 'quote',
      kind: 'mail.received',
      title: 'Quote for our website rebuild',
      summary: 'Could you send a rough quote by Friday?',
      from: 'Sarah Jacobs <sarah@harbour.example>',
      occurredAt: now - 60_000,
      raw: null,
    },
    {
      sourceId: source.id,
      externalId: 'receipt',
      kind: 'mail.received',
      title: 'Your PayFast receipt',
      summary: 'Payment of R 1,200 received.',
      from: 'PayFast <noreply@payfast.example>',
      occurredAt: now - 40 * 86_400_000,
      raw: null,
    },
  ]);
  const dot = (await workspace.dots())[0];
  await inbox.saveFinding({
    eventId: quote.id,
    attention: true,
    category: 'request',
    confidence: 0.97,
    reason: 'someone asking the owner to do something',
    judgedBy: 'jev',
    dotId: dot.id,
    urgency: 'tomorrow',
    asked: 'action',
  });
  const [search, read] = inboxTools(workspace, async () => undefined);
  const run = (tool: typeof search, input: unknown) =>
    tool.execute(input, detachedContext()) as Promise<Record<string, unknown>>;
  return { search, read, run, quote, receipt, workspace };
}

it('finds inbox items by words, sender and age, with what discovery made of them', async () => {
  const { search, run, quote, workspace } = await fixture();
  const found = await run(search, { query: 'harbour quote' });
  expect(found.items).toEqual([
    expect.objectContaining({
      id: quote.id,
      from: 'Sarah Jacobs <sarah@harbour.example>',
      discovery: expect.objectContaining({
        needs_owner: true,
        urgency: 'tomorrow',
        asks: 'action',
      }),
    }),
  ]);
  expect(
    ((await run(search, { query: 'payfast' })).items as unknown[]).length,
  ).toBe(1);
  expect(
    ((await run(search, { query: 'payfast', days: 30 })).items as unknown[])
      .length,
  ).toBe(0);
  expect(
    ((await run(search, { flaggedOnly: true })).items as { id: string }[]).map(
      (item) => item.id,
    ),
  ).toEqual([quote.id]);
  expect(
    ((await run(search, { waitingOnly: true })).items as { id: string }[]).map(
      (item) => item.id,
    ),
  ).toEqual([quote.id]);
  // Once a later item resolves it, it no longer waits on the owner.
  const finding = (await workspace.inbox.findingForEvent(quote.id))!;
  await workspace.inbox.updateFinding(finding.id, { state: 'resolved' });
  expect((await run(search, { waitingOnly: true })).items).toEqual([]);
  expect(
    ((await run(search, { flaggedOnly: true })).items as unknown[]).length,
  ).toBe(1);
  // Wildcards in the query are plain text, not patterns.
  expect(((await run(search, { query: '%%' })).items as unknown[]).length).toBe(
    2,
  );
});

it('reads one item in full, marked as untrusted', async () => {
  const { read, run, quote } = await fixture();
  const item = await run(read, { id: quote.id });
  expect(item).toMatchObject({
    title: 'Quote for our website rebuild',
    text: 'Could you send a rough quote by Friday?',
    note: expect.stringContaining('untrusted'),
  });
  expect(await run(read, { id: 'missing' })).toEqual({
    error: 'No inbox item with that id.',
  });
});
