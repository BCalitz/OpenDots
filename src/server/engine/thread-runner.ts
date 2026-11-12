import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { RunSummary } from '../../shared/insight-types.js';
import {
  compactEvents,
  messageText,
  reduceEvents,
  type BaseEvent,
  type Message,
} from '../../shared/thread-events.js';

type RunStatus = 'running' | 'finished' | 'error' | 'stopped' | 'interrupted';
export interface LocalThread {
  id: string;
  agentId: string;
  ownerId: string;
  name: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface LocalRun {
  id: string;
  threadId: string;
  parentRunId: string | null;
  agentId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
export interface FinishedRun {
  threadId: string;
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  error: string | null;
  /** The whole thread after this run. */
  messages: Message[];
  /** Messages this run added, including the user message that started it. */
  added: Message[];
}
export interface TokenUsage {
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
/** What a run's work function gets. */
export interface RunContext {
  threadId: string;
  runId: string;
  /** The thread's messages, ending with the ones this run started with. */
  messages: Message[];
  signal: AbortSignal;
  emit(event: BaseEvent): void;
  /** Reports model tokens; summed onto RUN_FINISHED and the run record. */
  usage(entries: TokenUsage[]): void;
}
/** Thrown when a thread already has a run going. */
export class ThreadLockedError extends Error {
  readonly code = 'thread_locked';
  constructor() {
    super('This conversation is already answering. Wait or stop it first.');
  }
}
type Listener = (event: BaseEvent) => void;
interface ActiveRun {
  runId: string;
  /** A main chat that also shows this run, live. */
  shownIn?: string;
  controller: AbortController;
  events: BaseEvent[];
  usage: TokenUsage[];
  stopRequested: boolean;
  done: Promise<FinishedRun>;
  /** Event writes, in order; the run's final save waits for them. */
  writes: Promise<void>;
}

/** Token usage reported on RUN_FINISHED, summed across models. */
export function runTokens(events: BaseEvent[]) {
  let found = false;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type !== 'RUN_FINISHED') continue;
    const usage = (event as { usage?: unknown }).usage;
    if (!Array.isArray(usage)) continue;
    for (const entry of usage as TokenUsage[]) {
      if (typeof entry?.inputTokens === 'number') {
        inputTokens += entry.inputTokens;
        found = true;
      }
      if (typeof entry?.outputTokens === 'number') {
        outputTokens += entry.outputTokens;
        found = true;
      }
    }
  }
  return found ? { inputTokens, outputTokens } : undefined;
}
/** Adds usage entries, one per model. */
function sumUsage(entries: TokenUsage[]) {
  const byModel = new Map<string, TokenUsage>();
  for (const entry of entries) {
    const key = entry.model ?? '';
    const total = byModel.get(key) ?? {
      ...(entry.model ? { model: entry.model } : {}),
    };
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const)
      if (typeof entry[field] === 'number')
        total[field] = (total[field] ?? 0) + entry[field];
    byModel.set(key, total);
  }
  return [...byModel.values()];
}
/** The text of the last user message a run started with. */
function promptOf(event: BaseEvent & { input?: { messages?: Message[] } }) {
  const message = event.input?.messages
    ?.filter((item) => item.role === 'user')
    .at(-1);
  const value = message ? messageText(message).trim() : '';
  return value ? value.slice(0, 300) : null;
}

/**
 * An event from a topic thread as its main chat shows it: the messages the
 * run started with say which thread they belong to.
 */
function shownFrom(event: BaseEvent, threadId: string): BaseEvent {
  if (event.type !== 'RUN_STARTED') return event;
  const input = (event as { input?: { messages?: Message[] } }).input;
  return {
    ...event,
    input: {
      ...input,
      messages: (input?.messages ?? []).map((message) => ({
        ...message,
        topicThreadId: threadId,
      })),
    },
  } as BaseEvent;
}

const INTERRUPTED_MESSAGE =
  'OpenDots stopped before this answer finished. Send your message again to continue.';
