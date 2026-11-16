import { expect, it } from 'vitest';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import { blockedRuns } from '../src/client/ActivityView.js';
import type { RunSummary } from '../src/shared/insight-types.js';
import { testDb } from './fixtures/db.js';

it('ends a run as blocked, with what blocked it, when the Dot stops on purpose', async () => {
  const runner = new ThreadRunner(await testDb(), 'owner');
  const { done, runId } = await runner.start({
    threadId: 't1',
    agentId: 'dot',
    messages: [{ id: 'u1', role: 'user', content: 'Check the portal' }],
    work: async (run) =>
      run.blocked('portal login kept failing, so I stopped.'),
  });
  const finished = await done;
  expect(finished.status).toBe('blocked');
  expect(finished.error).toMatch(/portal login/);
  const [stored] = await runner.listRuns({ threadId: 't1' });
  expect(stored).toMatchObject({ id: runId, status: 'blocked' });
});

it('only counts the newest run of a thread as blocked', () => {
  const run = (
    id: string,
    threadId: string,
    status: RunSummary['status'],
    startedAt: number,
  ) => ({ id, threadId, status, startedAt }) as RunSummary;
  expect(
    blockedRuns([
      run('a', 't1', 'blocked', 1),
      run('b', 't1', 'finished', 2),
      run('c', 't2', 'blocked', 3),
    ]).map((r) => r.id),
  ).toEqual(['c']);
});
