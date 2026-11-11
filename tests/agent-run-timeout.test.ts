import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotEngine } from '../src/server/engine/index.js';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import {
  DEFAULT_AGENT_RUN_TIMEOUT_MS,
  agentRunTimeoutMsFromEnv,
} from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const composio = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../src/server/composio.js', () => ({
  composioSession: composio.session,
}));

const resources: Array<{ close(): void }> = [];
function sharedStores() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-timeout-'));
  const path = join(dir, 'test.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  resources.push(first, second, {
    close: () => rmSync(dir, { recursive: true, force: true }),
  });
  return { first, second };
}
afterEach(() => {
  vi.restoreAllMocks();
  composio.session.mockReset();
  vi.useRealTimers();
  resources.splice(0).forEach((resource) => resource.close());
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

function composioEngine(timeout?: number) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const runner = new ThreadRunner(':memory:', 'owner');
  resources.push(runner, store, workspace);
  const dot = workspace.dots()[0];
  store.updateSettings({ appsAllowed: true });
  workspace.updateDot(dot.id, { ...dot, appsAllowed: true });
  workspace.bindThread('thread', dot.id, 'Timeout test');
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
  vi.useFakeTimers();
  const { engine } = composioEngine(1_250);
  composio.session.mockReturnValue(new Promise(() => {}));
  const { done } = engine.start({
    threadId: 'thread',
    message: { content: 'Keep working.' },
  });
  await vi.advanceTimersByTimeAsync(1_251);
  const run = await done;
  expect(run.status).toBe('error');
  expect(run.error).toContain('1.25 second time limit');
  const signal = composio.session.mock.calls[0][4] as AbortSignal;
  expect(signal.aborted).toBe(true);
});

it('does not call the model after Composio startup is cancelled', async () => {
  const { engine, runner } = composioEngine();
  let resolveSession!: (session: unknown) => void;
  composio.session.mockReturnValue(
    new Promise((resolve) => {
      resolveSession = resolve;
    }),
  );
  const network = vi.spyOn(globalThis, 'fetch');
  const { done } = engine.start({
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
  vi.useFakeTimers();
  const store = new Store(':memory:');
  resources.push(store);
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
  store.createTask('Long-running task');
  const pending = runner.tick();
  await vi.advanceTimersByTimeAsync(1_251);
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(store.tasks()[0].status).toBe('failed');
});

it('completes a longer background run after another worker checks the old lease deadline', async () => {
  vi.useFakeTimers();
  const { first, second } = sharedStores();
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
  const task = first.createTask('Long-running task');
  const pending = runner.tick();
  const lease = first.task(task.id)?.lease;
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect(second.task(task.id)?.status).toBe('running');
    expect(second.task(task.id)?.lease).toBe(lease);
    expect(signal?.aborted).toBe(false);
    expect(competingExecute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(second.task(task.id)?.status).toBe('completed');
    expect(second.detail(task.id)?.runs).toEqual([
      expect.objectContaining({ status: 'completed', result }),
    ]);
  } finally {
    runner.stop();
    competing.stop();
    await pending;
  }
});

it('still times out a longer background run after another worker checks its lease', async () => {
  vi.useFakeTimers();
  const { first, second } = sharedStores();
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
  const task = first.createTask('Long-running task');
  const pending = runner.tick();
  try {
    await vi.advanceTimersByTimeAsync(180_001);
    await competing.tick();
    expect(second.task(task.id)?.status).toBe('running');
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(second.task(task.id)?.status).toBe('failed');
    expect(second.detail(task.id)?.runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'Research exceeded the 240 second time limit.',
      }),
    ]);
  } finally {
    runner.stop();
    competing.stop();
    await pending;
  }
});
