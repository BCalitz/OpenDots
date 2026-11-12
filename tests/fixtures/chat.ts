import type { Hono } from 'hono';
import type { Platform } from '../../src/server/platform.js';
import type { BaseEvent } from '../../src/shared/thread-events.js';

export const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Sends a chat message over HTTP and waits for the turn to end, collecting
 * its live events. Watches before sending so a fast turn is not missed.
 */
export async function chatTurn(
  app: Hono,
  platform: Platform,
  threadId: string,
  content: string,
) {
  const events: BaseEvent[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const view = await platform.engine!.watch(threadId, (event) => {
    events.push(event);
    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') finish();
  });
  try {
    const response = await app.request(
      `/api/chat/${encodeURIComponent(threadId)}/messages`,
      json({ content }),
    );
    const body = (await response.json()) as {
      runId?: string;
      error?: string;
      code?: string;
    };
    if (response.status !== 202)
      return { status: response.status, body, events, text: '' };
    await finished;
    const error = events.find((event) => event.type === 'RUN_ERROR') as
      (BaseEvent & { message?: string }) | undefined;
    return {
      status: response.status,
      body,
      runId: body.runId!,
      events,
      error: error?.message,
      text: events
        .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
        .map((event) => (event as { delta?: string }).delta ?? '')
        .join(''),
    };
  } finally {
    view.unsubscribe();
  }
}
