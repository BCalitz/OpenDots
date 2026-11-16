import { expect, it } from 'vitest';
import { stopWhenStuck } from '../src/server/engine/stuck.js';
import { detachedContext, type Tool } from '../src/server/engine/tools.js';

const tool = (results: (() => unknown)[]): Tool => {
  let calls = 0;
  return {
    name: 'search',
    description: '',
    parameters: {} as never,
    execute: () => results[Math.min(calls++, results.length - 1)](),
  };
};
const run = (wrapped: Tool) => wrapped.execute({}, detachedContext());

it('tells the Dot to stop after a tool fails twice in a row', async () => {
  const [wrapped] = stopWhenStuck([tool([() => ({ isError: true })])]);
  expect(await run(wrapped)).toEqual({ isError: true });
  expect(await run(wrapped)).toMatchObject({ blocked: true });
  // Later calls do not reach the tool at all.
  expect(await run(wrapped)).toMatchObject({ status: 'blocked' });
});

it('counts thrown errors, and starts over after a success', async () => {
  const boom = () => {
    throw new Error('login refused');
  };
  const [wrapped] = stopWhenStuck([
    tool([boom, () => ({ ok: true }), boom, boom]),
  ]);
  await expect(run(wrapped)).rejects.toThrow('login refused');
  expect(await run(wrapped)).toEqual({ ok: true });
  await expect(run(wrapped)).rejects.toThrow('login refused');
  expect(await run(wrapped)).toMatchObject({ status: 'blocked' });
});

it('keeps a separate count for each turn', async () => {
  const failing = tool([() => ({ isError: true })]);
  const [first] = stopWhenStuck([failing]);
  await run(first);
  await run(first);
  const [second] = stopWhenStuck([failing]);
  expect(await run(second)).toEqual({ isError: true });
});

it('tells the run which tool blocked it', async () => {
  const blocked: string[] = [];
  const [wrapped] = stopWhenStuck([tool([() => ({ isError: true })])], (name) =>
    blocked.push(name),
  );
  await run(wrapped);
  expect(blocked).toEqual([]);
  await run(wrapped);
  expect(blocked).toEqual(['search']);
});
