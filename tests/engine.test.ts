import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DotEngine, CHANNEL_ERROR } from '../src/server/engine/index.js';
import {
  ThreadLockedError,
  ThreadRunner,
} from '../src/server/engine/thread-runner.js';
import { historyWindow } from '../src/server/engine/model.js';
import {
  reduceEvents,
  type BaseEvent,
  type Message,
} from '../src/shared/thread-events.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const config = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
};

function fixture(database = ':memory:', overrides = {}) {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const runner = new ThreadRunner(database, 'owner');
  const engine = new DotEngine({
    store,
    workspace,
    config: { ...config, ...overrides },
    runner,
  });
  cleanup.push(() => {
    runner.close();
    store.close();
    workspace.close();
  });
  const dot = workspace.dots()[0];
  const thread =
    workspace.conversations().find((item) => item.id === 'thread') ??
    workspace.bindThread('thread', dot.id, 'Chat');
  runner.createThread({ threadId: thread.id, agentId: dot.id });
  return { store, workspace, runner, engine, dot, thread };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}
const say = (content: string) => completion({ role: 'assistant', content });
const types = (events: BaseEvent[]) => events.map((event) => event.type);
/** A model request that only ends when it is aborted. */
const hangingModel = () =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    );

it('runs a tool, continues with its result and stores the turn', async () => {
  const f = fixture();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('create-page', 'create_space_page', {
        title: 'Notes',
        content: '# Notes',
      }),
    )
    .mockResolvedValueOnce(say('Created Notes.'));
  const seen: BaseEvent[] = [];
  f.engine.watch(f.thread.id, (event) => seen.push(event));
  const { done } = f.engine.start({
    threadId: f.thread.id,
    message: { id: 'user-1', content: 'Create a page called Notes.' },
  });
  const run = await done;

  expect(run.status).toBe('finished');
  expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Notes' })]),
  );
  expect(types(seen)[0]).toBe('RUN_STARTED');
  expect(types(seen).at(-1)).toBe('RUN_FINISHED');
  // One assistant message per model step, in the order the model API wants.
  expect(run.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ]);
  expect(run.messages[1]).toMatchObject({
    toolCalls: [{ id: 'create-page', function: { name: 'create_space_page' } }],
  });
  expect(run.messages[3]).toMatchObject({ content: 'Created Notes.' });
  // Live events rebuild the same messages the server stored.
  expect(reduceEvents(seen)).toEqual(run.messages);
  expect(f.runner.messages(f.thread.id)).toEqual(run.messages);

  const request = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(request.model).toBe('custom-model');
  expect(request.max_completion_tokens).toBe(2200);
  const continuation = JSON.parse(String(network.mock.calls[1][1]?.body));
  expect(continuation.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'create-page',
        content: expect.stringContaining('Notes'),
      }),
    ]),
  );
});

it('validates tool arguments before changing anything', async () => {
  const f = fixture();
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolCall('bad', 'create_space_page', { title: '' }))
    .mockResolvedValueOnce(say('That did not work.'));
  const run = await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Make a page.' },
  }).done;
  expect(run.status).toBe('finished');
  expect(f.workspace.pages.list(f.dot.spaceId)).toHaveLength(0);
  const result = run.messages.find((message) => message.role === 'tool');
  expect(String(result?.content)).toMatch(/error|invalid|title/i);
});

it('tells the model the current time and keeps old history out of the prompt window', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T07:33:12.000Z'));
  const f = fixture();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(say('It is 07:33 UTC.'));
  await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'What time is it?' },
  }).done;
  const request = JSON.parse(String(network.mock.calls[0][1]?.body));
  const system = request.messages.find(
    (message: { role: string }) => message.role === 'system',
  );
  expect(system.content).toContain(
    'Current time: 2026-10-04T07:33:12.000Z (UTC).',
  );
});

it('sends a recent window of history that starts at a user message', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 10; i++)
    messages.push(
      { id: `u${i}`, role: 'user', content: `question ${i}` },
      {
        id: `a${i}`,
        role: 'assistant',
        toolCalls: [
          {
            id: `c${i}`,
            type: 'function',
            function: { name: 'x', arguments: '{}' },
          },
        ],
      },
      { id: `t${i}`, role: 'tool', toolCallId: `c${i}`, content: 'ok' },
    );
  const window = historyWindow(messages, { messages: 7, characters: 1e6 });
  expect(window[0].role).toBe('user');
  expect(window.map((message) => message.id)).toEqual([
    'u8',
    'a8',
    't8',
    'u9',
    'a9',
    't9',
  ]);
  // A single huge message still goes through on its own.
  const huge = historyWindow(
    [{ id: 'big', role: 'user', content: 'x'.repeat(50) }],
    { messages: 10, characters: 10 },
  );
  expect(huge.map((message) => message.id)).toEqual(['big']);
});

