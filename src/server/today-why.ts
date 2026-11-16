import type { Asked, Urgency } from '../shared/inbox-types.js';

/**
 * The "why" line on each card on the home screen, built from what discovery
 * stored, never written by a model. Every template is here, so the full
 * "Why this?" (5.4) can extend them in one place.
 *
 * The person's name is used, never a pronoun, since a pronoun would be a
 * guess.
 */
export interface WhyFacts {
  /** The person the item is from, such as "Thandi Nkosi". */
  name: string | null;
  asked: Asked | null;
  /** How many items in this conversation asked something, this one included. */
  asks: number;
  urgency: Urgency | null;
  /** A focus subject the item matched, such as "GreenBasket". */
  focus: string | null;
}

const TIMES: Record<number, string> = { 2: 'twice', 3: 'three times' };
const times = (count: number) => TIMES[count] ?? `${count} times`;

const URGENCY: Record<Urgency, string | null> = {
  hours: 'Needed within hours.',
  today: 'Needed today.',
  tomorrow: 'Needed by tomorrow.',
  days: null,
};

/** One sentence: the strongest stored reason the item needs the owner. */
export function whyItem(facts: WhyFacts): string {
  if (facts.focus) return `About ${facts.focus}, which you are focusing on.`;
  const who = facts.name ?? 'The sender';
  const asking =
    facts.asked === 'reply' || facts.asked === 'information'
      ? 'reply'
      : facts.asked === 'action'
        ? 'action'
        : null;
  if (asking && facts.asks >= 2)
    return `${who} has asked ${times(facts.asks)}.`;
  if (facts.asked === 'decision') return 'Only you can decide this.';
  if (asking === 'reply') return `${who} is asking for a reply.`;
  if (asking === 'action') return `${who} is asking you to do something.`;
  const urgent = facts.urgency && URGENCY[facts.urgency];
  if (urgent) return urgent;
  return 'Flagged as needing you.';
}

/** For something the owner sent that nobody has answered. */
export function whyWaiting(since: number, now: number): string {
  const days = Math.max(1, Math.floor((now - since) / 86_400_000));
  return days === 1 ? 'You asked yesterday.' : `You asked ${days} days ago.`;
}

/** The due label on a card, from stored urgency. */
export function dueLabel(urgency: Urgency | null): string | null {
  switch (urgency) {
    case 'hours':
      return 'Due within hours';
    case 'today':
      return 'Due today';
    case 'tomorrow':
      return 'Due tomorrow';
    default:
      return null;
  }
}