const STOP_MESSAGE = 'Run stopped by user';

/**
 * Closes a run that ended without a terminal event: ends open text messages
 * and tool calls, gives unanswered tool calls a result, and adds
 * RUN_FINISHED (a stop) or RUN_ERROR. Appends to `events` and returns what
 * was added.
 */
function finalizeRunEvents(
  events: BaseEvent[],
  options: { stopRequested?: boolean; message?: string } = {},
): BaseEvent[] {
  if (events.some((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR'))
    return [];
  const openText = new Set<string>();
  const openCalls = new Map<string, { ended: boolean; answered: boolean }>();
  for (const raw of events) {
    const event = raw as BaseEvent & {
      messageId?: string;
      toolCallId?: string;
    };
    if (event.type === 'TEXT_MESSAGE_START' && event.messageId)
      openText.add(event.messageId);
    else if (event.type === 'TEXT_MESSAGE_END' && event.messageId)
      openText.delete(event.messageId);
    else if (event.type === 'TOOL_CALL_START' && event.toolCallId)
      openCalls.set(event.toolCallId, { ended: false, answered: false });
    else if (
      (event.type === 'TOOL_CALL_END' || event.type === 'TOOL_CALL_RESULT') &&
      event.toolCallId
    ) {
      const call = openCalls.get(event.toolCallId);
      if (!call) continue;
      if (event.type === 'TOOL_CALL_END') call.ended = true;
      else call.answered = true;
      if (call.ended && call.answered) openCalls.delete(event.toolCallId);
    }
  }
  const stopped = !!options.stopRequested;
  const message =
    options.message ??
    (stopped ? STOP_MESSAGE : 'Run ended without emitting a terminal event');
  const appended: BaseEvent[] = [];
  for (const messageId of openText)
    appended.push({ type: 'TEXT_MESSAGE_END', messageId } as BaseEvent);
  for (const [toolCallId, call] of openCalls) {
    if (!call.ended)
      appended.push({ type: 'TOOL_CALL_END', toolCallId } as BaseEvent);
    if (!call.answered)
      appended.push({
        type: 'TOOL_CALL_RESULT',
        toolCallId,
        messageId: `${toolCallId}-result`,
        role: 'tool',
        content: JSON.stringify(
          stopped
            ? { status: 'stopped', reason: 'stop_requested', message }
            : { status: 'error', reason: 'missing_terminal_event', message },
        ),
      } as BaseEvent);
  }
  appended.push(
    stopped
      ? ({ type: 'RUN_FINISHED' } as BaseEvent)
      : ({
          type: 'RUN_ERROR',
          message,
          code: 'INCOMPLETE_STREAM',
        } as BaseEvent),
  );
  events.push(...appended);
  return appended;
}

/**
 * Durable conversation runner. One run per thread at a time; every event is
 * written to the database as it streams and pushed to anyone watching the thread,
 * so a refresh or a second device picks up a run that is still going.
 *
 * When a run ends its events are compacted in place (text deltas merged),
 * which keeps replay fast and storage small. The tables are the ones phase 1
 * created, so earlier threads open unchanged.
 */
export class ThreadRunner {
  private active = new Map<string, ActiveRun>();
  private listeners = new Map<string, Set<Listener>>();
  constructor(
    private db: Db,
    private ownerId: string,
    private options: { onRunFinished?: (run: FinishedRun) => void } = {},
  ) {}

  // Thread records ------------------------------------------------------

  async createThread(input: {
    threadId: string;
    agentId: string;
    name?: string;
  }) {
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO conv_threads (id, agent_id, owner_id, name, created_at, updated_at) VALUES (${input.threadId}, ${input.agentId}, ${this.ownerId}, ${input.name ?? null}, ${now}, ${now}) ON CONFLICT (id) DO NOTHING`,
    );
    const thread = await this.thread(input.threadId);
    if (!thread) throw new Error('Conversation not found.');
    if (thread.agentId !== input.agentId)
      throw new Error('Conversation belongs to a different Dot.');
    return thread;
  }
  thread(threadId: string): Promise<LocalThread | undefined> {
    return this.db.row<LocalThread>(
      sql`SELECT id, agent_id, owner_id, name, archived, created_at, updated_at FROM conv_threads WHERE id=${threadId} AND owner_id=${this.ownerId}`,
    );
  }
  renameThread(threadId: string, name: string) {
    return this.updateThread(threadId, sql`name=${name}`);
  }
  archiveThread(threadId: string, archived = true) {
    return this.updateThread(threadId, sql`archived=${archived}`);
  }
  async deleteThread(threadId: string) {
    if (this.active.has(threadId))
      throw new Error('Stop the current answer before deleting this thread.');
    return this.db.transaction(async () => {
      const removed = await this.db.run(
        sql`DELETE FROM conv_threads WHERE id=${threadId} AND owner_id=${this.ownerId}`,
      );
      if (!removed) return false;
      await this.db.run(sql`DELETE FROM conv_runs WHERE thread_id=${threadId}`);
      await this.db.run(
        sql`DELETE FROM conv_events WHERE thread_id=${threadId}`,
      );
      return true;
    });
  }
  /**
   * Splits a thread at a message into `targetId`, a new thread for the same
   * agent. The cut is the user message that started the exchange `messageId`
   * belongs to.
   *
   * - move: that exchange and everything after it leave the source thread
   *   (runs, events and messages), so each thread keeps only its own topic.
   * - copy: the source is unchanged; the new thread starts with a copy of
   *   that one exchange, so the topic carries on with its context.
   *
   * Returns the id of the cut message and of the last message the source
   * keeps before it (where the new thread is shown in the source).
   */
  async split(input: {
    sourceId: string;
    targetId: string;
    messageId: string;
    mode: 'move' | 'copy';
    name?: string;
    /** For a move out of a main chat: keep showing the moved part there. */
    keepShown?: boolean;
  }): Promise<{ cutMessageId: string; anchorMessageId?: string }> {
    const { sourceId, targetId, messageId, mode } = input;
    const source = await this.thread(sourceId);
    if (!source) throw new Error('Conversation not found.');
    if (this.active.has(sourceId))
      throw new Error('Wait for the current answer before splitting.');
    const messages = await this.messages(sourceId);
    let cut = messages.findIndex((message) => message.id === messageId);
    while (cut >= 0 && messages[cut].role !== 'user') cut--;
    if (cut < 0)
      throw new Error('Choose a message in this conversation to split from.');
    const cutMessageId = messages[cut].id;
    let end = messages.findIndex(
      (message, index) => index > cut && message.role === 'user',
    );
    if (end < 0) end = messages.length;
    const runs = await this.runStarts(sourceId);
    const first = runs.findIndex((run) => run.added.includes(cutMessageId));
    const now = Date.now();
    await this.db.transaction(async () => {
      await this.db.run(
        sql`INSERT INTO conv_threads (id, agent_id, owner_id, name, created_at, updated_at) VALUES (${targetId}, ${source.agentId}, ${this.ownerId}, ${input.name ?? null}, ${now}, ${now})`,
      );
      if (mode === 'move') {
        if (first < 0)
          throw new Error('This part of the conversation cannot be moved.');
        await this.moveRuns(
          sourceId,
          targetId,
          runs.slice(first).map((run) => run.id),
          messages,
          cut,
          input.keepShown ? sourceId : null,
        );
      } else {
        // One finished run that introduces the copied exchange, so replay
        // shows it and the model reads it as earlier context.
        const copied = messages.slice(cut, end);
        const runId = randomUUID();
        await this.db.run(
          sql`INSERT INTO conv_runs (id, thread_id, parent_run_id, agent_id, status, started_at, finished_at) VALUES (${runId}, ${targetId}, NULL, ${source.agentId}, 'finished', ${now}, ${now})`,
        );
        const events: BaseEvent[] = [
          {
            type: 'RUN_STARTED',
            threadId: targetId,
            runId,
            input: { threadId: targetId, runId, messages: copied },
            splitFrom: sourceId,
            timestamp: now,
          } as BaseEvent,
          {
            type: 'RUN_FINISHED',
            threadId: targetId,
            runId,
            timestamp: now,
          } as BaseEvent,
        ];
        for (const event of events)
          await this.appendEvent(targetId, runId, event);
        await this.db.run(
          sql`UPDATE conv_threads SET messages=${JSON.stringify(copied)} WHERE id=${targetId}`,
        );
      }
    });
    // A copied thread hangs off the message it grew from; a moved one sits
    // after the last visible message the source keeps.
    const anchor =
      mode === 'copy'
        ? cutMessageId
        : messages
            .slice(0, cut)
            .findLast(
              (message) =>
                (message.role === 'user' || message.role === 'assistant') &&
                !!messageText(message).trim(),
            )?.id;
    return { cutMessageId, ...(anchor ? { anchorMessageId: anchor } : {}) };
  }
  /**
   * Moves the exchange `messageId` belongs to, and everything after it, to
   * the end of `targetId`, an existing thread for the same agent. Undoes a
   * split or an automatic move into a thread. Returns how many messages the
   * source keeps.
   */
  async moveTail(input: {
    sourceId: string;
    targetId: string;
    messageId: string;
  }): Promise<number> {
    const { sourceId, targetId, messageId } = input;
    const [source, target] = await Promise.all([
      this.thread(sourceId),
      this.thread(targetId),
    ]);
    if (!source || !target) throw new Error('Conversation not found.');
    if (source.agentId !== target.agentId)
      throw new Error('Conversation belongs to a different Dot.');
    if (this.active.has(sourceId) || this.active.has(targetId))
      throw new Error('Wait for the current answer before moving messages.');
    const messages = await this.messages(sourceId);
    let cut = messages.findIndex((message) => message.id === messageId);
    while (cut >= 0 && messages[cut].role !== 'user') cut--;
    if (cut < 0)
      throw new Error('Choose a message in this conversation to move.');
    const cutMessageId = messages[cut].id;
    const runs = await this.runStarts(sourceId);
    const first = runs.findIndex((run) => run.added.includes(cutMessageId));
    if (first < 0)
      throw new Error('This part of the conversation cannot be moved.');
    await this.db.transaction(() =>
      this.moveRuns(
        sourceId,
        targetId,
        runs.slice(first).map((run) => run.id),
        messages,
        cut,
      ),
    );
    return cut;
  }
  /** Each run of a thread, in order, with the message ids it introduced. */
  private async runStarts(threadId: string) {
    const rows = await this.db.rows<{ id: string; payload: string }>(
      sql`SELECT r.id, e.payload FROM conv_runs r JOIN conv_events e ON e.run_id=r.id AND e.type='RUN_STARTED' WHERE r.thread_id=${threadId} ORDER BY r.started_at, r.seq`,
    );
    return rows.map((row) => ({
      id: row.id,
      added: (
        (JSON.parse(row.payload) as { input?: { messages?: Message[] } }).input
          ?.messages ?? []
      ).map((message) => message.id),
    }));
  }
  /**
   * Moves runs, their events and messages from `cut` on to the end of the
   * target. Call inside a transaction.
   */
  private async moveRuns(
    sourceId: string,
    targetId: string,
    runIds: string[],
    messages: Message[],
    cut: number,
    shownIn: string | null = null,
  ) {
    const ids = sql.join(
      runIds.map((id) => sql`${id}`),
      ', ',
    );
    const now = Date.now();
    // Event numbers are per thread: continue after the target's last one.
    const offset =
      (
        await this.db.row<{ max: number | null }>(
          sql`SELECT MAX(seq) AS max FROM conv_events WHERE thread_id=${targetId}`,
        )
      )?.max ?? 0;
    const last = await this.db.row<{ id: string }>(
      sql`SELECT id FROM conv_runs WHERE thread_id=${targetId} ORDER BY started_at DESC, seq DESC LIMIT 1`,
    );
    await this.db.run(
      sql`UPDATE conv_runs SET thread_id=${targetId}, shown_in=${shownIn} WHERE id IN (${ids})`,
    );
    await this.db.run(
      sql`UPDATE conv_runs SET parent_run_id=${last?.id ?? null} WHERE id=${runIds[0]}`,
    );
    // Two steps, so no moved event collides with one already there.
    await this.db.run(
      sql`UPDATE conv_events SET seq=-seq WHERE run_id IN (${ids})`,
    );
    await this.db.run(
      sql`UPDATE conv_events SET thread_id=${targetId}, seq=${offset}-seq WHERE run_id IN (${ids})`,
    );
    const kept = await this.messages(targetId);
    await this.db.run(
      sql`UPDATE conv_threads SET messages=${JSON.stringify([...kept, ...messages.slice(cut)])}, updated_at=${now} WHERE id=${targetId}`,
    );
    await this.db.run(
      sql`UPDATE conv_threads SET messages=${JSON.stringify(messages.slice(0, cut))}, updated_at=${now} WHERE id=${sourceId}`,
    );
  }
  /** The thread's messages as of its last finished run. */
  async messages(threadId: string): Promise<Message[]> {
    const row = await this.db.row<{ messages: string }>(
      sql`SELECT messages FROM conv_threads WHERE id=${threadId} AND owner_id=${this.ownerId}`,
    );
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }
  runs(threadId: string): Promise<LocalRun[]> {
    return this.db.rows<LocalRun>(
      sql`SELECT id, thread_id, parent_run_id, agent_id, status, started_at, finished_at, error FROM conv_runs WHERE thread_id=${threadId} ORDER BY started_at, seq`,
    );
  }

  /** Runs newest first, for the run inspector. */
  async listRuns(
    filter: { agentId?: string; threadId?: string; limit?: number } = {},
  ): Promise<RunSummary[]> {
    const where = [sql`t.owner_id=${this.ownerId}`];
    if (filter.agentId) where.push(sql`r.agent_id=${filter.agentId}`);
    if (filter.threadId) where.push(sql`r.thread_id=${filter.threadId}`);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.db.rows<
      LocalRun & {
        threadName: string | null;
        inputTokens: number | null;
        outputTokens: number | null;
        started: string | null;
        toolCalls: number;
      }
    >(
      sql`SELECT r.id, r.thread_id, r.parent_run_id, r.agent_id, r.status, r.started_at, r.finished_at, r.error, r.input_tokens, r.output_tokens, t.name AS thread_name,
          (SELECT payload FROM conv_events e WHERE e.run_id=r.id AND e.type='RUN_STARTED' ORDER BY seq LIMIT 1) AS started,
          (SELECT COUNT(*) FROM conv_events e WHERE e.run_id=r.id AND e.type='TOOL_CALL_START') AS tool_calls
        FROM conv_runs r JOIN conv_threads t ON t.id=r.thread_id
        WHERE ${sql.join(where, ' AND ')} ORDER BY r.started_at DESC, r.seq DESC LIMIT ${limit}`,
    );
    return rows.map(({ started, ...row }) => ({
      ...row,
      prompt: started ? promptOf(JSON.parse(started) as BaseEvent) : null,
    }));
  }
  /** One run with its stored events, if it belongs to this owner. */
  async runDetail(runId: string) {
    const run = await this.db.row<
      LocalRun & { inputTokens: number | null; outputTokens: number | null }
    >(
      sql`SELECT r.id, r.thread_id, r.parent_run_id, r.agent_id, r.status, r.started_at, r.finished_at, r.error, r.input_tokens, r.output_tokens FROM conv_runs r JOIN conv_threads t ON t.id=r.thread_id WHERE r.id=${runId} AND t.owner_id=${this.ownerId}`,
    );
    if (!run) return undefined;
    const rows = await this.db.rows<{ payload: string; createdAt: number }>(
      sql`SELECT payload, created_at FROM conv_events WHERE run_id=${runId} ORDER BY seq`,
    );
    return {
      run,
      threadName: (await this.thread(run.threadId))?.name ?? null,
      events: rows.map((row) => {
        const event = JSON.parse(row.payload) as BaseEvent;
        // Events stored before timestamps existed fall back to the write time.
        event.timestamp ??= row.createdAt;
        return event;
      }),
    };
  }

  // Runs ---------------------------------------------------------------

  isRunning(threadId: string) {
    return this.active.has(threadId);
  }
  activeRunId(threadId: string) {
    return this.active.get(threadId)?.runId;
  }

  /**
   * Starts a run and resolves once it is recorded. `work` emits the run's
   * events and resolves when the answer is complete; a rejection becomes
   * RUN_ERROR with the error's message, so it must be safe to show the owner.
   */
  async start(input: {
    threadId: string;
    agentId: string;
    runId?: string;
    /** New messages this run starts with, usually one user message. */
    messages: Message[];
    /** Extra fields stored on RUN_STARTED, such as the turn's source. */
    meta?: Record<string, unknown>;
    /**
     * A main chat that also shows this run. The run's history stays in its
     * own thread, which is all the model reads; the main chat only displays it.
     */
    shownIn?: string;
    work: (run: RunContext) => Promise<void>;
  }): Promise<{ runId: string; done: Promise<FinishedRun> }> {
    const { threadId, agentId } = input;
    if (this.active.has(threadId)) throw new ThreadLockedError();
    const runId = input.runId ?? randomUUID();
    let resolveDone!: (run: FinishedRun) => void;
    const active: ActiveRun = {
      runId,
      ...(input.shownIn ? { shownIn: input.shownIn } : {}),
      controller: new AbortController(),
      events: [],
      usage: [],
      stopRequested: false,
      done: new Promise((resolve) => (resolveDone = resolve)),
      writes: Promise.resolve(),
    };
    // Claim the thread before the first await, so a second start is refused.
    this.active.set(threadId, active);
    let stored: Message[];
    let added: Message[];
    try {
      await this.createThread({ threadId, agentId });
      stored = await this.messages(threadId);
      const known = new Set(stored.map((message) => message.id));
      added = input.messages.filter((message) => !known.has(message.id));
      await this.db.run(
        sql`INSERT INTO conv_runs (id, thread_id, parent_run_id, agent_id, status, started_at, shown_in) VALUES (${runId}, ${threadId}, (SELECT id FROM conv_runs WHERE thread_id=${threadId} ORDER BY started_at DESC, seq DESC LIMIT 1), ${agentId}, 'running', ${Date.now()}, ${input.shownIn ?? null})`,
      );
    } catch (error) {
      if (this.active.get(threadId) === active) this.active.delete(threadId);
      throw error;
    }
    let closed = false;
    const record = (event: BaseEvent) => {
      // Nothing is recorded once the run is final, e.g. a late tool event.
      if (closed) return;
      // Stored events keep their own time so the run inspector can show timings.
      event.timestamp ??= Date.now();
      active.events.push(event);
      // The final save rewrites every event, so a failed write here only
      // delays what a refresh sees.
      active.writes = active.writes
        .then(() => this.appendEvent(threadId, runId, event))
        .catch(() => undefined);
      this.publish(threadId, event);
      if (active.shownIn)
        this.publish(active.shownIn, shownFrom(event, threadId));
    };
    // Replay rebuilds the transcript from RUN_STARTED inputs, so each run
    // records only the messages it introduced.
    record({
      type: 'RUN_STARTED',
      threadId,
      runId,
      input: { threadId, runId, messages: added },
      ...input.meta,
    } as BaseEvent);
    void (async () => {
      let failure: string | undefined;
      try {
        await input.work({
          threadId,
          runId,
          messages: [...stored, ...added],
          signal: active.controller.signal,
          emit: (event) => {
            if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR')
              throw new Error('The runner adds terminal events itself.');
            record(event);
          },
          usage: (entries) => active.usage.push(...entries),
        });
      } catch (error) {
        failure =
          error instanceof Error
            ? error.message
            : 'The answer could not finish.';
      }
      const usage = sumUsage(active.usage);
      if (!active.stopRequested && failure === undefined)
        record({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          ...(usage.length ? { usage } : {}),
        } as BaseEvent);
      else
        for (const event of finalizeRunEvents([...active.events], {
          stopRequested: active.stopRequested,
          ...(active.stopRequested ? {} : { message: failure }),
        }))
          record(
            event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
              ? ({
                  ...event,
                  threadId,
                  runId,
                  ...(usage.length ? { usage } : {}),
                } as BaseEvent)
              : event,
          );
      closed = true;
      resolveDone(await this.finish(threadId, active, stored, failure));
    })();
    return { runId, done: active.done };
  }

  /**
   * The thread's events so far, then every new one as it happens, for this
   * run and later ones. Replay and subscription happen together, so no
   * event is missed or repeated.
   */
  async watch(threadId: string, listener: Listener) {
    // The thread's own runs, and runs in its topic threads that it shows,
    // in the order they started.
    const rows = (await this.thread(threadId))
      ? await this.db.rows<{
          runId: string;
          payload: string;
          sourceThread: string;
        }>(
          sql`SELECT e.run_id, e.payload, r.thread_id AS source_thread FROM conv_events e JOIN conv_runs r ON r.id=e.run_id WHERE e.thread_id=${threadId} OR r.shown_in=${threadId} ORDER BY r.started_at, r.seq, e.seq`,
        )
      : [];
    // Read live runs after the query: their events come from memory.
    const live = [...this.active.entries()].filter(
      ([id, run]) => id === threadId || run.shownIn === threadId,
    );
    const liveIds = new Set(live.map(([, run]) => run.runId));
    const events = [
      ...compactEvents(
        rows
          .filter((row) => !liveIds.has(row.runId))
          .map((row) => {
            const event = JSON.parse(row.payload) as BaseEvent;
            return row.sourceThread === threadId
              ? event
              : shownFrom(event, row.sourceThread);
          }),
      ),
      ...live.flatMap(([id, run]) =>
        id === threadId
          ? run.events
          : run.events.map((event) => shownFrom(event, id)),
      ),
    ];
    let set = this.listeners.get(threadId);
    if (!set) this.listeners.set(threadId, (set = new Set()));
    set.add(listener);
    return {
      events,
      running: live.length > 0,
      unsubscribe: () => {
        set.delete(listener);
        if (!set.size && this.listeners.get(threadId) === set)
          this.listeners.delete(threadId);
      },
    };
  }

  /** Stops the thread's run (or only `runId`, when given). */
  stop(threadId: string, runId?: string) {
    // A main chat can stop a run it shows from one of its threads.
    const active =
      this.active.get(threadId) ??
      [...this.active.values()].find((run) => run.shownIn === threadId);
    if (!active || active.stopRequested) return false;
    if (runId !== undefined && runId !== active.runId) return false;
    active.stopRequested = true;
    active.controller.abort(new Error(STOP_MESSAGE));
    return true;
  }
  /** Resolves when the given run (or the thread's current one) ends. */
  done(threadId: string, runId?: string) {
    const active = this.active.get(threadId);
    return active && (runId === undefined || active.runId === runId)
      ? active.done
      : undefined;
  }
  close() {
    for (const [threadId, active] of this.active) {
      active.stopRequested = true;
      active.controller.abort(new Error(INTERRUPTED_MESSAGE));
      this.active.delete(threadId);
    }
    this.listeners.clear();
  }

  // Internals ----------------------------------------------------------

  private publish(threadId: string, event: BaseEvent) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {
        // One broken watcher must not stop the run or other watchers.
      }
    }
  }
  private async finish(
    threadId: string,
    active: ActiveRun,
    stored: Message[],
    failure?: string,
  ): Promise<FinishedRun> {
    const runError = active.events.find((e) => e.type === 'RUN_ERROR') as
      (BaseEvent & { message?: string }) | undefined;
    const status: FinishedRun['status'] = active.stopRequested
      ? 'stopped'
      : runError
        ? 'error'
        : 'finished';
    const error =
      status === 'error'
        ? (failure ?? runError?.message ?? 'The run failed.')
        : null;
    const messages = reduceEvents(active.events, stored);
    const result: FinishedRun = {
      threadId,
      runId: active.runId,
      status,
      error,
      messages,
      added: messages.slice(stored.length),
    };
    try {
      await active.writes;
      await this.db.transaction(async () => {
        await this.replaceEvents(
          threadId,
          active.runId,
          compactEvents(active.events),
        );
        const tokens = runTokens(active.events);
        await this.db.run(
          sql`UPDATE conv_runs SET status=${status}, finished_at=${Date.now()}, error=${error}, input_tokens=${tokens?.inputTokens ?? null}, output_tokens=${tokens?.outputTokens ?? null} WHERE id=${active.runId}`,
        );
        await this.db.run(
          sql`UPDATE conv_threads SET messages=${JSON.stringify(messages)}, updated_at=${Date.now()} WHERE id=${threadId}`,
        );
      });
      this.options.onRunFinished?.(result);
    } catch (caught) {
      console.error(
        'Could not save the finished conversation run:',
        caught instanceof Error ? caught.name : 'unknown',
      );
    } finally {
      if (this.active.get(threadId) === active) this.active.delete(threadId);
    }
    return result;
  }
  /**
   * Runs left 'running' by a crash or restart are closed with a visible
   * error. Call once at startup, before any run starts.
   */
  async recoverInterruptedRuns() {
    const runs = await this.db.rows<{ id: string; threadId: string }>(
      sql`SELECT id, thread_id FROM conv_runs WHERE status='running'`,
    );
    for (const run of runs) {
      if (this.active.get(run.threadId)?.runId === run.id) continue;
      const events = await this.runEvents(run.id);
      finalizeRunEvents(events, { message: INTERRUPTED_MESSAGE });
      await this.db.transaction(async () => {
        await this.replaceEvents(run.threadId, run.id, compactEvents(events));
        // The partial answer joins the thread so the model sees what was said.
        const messages = reduceEvents(
          events,
          await this.messages(run.threadId),
        );
        await this.db.run(
          sql`UPDATE conv_threads SET messages=${JSON.stringify(messages)} WHERE id=${run.threadId}`,
        );
        await this.db.run(
          sql`UPDATE conv_runs SET status='interrupted', finished_at=${Date.now()}, error=${INTERRUPTED_MESSAGE} WHERE id=${run.id}`,
        );
      });
    }
  }
  private async appendEvent(threadId: string, runId: string, event: BaseEvent) {
    await this.db.run(
      sql`INSERT INTO conv_events (thread_id, run_id, seq, type, payload, created_at) VALUES (${threadId}, ${runId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conv_events WHERE thread_id=${threadId}), ${event.type}, ${JSON.stringify(event)}, ${Date.now()})`,
    );
  }
  private async replaceEvents(
    threadId: string,
    runId: string,
    events: BaseEvent[],
  ) {
    await this.db.run(sql`DELETE FROM conv_events WHERE run_id=${runId}`);
    for (const event of events) await this.appendEvent(threadId, runId, event);
  }
  private async runEvents(runId: string): Promise<BaseEvent[]> {
    const rows = await this.db.rows<{ payload: string }>(
      sql`SELECT payload FROM conv_events WHERE run_id=${runId} ORDER BY seq`,
    );
    return rows.map((row) => JSON.parse(row.payload) as BaseEvent);
  }
  private async updateThread(
    threadId: string,
    assignment: ReturnType<typeof sql>,
  ) {
    const changed = await this.db.run(
      sql`UPDATE conv_threads SET ${assignment}, updated_at=${Date.now()} WHERE id=${threadId} AND owner_id=${this.ownerId}`,
    );
    return changed ? this.thread(threadId) : undefined;
  }
}
