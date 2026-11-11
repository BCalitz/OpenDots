import { fetch as streamingFetch } from 'expo/fetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders, type PageContext } from './api';
import type { Session } from './session';
import type { Message } from './thread-events';
import type { ApprovalView } from './approvals';
import { ThreadConnection, type ThreadState } from './thread-client';

// Same id prefix the server gives scheduled-task prompts.
export const isScheduledMessage = (message: Message) =>
  message.role === 'user' && message.id.startsWith('opendots:scheduled_task:');

// Matches the web app's contextualMessage(): page conversations prefix each
// message with a link to the page so the Dot knows which page you mean.
function contextual(text: string, page: PageContext | null) {
  return page
    ? `From [${page.title.replace(/[[\]\\\r\n]/g, '')}](/#/spaces/${page.spaceId}/pages/${page.id}):\n\n${text}`
    : text;
}

const initial: ThreadState = {
  messages: [],
  approvals: {},
  ready: false,
  running: false,
  runError: '',
  connectionError: '',
};
const chatPath = (threadId: string) => `/chat/${encodeURIComponent(threadId)}`;

/**
 * One conversation with a Dot over the server's chat routes, the same ones
 * the web app uses: a live event stream plus small requests to send, stop
 * and answer approvals. React Native's built-in fetch cannot stream, so the
 * stream uses expo/fetch.
 */
export function useConversation(session: Session, threadId: string) {
  const connection = useRef<ThreadConnection | null>(null);
  const page = useRef<PageContext | null>(null);
  const [state, setState] = useState<ThreadState>(initial);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState(initial);
    setError('');
    page.current = null;
    let active = true;
    void api<PageContext | null>(
      session,
      `/conversations/${encodeURIComponent(threadId)}/page-context`,
    )
      .then((value) => {
        if (active) page.current = value;
      })
      .catch(() => {});
    const current = new ThreadConnection({
      url: `${session.server}/api${chatPath(threadId)}/events`,
      headers: () => authHeaders(session),
      onState: setState,
      fetch: streamingFetch as unknown as typeof fetch,
    });
    connection.current = current;
    current.start();
    return () => {
      active = false;
      current.close();
      if (connection.current === current) connection.current = null;
    };
  }, [session, threadId, attempt]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      const id = crypto.randomUUID();
      const content = contextual(text.trim(), page.current);
      setError('');
      connection.current?.addOptimistic({ id, role: 'user', content });
      try {
        await api(session, `${chatPath(threadId)}/messages`, 'POST', {
          id,
          content,
        });
      } catch (cause) {
        connection.current?.removeOptimistic(id);
        setError(
          cause instanceof Error ? cause.message : 'The message was not sent.',
        );
        throw cause;
      }
    },
    [session, threadId],
  );

  const stop = useCallback(() => {
    void api(session, `${chatPath(threadId)}/stop`, 'POST', {}).catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Could not stop.'),
    );
  }, [session, threadId]);

  // Answers an owner approval; the Dot continues on the server.
  const decide = useCallback(
    (approvalId: string, approved: boolean) =>
      api<ApprovalView>(
        session,
        `/chat/approvals/${encodeURIComponent(approvalId)}`,
        'POST',
        { approved },
      ),
    [session],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    ...state,
    error: error || state.runError,
    send,
    stop,
    decide,
    retry,
  };
}
