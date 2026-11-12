import { TypeSafeClient, noul, type Questions } from '@typesafe-ai/sdk';

/** What the router sees: the main chat so far and its topic threads. */
export interface TopicState {
  /**
   * The latest messages in the main chat as the owner sees it, oldest
   * first; `thread` names the thread one was answered in.
   */
  recent: { role: 'user' | 'assistant'; text: string; thread?: string }[];
  threads: {
    id: string;
    title: string;
    /** The owner's first message in the thread. */
    opened: string;
    /** The thread's latest messages, oldest first. */
    recent: { role: 'user' | 'assistant'; text: string }[];
  }[];
  message: string;
}
/** Jev's answers, each the probability the statement is true. */
export interface TopicAnswers {
  /** The message carries on the main chat's current topic. */
  continues: number | null;
  /**
   * The thread the latest exchange in the main chat belongs to; undefined
   * when it was in the main chat itself. A fact from code, not Jev.
   */
  latestThreadId?: string;
  /** The message asks for work or information on a subject of its own. */
  substantive: number;
  /** Per thread id: the message is about that thread's topic. */
  about: Record<string, number>;
}
export type TopicRoute =
  { kind: 'stay' } | { kind: 'thread'; threadId: string } | { kind: 'new' };

const YES = 0.7;
const NO = 0.3;
/** Moving a message the owner wrote is surprising; be sure first. */
const SURE = 0.8;

/**
 * The decision, in code. Jev answers three kinds of judgment; this table
 * maps them to where the message goes. Anything unsettled stays in the main
 * chat, where the owner wrote it.
 *
 * | continues | best thread  | substantive | route                       |
 * | --------- | ------------ | ----------- | --------------------------- |
 * | ≥ 0.3     | any          | any         | where the latest one went   |
 * | < 0.3     | ≥ 0.8        | any         | that thread                 |
 * | < 0.3     | all < 0.3    | ≥ 0.7       | new thread                  |
 * | < 0.3     | otherwise    | otherwise   | stay                        |
 *
 * "Where the latest one went": a follow-up joins the exchange it follows,
 * in its thread when that exchange was answered in one.
 *
 * With nothing in the main chat yet (`continues` is null), the message is
 * the chat's first topic and stays, unless it is clearly about a thread.
 */
export function decideRoute(answers: TopicAnswers): TopicRoute {
  const ranked = Object.entries(answers.about).sort((a, b) => b[1] - a[1]);
  const [best] = ranked;
  if (answers.continues !== null && answers.continues >= NO)
    return answers.latestThreadId
      ? { kind: 'thread', threadId: answers.latestThreadId }
      : { kind: 'stay' };
  if (best && best[1] >= SURE) return { kind: 'thread', threadId: best[0] };
  if (answers.continues === null) return { kind: 'stay' };
  if (ranked.every(([, p]) => p < NO) && answers.substantive >= YES)
    return { kind: 'new' };
  return { kind: 'stay' };
}

/** Thread labels Jev reads; ids stay in code. */
const label = (index: number) => `thread_${index + 1}`;

/** The questions, in one place so they are easy to audit and edit. */
export function topicQuestions(state: TopicState): Questions {
  const questions: Questions = {
    substantive: noul(
      'Does `new_message` ask for work or information about a specific subject?',
      {
        true: 'it asks a question, gives a task or raises a matter on a specific subject, such as an invoice, a trip or a piece of code',
        false:
          'it is a greeting, thanks, an acknowledgement such as "ok" or "great", or a remark about the assistant itself',
      },
    ),
  };
  if (state.recent.length)
    questions.continues = noul(
      'Does `new_message` carry on the subject of the latest messages in `main_chat`?',
      {
        true: 'it follows up, answers, corrects or reacts to what `main_chat` was just discussing, including short replies such as "yes, do that"',
        false:
          'it moves to a subject `main_chat` was not just discussing, such as asking about a different bill after talking about a holiday',
      },
    );
  state.threads.forEach((_, index) => {
    questions[`about__${label(index)}`] = noul(
      `Is \`new_message\` about the same subject as \`threads.${label(index)}\`?`,
      {
        true: 'it raises, follows up on or asks about the matter that thread discusses',
        false:
          'it concerns a different matter, even if it is about a similar kind of thing, such as a different invoice from the same company',
      },
    );
  });
  return questions;
}

export function topicPayload(state: TopicState) {
  return {
    ...(state.recent.length
      ? {
          main_chat: state.recent.map(({ thread, ...message }) =>
            thread ? { ...message, answered_in_thread: thread } : message,
          ),
        }
      : {}),
    ...(state.threads.length
      ? {
          threads: Object.fromEntries(
            state.threads.map((thread, index) => [
              label(index),
              {
                title: thread.title,
                opened_with: thread.opened,
                latest_messages: thread.recent,
              },
            ]),
          ),
        }
      : {}),
    new_message: state.message,
  };
}

export type TopicRouter = (
  state: TopicState,
  signal?: AbortSignal,
) => Promise<TopicAnswers>;

/** Jev (TypeSafe's System One model) as the topic router. */
export function jevTopicRouter(options: {
  apiKey: string;
  fetch?: typeof fetch;
  compression?: false;
}): TopicRouter {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    fetch: options.fetch,
    compression: options.compression,
  });
  return async (state, signal) => {
    const { answers } = await client.systemOne(
      { state: topicPayload(state), questions: topicQuestions(state) },
      { signal },
    );
    const a = answers as unknown as Record<string, { noul: number }>;
    return {
      continues: state.recent.length ? a.continues.noul : null,
      substantive: a.substantive.noul,
      about: Object.fromEntries(
        state.threads.map((thread, index) => [
          thread.id,
          a[`about__${label(index)}`].noul,
        ]),
      ),
    };
  };
}
