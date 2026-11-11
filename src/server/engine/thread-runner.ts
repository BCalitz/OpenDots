import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
}
type ThreadRow = Omit<LocalThread, 'archived'> & { archived: number };

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
export function finalizeRunEvents(
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
 * written to SQLite as it streams and pushed to anyone watching the thread,
 * so a refresh or a second device picks up a run that is still going.
 *
 * When a run ends its events are compacted in place (text deltas merged),
 * which keeps replay fast and storage small. The tables are the ones phase 1
 * created, so earlier threads open unchanged.
 */
export class ThreadRunner {
  private db: DatabaseSync;
  private active = new Map<string, ActiveRun>();
  private listeners = new Map<string, Set<Listener>>();
  constructor(
    path: string,
    private ownerId: string,
    private options: { onRunFinished?: (run: FinishedRun) => void } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conv_threads(id TEXT PRIMARY KEY, agentId TEXT NOT NULL, ownerId TEXT NOT NULL, name TEXT, archived INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conv_runs(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, parentRunId TEXT, agentId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, error TEXT, inputTokens INTEGER, outputTokens INTEGER);
      CREATE INDEX IF NOT EXISTS conv_runs_thread ON conv_runs(threadId, startedAt);
      CREATE TABLE IF NOT EXISTS conv_events(threadId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, seq));
      CREATE INDEX IF NOT EXISTS conv_events_run ON conv_events(runId);`);
    this.recoverInterruptedRuns();
  }

  // Thread records ------------------------------------------------------

  createThread(input: { threadId: string; agentId: string; name?: string }) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO conv_threads (id, agentId, ownerId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(
        input.threadId,
        input.agentId,
        this.ownerId,
        input.name ?? null,
        now,
        now,
      );
    const thread = this.thread(input.threadId);
    if (!thread) throw new Error('Conversation not found.');
    if (thread.agentId !== input.agentId)
      throw new Error('Conversation belongs to a different Dot.');
    return thread;
  }
  thread(threadId: string): LocalThread | undefined {
    const row = this.db
      .prepare(
        'SELECT id, agentId, ownerId, name, archived, createdAt, updatedAt FROM conv_threads WHERE id=? AND ownerId=?',
      )
      .get(threadId, this.ownerId) as unknown as ThreadRow | undefined;
    return row ? { ...row, archived: !!row.archived } : undefined;
  }
  renameThread(threadId: string, name: string) {
    return this.updateThread(threadId, 'name=?', name);
  }
  archiveThread(threadId: string, archived = true) {
    return this.updateThread(threadId, 'archived=?', archived ? 1 : 0);
  }
  deleteThread(threadId: string) {
    if (this.active.has(threadId))
      throw new Error('Stop the current answer before deleting this thread.');
    const removed = this.db
      .prepare('DELETE FROM conv_threads WHERE id=? AND ownerId=?')
      .run(threadId, this.ownerId).changes;
    if (!removed) return false;
    this.db.prepare('DELETE FROM conv_runs WHERE threadId=?').run(threadId);
    this.db.prepare('DELETE FROM conv_events WHERE threadId=?').run(threadId);
    return true;
  }
  /** The thread's messages as of its last finished run. */
  messages(threadId: string): Message[] {
    const row = this.db
      .prepare('SELECT messages FROM conv_threads WHERE id=? AND ownerId=?')
      .get(threadId, this.ownerId) as { messages: string } | undefined;
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }
  runs(threadId: string): LocalRun[] {
    return this.db
      .prepare(
        'SELECT id, threadId, parentRunId, agentId, status, startedAt, finishedAt, error FROM conv_runs WHERE threadId=? ORDER BY startedAt, rowid',
      )
      .all(threadId) as unknown as LocalRun[];
  }

  /** Runs newest first, for the run inspector. */
  listRuns(
    filter: { agentId?: string; threadId?: string; limit?: number } = {},
  ): RunSummary[] {
    const where = ['t.ownerId=?'];
    const values: string[] = [this.ownerId];
    if (filter.agentId) {
      where.push('r.agentId=?');
      values.push(filter.agentId);
    }
    if (filter.threadId) {
      where.push('r.threadId=?');
      values.push(filter.threadId);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT r.id, r.threadId, r.parentRunId, r.agentId, r.status, r.startedAt, r.finishedAt, r.error, r.inputTokens, r.outputTokens, t.name AS threadName,
          (SELECT payload FROM conv_events e WHERE e.runId=r.id AND e.type='RUN_STARTED' ORDER BY seq LIMIT 1) AS started,
          (SELECT COUNT(*) FROM conv_events e WHERE e.runId=r.id AND e.type='TOOL_CALL_START') AS toolCalls
        FROM conv_runs r JOIN conv_threads t ON t.id=r.threadId
        WHERE ${where.join(' AND ')} ORDER BY r.startedAt DESC, r.rowid DESC LIMIT ${limit}`,
      )
      .all(...values) as unknown as (LocalRun & {
      threadName: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      started: string | null;
      toolCalls: number;
    })[];
    return rows.map(({ started, ...row }) => ({
      ...row,
      prompt: started ? promptOf(JSON.parse(started) as BaseEvent) : null,
    }));
  }
  /** One run with its stored events, if it belongs to this owner. */
  runDetail(runId: string) {
    const run = this.db
      .prepare(
        'SELECT r.id, r.threadId, r.parentRunId, r.agentId, r.status, r.startedAt, r.finishedAt, r.error, r.inputTokens, r.outputTokens FROM conv_runs r JOIN conv_threads t ON t.id=r.threadId WHERE r.id=? AND t.ownerId=?',
      )
      .get(runId, this.ownerId) as unknown as
      | (LocalRun & {
          inputTokens: number | null;
          outputTokens: number | null;
        })
      | undefined;
    if (!run) return undefined;
    const rows = this.db
      .prepare(
        'SELECT payload, createdAt FROM conv_events WHERE runId=? ORDER BY seq',
      )
      .all(runId) as { payload: string; createdAt: number }[];
    return {
      run,
      threadName: this.thread(run.threadId)?.name ?? null,
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
   * Starts a run and returns at once. `work` emits the run's events and
   * resolves when the answer is complete; a rejection becomes RUN_ERROR with
   * the error's message, so it must be safe to show the owner.
   */
  start(input: {
    threadId: string;
    agentId: string;
    runId?: string;
    /** New messages this run starts with, usually one user message. */
    messages: Message[];
    /** Extra fields stored on RUN_STARTED, such as the turn's source. */
    meta?: Record<string, unknown>;
    work: (run: RunContext) => Promise<void>;
  }): { runId: string; done: Promise<FinishedRun> } {
    const { threadId, agentId } = input;
    if (this.active.has(threadId)) throw new ThreadLockedError();
    this.createThread({ threadId, agentId });
    const stored = this.messages(threadId);
    const known = new Set(stored.map((message) => message.id));
    const added = input.messages.filter((message) => !known.has(message.id));
    const runId = input.runId ?? randomUUID();
    const parentRunId =
      (
        this.db
          .prepare(
            'SELECT id FROM conv_runs WHERE threadId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1',
          )
          .get(threadId) as { id: string } | undefined
      )?.id ?? null;
    this.db
      .prepare(
        "INSERT INTO conv_runs (id, threadId, parentRunId, agentId, status, startedAt) VALUES (?, ?, ?, ?, 'running', ?)",
      )
      .run(runId, threadId, parentRunId, agentId, Date.now());
    let resolveDone!: (run: FinishedRun) => void;
    const active: ActiveRun = {
      runId,
      controller: new AbortController(),
      events: [],
      usage: [],
      stopRequested: false,
      done: new Promise((resolve) => (resolveDone = resolve)),
    };
    this.active.set(threadId, active);
    let closed = false;
    const record = (event: BaseEvent) => {
      // Nothing is recorded once the run is final, e.g. a late tool event.
      if (closed) return;
      // Stored events keep their own time so the run inspector can show timings.
      event.timestamp ??= Date.now();
      active.events.push(event);
      this.appendEvent(threadId, runId, event);
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
      resolveDone(this.finish(threadId, active, stored, failure));
    })();
    return { runId, done: active.done };
  }

  /**
   * The thread's events so far, then every new one as it happens, for this
   * run and later ones. Replay and subscription happen together, so no
   * event is missed or repeated.
   */
  watch(threadId: string, listener: Listener) {
    const active = this.active.get(threadId);
    const events = [
      ...compactEvents(this.storedEvents(threadId, active?.runId)),
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
    this.db.close();
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
  private finish(
    threadId: string,
    active: ActiveRun,
    stored: Message[],
    failure?: string,
  ): FinishedRun {
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
      this.transaction(() => {
        this.db
          .prepare('DELETE FROM conv_events WHERE runId=?')
          .run(active.runId);
        for (const event of compactEvents(active.events))
          this.appendEvent(threadId, active.runId, event);
        const tokens = runTokens(active.events);
        this.db
          .prepare(
            'UPDATE conv_runs SET status=?, finishedAt=?, error=?, inputTokens=?, outputTokens=? WHERE id=?',
          )
          .run(
            status,
            Date.now(),
            error,
            tokens?.inputTokens ?? null,
            tokens?.outputTokens ?? null,
            active.runId,
          );
        this.db
          .prepare('UPDATE conv_threads SET messages=?, updatedAt=? WHERE id=?')
          .run(JSON.stringify(messages), Date.now(), threadId);
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
  /** Runs left 'running' by a crash or restart are closed with a visible error. */
  private recoverInterruptedRuns() {
    const runs = this.db
      .prepare("SELECT id, threadId FROM conv_runs WHERE status='running'")
      .all() as { id: string; threadId: string }[];
    for (const run of runs) {
      const events = this.runEvents(run.id);
      finalizeRunEvents(events, { message: INTERRUPTED_MESSAGE });
      this.transaction(() => {
        this.db.prepare('DELETE FROM conv_events WHERE runId=?').run(run.id);
        for (const event of compactEvents(events))
          this.appendEvent(run.threadId, run.id, event);
        // The partial answer joins the thread so the model sees what was said.
        const messages = reduceEvents(events, this.messages(run.threadId));
        this.db
          .prepare('UPDATE conv_threads SET messages=? WHERE id=?')
          .run(JSON.stringify(messages), run.threadId);
        this.db
          .prepare(
            "UPDATE conv_runs SET status='interrupted', finishedAt=?, error=? WHERE id=?",
          )
          .run(Date.now(), INTERRUPTED_MESSAGE, run.id);
      });
    }
  }
  private appendEvent(threadId: string, runId: string, event: BaseEvent) {
    this.db
      .prepare(
        'INSERT INTO conv_events (threadId, runId, seq, type, payload, createdAt) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conv_events WHERE threadId=?), ?, ?, ?)',
      )
      .run(
        threadId,
        runId,
        threadId,
        event.type,
        JSON.stringify(event),
        Date.now(),
      );
  }
  private storedEvents(threadId: string, exceptRunId?: string): BaseEvent[] {
    if (!this.thread(threadId)) return [];
    const rows = this.db
      .prepare(
        'SELECT payload FROM conv_events WHERE threadId=? AND runId<>? ORDER BY seq',
      )
      .all(threadId, exceptRunId ?? '') as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as BaseEvent);
  }
  private runEvents(runId: string): BaseEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM conv_events WHERE runId=? ORDER BY seq')
      .all(runId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as BaseEvent);
  }
  private updateThread(threadId: string, assignment: string, value: unknown) {
    const changed = this.db
      .prepare(
        `UPDATE conv_threads SET ${assignment}, updatedAt=? WHERE id=? AND ownerId=?`,
      )
      .run(
        value as string | number,
        Date.now(),
        threadId,
        this.ownerId,
      ).changes;
    return changed ? this.thread(threadId) : undefined;
  }
  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
