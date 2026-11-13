import { expect, it, vi } from 'vitest';
import { sql } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrations.js';
import { ToolCalls } from '../src/server/engine/tool-calls.js';
import {
  sourceFromMetadata,
  TURN_MODES,
  type TurnSource,
} from '../src/server/engine/modes.js';
import { systemPrompt } from '../src/server/engine/prompt.js';
import { testDb } from './fixtures/db.js';

const key = (toolCallId = 'call') => ({
  threadId: 'thread',
  toolCallId,
  kind: 'approval' as const,
  tool: 'request_approval',
});

it('runs a tool call once and hands a repeat the first result', async () => {
  const calls = new ToolCalls(await testDb());
  const work = vi.fn(async () => 'approved');
  expect(await calls.once(key(), work)).toEqual({
    ran: true,
    result: 'approved',
  });
  expect(await calls.once(key(), work)).toEqual({
    ran: false,
    status: 'done',
    result: 'approved',
  });
  expect(work).toHaveBeenCalledOnce();
});

it('tells a repeat that the first call is still running', async () => {
  const calls = new ToolCalls(await testDb());
  let finish!: (value: string) => void;
  const first = calls.once(
    key(),
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  await vi.waitFor(async () =>
    expect(await calls.get('thread', 'call')).toBeDefined(),
  );
  const work = vi.fn(async () => 'again');
  expect(await calls.once(key(), work)).toEqual({
    ran: false,
    status: 'running',
    result: null,
  });
  finish('approved');
  expect(await first).toEqual({ ran: true, result: 'approved' });
  expect(work).not.toHaveBeenCalled();
});

it('keeps a failed claim unless the work had no outside effect', async () => {
  const calls = new ToolCalls(await testDb());
  const fail = async () => {
    throw new Error('network');
  };
  // An outside call may have happened before it failed: never run it again.
  await expect(calls.once(key('kept'), fail)).rejects.toThrow('network');
  expect((await calls.once(key('kept'), async () => 'x')).ran).toBe(false);
  // Nothing outside happened: the call may be tried again.
  await expect(
    calls.once(key('freed'), fail, { release: true }),
  ).rejects.toThrow('network');
  expect((await calls.once(key('freed'), async () => 'x')).ran).toBe(true);
});

it('commits an atomic claim with its work, or not at all', async () => {
  const db = await testDb();
  const calls = new ToolCalls(db);
  await expect(
    calls.once(
      key(),
      async () => {
        await db.run(
          sql`INSERT INTO memories (id, text, created_at) VALUES ('m1', 'kept?', 1)`,
        );
        throw new Error('failed after writing');
      },
      { atomic: true },
    ),
  ).rejects.toThrow('failed after writing');
  expect(await calls.get('thread', 'call')).toBeUndefined();
  expect(await db.rows(sql`SELECT 1 FROM memories WHERE id='m1'`)).toEqual([]);
});

it('moves connector receipts and reviewed pages into one table', async () => {
  const db = await testDb(11);
  await db.run(
    sql`INSERT INTO connector_actions (thread_id, tool_call_id, account_id, dot_id, tool, status, result, created_at, claimed_at, approval_id) VALUES ('t', 'tc1', 'a1', 'd1', 'send', 'done', '{"isError":false,"text":"ok"}', 5, 5, 'ap1')`,
  );
  await db.run(
    sql`INSERT INTO page_reviews (thread_id, tool_call_id, page_id, space_id, draft) VALUES ('t', 'tc2', 'p1', 's1', '{"title":"T","content":"C","spaceId":"s1"}'), ('t', 'tc3', 'p2', 's1', NULL)`,
  );
  await migrate(db);
  const calls = new ToolCalls(db);
  expect(await calls.get('t', 'tc1')).toMatchObject({
    kind: 'connector',
    approvalId: 'ap1',
    status: 'done',
    result: { isError: false, text: 'ok' },
  });
  expect(await calls.get('t', 'tc2')).toMatchObject({
    kind: 'page_review',
    status: 'done',
    result: {
      pageId: 'p1',
      spaceId: 's1',
      draft: { title: 'T', content: 'C', spaceId: 's1' },
    },
  });
  expect((await calls.get('t', 'tc3'))?.result).toEqual({
    pageId: 'p2',
    spaceId: 's1',
    draft: null,
  });
  expect(await db.row(sql`SELECT to_regclass('page_reviews') AS gone`)).toEqual(
    { gone: null },
  );
});

it('reads every kind of turn from one table', () => {
  expect(sourceFromMetadata()).toBe('chat');
  expect(sourceFromMetadata({ opendotsSource: 'voice_receipt' })).toBe('voice');
  expect(sourceFromMetadata({ opendotsSource: 'nonsense' })).toBe('chat');
  for (const source of Object.keys(TURN_MODES) as TurnSource[]) {
    const { marker } = TURN_MODES[source];
    if (marker)
      expect(sourceFromMetadata({ opendotsSource: marker })).toBe(source);
  }
  // Read-only turns never ask, and only people in a chat are asked.
  const asking = (Object.keys(TURN_MODES) as TurnSource[]).filter(
    (source) => TURN_MODES[source].approvals,
  );
  expect(asking.sort()).toEqual(['chat', 'handle', 'reply']);
  for (const source of asking) expect(TURN_MODES[source].readOnly).toBe(false);
});

it('builds the system prompt from the parts a turn has on', () => {
  const base = {
    dot: { name: 'Ada', instructions: 'Help.', spaceId: 'space-1' },
    computer: false,
    team: [],
    connected: false,
    approvals: false,
    memories: [],
    pageContext: null,
    threadNote: '',
    modePrompt: '',
    now: new Date(0),
  };
  const plain = systemPrompt(base);
  expect(plain).toContain('Computer tools are not configured.');
  expect(plain).toContain('Tools that need owner approval are unavailable');
  expect(plain).not.toContain('ask_dot');
  const full = systemPrompt({
    ...base,
    team: ['Bea'],
    connected: true,
    approvals: true,
    modePrompt: TURN_MODES.reply.prompt,
  });
  expect(full).toContain('You coordinate other Dots: Bea.');
  expect(full).toContain('Connected-service tools are available');
  expect(full).toContain('request_approval');
  expect(full.endsWith(TURN_MODES.reply.prompt)).toBe(true);
});
