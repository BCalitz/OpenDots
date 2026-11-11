import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
import { ThreadConnection, type ThreadState } from '../shared/thread-client';
import type { BaseEvent } from '../shared/thread-events';
import type { ApprovalView } from '../shared/approvals';

const initial: ThreadState = {
  messages: [],
  approvals: {},
  ready: false,
  running: false,
  runError: '',
  connectionError: '',
};
const chatPath = (threadId: string) => `/chat/${encodeURIComponent(threadId)}`;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * One conversation: its history, live answers from any device, and the
 * actions the owner can take on it.
 */
export function useThread(
  threadId: string,
  options: { onEvent?: (event: BaseEvent) => void } = {},
) {
  const [state, setState] = useState<ThreadState>(initial);
  const [attempt, setAttempt] = useState(0);
  const connection = useRef<ThreadConnection | null>(null);
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;
  useEffect(() => {
    setState(initial);
    const current = new ThreadConnection({
      url: `/api${chatPath(threadId)}/events`,
      headers: authHeaders,
      onState: setState,
      onEvent: (event) => onEvent.current?.(event),
    });
    connection.current = current;
    current.start();
    return () => {
      current.close();
      if (connection.current === current) connection.current = null;
    };
  }, [threadId, attempt]);

  /** Sends a message; resolves once the server has started the turn. */
  const send = useCallback(
    async (content: string) => {
      const id = newId();
      connection.current?.addOptimistic({ id, role: 'user', content });
      try {
        await api(`${chatPath(threadId)}/messages`, 'POST', { id, content });
      } catch (error) {
        connection.current?.removeOptimistic(id);
        throw error;
      }
    },
    [threadId],
  );
  const stop = useCallback(
    () => api(`${chatPath(threadId)}/stop`, 'POST', {}),
    [threadId],
  );
  const decide = useCallback(
    (approvalId: string, approved: boolean) =>
      api<ApprovalView>(
        `/chat/approvals/${encodeURIComponent(approvalId)}`,
        'POST',
        { approved },
      ),
    [],
  );
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, send, stop, decide, reconnect };
}
