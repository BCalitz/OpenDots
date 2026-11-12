import { afterEach, expect, it, vi } from 'vitest';
import { DotEngine } from '../src/server/engine/index.js';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import {
  DEFAULT_AGENT_RUN_TIMEOUT_MS,
  agentRunTimeoutMsFromEnv,
} from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { testDb, testWorkspace } from './fixtures/db.js';

const composio = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../src/server/composio.js', () => ({
  composioSession: composio.session,
}));

/** Two workers' stores on one database. */
async function sharedStores() {
  const db = await testDb();
  return { first: new Store(db), second: new Store(db) };
}
// Database I/O needs real immediates and ticks; only fake the clocks.
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
afterEach(() => {
  vi.restoreAllMocks();
  composio.session.mockReset();
  vi.useRealTimers();
});

it('uses 90 seconds by default and accepts a positive integer override', () => {
  expect(agentRunTimeoutMsFromEnv({})).toBe(DEFAULT_AGENT_RUN_TIMEOUT_MS);
  expect(agentRunTimeoutMsFromEnv({ AGENT_RUN_TIMEOUT_MS: ' 240000 ' })).toBe(
    240_000,
  );
});

it('rejects invalid timeout overrides at startup', () => {
  for (const value of ['0', '-1', '1.5', 'not-a-number', '2147483648'])
    expect(() =>
      agentRunTimeoutMsFromEnv({ AGENT_RUN_TIMEOUT_MS: value }),
    ).toThrow(/AGENT_RUN_TIMEOUT_MS/);
});

async function composioEngine(timeout?: number) {
  const { db, store, workspace } = await testWorkspace();
  const runner = new ThreadRunner(db, 'owner');
  const dot = (await workspace.dots())[0];
  await store.updateSettings({ appsAllowed: true });
  await workspace.updateDot(dot.id, { ...dot, appsAllowed: true });
  await workspace.bindThread('thread', dot.id, 'Timeout test');
  const engine = new DotEngine({
    store,
    workspace,
    runner,
    config: {
      apiKey: 'fixture',
      model: 'custom-model',
      composioApiKey: 'fixture',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      ...(timeout ? { agentRunTimeoutMs: timeout } : {}),
    },
  });
  return { engine, runner };
}

it('finishes an interactive turn when Composio startup stalls', async () => {
  const { engine } = await composioEngine(1_250);
  fakeTimers();
  composio.session.mockReturnValue(new Promise(() => {}));
  const { done } = await engine.start({
    threadId: 'thread',
    message: { content: 'Keep working.' },
  });
  await vi.waitFor(() => expect(composio.session).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1_251);
  const run = await done;
  expect(run.status).toBe('error');
  expect(run.error).toContain('1.25 second time limit');
  const signal = composio.session.mock.calls[0][4] as AbortSignal;
  expect(signal.aborted).toBe(true);
});

it('does not call the model after Composio startup is cancelled', async () => {
  const { engine, runner } = await composioEngine();
  let resolveSession!: (session: unknown) => void;
  composio.session.mockReturnValue(
    new Promise((resolve) => {
      resolveSession = resolve;
    }),
  );
  const network = vi.spyOn(globalThis, 'fetch');
  const { done } = await engine.start({
    threadId: 'thread',
    message: { content: 'Keep working.' },
  });
  await vi.waitFor(() => expect(composio.session).toHaveBeenCalled());
  const tools = vi.fn().mockResolvedValue([]);
  runner.stop('thread');
  resolveSession({ tools });
  expect((await done).status).toBe('stopped');
  expect(tools).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it('uses the configured timeout for scheduled/background runs', async () => {
  const store = new Store(await testDb());
  fakeTimers();
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    store,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((_resolve, reject) => {
        signal = runSignal;
        runSignal.addEventListener('abort', () => reject(runSignal.reason), {
          once: true,
        });
      }),
    1_250,
  );
  await store.createTask('Long-running task');
  const pending = runner.tick();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await vi.advanceTimersByTimeAsync(1_251);
  await pending;
  expect(signal?.aborted).toBe(true);
  expect((await store.tasks())[0].status).toBe('failed');
});

it('completes a longer background run after another worker checks the old lease deadline', async () => {
  const { first, second } = await sharedStores();
  fakeTimers();
  const result = {
    text: 'Finished after 200 seconds',
    sources: [],
    sample: true,
  };
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    first,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((resolve, reject) => {
        signal = runSignal;
        const timer = setTimeout(() => resolve(result), 200_000);
        runSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(runSignal.reason);
          },
          { once: true },
        );
      }),
    240_000,
  );
  const competingExecute = vi.fn().mockResolvedValue(result);
  const competing = new Runner(
    second,
    { mode: 'sample', baseUrl: '' },
    competingExecute,
  );
  const task = await first.createTask('Long-running task');
  const pending = runner.tick();
  await vi.waitFor(() => expect(signal).toBeDefined());
  const lease = (await first.task(task.id))?.lease;
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect((await second.task(task.id))?.status).toBe('running');
    expect((await second.task(task.id))?.lease).toBe(lease);
    expect(signal?.aborted).toBe(false);
    expect(competingExecute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect((await second.task(task.id))?.status).toBe('completed');
    expect((await second.detail(task.id))?.runs).toEqual([
      expect.objectContaining({ status: 'completed', result }),
    ]);
  } finally {
    await runner.stop();
    await competing.stop();
    await pending;
  }
});

it('still times out a longer background run after another worker checks its lease', async () => {
  const { first, second } = await sharedStores();
  fakeTimers();
  let signal: AbortSignal | undefined;
  const runner = new Runner(
    first,
    { mode: 'sample', baseUrl: '' },
    (_claim, _memories, runSignal) =>
      new Promise((_resolve, reject) => {
        signal = runSignal;
        runSignal.addEventListener('abort', () => reject(runSignal.reason), {
          once: true,
        });
      }),
    240_000,
  );
  const competing = new Runner(second, { mode: 'sample', baseUrl: '' });
  const task = await first.createTask('Long-running task');
  const pending = runner.tick();
  await vi.waitFor(() => expect(signal).toBeDefined());
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect((await second.task(task.id))?.status).toBe('running');
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect((await second.task(task.id))?.status).toBe('failed');
    expect((await second.detail(task.id))?.runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'Research exceeded the 240 second time limit.',
      }),
    ]);
  } finally {
    await runner.stop();
    await competing.stop();
    await pending;
  }
});
