import { afterEach, describe, expect, it } from 'vitest';
import {
  decideRoute,
  topicQuestions,
} from '../src/server/conversations/auto-thread.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import {
  reduceEvents,
  type BaseEvent,
  type Message,
} from '../src/shared/thread-events.js';
import { testDb } from './fixtures/db.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A main chat with three exchanges: hello, invoice, invoice follow-up. */
async function fixture() {
  const db = await testDb();
  const workspace = await WorkspaceStore.open(db, 'owner');
  const runner = new ThreadRunner(db, 'owner');
  cleanup.push(() => runner.close());
  const dot = (await workspace.dots())[0];
  const main = await workspace.bindThread('main', dot.id, 'Chat');
  await runner.createThread({ threadId: main.id, agentId: dot.id });
  for (const [id, question] of [
    ['u1', 'Hello'],
    ['u2', 'About the PayFast invoice'],
    ['u3', 'Was it paid?'],
  ]) {
    const { done } = await runner.start({
      threadId: main.id,
      agentId: dot.id,
      messages: [{ id, role: 'user', content: question }],
      work: async (run) => {
        run.emit({
          type: 'TEXT_MESSAGE_START',
          messageId: `a-${id}`,
          role: 'assistant',
        } as never);
        run.emit({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: `a-${id}`,
          delta: `Answer to ${question}`,
        } as never);
        run.emit({ type: 'TEXT_MESSAGE_END', messageId: `a-${id}` } as never);
      },
    });
    await done;
  }
  return { db, workspace, runner, dot, main };
}

/** What a client sees when it opens the thread. */
async function replay(runner: ThreadRunner, threadId: string) {
  const view = await runner.watch(threadId, () => undefined);
  view.unsubscribe();
  return reduceEvents(view.events, []).map((message: Message) => message.id);
}

it('moves an exchange and everything after it into a new thread', async () => {
  const { runner, main } = await fixture();
  const result = await runner.split({
    sourceId: main.id,
    targetId: 'topic',
    // An assistant message cuts at the user message that asked it.
    messageId: 'a-u2',
    mode: 'move',
  });
  expect(result).toEqual({ cutMessageId: 'u2', anchorMessageId: 'a-u1' });
  expect((await runner.messages(main.id)).map((m) => m.id)).toEqual([
    'u1',
    'a-u1',
  ]);
  expect((await runner.messages('topic')).map((m) => m.id)).toEqual([
    'u2',
    'a-u2',
    'u3',
    'a-u3',
  ]);
  expect(await replay(runner, main.id)).toEqual(['u1', 'a-u1']);
  expect(await replay(runner, 'topic')).toEqual(['u2', 'a-u2', 'u3', 'a-u3']);
  expect((await runner.runs('topic')).length).toBe(2);
  expect((await runner.runs(main.id)).length).toBe(1);
});

it('copies one exchange into a thread and leaves the chat as it was', async () => {
  const { runner, main } = await fixture();
  const result = await runner.split({
    sourceId: main.id,
    targetId: 'topic',
    messageId: 'u2',
    mode: 'copy',
  });
  expect(result).toEqual({ cutMessageId: 'u2', anchorMessageId: 'u2' });
  expect(await replay(runner, main.id)).toEqual([
    'u1',
    'a-u1',
    'u2',
    'a-u2',
    'u3',
    'a-u3',
  ]);
  expect(await replay(runner, 'topic')).toEqual(['u2', 'a-u2']);
  expect((await runner.messages('topic')).map((m) => m.id)).toEqual([
    'u2',
    'a-u2',
  ]);
  // The thread carries on as its own conversation.
  const { done } = await runner.start({
    threadId: 'topic',
    agentId: (await runner.thread(main.id))!.agentId,
    messages: [{ id: 'u4', role: 'user', content: 'Check the bank too' }],
    work: async () => undefined,
  });
  await done;
  expect((await runner.messages('topic')).map((m) => m.id)).toEqual([
    'u2',
    'a-u2',
    'u4',
  ]);
  expect((await runner.messages(main.id)).length).toBe(6);
});

it('refuses to split a message that is not in the conversation', async () => {
  const { runner, main } = await fixture();
  await expect(
    runner.split({
      sourceId: main.id,
      targetId: 'topic',
      messageId: 'missing',
      mode: 'move',
    }),
  ).rejects.toThrow(/Choose a message/);
  expect(await runner.thread('topic')).toBeUndefined();
});

it('keeps topic threads out of the main chat and lists them under it', async () => {
  const { workspace, dot, main } = await fixture();
  await workspace.bindThread('topic', dot.id, 'PayFast invoice', undefined, {
    parentId: main.id,
    anchorMessageId: 'a-u1',
  });
  expect((await workspace.mainConversation(dot.id))?.id).toBe(main.id);
  expect(await workspace.topicThreads(main.id)).toEqual([
    expect.objectContaining({
      id: 'topic',
      parentId: main.id,
      anchorMessageId: 'a-u1',
    }),
  ]);
});

it('moves a thread exchange back to the end of the main chat', async () => {
  const { runner, main } = await fixture();
  await runner.split({
    sourceId: main.id,
    targetId: 'topic',
    messageId: 'u3',
    mode: 'move',
  });
  const kept = await runner.moveTail({
    sourceId: 'topic',
    targetId: main.id,
    messageId: 'u3',
  });
  expect(kept).toBe(0);
  expect(await replay(runner, main.id)).toEqual([
    'u1',
    'a-u1',
    'u2',
    'a-u2',
    'u3',
    'a-u3',
  ]);
  expect((await runner.messages(main.id)).length).toBe(6);
  // Event numbers stay unique, so the main chat keeps working.
  const { done } = await runner.start({
    threadId: main.id,
    agentId: (await runner.thread(main.id))!.agentId,
    messages: [{ id: 'u5', role: 'user', content: 'Thanks' }],
    work: async () => undefined,
  });
  await done;
  expect((await replay(runner, main.id)).at(-1)).toBe('u5');
});

