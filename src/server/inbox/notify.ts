import type {
  InboxEventView,
  InboxNotify,
  InboxPriority,
  SourceKind,
} from '../../shared/inbox-types.js';
import type { PushMessage, PushService } from '../push.js';
import type { NewEvents } from './engine.js';

const rank: Record<InboxPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};
const threshold: Record<Exclude<InboxNotify, 'off'>, number> = {
  all: 0,
  high: 2,
  urgent: 3,
};
const noun: Record<SourceKind, string> = {
  ticket: 'ticket',
  mail: 'mail',
  message: 'message',
  calendar: 'calendar change',
};
export function shouldNotify(notify: InboxNotify, priority: InboxPriority) {
  return notify !== 'off' && rank[priority] >= threshold[notify];
}
/**
 * Level 0 autonomy: tell the owner something happened. Titles never carry
 * outside content; the event title appears only when previews are enabled.
 */
function inboxPushMessage(
  push: PushService,
  kind: SourceKind,
  events: InboxEventView[],
): PushMessage {
  const top = [...events].sort(
    (a, b) => rank[b.priority] - rank[a.priority],
  )[0];
  const label =
    top.priority === 'urgent' || top.priority === 'high'
      ? `${top.priority} `
      : '';
  const title =
    events.length === 1
      ? `New ${label}${noun[kind]}`
      : `${events.length} new ${noun[kind]}s`;
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    body: push.previews
      ? top.title.replace(/\s+/g, ' ').slice(0, 160)
      : 'Open the OpenDots inbox to see it.',
    data: { url: '/#/inbox' },
  };
}
/** Sends one push per batch for the events that cross the source's threshold. */
export function pushNotifier(push: PushService) {
  return async ({ source, events, initial }: NewEvents) => {
    // The first poll backfills existing items; announcing them would be noise.
    if (initial) return;
    const loud = events.filter((event) =>
      shouldNotify(source.notify, event.priority),
    );
    if (loud.length) await push.send(inboxPushMessage(push, source.kind, loud));
  };
}
