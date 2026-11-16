import {
  URGENCIES,
  type Asked,
  type ProposalState,
  type ProposalView,
  type Urgency,
  type WaitingView,
} from '../shared/inbox-types.js';
import type { ApprovalView } from '../shared/approvals.js';
import type {
  TodayAction,
  TodayItem,
  TodayStatus,
  TodayView,
} from '../shared/today-types.js';
import { NUDGE_AFTER_MS } from './discovery/waiting.js';
import { dueLabel, whyItem, whyWaiting } from './today-why.js';

/** A proposal with the stored facts its card is built from. */
export interface TodayProposal {
  proposal: ProposalView;
  /** The sender's name, such as "Thandi Nkosi". */
  name: string | null;
  /** The company memory says the sender works at. */
  org: string | null;
  asked: Asked | null;
  /** Items in this conversation that asked something, this one included. */
  asks: number;
  /** The focus subject the item matched, if any. */
  focus: string | null;
  /** The item matched something the owner muted. */
  muted: boolean;
}

export interface TodayInputs {
  /** Local date in the owner's time zone. */
  date: string;
  proposals: TodayProposal[];
  /** Approvals still waiting for the owner. */
  approvals: ApprovalView[];
  /** Things the owner sent that nobody answered. */
  waiting: WaitingView[];
  quiet: TodayView['quiet'];
  status: TodayStatus;
}

/** How many urgent items the "Needs you now" row holds. */
export const NOW_LIMIT = 2;
/** Proposal states that still wait on the owner's choice. */
const OPEN: ProposalState[] = ['open', 'prepared', 'failed'];
const URGENT: Urgency[] = ['hours', 'today'];

/** A card with what it is sorted by. */
interface Sortable {
  item: TodayItem;
  importance: number;
  createdAt: number;
}

// Unknown urgency sorts as "tomorrow", as importanceOf scores it.
const urgencyRank = (urgency: Urgency | null) =>
  URGENCIES.indexOf(urgency ?? 'tomorrow');
const byPriority = (a: Sortable, b: Sortable) =>
  urgencyRank(b.item.urgency) - urgencyRank(a.item.urgency) ||
  b.importance - a.importance ||
  a.createdAt - b.createdAt;

const whoOf = (name: string | null, org: string | null) =>
  name && org ? `${name}, ${org}` : (name ?? org);

function proposalActions(proposal: ProposalView): TodayAction[] {
  const decide = (choice: string, until?: string) => ({
    method: 'POST' as const,
    path: `/proposals/${proposal.id}/decide`,
    body: until ? { choice, until } : { choice },
  });
  const actions: TodayAction[] = [
    { id: 'review', label: 'Review', request: null },
  ];
  if (proposal.options.includes('prepare') && proposal.state !== 'prepared')
    actions.push({
      id: 'prepare',
      label: 'Prepare',
      request: decide('prepare'),
    });
  if (proposal.options.includes('handle'))
    actions.push({ id: 'handle', label: 'Handle', request: decide('handle') });
  actions.push(
    { id: 'snooze', label: 'Later', request: decide('snooze', 'later') },
    { id: 'dismiss', label: 'Not important', request: decide('dismiss') },
  );
  return actions;
}

function approvalActions(approval: ApprovalView): TodayAction[] {
  const decide = (approved: boolean) => ({
    method: 'POST' as const,
    path: '/chat/approvals',
    body: { ids: [approval.id], approved },
  });
  // TODO(1.2): add "Always allow this" when the tool's risk is `low`, once
  // tools have a risk. Until then it is left out, so nothing that sends,
  // changes a meeting, pays or deletes can be offered it.
  return [
    { id: 'review', label: 'Review', request: null },
    { id: 'approve', label: 'Approve', request: decide(true) },
    { id: 'decline', label: 'Decline', request: decide(false) },
  ];
}

const payloadOf = (approval: ApprovalView) =>
  (approval.payload ?? {}) as { title?: unknown; output?: unknown };

