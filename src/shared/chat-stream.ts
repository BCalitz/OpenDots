import type { BaseEvent } from './thread-events.js';

/**
 * One frame of GET /api/chat/:threadId/events, sent as an SSE `data:` line.
 * The stream replays the thread's events, sends `ready`, then stays open
 * and sends each new event as it happens.
 */
export type ChatFrame =
  { kind: 'event'; event: BaseEvent } | { kind: 'ready'; running: boolean };

/**
 * Splits a streamed SSE body into frames. Feed it text as it arrives; it
 * returns the complete frames and keeps any partial one for next time.
 */
export function sseParser() {
  let buffer = '';
  return (chunk: string): ChatFrame[] => {
    // Line ends may be CRLF, LF or CR, and a CRLF can be split across
    // chunks, so a trailing CR waits for the next chunk.
    buffer = (buffer + chunk).replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
    const frames: ChatFrame[] = [];
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        frames.push(JSON.parse(data) as ChatFrame);
      } catch {
        // A malformed frame is skipped; the next reconnect replays history.
      }
    }
    return frames;
  };
}
