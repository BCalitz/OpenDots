import { sql, type Db } from '../db/index.js';
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
  private waiting = new Map<string, (status: ApprovalStatus) => void>();
  private closed = false;
  constructor(
    private db: Db,
    private options: { waitMs?: number } = {},
  ) {}
  /** Nothing is waiting on requests from before a restart. */
  async expireStale() {
    await this.db.run(
      sql`UPDATE chat_approvals SET status='expired', decided_at=${Date.now()} WHERE status='pending'`,
    );
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
    await this.db.run(
      sql`INSERT INTO chat_approvals (id, thread_id, tool_call_id, kind, payload, status, created_at) VALUES (${view.id}, ${view.threadId}, ${view.toolCallId}, ${view.kind}, ${JSON.stringify(view.payload)}, 'pending', ${view.createdAt})`,
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
      if (!this.closed)
        await this.finish(view.id, status, announce).catch(() => undefined);
    }
  }

  private async finish(
    id: string,
    status: ApprovalStatus,
    announce: (view: ApprovalView) => void,
  ) {
    // A decision already wrote its own status; anything else expired.
    await this.db.run(
      sql`UPDATE chat_approvals SET status=${status === 'pending' ? 'expired' : status}, decided_at=${Date.now()} WHERE id=${id} AND status='pending'`,
    );
    const final = await this.get(id);
    if (final) announce(final);
  }

  /** Records the owner's decision and lets the waiting tool continue. */
  async decide(id: string, approved: boolean): Promise<ApprovalView> {
    const current = await this.get(id);
    if (!current) throw new Error('Approval request not found.');
    const resolve = this.waiting.get(id);
    if (current.status !== 'pending' || !resolve)
      throw new ApprovalClosedError(
        current.status === 'pending' ? 'expired' : current.status,
      );
    const status: ApprovalStatus = approved ? 'approved' : 'declined';
    // Claim the decision before writing it, so two decisions cannot both win.
    this.waiting.delete(id);
    await this.db.run(
      sql`UPDATE chat_approvals SET status=${status}, decided_at=${Date.now()} WHERE id=${id} AND status='pending'`,
    );
    resolve(status);
    return (await this.get(id))!;
  }

  async get(id: string): Promise<ApprovalView | undefined> {
    const row = await this.db.row<Row>(
      sql`SELECT id, thread_id, tool_call_id, kind, payload, status, created_at, decided_at FROM chat_approvals WHERE id=${id}`,
    );
    return row ? { ...row, payload: JSON.parse(row.payload) } : undefined;
  }

  /** Requests still waiting for the owner, newest first. */
  async pending(threadId?: string): Promise<ApprovalView[]> {
    const rows = await this.db.rows<Row>(
      sql`SELECT id, thread_id, tool_call_id, kind, payload, status, created_at, decided_at FROM chat_approvals WHERE status='pending'${threadId ? sql` AND thread_id=${threadId}` : sql``} ORDER BY created_at DESC`,
    );
    return rows
      .filter((row) => this.waiting.has(row.id))
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  close() {
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve('expired');
    this.waiting.clear();
  }
}
