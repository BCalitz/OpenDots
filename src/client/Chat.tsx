import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import {
  FilePlus,
  Inbox,
  ArrowUp,
  Clock3,
  CornerDownRight,
  Link2,
  MessageSquareReply,
  MessagesSquare,
  Scissors,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import { ToolCalls, toolResults } from './ToolCalls';
import { useThread, type SendResult } from './useThread';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';

export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
  topics = [],
  activeTopicId,
  onOpenThread,
  onSplit,
  onClose,
  onMoved,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
  /** Topic threads in this chat. */
  topics?: Conversation[];
  /** The topic thread open beside this chat, if any. */
  activeTopicId?: string;
  onOpenThread?: (threadId: string) => void;
  /** Splits this conversation at a message into a new topic thread. */
  onSplit?: (messageId: string, mode: 'move' | 'copy') => Promise<void>;
  /** Set when this chat is a topic thread shown beside the main chat. */
  onClose?: () => void;
  /**
   * Set on a Dot's main chat: messages may be sorted into topic threads,
   * and this hears where one went.
   */
  onMoved?: (sent: SendResult) => void;
}) {
  const chat = useThread(thread.id, {
    // A finished turn may have saved pages or changed the workspace.
    onEvent: (event) => {
      if (event.type === 'RUN_FINISHED') onSaved();
    },
  });
  const messages = chat.messages;
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const split = async (messageId: string, mode: 'move' | 'copy') => {
    if (!onSplit || splitting) return;
    if (
      mode === 'move' &&
      !window.confirm(
        'Move this message and everything after it into a new thread?',
      )
    )
      return;
    setSplitting(true);
    setError('');
    try {
      await onSplit(messageId, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not split.');
    } finally {
      setSplitting(false);
    }
  };
  /** The topic thread a shown exchange belongs to, if any. */
  const topicOf = (message: object) => {
    const id = (message as { topicThreadId?: unknown }).topicThreadId;
    return typeof id === 'string' ? id : undefined;
  };
  /** Turns the Dot starts itself, shown in the main chat. */
  const internalSource = (message: { role: string; metadata?: unknown }) => {
    const source =
      message.role === 'user' &&
      (message.metadata as { opendotsSource?: unknown } | undefined)
        ?.opendotsSource;
    return source === 'discovery' ||
      source === 'reply' ||
      source === 'prepare' ||
      source === 'handle'
      ? source
      : undefined;
  };
  const threadLabel = (threadId: string) => {
    const topic = topics.find((item) => item.id === threadId);
    return (
      <button
        className={`thread-link ${threadId === activeTopicId ? 'active' : ''}`}
        onClick={() => onOpenThread?.(threadId)}
      >
        <CornerDownRight size={12} />
        In thread{topic ? <strong>{topic.title}</strong> : null}
      </button>
    );
  };
  const threadCard = (topic: Conversation) => (
    <button
      key={topic.id}
      className={`thread-card ${topic.id === activeTopicId ? 'active' : ''}`}
      onClick={() => onOpenThread?.(topic.id)}
    >
      <CornerDownRight size={14} />
      <span>
        <strong>{topic.title}</strong>
        <small>
          {topic.source === 'discovery'
            ? 'From your inbox'
            : topic.title.startsWith('From ')
              ? 'Asked by another Dot'
              : 'Thread'}
          {' · '}
          {new Date(topic.createdAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}
        </small>
      </span>
    </button>
  );
  const chatError = error || chat.runError || chat.connectionError;
  const loaded = chat.ready;
  const running = chat.running || sending;
  const voice = useVoice(thread.id, onSaved, messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const send = async (text: string) => {
    if (!text.trim() || running || !loaded || !contextReady || paused) return;
    setError('');
    setSending(true);
    const previous = { draft, source, sourceOpen };
    setDraft('');
    setSource('');
    setSourceOpen(false);
    try {
      const sent = await chat.send(contextualMessage(text, pageContext), {
        autoThread: !!onMoved,
      });
      if (sent.moved && sent.threadId) onMoved?.(sent);
    } catch (e) {
      // Keep what the owner wrote so nothing is lost.
      setDraft(previous.draft);
      setSource(previous.source);
      setSourceOpen(previous.sourceOpen);
      setError(
        e instanceof Error
          ? e.message
          : 'The message could not be sent. Your conversation remains saved.',
      );
    } finally {
      setSending(false);
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages.length, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  const computerCalls = messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  const results = toolResults(messages);
  // In the main chat, an exchange from a topic thread shows only what
  // happened: the Dot's final answer and anything waiting on the owner. The
  // thread keeps the tool calls and the working in between.
  const fromThread = new Set<string>();
  const outcomes = new Set<string>();
  if (!onClose) {
    let from: string | undefined;
    let lastText: string | undefined;
    const close = () => {
      if (from && lastText) outcomes.add(lastText);
      lastText = undefined;
    };
    for (const message of messages) {
      if (message.role === 'user') {
        close();
        from = topicOf(message);
        continue;
      }
      if (!from) continue;
      fromThread.add(message.id);
      if (
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim()
      )
        lastText = message.id;
    }
    close();
  }
  const asksOwner = (message: (typeof messages)[number]) =>
    message.role === 'assistant' &&
    !!message.toolCalls?.some((call) => chat.approvals[call.id]);
  const visible = messages.filter(
    (message) =>
      (!fromThread.has(message.id) ||
        outcomes.has(message.id) ||
        asksOwner(message)) &&
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' && !!message.toolCalls?.length)),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{onClose ? thread.title : dot.name}</strong>
          <span>
            {onClose && (
              <>
                Thread with {dot.name}
                {' · '}
              </>
            )}
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          {!onClose && topics.length > 0 && (
            <div className="threads-menu">
              <button
                className={`icon-button ${threadsOpen ? 'on' : ''}`}
                aria-label="Threads in this chat"
                aria-expanded={threadsOpen}
                title="Threads"
                onClick={() => setThreadsOpen(!threadsOpen)}
              >
                <MessagesSquare size={18} />
                <span className="threads-count">{topics.length}</span>
              </button>
              {threadsOpen && (
                <div className="threads-popover" role="menu">
                  <strong>Threads</strong>
                  {topics.map((topic) => (
                    <div key={topic.id} onClick={() => setThreadsOpen(false)}>
                      {threadCard(topic)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
          {onClose && (
            <button
              className="icon-button"
              aria-label="Close thread"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>{onClose ? thread.title : 'What’s on your mind?'}</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderActions={
            onSplit && !running
              ? (message) =>
                  // An exchange shown from a thread is split from there.
                  topicOf(message) ? null : (
                    <div className="message-actions">
                      {!onClose && (
                        <button
                          disabled={splitting}
                          title="Start a thread with this exchange; the chat stays as it is"
                          onClick={() => void split(message.id, 'copy')}
                        >
                          <MessageSquareReply size={13} /> Reply in thread
                        </button>
                      )}
                      <button
                        disabled={splitting}
                        title="Move this exchange and everything after it into a new thread"
                        onClick={() => void split(message.id, 'move')}
                      >
                        <Scissors size={13} /> Split from here
                      </button>
                    </div>
                  )
              : undefined
          }
          renderAfter={(message) => {
            const here = topics.filter(
              (topic) => topic.anchorMessageId === message.id,
            );
            const shown = topicOf(message);
            return (
              <>
                {shown &&
                  message.role === 'user' &&
                  !internalSource(message) &&
                  threadLabel(shown)}
                {here.length > 0 && (
                  <div className="thread-cards">{here.map(threadCard)}</div>
                )}
              </>
            );
          }}
          renderMessage={(message) => {
            const shown = topicOf(message);
            const source = internalSource(message);
            if (!shown || !source || onClose) return undefined;
            // The Dot's own prompt to itself is not the owner's words.
            if (source === 'reply') return null;
            if (source === 'discovery') {
              const topic = topics.find((item) => item.id === shown);
              return (
                <button
                  className="dot-notice"
                  onClick={() => onOpenThread?.(shown)}
                >
                  <Inbox size={14} />
                  <span>
                    {dot.name} noticed something
                    {topic ? (
                      <>
                        : <strong>{topic.title}</strong>
                      </>
                    ) : null}
                  </span>
                </button>
              );
            }
            return (
              <div className="chat-message user">
                <div className="chat-bubble user">
                  {String(message.content).split(/\r?\n/)[0]}
                </div>
                {threadLabel(shown)}
              </div>
            );
          }}
          renderTools={(message) => (
            <ToolCalls
              message={
                fromThread.has(message.id)
                  ? {
                      ...message,
                      toolCalls: message.toolCalls?.filter(
                        (call) => chat.approvals[call.id],
                      ),
                    }
                  : message
              }
              results={results}
              approvals={chat.approvals}
              running={chat.running}
              dot={dot}
              latestBrowserCallId={latestBrowserCall?.id}
              onComputer={onComputer}
              onDecide={chat.decide}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(chatError || voice.error) && (
        <div className="chat-error" role="alert">
          {chatError || voice.error}
          {chatError && (
            <button
              onClick={() => {
                setError('');
                chat.reconnect();
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label={onClose ? 'Reply in thread' : 'Message your Dot'}
            placeholder={onClose ? 'Reply in thread…' : `Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() =>
                void chat
                  .stop()
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : 'Could not stop.',
                    ),
                  )
              }
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={!draft.trim() || !loaded || !contextReady || paused}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
