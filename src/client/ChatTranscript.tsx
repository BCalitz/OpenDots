import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { isScheduledTaskMessage } from '../shared/scheduled-message';
import {
  isDiscoveryMessage,
  parseDiscoveryMessage,
} from '../shared/discovery-message';
import { DiscoveryCard } from './DiscoveryCard';
// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  renderActions,
  renderAfter,
  renderMessage,
}: {
  messages: Message[];
  calls: CallReceipt[];
  renderTools?: (message: AssistantMessage) => ReactNode;
  /** Per-message actions, shown on hover (for example splitting). */
  renderActions?: (message: Message) => ReactNode;
  /** Shown after a message, such as the topic threads that grew from it. */
  renderAfter?: (message: Message) => ReactNode;
  /** Replaces a message's bubble when it returns something other than undefined. */
  renderMessage?: (message: Message) => ReactNode | undefined;
}) {
  const ids = new Set(messages.map((message) => message.id));
  return (
    <>
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message) => {
        const discovery =
          isDiscoveryMessage(message) && typeof message.content === 'string'
            ? parseDiscoveryMessage(message.content)
            : null;
        return (
          <Fragment key={message.id}>
            {renderMessage?.(message) !== undefined ? (
              renderMessage(message)
            ) : discovery ? (
              <div className="chat-message discovery">
                <DiscoveryCard
                  parsed={discovery}
                  onOpenInbox={() => {
                    location.hash = '#/inbox';
                  }}
                />
              </div>
            ) : (
              typeof message.content === 'string' &&
              message.content.trim() && (
                <div className={`chat-message ${message.role}`}>
                  <div
                    className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) || isDiscoveryMessage(message) ? ' scheduled' : ''}`}
                  >
                    {isScheduledTaskMessage(message) && (
                      <span className="scheduled-message-label">Scheduled</span>
                    )}
                    {isDiscoveryMessage(message) && (
                      <span className="scheduled-message-label">Discovery</span>
                    )}
                    <ReactMarkdown
                      components={{
                        img: ({ alt }) => <span>{alt}</span>,
                        a: ({ href, children }) => (
                          <a
                            onClick={(event) => {
                              if (href?.startsWith('/#/spaces/')) {
                                event.preventDefault();
                                openPageLink(href);
                              }
                            }}
                            href={href}
                            target={
                              href?.startsWith('/#/spaces/')
                                ? undefined
                                : '_blank'
                            }
                            rel="noreferrer"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {String(message.content)}
                    </ReactMarkdown>
                  </div>
                  {renderActions?.(message)}
                </div>
              )
            )}
            {message.role === 'assistant' && renderTools?.(message)}
            {calls
              .filter((call) => call.anchorMessageId === message.id)
              .map((call) => (
                <Receipt key={call.id} call={call} />
              ))}
            {renderAfter?.(message)}
          </Fragment>
        );
      })}
    </>
  );
}