describe('deciding where a message goes', () => {
  const answers = (
    continues: number | null,
    substantive: number,
    about: Record<string, number> = {},
  ) => ({ continues, substantive, about });
  it('keeps a follow-up in the main chat', () => {
    expect(decideRoute(answers(0.9, 0.9, { t: 0.9 }))).toEqual({
      kind: 'stay',
    });
    // Unsettled counts as a follow-up: the owner wrote it here.
    expect(decideRoute(answers(0.5, 0.9))).toEqual({ kind: 'stay' });
  });
  it('sends a follow-up to the thread the latest exchange was in', () => {
    expect(
      decideRoute({
        ...answers(0.9, 0.9, { cookies: 0.6, cake: 0.6 }),
        latestThreadId: 'cake',
      }),
    ).toEqual({ kind: 'thread', threadId: 'cake' });
    // Unsure whether it follows on: still where the conversation is.
    expect(
      decideRoute({ ...answers(0.5, 0.9), latestThreadId: 'cake' }),
    ).toEqual({ kind: 'thread', threadId: 'cake' });
  });
  it('sends a change of topic to the thread it is about', () => {
    expect(decideRoute(answers(0.1, 0.9, { a: 0.2, b: 0.85 }))).toEqual({
      kind: 'thread',
      threadId: 'b',
    });
  });
  it('opens a new thread only for a clearly new, substantive topic', () => {
    expect(decideRoute(answers(0.1, 0.9, { a: 0.1 }))).toEqual({
      kind: 'new',
    });
    expect(decideRoute(answers(0.1, 0.2))).toEqual({ kind: 'stay' });
    // Possibly about a thread, but not surely: leave it where it was written.
    expect(decideRoute(answers(0.1, 0.9, { a: 0.5 }))).toEqual({
      kind: 'stay',
    });
  });
  it('keeps the first topic of an empty chat in the chat', () => {
    expect(decideRoute(answers(null, 0.9))).toEqual({ kind: 'stay' });
    expect(decideRoute(answers(null, 0.9, { a: 0.9 }))).toEqual({
      kind: 'thread',
      threadId: 'a',
    });
  });
  it('asks one question per thread, by label, never by id', () => {
    const questions = topicQuestions({
      recent: [{ role: 'user', text: 'Plan my trip' }],
      threads: [
        {
          id: 'uuid-1',
          title: 'Invoice',
          opened: 'x',
          recent: [{ role: 'user', text: 'y' }],
        },
      ],
      message: 'Was the invoice paid?',
    });
    expect(Object.keys(questions).sort()).toEqual([
      'about__thread_1',
      'continues',
      'substantive',
    ]);
    expect(JSON.stringify(questions)).not.toContain('uuid-1');
  });
});

it('streams a thread answer into the main chat that shows it', async () => {
  const { runner, main, dot } = await fixture();
  await runner.createThread({ threadId: 'topic', agentId: dot.id });
  const live: BaseEvent[] = [];
  const view = await runner.watch(main.id, (event) => live.push(event));
  const { done } = await runner.start({
    threadId: 'topic',
    agentId: dot.id,
    shownIn: main.id,
    messages: [
      { id: 'cap', role: 'user', content: 'Capital of South Africa?' },
    ],
    work: async (run) => {
      run.emit({
        type: 'TEXT_MESSAGE_START',
        messageId: 'a-cap',
        role: 'assistant',
      } as never);
      run.emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'a-cap',
        delta: 'Pretoria, Cape Town and Bloemfontein',
      } as never);
      run.emit({ type: 'TEXT_MESSAGE_END', messageId: 'a-cap' } as never);
    },
  });
  await done;
  view.unsubscribe();
  const streamed = reduceEvents(live, []);
  expect(streamed.map((m) => m.id)).toEqual(['cap', 'a-cap']);
  expect(streamed[0]).toMatchObject({ topicThreadId: 'topic' });
  // Replayed in order with the main chat's own exchanges...
  expect(await replay(runner, main.id)).toEqual([
    'u1',
    'a-u1',
    'u2',
    'a-u2',
    'u3',
    'a-u3',
    'cap',
    'a-cap',
  ]);
  // ...but only the thread's history is context for it.
  expect((await runner.messages(main.id)).map((m) => m.id)).not.toContain(
    'cap',
  );
  expect((await runner.messages('topic')).map((m) => m.id)).toEqual([
    'cap',
    'a-cap',
  ]);
});

it('keeps showing a moved split in the main chat when asked', async () => {
  const { runner, main } = await fixture();
  await runner.split({
    sourceId: main.id,
    targetId: 'topic',
    messageId: 'u2',
    mode: 'move',
    keepShown: true,
  });
  expect((await runner.messages(main.id)).map((m) => m.id)).toEqual([
    'u1',
    'a-u1',
  ]);
  expect(await replay(runner, main.id)).toEqual([
    'u1',
    'a-u1',
    'u2',
    'a-u2',
    'u3',
    'a-u3',
  ]);
  // Moving it back clears the mark, so nothing shows twice.
  await runner.moveTail({
    sourceId: 'topic',
    targetId: main.id,
    messageId: 'u2',
  });
  expect(await replay(runner, main.id)).toEqual([
    'u1',
    'a-u1',
    'u2',
    'a-u2',
    'u3',
    'a-u3',
  ]);
});
