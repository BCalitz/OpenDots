import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { MAX_MESSAGE_LENGTH } from './engine/index.js';
import { ThreadLockedError } from './engine/thread-runner.js';
import { ApprovalClosedError } from './engine/approvals.js';
import type { ChatFrame } from '../shared/chat-stream.js';

/** Keeps proxies from closing a quiet stream. */
const HEARTBEAT_MS = 15_000;

const messageInput = z
  .object({
    // Lets the client show its message at once and match it in the stream.
    id: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,200}$/)
      .optional(),
    content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  })
  .strict();

/**
 * Chat over plain HTTP: one long-lived Server-Sent Events stream per open
 * thread, and small POSTs to send, stop and decide approvals. Every client
 * (web, mobile) uses the same routes.
 */
export function chatRoutes(platform: Platform) {
  const app = new Hono();
  const engine = () => {
    if (!platform.engine)
      throw new Error(
        'Chat needs CONVERSATION_BACKEND=local, which is the default.',
      );
    return platform.engine;
  };
  app.onError((error, c) => {
    if (error instanceof ThreadLockedError)
      return c.json({ error: error.message, code: error.code }, 409);
    if (error instanceof ApprovalClosedError)
      return c.json({ error: error.message, code: 'approval_closed' }, 409);
    if (error instanceof z.ZodError)
      return c.json(
        { error: 'Write a message of up to 20,000 characters.' },
        400,
      );
    const text = error.message;
    if (/^(Conversation does not belong|Approval request not found)/.test(text))
      return c.json({ error: text }, 404);
    if (/^(Setup required|Chat needs)/.test(text))
      return c.json({ error: text }, 503);
    if (
      /^(Write a message|Messages can be|This message was already)/.test(text)
    )
      return c.json({ error: text }, 400);
    console.error('Chat request failed:', error.name);
    return c.json({ error: 'The chat request failed. Try again.' }, 500);
  });

  // History first, then a `ready` frame, then live events for as long as
  // the client stays connected, including turns started elsewhere (voice,
  // schedules, another device).
  app.get('/chat/:threadId/events', (c) => {
    const threadId = c.req.param('threadId');
    const chat = engine();
    platform.workspace.requireThread(threadId);
    const encoder = new TextEncoder();
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (chunk: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const send = (frame: ChatFrame) =>
          write(`data: ${JSON.stringify(frame)}\n\n`);
        const view = chat.watch(threadId, (event) =>
          send({ kind: 'event', event }),
        );
        for (const event of view.events) send({ kind: 'event', event });
        send({ kind: 'ready', running: view.running });
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
        close = () => {
          if (!open) return;
          open = false;
          clearInterval(heartbeat);
          view.unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };
        c.req.raw.signal.addEventListener('abort', () => close(), {
          once: true,
        });
      },
      cancel() {
        close();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.post('/chat/:threadId/messages', async (c) => {
    const chat = engine();
    platform.requireReady();
    if (platform.store.settings().paused)
      return c.json(
        {
          error: 'OpenDots is paused. Resume it to keep chatting.',
          code: 'paused',
        },
        409,
      );
    const input = messageInput.parse(await c.req.json());
    const { runId } = chat.start({
      threadId: c.req.param('threadId'),
      message: input,
      source: 'chat',
    });
    return c.json({ runId }, 202);
  });

  app.post('/chat/:threadId/stop', (c) =>
    c.json({ stopped: engine().stop(c.req.param('threadId')) }),
  );

  app.get('/chat/:threadId/approvals', (c) => {
    const thread = platform.workspace.requireThread(c.req.param('threadId'));
    return c.json(platform.approvals?.pending(thread.id) ?? []);
  });

  app.post('/chat/approvals/:id', async (c) => {
    const { approved } = z
      .object({ approved: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const approvals = platform.approvals;
    const current = approvals?.get(c.req.param('id'));
    if (!approvals || !current) throw new Error('Approval request not found.');
    // Only for a conversation that still exists in this workspace.
    platform.workspace.requireThread(current.threadId);
    return c.json(approvals.decide(current.id, approved));
  });
  return app;
}