function proposalCard(entry: TodayProposal): Sortable {
  const { proposal } = entry;
  return {
    item: {
      id: `proposal:${proposal.id}`,
      kind: 'proposal',
      title: proposal.title,
      who: whoOf(entry.name, entry.org),
      why: whyItem({
        name: entry.name,
        asked: entry.asked,
        asks: entry.asks,
        urgency: proposal.urgency,
        focus: entry.focus,
      }),
      due: dueLabel(proposal.urgency),
      ready:
        proposal.state === 'prepared'
          ? proposal.route === 'draft'
            ? 'Draft reply is ready'
            : 'Prepared for you'
          : null,
      urgency: proposal.urgency,
      threadId: proposal.threadId,
      eventId: proposal.eventId,
      actions: proposalActions(proposal),
    },
    importance: proposal.importance,
    createdAt: proposal.createdAt,
  };
}

/** An approval, with the facts of the proposal about the same item. */
function approvalCard(
  approval: ApprovalView,
  entry: TodayProposal | undefined,
): Sortable {
  const payload = payloadOf(approval);
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title
      : (entry?.proposal.title ?? 'Waiting for your approval');
  const proposal = entry?.proposal;
  return {
    item: {
      id: `approval:${approval.id}`,
      kind: 'approval',
      title,
      who: entry ? whoOf(entry.name, entry.org) : null,
      why: entry
        ? whyItem({
            name: entry.name,
            asked: entry.asked,
            asks: entry.asks,
            urgency: proposal!.urgency,
            focus: entry.focus,
          })
        : 'Waiting for your yes before it goes ahead.',
      due: dueLabel(proposal?.urgency ?? null),
      ready:
        typeof payload.output === 'string' && payload.output.trim()
          ? 'Draft is ready'
          : 'Ready for your approval',
      urgency: proposal?.urgency ?? null,
      threadId: approval.threadId,
      eventId: proposal?.eventId ?? null,
      actions: approvalActions(approval),
    },
    importance: proposal?.importance ?? 0,
    createdAt: approval.createdAt,
  };
}

function waitingCard(wait: WaitingView, now: number): Sortable {
  return {
    item: {
      id: `waiting:${wait.id}`,
      kind: 'waiting',
      title: wait.title,
      who: wait.who,
      why: whyWaiting(wait.since, now),
      due: null,
      ready: null,
      urgency: null,
      threadId: null,
      eventId: wait.eventId,
      // TODO: "Wait longer" needs a route and a column to snooze a waiting
      // item; none exists yet, so it is left out.
      actions: [
        {
          id: 'follow_up',
          label: 'Review the follow-up',
          request: {
            method: 'POST',
            path: `/discovery/waiting/${wait.id}/follow-up`,
          },
        },
      ],
    },
    importance: 0,
    createdAt: wait.since,
  };
}

/**
 * The home screen's list. Pure: everything it needs is in `inputs`, so it
 * is tested without a database.
 */
export function buildToday(inputs: TodayInputs, now: number): TodayView {
  const shown = inputs.proposals.filter(
    (entry) => OPEN.includes(entry.proposal.state) && !entry.muted,
  );
  const byThread = new Map(
    inputs.proposals.map((entry) => [entry.proposal.threadId, entry]),
  );
  // A proposal and an approval about the same item appear once, as the
  // approval, since that is the next thing to decide.
  const approvalThreads = new Set(
    inputs.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.threadId),
  );
  const cards = [
    ...inputs.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) =>
        approvalCard(approval, byThread.get(approval.threadId)),
      ),
    ...shown
      .filter((entry) => !approvalThreads.has(entry.proposal.threadId))
      .map(proposalCard),
  ].sort(byPriority);

  const urgent = cards.filter(
    (card) => card.item.urgency && URGENT.includes(card.item.urgency),
  );
  const rest = cards.filter((card) => !urgent.includes(card));
  const waiting = inputs.waiting
    .filter(
      (wait) => wait.state === 'waiting' && wait.since <= now - NUDGE_AFTER_MS,
    )
    .map((wait) => waitingCard(wait, now))
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    date: inputs.date,
    now: urgent.slice(0, NOW_LIMIT).map((card) => card.item),
    moreNow: Math.max(urgent.length - NOW_LIMIT, 0),
    decide: [...urgent.slice(NOW_LIMIT), ...rest].map((card) => card.item),
    waiting: waiting.map((card) => card.item),
    day: [],
    quiet: inputs.quiet,
    status: inputs.status,
  };
}
