/**
 * Owner approvals, as the web and mobile apps see them. The server sends
 * one CUSTOM event named APPROVAL_EVENT when a tool asks, and another when
 * the request is decided or expires. mobile/src/lib has a copy;
 * tests/thread-events.test.ts fails if the two drift apart.
 */
export const APPROVAL_EVENT = 'opendots.approval';
export type ApprovalKind = 'page_review' | 'connection_action' | 'action';
/** Extras on an approval: also stop asking about this tool next time. */
export interface DecideOptions {
  always?: boolean;
  /** The word typed to allow a risky tool, such as one that sends mail. */
  confirm?: string;
}
export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired';
export interface ApprovalView {
  id: string;
  threadId: string;
  toolCallId: string;
  kind: ApprovalKind;
  /**
   * page_review: { title, content, spaceId }.
   * connection_action: { connection, title, description, arguments, rule },
   * the server's record of exactly what will run. `rule` names the tool
   * that "Always allow" would stop asking about.
   * action: { title, description, link? }, from the request_approval tool.
   */
  payload: unknown;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
}

/** The latest state of each approval in a thread's events, by tool call. */
export function approvalsFrom(
  events: { type: string; name?: unknown; value?: unknown }[],
): Map<string, ApprovalView> {
  const byToolCall = new Map<string, ApprovalView>();
  for (const event of events) {
    const view = approvalOf(event);
    if (view) byToolCall.set(view.toolCallId, view);
  }
  return byToolCall;
}

/** The approval carried by one event, if it is an approval event. */
export function approvalOf(event: {
  type: string;
  name?: unknown;
  value?: unknown;
}): ApprovalView | undefined {
  if (event.type !== 'CUSTOM' || event.name !== APPROVAL_EVENT) return;
  const value = event.value as Partial<ApprovalView> | undefined;
  return value &&
    typeof value.id === 'string' &&
    typeof value.toolCallId === 'string'
    ? (value as ApprovalView)
    : undefined;
}