it('allows one run per thread, stops it cleanly and keeps the stop in history', async () => {
  const f = fixture();
  hangingModel();
  const { done } = f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Think for a long time.' },
  });
  expect(() =>
    f.engine.start({ threadId: f.thread.id, message: { content: 'Again' } }),
  ).toThrow(ThreadLockedError);
  await vi.waitFor(() => expect(f.runner.isRunning(f.thread.id)).toBe(true));
  expect(f.engine.stop(f.thread.id)).toBe(true);
  const run = await done;
  expect(run.status).toBe('stopped');
  expect(f.runner.isRunning(f.thread.id)).toBe(false);
  expect(f.runner.runs(f.thread.id).at(-1)?.status).toBe('stopped');
  // The user message stays; nothing invented an answer.
  expect(f.runner.messages(f.thread.id)).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'Think for a long time.',
    }),
  ]);
});

it('stops a turn that hits the time limit with a visible error', async () => {
  vi.useFakeTimers();
  const f = fixture(':memory:', { agentRunTimeoutMs: 5_000 });
  hangingModel();
  const seen: BaseEvent[] = [];
  f.engine.watch(f.thread.id, (event) => seen.push(event));
  const { done } = f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Slow' },
  });
  await vi.advanceTimersByTimeAsync(5_001);
  const run = await done;
  expect(run.status).toBe('error');
  expect(run.error).toMatch(/5 second time limit/);
  expect(seen.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    message: expect.stringMatching(/time limit/),
  });
});

it('stops when the owner pauses work and says why', async () => {
  const f = fixture();
  const network = hangingModel();
  const { done } = f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Work' },
  });
  await vi.waitFor(() => expect(network).toHaveBeenCalled());
  f.store.updateSettings({ paused: true });
  const run = await done;
  expect(run.status).toBe('error');
  expect(run.error).toMatch(/paused/);
  expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('runs headless turns in the same thread, waiting for a turn already running', async () => {
  const f = fixture();
  let release!: () => void;
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(say('Chat answer'));
        }),
    )
    .mockResolvedValueOnce(say('Your summary'));
  const chat = f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Hello' },
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const scheduled = f.engine.turn(
    f.thread.id,
    'Daily summary',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );
  release();
  await chat.done;
  expect(await scheduled).toBe('Your summary');
  const messages = f.runner.messages(f.thread.id);
  expect(messages.map((message) => message.content)).toEqual([
    'Hello',
    'Chat answer',
    'Daily summary',
    'Your summary',
  ]);
  expect(messages[2].id).toMatch(/^opendots:scheduled_task:/);
  expect(messages[2]).toMatchObject({
    metadata: { opendotsSource: 'scheduled_task' },
  });
});

it('stops a headless turn when its signal aborts', async () => {
  const f = fixture();
  hangingModel();
  const controller = new AbortController();
  const pending = f.engine.turn(f.thread.id, 'Long', controller.signal);
  await vi.waitFor(() => expect(f.runner.isRunning(f.thread.id)).toBe(true));
  controller.abort(new Error('caller left'));
  await expect(pending).rejects.toThrow('caller left');
  await vi.waitFor(() => expect(f.runner.isRunning(f.thread.id)).toBe(false));
  expect(f.runner.runs(f.thread.id).at(-1)?.status).toBe('stopped');
});

it('meters tokens per run and refuses new turns at the monthly cap', async () => {
  const f = fixture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      [
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'custom-model',
          choices: [
            { index: 0, delta: { content: 'Hi' }, finish_reason: null },
          ],
        },
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'custom-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 200,
            total_tokens: 1100,
          },
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  const run = await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Hi' },
  }).done;
  expect(run.status).toBe('finished');
  expect(f.workspace.usage.monthTokens(f.dot.id)).toBe(1100);
  expect(f.runner.listRuns()[0]).toMatchObject({
    inputTokens: 900,
    outputTokens: 200,
    prompt: 'Hi',
  });

  f.workspace.setMonthlyTokenCap(f.dot.id, 1000);
  const capped = await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'More' },
  }).done;
  expect(capped.status).toBe('error');
  expect(capped.error).toMatch(/monthly limit of 1,000 tokens/);
});

it('never shows error details in Slack', async () => {
  const f = fixture(':memory:', { model: undefined });
  const run = await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Hi' },
    source: 'slack',
  }).done;
  expect(run.error).toBe(CHANNEL_ERROR);
  const web = await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Hi' },
  }).done;
  expect(web.error).toBe('Model configuration is required.');
});

