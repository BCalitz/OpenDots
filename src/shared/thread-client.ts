/**
 * Follows one conversation over GET /api/chat/:threadId/events: replays its
 * history, then applies live events, and reconnects when the connection
 * drops. Framework-free so the web app's useThread hook and the mobile app
 * share it. mobile/src/lib has a copy; tests/thread-events.test.ts fails if
 * the two drift apart.
 */
import { applyEvent, type BaseEvent, type Message } from './thread-events.js';
import { approvalOf, type ApprovalView } from './approvals.js';
import { sseParser } from './chat-stream.js';

export interface ThreadState {
  messages: Message[];
  /** Latest state of each owner approval, by tool call id. */
  approvals: Record<string, ApprovalView>;
  /** History has loaded and the stream is live. */
  ready: boolean;
  /** A turn is running on the server, from any device or schedule. */
  running: boolean;
  /** Why the last live turn failed; cleared when the next one starts. */
  runError: string;
  /** Why the stream is not connected, while it retries. */
  connectionError: string;
}

const empty = (): ThreadState => ({
  messages: [],
  approvals: {},
  ready: false,
  running: false,
  runError: '',
  connectionError: '',
});

/** Folds one event into the state. */
export function applyThreadEvent(
  state: ThreadState,
  event: BaseEvent,
  live: boolean,
): ThreadState {
  const next = { ...state, messages: applyEvent(state.messages, event) };
  const approval = approvalOf(event as { type: string });
  if (approval)
    next.approvals = { ...state.approvals, [approval.toolCallId]: approval };
  if (event.type === 'RUN_STARTED') {
    next.running = true;
    if (live) next.runError = '';
  } else if (event.type === 'RUN_FINISHED') next.running = false;
  else if (event.type === 'RUN_ERROR') {
    next.running = false;
    if (live)
      next.runError =
        (event as { message?: string }).message || 'The turn failed.';
  }
  return next;
}

const RETRY_MS = [1000, 2000, 5000, 10000];

export class ThreadConnection {
  state: ThreadState = empty();
  private controller?: AbortController;
  private closed = false;
  /** Messages shown before the server confirms them. */
  private optimistic: Message[] = [];
  constructor(
    private options: {
      url: string;
      headers: () => Record<string, string>;
      onState: (state: ThreadState) => void;
      /** Called for each live (not replayed) event. */
      onEvent?: (event: BaseEvent) => void;
      fetch?: typeof fetch;
      retryMs?: number[];
    },
  ) {}

  start() {
    this.closed = false;
    void this.run();
  }
  close() {
    this.closed = true;
    this.controller?.abort();
  }
  /** Shows a message the owner just sent until the stream confirms it. */
  addOptimistic(message: Message) {
    this.optimistic.push(message);
    this.publish(this.state);
  }
  removeOptimistic(id: string) {
    this.optimistic = this.optimistic.filter((message) => message.id !== id);
    this.publish(this.state);
  }

  private publish(state: ThreadState) {
    this.state = state;
    const known = new Set(state.messages.map((message) => message.id));
    this.optimistic = this.optimistic.filter(
      (message) => !known.has(message.id),
    );
    this.options.onState(
      this.optimistic.length
        ? { ...state, messages: [...state.messages, ...this.optimistic] }
        : state,
    );
  }

  private async run() {
    let attempt = 0;
    while (!this.closed) {
      const controller = new AbortController();
      this.controller = controller;
      let failure: string;
      try {
        const response = await (this.options.fetch ?? fetch)(this.options.url, {
          headers: { Accept: 'text/event-stream', ...this.options.headers() },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          failure =
            body.error ?? `The chat stream returned HTTP ${response.status}.`;
          // Bad credentials or a missing thread will not fix themselves.
          if ([401, 403, 404].includes(response.status)) {
            this.publish({
              ...this.state,
              ready: false,
              connectionError: failure,
            });
            return;
          }
        } else {
          // Replay builds a fresh state, shown at once when `ready` arrives.
          let replay: ThreadState | undefined = empty();
          const parse = sseParser();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of parse(
              decoder.decode(value, { stream: true }),
            )) {
              if (frame.kind === 'ready') {
                attempt = 0;
                this.publish({
                  ...(replay ?? this.state),
                  ready: true,
                  running: frame.running,
                  runError: replay ? '' : this.state.runError,
                  connectionError: '',
                });
                replay = undefined;
              } else if (replay)
                replay = applyThreadEvent(replay, frame.event, false);
              else {
                this.publish(applyThreadEvent(this.state, frame.event, true));
                this.options.onEvent?.(frame.event);
              }
            }
          }
          failure = 'The chat stream closed.';
        }
      } catch (error) {
        if (this.closed || controller.signal.aborted) return;
        failure =
          error instanceof Error && error.message
            ? `The chat stream disconnected: ${error.message}`
            : 'The chat stream disconnected.';
      }
      if (this.closed) return;
      this.publish({ ...this.state, ready: false, connectionError: failure });
      const retry = this.options.retryMs ?? RETRY_MS;
      const wait = retry[Math.min(attempt++, retry.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
