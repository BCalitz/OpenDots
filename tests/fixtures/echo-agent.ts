import { AbstractAgent, type BaseEvent, type Message } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';

/** Replies "echo: <last user text>", or hangs until aborted when told to. */
export class EchoAgent extends AbstractAgent {
  seen: Message[][] = [];
  private abort?: () => void;
  private aborted = false;
  constructor(
    private hang = false,
    agentId = 'dot',
  ) {
    super({ agentId });
  }
  clone() {
    return new EchoAgent(this.hang, this.agentId);
  }
  abortRun() {
    this.aborted = true;
    this.abort?.();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.seen.push(input.messages);
    return new Observable<BaseEvent>((subscriber) => {
      const last = input.messages.filter((m) => m.role === 'user').at(-1);
      const id = `reply-${input.runId}`;
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: id,
        role: 'assistant',
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: id,
        delta: 'echo: ',
      } as BaseEvent);
      if (this.hang) {
        this.abort = () => subscriber.complete();
        if (this.aborted) subscriber.complete();
        return;
      }
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: id,
        delta: String(last?.content ?? ''),
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: id,
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}
