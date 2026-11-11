import { TypeSafeClient, noul, choice, score } from '@typesafe-ai/sdk';
import type { InboxEventView } from '../../shared/inbox-types.js';

/** What the discovery model says about one item. */
export interface Verdict {
  /** The base, single-item signal — independent of any correlation. */
  attention: boolean;
  category: string;
  /** 0 to 1. */
  confidence: number;
  reason: string;
  /** Set whenever the item reads as referencing one of `candidates` and
   * asking for an action — independent of the business urgency threshold,
   * which the caller applies to `urgency`. */
  referencedEventId: string | null;
  /** 0 to 1, how urgent the item reads; `null` when there were no candidates
   * to check against. */
  urgency: number | null;
}
type JudgeItem = Pick<InboxEventView, 'title' | 'summary' | 'from' | 'kind'> & {
  app: string;
};
/** The fast first pass: does this item need the owner? */
export interface Judge {
  /** Shown on findings, for example "jev". */
  readonly name: string;
  judge(
    item: JudgeItem,
    /** Recent items from the same sender, for cross-item reference checks. */
    candidates: InboxEventView[],
    signal: AbortSignal,
  ): Promise<Verdict>;
}

const CATEGORY_CRITERIA = {
  payment: 'a payment made or received, remittance or proof of payment',
  invoice: 'an invoice sent to or by the owner',
  bill: 'a bill, statement or amount the owner owes',
  request: 'someone asking the owner to do something',
  question: 'someone asking the owner a question',
  meeting: 'a meeting invite, reschedule or call',
  deadline: 'a due date, expiry or renewal',
  security: 'a login, password, account or security problem',
  personal: 'a personal message from someone the owner knows',
  newsletter: 'a newsletter, marketing or promotion',
  notification: 'an automatic notification with nothing to do',
  other: 'anything else',
};

/**
 * Cheap checks before any model call. Mail the app itself filed as
 * promotions, social or spam never needs the owner.
 */
export function ruleVerdict(raw: unknown): Verdict | undefined {
  const labels =
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as Record<string, unknown>).labelIds)
      ? ((raw as Record<string, unknown>).labelIds as unknown[])
      : [];
  const filed = labels.find(
    (label) =>
      typeof label === 'string' &&
      [
        'CATEGORY_PROMOTIONS',
        'CATEGORY_SOCIAL',
        'CATEGORY_FORUMS',
        'SPAM',
      ].includes(label),
  );
  if (!filed) return undefined;
  return {
    attention: false,
    category: filed === 'CATEGORY_SOCIAL' ? 'notification' : 'newsletter',
    confidence: 0.95,
    reason: `Filed by the app under ${String(filed).replace('CATEGORY_', '').toLowerCase()}.`,
    referencedEventId: null,
    urgency: null,
  };
}

// 0.7 is the skill's suggested starting threshold for a Noul reading as yes.
const YES_THRESHOLD = 0.7;

function summarize(item: Pick<InboxEventView, 'title' | 'summary'>): string {
  return `${item.title}: ${item.summary}`.slice(0, 1500);
}

function describe(item: Pick<InboxEventView, 'kind' | 'from'>): string {
  const from = item.from ? ` from ${item.from}` : '';
  return `an earlier ${item.kind.split('.')[0] || 'item'}${from}`;
}

// Candidate labels describe their kind, not a bare position — the skill
// warns that positional names ("A", "option_1") give the model nothing to
// go on. The content itself lives in the criteria description.
function candidateLabels(
  candidates: InboxEventView[],
): Map<string, InboxEventView> {
  const counts = new Map<string, number>();
  const byLabel = new Map<string, InboxEventView>();
  for (const candidate of candidates) {
    const key = candidate.kind.split('.')[0] || 'item';
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    byLabel.set(`${key}_${n}`, candidate);
  }
  return byLabel;
}

/**
 * Jev (TypeSafe's System One model). One bundled request per item: whether
 * the owner needs to look at it and what kind it is, plus — only when there
 * are recent items from the same sender — whether it references one of
 * them, asks for an action, and how urgent it reads. Jev answers typed
 * questions with probabilities; it writes no prose, so `reason` is built
 * from its answers rather than generated.
 */
export function jevJudge(options: {
  apiKey: string;
  fetch?: typeof fetch;
  /** Disable request compression, e.g. so a test fetch can read plain JSON. */
  compression?: false;
}): Judge {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    fetch: options.fetch,
    compression: options.compression,
  });
  return {
    name: 'jev',
    async judge(item, candidates, signal) {
      const byLabel = candidates.length
        ? candidateLabels(candidates)
        : undefined;
      const state = {
        new_item: { app: item.app, kind: item.kind, text: summarize(item) },
        ...(byLabel
          ? {
              candidates: [...byLabel].map(([label, candidate]) => ({
                label,
                text: summarize(candidate),
              })),
            }
          : {}),
      };
      const baseQuestions = {
        attention: noul(
          'Does the owner of this inbox need to look at `new_item`?',
          {
            true: 'money in or out, a direct request or question, a deadline, a meeting that needs a reply, or an account or security problem',
            false:
              'a newsletter, marketing, a social update, or an automatic notification with nothing to do',
          },
        ),
        category: choice('What kind of item is `new_item`?', CATEGORY_CRITERIA),
      };
      if (!byLabel) {
        const { answers } = await client.systemOne(
          { state, questions: baseQuestions },
          { signal },
        );
        return {
          attention: answers.attention.noul >= YES_THRESHOLD,
          category: answers.category.choice,
          confidence: answers.attention.noul,
          reason: `${CATEGORY_CRITERIA[answers.category.choice]}.`,
          referencedEventId: null,
          urgency: null,
        };
      }
      const { answers } = await client.systemOne(
        {
          state,
          questions: {
            ...baseQuestions,
            references_any: noul(
              'Does `new_item` refer back to one of the items in `candidates`?',
            ),
            which_candidate: choice(
              'Which item in `candidates` does `new_item` refer to?',
              Object.fromEntries(
                [...byLabel].map(([label, candidate]) => [
                  label,
                  summarize(candidate),
                ]),
              ),
            ),
            is_ask: noul(
              'Does `new_item` ask the recipient to do something: reply, review, approve, or fix something?',
            ),
            urgency: score('How urgent does `new_item` read?', [
              'Can wait',
              'Needs attention this week',
              'Needs attention today',
            ] as const),
          },
        },
        { signal },
      );
      const referencesAny = answers.references_any.noul >= YES_THRESHOLD;
      const isAsk = answers.is_ask.noul >= YES_THRESHOLD;
      const urgency = answers.urgency.score / 2; // normalize the 0-2 rubric to 0-1
      // Detected whenever Jev is confident of a reference + an ask — the
      // caller (DiscoveryService) still gates escalation on `urgency` against
      // its own configurable threshold, same as it gates `attention` on
      // `confidence` below.
      const correlated = referencesAny && isAsk;
      const referenced = correlated
        ? (byLabel.get(answers.which_candidate.choice) ?? null)
        : null;
      return {
        attention: answers.attention.noul >= YES_THRESHOLD,
        category: answers.category.choice,
        confidence: answers.attention.noul,
        reason: referenced
          ? `References ${describe(referenced)} and asks for a reply.`
          : `${CATEGORY_CRITERIA[answers.category.choice]}.`,
        referencedEventId: referenced?.id ?? null,
        urgency,
      };
    },
  };
}
