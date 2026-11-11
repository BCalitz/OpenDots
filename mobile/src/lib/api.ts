import type { Session } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const authHeaders = (session: Session): Record<string, string> => ({
  Authorization: `Bearer ${session.token}`,
});

// Same contract as the web client's api(): JSON in, JSON out, server errors
// surface as their `error` message.
export async function api<T>(
  session: Session,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${session.server}/api${path}`, {
      method,
      signal,
      headers: {
        ...authHeaders(session),
        ...(['GET', 'HEAD'].includes(method)
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(
      'Could not reach the server. Check the address and your connection.',
      0,
    );
  }
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}

// Subset of the server's workspace snapshot the app uses.
export interface Dot {
  id: string;
  name: string;
  instructions: string;
  spaceId: string;
}
export interface Conversation {
  id: string;
  dotId: string;
  title: string;
  createdAt: number;
}
// Set when a conversation belongs to a Space page.
export interface PageContext {
  id: string;
  spaceId: string;
  title: string;
}
export interface Workspace {
  dots: Dot[];
  conversations: Conversation[];
  /** Each Dot's one continuing chat, by Dot id (older servers omit it). */
  mainConversations?: Record<string, string>;
  setup: { missing: string[] };
}
export interface PendingApproval {
  id: string;
  connection: string;
  title: string;
  description: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}
export interface ConnectionActionResult {
  isError: boolean;
  text: string;
}
export interface ConnectionActionReceipt {
  approvalId: string | null;
  status: 'running' | 'interrupted' | 'done';
  result: ConnectionActionResult | null;
}
export interface PageReviewDraft {
  title: string;
  content: string;
  spaceId: string;
}
// A saved review (a page), or a review whose page was later deleted.
export type ReviewedPage =
  | {
      deleted?: false;
      id: string;
      spaceId: string;
      title: string;
      reviewDraft: PageReviewDraft | null;
    }
  | {
      deleted: true;
      pageId: string;
      spaceId: string;
      reviewDraft: PageReviewDraft | null;
    };

export const conversationPath = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}`;