it('keeps history across a restart, replays it and closes runs a crash left open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'opendots.sqlite');
  let f = fixture(database);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(say('Hello there'));
  await f.engine.start({
    threadId: f.thread.id,
    message: { content: 'Say hello' },
  }).done;
  // A run the process never finished, as after a crash.
  const crashed = new ThreadRunner(database, 'owner');
  crashed.start({
    threadId: f.thread.id,
    agentId: f.dot.id,
    messages: [{ id: 'lost', role: 'user', content: 'Are you there?' }],
    work: async (run) => {
      run.emit({
        type: 'TEXT_MESSAGE_START',
        messageId: 'partial',
        role: 'assistant',
      } as BaseEvent);
      run.emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'partial',
        delta: 'I was say',
      } as BaseEvent);
      await new Promise(() => {});
    },
  });
  crashed.close();
  cleanup.pop()!();

  f = fixture(database);
  const replay = f.engine.watch(f.thread.id, () => {});
  replay.unsubscribe();
  expect(replay.running).toBe(false);
  const messages = reduceEvents(replay.events);
  expect(messages.map((message) => message.content)).toEqual([
    'Say hello',
    'Hello there',
    'Are you there?',
    'I was say',
  ]);
  expect(replay.events.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    message: expect.stringMatching(/stopped before this answer finished/),
  });
  expect(f.runner.runs(f.thread.id).at(-1)?.status).toBe('interrupted');
  // The partial answer is part of what the model sees next time.
  expect(f.runner.messages(f.thread.id)).toHaveLength(4);
});

it('replays a running turn to a late watcher without gaps', async () => {
  const f = fixture();
  let release!: () => void;
  f.runner.start({
    threadId: f.thread.id,
    agentId: f.dot.id,
    messages: [{ id: 'u', role: 'user', content: 'Hi' }],
    work: async (run) => {
      run.emit({
        type: 'TEXT_MESSAGE_START',
        messageId: 'm',
        role: 'assistant',
      } as BaseEvent);
      run.emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm',
        delta: 'Hel',
      } as BaseEvent);
      await new Promise<void>((resolve) => (release = resolve));
      run.emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm',
        delta: 'lo',
      } as BaseEvent);
      run.emit({ type: 'TEXT_MESSAGE_END', messageId: 'm' } as BaseEvent);
    },
  });
  const live: BaseEvent[] = [];
  const view = f.runner.watch(f.thread.id, (event) => live.push(event));
  expect(view.running).toBe(true);
  release();
  await f.runner.done(f.thread.id);
  const messages = reduceEvents([...view.events, ...live]);
  expect(messages.map((message) => message.content)).toEqual(['Hi', 'Hello']);
  expect(types(live).at(-1)).toBe('RUN_FINISHED');
  // Stored events are compacted once the run ends.
  const stored = f.runner.watch(f.thread.id, () => {});
  stored.unsubscribe();
  expect(
    stored.events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT'),
  ).toEqual([expect.objectContaining({ delta: 'Hello' })]);
});

it('renames, archives and deletes threads for the owner only', () => {
  const runner = new ThreadRunner(':memory:', 'owner');
  cleanup.push(() => runner.close());
  runner.createThread({ threadId: 't', agentId: 'dot' });
  expect(runner.renameThread('t', 'Named')?.name).toBe('Named');
  expect(runner.archiveThread('t')?.archived).toBe(true);
  expect(() =>
    runner.createThread({ threadId: 't', agentId: 'other' }),
  ).toThrow(/different Dot/);
  expect(runner.deleteThread('t')).toBe(true);
  expect(runner.thread('t')).toBeUndefined();
});

it('reports setup activation once an answer streams, and failures by class', async () => {
  const capture = vi.fn();
  const make = (overrides = {}) => {
    const f = fixture(':memory:', overrides);
    const engine = new DotEngine({
      store: f.store,
      workspace: f.workspace,
      runner: f.runner,
      config: { ...config, ...overrides },
      setupTelemetry: { capture } as never,
    });
    return { ...f, engine };
  };
  const ok = make();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(say('Hello'));
  await ok.engine.start({ threadId: ok.thread.id, message: { content: 'Hi' } })
    .done;
  expect(capture).toHaveBeenCalledWith({ kind: 'activated' });

  capture.mockClear();
  const unconfigured = make({ model: undefined });
  await unconfigured.engine.start({
    threadId: unconfigured.thread.id,
    message: { content: 'Hi' },
  }).done;
  expect(capture.mock.calls).toEqual([
    [
      {
        kind: 'setup_failed',
        step: 'setup_required',
        error_class: 'configuration_missing',
      },
    ],
  ]);

  capture.mockClear();
  const failing = make();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response('nope', { status: 500 }),
  );
  await failing.engine.start({
    threadId: failing.thread.id,
    message: { content: 'Hi' },
  }).done;
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({ error_class: 'assistant_run_failed' }),
  );
  expect(capture).not.toHaveBeenCalledWith({ kind: 'activated' });
});
