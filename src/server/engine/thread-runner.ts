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
    work: (run: RunContext) => Promise<void>;
  }): Promise<{ runId: string; done: Promise<FinishedRun> }> {
    const { threadId, agentId } = input;
    if (this.active.has(threadId)) throw new ThreadLockedError();
    const runId = input.runId ?? randomUUID();
    let resolveDone!: (run: FinishedRun) => void;
    const active: ActiveRun = {
      runId,
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
        sql`INSERT INTO conv_runs (id, thread_id, parent_run_id, agent_id, status, started_at) VALUES (${runId}, ${threadId}, (SELECT id FROM conv_runs WHERE thread_id=${threadId} ORDER BY started_at DESC, seq DESC LIMIT 1), ${agentId}, 'running', ${Date.now()})`,
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
    const rows = (await this.thread(threadId))
      ? await this.db.rows<{ runId: string; payload: string }>(
          sql`SELECT run_id, payload FROM conv_events WHERE thread_id=${threadId} ORDER BY seq`,
        )
      : [];
    // Read the live run after the query: its events come from memory.
    const active = this.active.get(threadId);
    const events = [
      ...compactEvents(
        rows
          .filter((row) => row.runId !== active?.runId)
          .map((row) => JSON.parse(row.payload) as BaseEvent),
      ),
      ...(active?.events ?? []),
    ];
    let set = this.listeners.get(threadId);
    if (!set) this.listeners.set(threadId, (set = new Set()));
    set.add(listener);
    return {
      events,
      running: !!active,
      unsubscribe: () => {
        set.delete(listener);
        if (!set.size && this.listeners.get(threadId) === set)
          this.listeners.delete(threadId);
      },
    };
  }

  /** Stops the thread's run (or only `runId`, when given). */
  stop(threadId: string, runId?: string) {
    const active = this.active.get(threadId);
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
