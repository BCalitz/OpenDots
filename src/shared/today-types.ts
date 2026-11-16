import type { Urgency } from './inbox-types.js';

/**
 * The home screen's list for today (spec 1.1), built by code from what
 * discovery stored. No model is called to build it.
 */
export interface TodayView {
  /** Local date in the owner's time zone, "YYYY-MM-DD". */
  date: string;
  /** The most urgent items, at most two. */
  now: TodayItem[];
  /** Urgent items that did not fit in `now`; they are listed first in `decide`. */
  moreNow: number;
  decide: TodayItem[];
  waiting: TodayItem[];
  /** Empty until 2.1 adds the calendar. */
  day: DayEntry[];
  /** Since the last local midnight. */
  quiet: { read: number; kept: number; sent: number };
  status: TodayStatus;
}

export type TodayStatus =
  'ok' | 'paused' | 'no_accounts' | 'no_judge' | 'account_error';

export type TodayItemKind = 'proposal' | 'approval' | 'waiting';

export interface TodayItem {
  /** "proposal:<id>", "approval:<id>" or "waiting:<id>". */
  id: string;
  kind: TodayItemKind;
  title: string;
  /** "Thandi Nkosi, Acme Ltd". */
  who: string | null;
  /** One sentence, built by code from stored facts. */
  why: string;
  /** "Due tomorrow". */
  due: string | null;
  /** "Draft reply is ready". */
  ready: string | null;
  urgency: Urgency | null;
  threadId: string | null;
  eventId: string | null;
  /** In display order; the first is the main button. */
  actions: TodayAction[];
}

export type TodayActionId =
  | 'review'
  | 'prepare'
  | 'handle'
  | 'snooze'
  | 'dismiss'
  | 'approve'
  | 'decline'
  | 'follow_up';

/**
 * One button on a card. `request` is the existing API call it makes; null
 * means the client opens the item instead.
 */
export interface TodayAction {
  id: TodayActionId;
  label: string;
  request: {
    method: 'POST';
    /** Under /api, such as "/proposals/<id>/decide". */
    path: string;
    body?: unknown;
  } | null;
}

/** One entry in the owner's day. Spec 2.1 fills this in from the calendar. */
export interface DayEntry {
  id: string;
  title: string;
  start: number;
  end: number | null;
}
