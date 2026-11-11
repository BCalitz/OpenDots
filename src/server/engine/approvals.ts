import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BaseEvent } from '../../shared/thread-events.js';
import {
  APPROVAL_EVENT,
  type ApprovalKind,
  type ApprovalStatus,
  type ApprovalView,
} from '../../shared/approvals.js';
import type { ToolContext } from './tools.js';

/** How long a tool waits for the owner before giving up. */
const APPROVAL_WAIT_MS = 30 * 60_000;

/** Thrown for a decision on a request that is no longer waiting. */
export class ApprovalClosedError extends Error {
  constructor(status: ApprovalStatus) {
    super(
      status === 'expired'
        ? 'This request is no longer waiting. Ask the Dot to try again.'
        : `This request was already ${status}.`,
    );
  }
}

type Row = Omit<ApprovalView, 'payload'> & { payload: string };

/**
 * Owner approvals for tools that change things: saving a reviewed page,
 * running a gated connection tool. The tool writes a pending request and
 * waits; the decision can come from the web app, the mobile app or
 * anywhere else that can reach the owner's API. A request whose turn has
 * ended (stopped, timed out, server restarted) can no longer be approved.
 */
export class Approvals {
  private db: DatabaseSync;
  private waiting = new Map<string, (status: ApprovalStatus) => void>();
  private closed = false;
  constructor(
    path: string,
    private options: { waitMs?: number } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, decidedAt INTEGER);
      CREATE INDEX IF NOT EXISTS chat_approvals_thread ON chat_approvals(threadId, createdAt);`);
    // Nothing is waiting on requests from before a restart.
    this.db
      .prepare(
        "UPDATE chat_approvals SET status='expired', decidedAt=? WHERE status='pending'",
      )
      .run(Date.now());
  }

  /**
   * Asks the owner and waits for an answer. Time spent waiting does not
   * count toward the turn's time limit. Resolves to 'expired' when the wait
   * runs out; rejects if the turn is stopped.
   */
  async request(
    context: ToolContext,
    input: { threadId: string; kind: ApprovalKind; payload: unknown },
  ): Promise<ApprovalStatus> {
    context.signal.throwIfAborted();
    const view: ApprovalView = {
      id: randomUUID(),
      threadId: input.threadId,
      toolCallId: context.toolCallId,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO chat_approvals (id, threadId, toolCallId, kind, payload, status, createdAt) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        view.id,
        view.threadId,
        view.toolCallId,
        view.kind,
        JSON.stringify(view.payload),
        view.createdAt,
      );
    const announce = (current: ApprovalView) =>
      context.emit({
        type: 'CUSTOM',
        name: APPROVAL_EVENT,
        value: current,
      } as BaseEvent);
    announce(view);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const decided = new Promise<ApprovalStatus>((resolve, reject) => {
      this.waiting.set(view.id, resolve);
      timer = setTimeout(
        () => resolve('expired'),
        this.options.waitMs ?? APPROVAL_WAIT_MS,
      );
      onAbort = () => reject(context.signal.reason);
      context.signal.addEventListener('abort', onAbort, { once: true });
    });
    let status: ApprovalStatus = 'expired';
    try {
      status = await context.hold(decided);
      return status;
    } finally {
      clearTimeout(timer);
      if (onAbort) context.signal.removeEventListener('abort', onAbort);
      this.waiting.delete(view.id);
      // On shutdown the database is gone; the next start expires the row.
      if (!this.closed) this.finish(view.id, status, announce);
    }
  }

  private finish(
    id: string,
    status: ApprovalStatus,
    announce: (view: ApprovalView) => void,
  ) {
    // A decision already wrote its own status; anything else expired.
    this.db
      .prepare(
        "UPDATE chat_approvals SET status=?, decidedAt=? WHERE id=? AND status='pending'",
      )
      .run(status === 'pending' ? 'expired' : status, Date.now(), id);
    const final = this.get(id);
    if (final) announce(final);
  }

  /** Records the owner's decision and lets the waiting tool continue. */
  decide(id: string, approved: boolean): ApprovalView {
    const current = this.get(id);
    if (!current) throw new Error('Approval request not found.');
    const resolve = this.waiting.get(id);
    if (current.status !== 'pending' || !resolve)
      throw new ApprovalClosedError(
        current.status === 'pending' ? 'expired' : current.status,
      );
    const status: ApprovalStatus = approved ? 'approved' : 'declined';
    this.db
      .prepare(
        "UPDATE chat_approvals SET status=?, decidedAt=? WHERE id=? AND status='pending'",
      )
      .run(status, Date.now(), id);
    this.waiting.delete(id);
    resolve(status);
    return this.get(id)!;
  }

  get(id: string): ApprovalView | undefined {
    const row = this.db
      .prepare(
        'SELECT id, threadId, toolCallId, kind, payload, status, createdAt, decidedAt FROM chat_approvals WHERE id=?',
      )
      .get(id) as unknown as Row | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : undefined;
  }

  /** Requests still waiting for the owner, newest first. */
  pending(threadId?: string): ApprovalView[] {
    const rows = this.db
      .prepare(
        `SELECT id, threadId, toolCallId, kind, payload, status, createdAt, decidedAt FROM chat_approvals WHERE status='pending'${threadId ? ' AND threadId=?' : ''} ORDER BY createdAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as Row[];
    return rows
      .filter((row) => this.waiting.has(row.id))
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  close() {
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve('expired');
    this.waiting.clear();
    this.db.close();
  }
}
