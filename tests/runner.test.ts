import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { research, type Config } from '../src/server/research.js';
import { testDb } from './fixtures/db.js';
const config: Config = {
  mode: 'live',
  apiKey: 'test',
  model: 'test',
  browserUrl: 'http://browser:4311',
  browserSecret: 'test',
  baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
it('records generic scheduled runs without research wording', async () => {
  const store = new Store(await testDb());
  const prompt = 'Draft a welcome email.';
  const result = {
    text: 'A concise welcome email.',
    sources: [],
    sample: false,
  };
  const execute = vi.fn(async () => result);
  const runner = new Runner(store, config, execute);
  const task = await store.createTask(prompt);

  try {
    await runner.tick();

    const detail = (await store.detail(task.id))!;
    expect(detail.task.prompt).toBe(prompt);
    expect(detail.runs[0].result).toEqual(result);
    expect(detail.events.map((event) => event.text)).toEqual([
      'Task added to the queue.',
      'Run started.',
      'Run completed.',
    ]);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await runner.stop();
  }
});
it('aborts research when permissions are revoked outside the runner instance', async () => {
  const store = new Store(await testDb());
  const runner = new Runner(store, config);
  let requestSignal: AbortSignal | undefined;
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', request);
  await store.createTask('Read https://example.com');
  const tick = runner.tick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect((await store.tasks())[0].status).toBe('interrupted');
  await runner.stop();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      title: 'Source',
      text: 'Page text',
      url: 'https://example.com',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(
    research(
      'Read https://example.com',
      [],
      config,
      controller.signal,
      (text) => {
        if (text.startsWith('Source captured')) controller.abort();
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
  const store = new Store(await testDb());
  await store.saveMemory('Sensitive preference');
  await store.updateSettings({ memoryAllowed: false });
  const task = await store.createTask('Read this sample');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  try {
    await runner.tick();
    expect((await store.detail(task.id))?.runs[0].result?.text).not.toContain(
      'Sensitive preference',
    );
    expect((await store.detail(task.id))?.runs[0].result?.sample).toBe(true);
    expect((await store.detail(task.id))?.events.at(-1)?.text).toBe(
      'Fictional sample brief ready.',
    );
  } finally {
    await runner.stop();
  }
});
it('holds active work for review on graceful shutdown', async () => {
  const store = new Store(await testDb());
  const runner = new Runner(store, config);
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await store.createTask('Read https://example.com');
  const pending = runner.tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await runner.stop();
  await pending;
  expect((await store.tasks())[0].status).toBe('interrupted');
  expect(await store.claim()).toBeNull();
  await store.action((await store.tasks())[0].id, 'run');
  expect(await store.claim()).toBeTruthy();
});
it('survives a claim failure and runs work on the next tick', async () => {
  const store = new Store(await testDb());
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const claim = vi
    .spyOn(store, 'claim')
    .mockRejectedValueOnce(new Error('Database busy'));
  const task = await store.createTask('Read this sample');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    await runner.tick();
    expect(claim).toHaveBeenCalledTimes(2);
    expect((await store.detail(task.id))?.runs[0].result).toBeTruthy();
  } finally {
    log.mockRestore();
  }
});
it('survives failure persistence errors and clears active work', async () => {
  const store = new Store(await testDb());
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error('Provider failure'))
    .mockResolvedValueOnce({ text: 'Recovered', sources: [], memories: [] });
  const runner = new Runner(store, config, execute);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fail = vi
    .spyOn(store, 'fail')
    .mockRejectedValueOnce(new Error('Database busy'));
  await store.createTask('First');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
    await store.createTask('Second');
    await runner.tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
it('aborts work instead of throwing from an ownership timer', async () => {
  const store = new Store(await testDb());
  await store.createTask('First');
  const runner = new Runner(
    store,
    config,
    (_claim, _memories, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.spyOn(store, 'owns').mockRejectedValueOnce(
    new Error('Database unavailable'),
  );
  await expect(runner.tick()).resolves.toBeUndefined();
  expect((await store.tasks())[0].status).toBe('failed');
});
