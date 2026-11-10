import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { EchoAgent } from './fixtures/echo-agent.js';
import { LocalAgentRunner } from '../src/server/conversations/local-runner.js';
import { LocalConversationBackend } from '../src/server/conversations/backend.js';
import { scheduledTaskMessagePrefix } from '../src/shared/scheduled-message.js';
import {
  generateThreadName,
  namingExcerpt,
} from '../src/server/conversations/thread-names.js';
import {
  conversationBackend,
  conversationBackendFromEnv,
  setupStatus,
  INTELLIGENCE_KEY_MISSING_LABEL,
} from '../src/server/platform-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}
const input = (threadId: string, runId: string, messages: Message[]) => ({
  threadId,
  runId,
  messages,
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});
const user = (id: string, content: string): Message => ({
  id,
  role: 'user',
  content,
});
async function runTurn(
  runner: LocalAgentRunner,
  threadId: string,
  runId: string,
  messages: Message[],
  agent = new EchoAgent(),
) {
  return lastValueFrom(
    runner
      .run({ threadId, agent, input: input(threadId, runId, messages) })
      .pipe(toArray()),
  );
}
const texts = (messages: Message[]) =>
  messages.map((m) => `${m.role}:${String(m.content ?? '')}`);

it('keeps history across a restart and replays it on connect', async () => {
  const path = databasePath();
  let runner = new LocalAgentRunner(path, 'owner');
  runner.createThread({ threadId: 't1', agentId: 'dot' });
  await runTurn(runner, 't1', 'r1', [user('u1', 'hello')]);
  runner.close();

  runner = new LocalAgentRunner(path, 'owner');
  expect(texts(runner.getThreadMessages('t1'))).toEqual([
    'user:hello',
    'assistant:echo: hello',
  ]);
  const replay = await lastValueFrom(
    runner.connect({ threadId: 't1' }).pipe(toArray()),
  );
  expect(replay.map((e) => e.type)).toContain(EventType.RUN_STARTED);
  // Deltas are compacted into one content event when the run ends.
  expect(
    replay.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toHaveLength(1);
  const started = replay.find((e) => e.type === EventType.RUN_STARTED) as {
    input?: { messages: Message[] };
  };
  expect(started.input?.messages.map((m) => m.id)).toEqual(['u1']);
  expect(runner.runs('t1')).toMatchObject([{ id: 'r1', status: 'finished' }]);
  expect(runner.listThreads()).toMatchObject([{ id: 't1', agentId: 'dot' }]);
  runner.close();
});

it('uses stored history over what the caller sends and records only new messages', async () => {
  const runner = new LocalAgentRunner(':memory:', 'owner');
  await runTurn(runner, 't1', 'r1', [user('u1', 'first')]);
  const agent = new EchoAgent();
  // A stale client that never saw the first answer, plus a tampered copy of u1.
  await runTurn(
    runner,
    't1',
    'r2',
    [user('u1', 'tampered'), user('u2', 'second')],
    agent,
  );
  expect(texts(agent.seen[0])).toEqual([
    'user:first',
    'assistant:echo: first',
    'user:second',
  ]);
  const replay = runner.getThreadEvents('t1');
  const inputs = replay
    .filter((e) => e.type === EventType.RUN_STARTED)
    .map((e) =>
      (e as { input?: { messages: Message[] } }).input?.messages.map(
        (m) => m.id,
      ),
    );
  expect(inputs).toEqual([['u1'], ['u2']]);
  runner.close();
});

it('allows one run per thread and stops it cleanly', async () => {
  const runner = new LocalAgentRunner(':memory:', 'owner');
  const agent = new EchoAgent(true);
  const events = lastValueFrom(
    runner
      .run({
        threadId: 't1',
        agent,
        input: input('t1', 'r1', [user('u1', 'wait')]),
      })
      .pipe(toArray()),
  );
  expect(await runner.isRunning({ threadId: 't1' })).toBe(true);
  expect(() =>
    runner.run({
      threadId: 't1',
      agent: new EchoAgent(),
      input: input('t1', 'r2', [user('u2', 'again')]),
    }),
  ).toThrow('Thread already running');
  // A late joiner sees the run so far, then follows it to the end.
  const joined = lastValueFrom(
    runner.connect({ threadId: 't1' }).pipe(toArray()),
  );
  expect(await runner.stop({ threadId: 't1', runId: 'other' })).toBe(false);
  expect(await runner.stop({ threadId: 't1', runId: 'r1' })).toBe(true);
  const emitted = await events;
  expect((await joined).length).toBe(emitted.length);
  expect(emitted.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(await runner.isRunning({ threadId: 't1' })).toBe(false);
  expect(runner.runs('t1')[0].status).toBe('stopped');
  runner.close();
});

it('closes runs a crash left open with a visible error', () => {
  const path = databasePath();
  const runner = new LocalAgentRunner(path, 'owner');
  runner.createThread({ threadId: 't1', agentId: 'dot' });
  runner.close();
  const db = new DatabaseSync(path);
  db.prepare(
    "INSERT INTO conv_runs (id, threadId, agentId, status, startedAt) VALUES ('r1', 't1', 'dot', 'running', 1)",
  ).run();
  for (const [seq, event] of [
    { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'm', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'half' },
  ].entries())
    db.prepare("INSERT INTO conv_events VALUES ('t1', 'r1', ?, ?, ?, 1)").run(
      seq + 1,
      event.type,
      JSON.stringify(event),
    );
  db.close();

  const reopened = new LocalAgentRunner(path, 'owner');
  expect(reopened.runs('t1')[0].status).toBe('interrupted');
  const types = reopened.getThreadEvents('t1').map((e) => e.type);
  expect(types).toContain(EventType.TEXT_MESSAGE_END);
  expect(types.at(-1)).toBe(EventType.RUN_ERROR);
  reopened.close();
});

it('runs headless turns through the same thread and stores them', async () => {
  const runner = new LocalAgentRunner(':memory:', 'owner');
  const backend = new LocalConversationBackend(runner, () => new EchoAgent());
  await backend.createThread({ threadId: 't1', dotId: 'dot', name: 'ignored' });
  expect(runner.thread('t1')?.name).toBeNull();
  const reply = await backend.turn({
    threadId: 't1',
    dotId: 'dot',
    prompt: 'daily summary',
    signal: new AbortController().signal,
    metadata: { opendotsSource: 'scheduled_task' },
  });
  expect(reply).toBe('echo: daily summary');
  const [first] = runner.getThreadMessages('t1');
  expect(first.id.startsWith(scheduledTaskMessagePrefix)).toBe(true);
  expect(
    (await backend.getThreadMessages({ threadId: 't1', userId: 'owner' }))
      .messages,
  ).toHaveLength(2);
  runner.close();
});

it('stops a headless turn when its signal aborts', async () => {
  const runner = new LocalAgentRunner(':memory:', 'owner');
  const backend = new LocalConversationBackend(
    runner,
    () => new EchoAgent(true),
  );
  const controller = new AbortController();
  const turn = backend.turn({
    threadId: 't1',
    dotId: 'dot',
    prompt: 'long job',
    signal: controller.signal,
  });
  controller.abort();
  await expect(turn).rejects.toThrow();
  expect(runner.runs('t1')[0].status).toBe('stopped');
  runner.close();
});

it('renames, archives and deletes threads for the owner only', async () => {
  const runner = new LocalAgentRunner(':memory:', 'owner');
  await runTurn(runner, 't1', 'r1', [user('u1', 'hi')]);
  expect(runner.renameThread('t1', 'Greeting')?.name).toBe('Greeting');
  runner.archiveThread('t1');
  expect(runner.listThreads()).toEqual([]);
  expect(runner.deleteThread('t1')).toBe(true);
  expect(runner.getThreadEvents('t1')).toEqual([]);
  expect(runner.runs('t1')).toEqual([]);
  runner.close();
});

it('names a conversation with one model call and never throws', async () => {
  const excerpt = namingExcerpt([
    user('u1', 'Plan a trip to Lisbon'),
    { id: 'a1', role: 'assistant', content: 'Sure.' },
  ])!;
  expect(excerpt).toContain('Lisbon');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      choices: [{ message: { content: '"Lisbon trip plan."' } }],
    }),
  );
  const config = {
    apiKey: 'k',
    model: 'm',
    baseUrl: 'https://example.com/v1/',
  };
  expect(await generateThreadName(config, excerpt, fetcher)).toBe(
    'Lisbon trip plan',
  );
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://example.com/v1/chat/completions',
  );
  expect(
    await generateThreadName(
      config,
      excerpt,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('down')),
    ),
  ).toBeNull();
  expect(
    await generateThreadName({ baseUrl: 'x' }, excerpt, fetcher),
  ).toBeNull();
});

it('chooses the backend and only asks for Intelligence when it is selected', () => {
  expect(conversationBackendFromEnv({})).toBeUndefined();
  expect(conversationBackendFromEnv({ CONVERSATION_BACKEND: ' Local ' })).toBe(
    'local',
  );
  expect(() =>
    conversationBackendFromEnv({ CONVERSATION_BACKEND: 'redis' }),
  ).toThrow();
  expect(conversationBackend({})).toBe('local');
  expect(conversationBackend({ intelligenceKey: 'k' })).toBe('intelligence');
  expect(
    conversationBackend({ intelligenceKey: 'k', conversationBackend: 'local' }),
  ).toBe('local');
  const base = {
    apiKey: 'k',
    model: 'm',
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [] as string[],
  };
  expect(setupStatus(base)).toMatchObject({
    conversations: 'local',
    missing: [],
  });
  expect(
    setupStatus({ ...base, conversationBackend: 'intelligence' }).missing,
  ).toEqual([INTELLIGENCE_KEY_MISSING_LABEL]);
  expect(
    setupStatus(
      { ...base, slackChannel: 'c', slackTeam: 't', slackUsers: ['u'] },
      'online',
    ).slack,
  ).toBe('setup_required');
});
