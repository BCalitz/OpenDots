import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Observable, ReplaySubject } from 'rxjs';
import {
  EventType,
  compactEvents,
  type AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';

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
  messages: Message[];
}
interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  events: BaseEvent[];
  stopRequested: boolean;
}
type ThreadRow = Omit<LocalThread, 'archived'> & { archived: number };

const INTERRUPTED_MESSAGE =
  'OpenDots stopped before this answer finished. Send your message again to continue.';

/**
 * Durable AG-UI runner for local conversations. Behaves like the SDK's
 * InMemoryAgentRunner (one run per thread, replay on connect, clean stop),
 * but keeps threads, runs and events in SQLite so history survives restarts.
 *
 * Events are appended as they stream, so a crash loses nothing already sent.
 * When a run ends its events are compacted in place (text deltas merged),
 * which keeps replay fast and storage small.
 */
export class LocalAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private db: DatabaseSync;
  private active = new Map<string, ActiveRun>();
  constructor(
    path: string,
    private ownerId: string,
    private options: { onRunFinished?: (run: FinishedRun) => void } = {},
  ) {
    super();
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
    const thread = this.thread(input.threadId)!;
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
  runs(threadId: string): LocalRun[] {
    return this.db
      .prepare(
        'SELECT id, threadId, parentRunId, agentId, status, startedAt, finishedAt, error FROM conv_runs WHERE threadId=? ORDER BY startedAt, rowid',
      )
      .all(threadId) as unknown as LocalRun[];
  }

  // LocalThreadEndpointRunner ------------------------------------------

  listThreads(): LocalThreadEndpointRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, agentId, ownerId, name, archived, createdAt, updatedAt FROM conv_threads WHERE ownerId=? AND archived=0 ORDER BY updatedAt DESC',
      )
      .all(this.ownerId) as unknown as ThreadRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      agentId: row.agentId,
      organizationId: '',
      createdById: row.ownerId,
      archived: false,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }
  getThreadMessages(threadId: string): Message[] {
    const row = this.db
      .prepare('SELECT messages FROM conv_threads WHERE id=? AND ownerId=?')
      .get(threadId, this.ownerId) as { messages: string } | undefined;
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }
  getThreadEvents(threadId: string): BaseEvent[] {
    return compactEvents(this.storedEvents(threadId));
  }
  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as BaseEvent & { snapshot?: unknown };
      if (event.type !== EventType.STATE_SNAPSHOT) continue;
      return event.snapshot &&
        typeof event.snapshot === 'object' &&
        !Array.isArray(event.snapshot)
        ? { ...(event.snapshot as Record<string, unknown>) }
        : null;
    }
    return null;
  }
  /** History lives in the owner's database; the SDK's clear route never wipes it. */
  clearThreads() {}

  // AgentRunner ----------------------------------------------------------

  run({
    threadId,
    agent,
    input,
  }: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (this.active.has(threadId)) throw new Error('Thread already running');
    const agentId = agent.agentId ?? 'default';
    this.createThread({ threadId, agentId });
    // The stored thread is the source of truth. Messages the caller already
    // holds are dropped in favour of the stored copy; new ones are appended.
    // This also picks up turns (schedules, voice) the browser has not seen.
    const stored = this.getThreadMessages(threadId);
    const storedIds = new Set(stored.map((message) => message.id));
    const messages = [
      ...stored,
      ...(input.messages ?? []).filter((message) => !storedIds.has(message.id)),
    ];
    const replayed = this.replayedMessageIds(threadId);
    const runInput: RunAgentInput = { ...input, threadId, messages };
    agent.threadId = threadId;
    agent.setMessages(messages);
    const runId = input.runId;
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
    const active: ActiveRun = {
      runId,
      agent,
      subject: new ReplaySubject<BaseEvent>(Infinity),
      events: [],
      stopRequested: false,
    };
    this.active.set(threadId, active);
    const record = (event: BaseEvent) => {
      active.events.push(event);
      this.appendEvent(threadId, runId, event);
      active.subject.next(event);
    };
    void (async () => {
      let failure: string | undefined;
      try {
        await agent.runAgent(runInput, {
          onEvent: ({ event }) => {
            // A stop can land before the agent wired up its abort; repeat it.
            if (active.stopRequested) active.agent.abortRun();
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & { input?: RunAgentInput };
              // Replay rebuilds the transcript from RUN_STARTED inputs, so
              // each run records only the messages it introduced.
              started.input ??= {
                ...runInput,
                messages: messages.filter((m) => !replayed.has(m.id)),
              };
            }
            record(event);
          },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      this.finish(threadId, active, failure);
    })();
    return active.subject.asObservable();
  }
  connect({ threadId }: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const active = this.active.get(threadId);
    const emitted = new Set<string>();
    for (const event of compactEvents(
      this.storedEvents(threadId, active?.runId),
    )) {
      subject.next(event);
      const messageId = (event as { messageId?: unknown }).messageId;
      if (typeof messageId === 'string') emitted.add(messageId);
    }
    if (!active) {
      subject.complete();
      return subject.asObservable();
    }
    active.subject.subscribe({
      next: (event) => {
        const messageId = (event as { messageId?: unknown }).messageId;
        if (typeof messageId === 'string' && emitted.has(messageId)) return;
        subject.next(event);
      },
      complete: () => subject.complete(),
      error: (error) => subject.error(error),
    });
    return subject.asObservable();
  }
  isRunning({ threadId }: AgentRunnerIsRunningRequest) {
    return Promise.resolve(this.active.has(threadId));
  }
  stop({ threadId, runId }: AgentRunnerStopRequest) {
    const active = this.active.get(threadId);
    if (!active || active.stopRequested) return Promise.resolve(false);
    if (runId !== undefined && runId !== active.runId)
      return Promise.resolve(false);
    active.stopRequested = true;
    try {
      active.agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      active.stopRequested = false;
      console.error(
        'Failed to stop conversation run:',
        error instanceof Error ? error.name : 'unknown',
      );
      return Promise.resolve(false);
    }
  }
  close() {
    for (const [threadId, active] of this.active) {
      active.stopRequested = true;
      try {
        active.agent.abortRun();
      } catch {
        // The run is finalized as interrupted on the next start.
      }
      this.active.delete(threadId);
    }
    this.db.close();
  }

  // Internals ----------------------------------------------------------

  private finish(threadId: string, active: ActiveRun, failure?: string) {
    const startedEvents = active.events.length;
    let status: FinishedRun['status'] = 'finished';
    let error: string | null = failure ?? null;
    try {
      const appended = finalizeRunEvents(active.events, {
        stopRequested: active.stopRequested,
        ...(failure !== undefined ? { interruptionMessage: failure } : {}),
      });
      for (const event of appended) active.subject.next(event);
      const runError = active.events.find(
        (event) => event.type === EventType.RUN_ERROR,
      ) as (BaseEvent & { message?: string }) | undefined;
      if (active.stopRequested) status = 'stopped';
      else if (failure !== undefined || runError) {
        status = 'error';
        error ??= runError?.message ?? 'The run failed.';
      }
      // A run that failed before emitting anything leaves no trace in the
      // transcript, matching the SDK's in-memory runner.
      const keep = startedEvents > 0;
      const messages = keep ? [...active.agent.messages] : [];
      this.transaction(() => {
        this.db
          .prepare('DELETE FROM conv_events WHERE runId=?')
          .run(active.runId);
        if (keep)
          for (const event of compactEvents(active.events))
            this.appendEvent(threadId, active.runId, event);
        this.db
          .prepare(
            'UPDATE conv_runs SET status=?, finishedAt=?, error=? WHERE id=?',
          )
          .run(status, Date.now(), error, active.runId);
        if (keep)
          this.db
            .prepare(
              'UPDATE conv_threads SET messages=?, updatedAt=? WHERE id=?',
            )
            .run(JSON.stringify(messages), Date.now(), threadId);
      });
      if (keep)
        this.options.onRunFinished?.({
          threadId,
          runId: active.runId,
          status,
          messages,
        });
    } catch (caught) {
      console.error(
        'Could not save the finished conversation run:',
        caught instanceof Error ? caught.name : 'unknown',
      );
    } finally {
      if (this.active.get(threadId) === active) this.active.delete(threadId);
      active.subject.complete();
    }
  }
  /** Runs left 'running' by a crash or restart are closed with a visible error. */
  private recoverInterruptedRuns() {
    const runs = this.db
      .prepare("SELECT id, threadId FROM conv_runs WHERE status='running'")
      .all() as { id: string; threadId: string }[];
    for (const run of runs) {
      const events = this.runEvents(run.id);
      const keep = events.length > 0;
      if (keep)
        finalizeRunEvents(events, { interruptionMessage: INTERRUPTED_MESSAGE });
      this.transaction(() => {
        this.db.prepare('DELETE FROM conv_events WHERE runId=?').run(run.id);
        if (keep)
          for (const event of compactEvents(events))
            this.appendEvent(run.threadId, run.id, event);
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
  /** Message IDs a connect replay already shows for this thread. */
  private replayedMessageIds(threadId: string) {
    const ids = new Set<string>();
    for (const event of this.storedEvents(threadId)) {
      const { messageId, input } = event as {
        messageId?: unknown;
        input?: { messages?: Message[] };
      };
      if (typeof messageId === 'string') ids.add(messageId);
      if (event.type === EventType.RUN_STARTED)
        for (const message of input?.messages ?? []) ids.add(message.id);
    }
    return ids;
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
