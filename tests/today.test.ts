import { describe, expect, it } from 'vitest';
import {
  buildToday,
  type TodayInputs,
  type TodayProposal,
} from '../src/server/today.js';
import { dueLabel, whyItem, whyWaiting } from '../src/server/today-why.js';
import { NUDGE_AFTER_MS } from '../src/server/discovery/waiting.js';
import type {
  ProposalView,
  Urgency,
  WaitingView,
} from '../src/shared/inbox-types.js';
import type { ApprovalView } from '../src/shared/approvals.js';

const NOW = Date.UTC(2026, 10, 16, 10, 0);
const DAY = 86_400_000;

function proposal(
  id: string,
  patch: Partial<ProposalView> = {},
  facts: Partial<TodayProposal> = {},
): TodayProposal {
  return {
    proposal: {
      id,
      findingId: `f-${id}`,
      eventId: `e-${id}`,
      dotId: 'dot',
      threadId: `t-${id}`,
      title: `Item ${id}`,
      summary: '',
      options: ['prepare', 'handle', 'not_now'],
      state: 'open',
      decision: null,
      decidedAt: null,
      snoozeUntil: null,
      importance: 1,
      urgency: 'days',
      route: 'draft',
      sender: `${id}@example.com`,
      error: null,
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
      ...patch,
    },
    name: 'Thandi Nkosi',
    org: null,
    asked: 'reply',
    asks: 1,
    focus: null,
    muted: false,
    ...facts,
  };
}
function approval(
  id: string,
  threadId: string,
  patch: Partial<ApprovalView> = {},
): ApprovalView {
  return {
    id,
    threadId,
    toolCallId: `call-${id}`,
    kind: 'action',
    payload: { title: `Send reply ${id}`, description: 'd', output: 'Hi' },
    status: 'pending',
    createdAt: NOW - 60_000,
    decidedAt: null,
    ...patch,
  };
}
function waiting(id: string, since: number): WaitingView {
  return {
    id,
    eventId: `e-${id}`,
    who: 'Sipho',
    title: `Sent ${id}`,
    dotId: null,
    state: 'waiting',
    since,
    nudgedAt: null,
    answeredBy: null,
  };
}
function build(patch: Partial<TodayInputs>) {
  return buildToday(
    {
      date: '2026-11-16',
      proposals: [],
      approvals: [],
      waiting: [],
      quiet: { read: 0, kept: 0, sent: 0 },
      status: 'ok',
      ...patch,
    },
    NOW,
  );
}
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('buildToday', () => {
  it('puts urgent items in now and the rest in decide', () => {
    const view = build({
      proposals: [
        proposal('a', { urgency: 'hours' }),
        proposal('b', { urgency: 'tomorrow' }),
        proposal('c', { urgency: 'today' }),
        proposal('d', { urgency: null }),
      ],
    });
    expect(ids(view.now)).toEqual(['proposal:a', 'proposal:c']);
    expect(view.moreNow).toBe(0);
    expect(ids(view.decide)).toEqual(['proposal:b', 'proposal:d']);
    expect(view.day).toEqual([]);
    expect(view.date).toBe('2026-11-16');
  });

  it('orders by urgency, then importance, then oldest first', () => {
    const view = build({
      proposals: [
        proposal('new', { urgency: 'days', createdAt: NOW - 1000 }),
        proposal('old', { urgency: 'days', createdAt: NOW - 5000 }),
        proposal('big', { urgency: 'days', importance: 2 }),
        proposal('soon', { urgency: 'tomorrow', importance: 0 }),
      ],
    });
    expect(ids(view.decide)).toEqual([
      'proposal:soon',
      'proposal:big',
      'proposal:old',
      'proposal:new',
    ]);
  });

  it('holds two urgent items and lists the rest first in decide', () => {
    const view = build({
      proposals: [
        proposal('later', { urgency: 'days' }),
        proposal('u1', { urgency: 'hours', importance: 3 }),
        proposal('u2', { urgency: 'hours', importance: 2 }),
        proposal('u3', { urgency: 'today', importance: 2 }),
        proposal('u4', { urgency: 'today', importance: 1 }),
      ],
    });
    expect(ids(view.now)).toEqual(['proposal:u1', 'proposal:u2']);
    expect(view.moreNow).toBe(2);
    expect(ids(view.decide)).toEqual([
      'proposal:u3',
      'proposal:u4',
      'proposal:later',
    ]);
  });

  it('shows a proposal and its approval once, as the approval', () => {
    const view = build({
      proposals: [
        proposal('a', { urgency: 'today' }, { org: 'Acme Ltd' }),
        proposal('b'),
      ],
      approvals: [approval('x', 't-a'), approval('loose', 't-other')],
    });
    expect(ids(view.now)).toEqual(['approval:x']);
    const card = view.now[0];
    expect(card).toMatchObject({
      kind: 'approval',
      title: 'Send reply x',
      who: 'Thandi Nkosi, Acme Ltd',
      due: 'Due today',
      urgency: 'today',
      eventId: 'e-a',
      threadId: 't-a',
      ready: 'Draft is ready',
    });
    expect(card.actions.map((action) => action.id)).toEqual([
      'review',
      'approve',
      'decline',
    ]);
    expect(card.actions[1].request).toEqual({
      method: 'POST',
      path: '/chat/approvals',
      body: { ids: ['x'], approved: true },
    });
    // An approval with no proposal sorts as "tomorrow", like importanceOf.
    expect(ids(view.decide)).toEqual(['approval:loose', 'proposal:b']);
    expect(view.decide[0].why).toBe(
      'Waiting for your yes before it goes ahead.',
    );
  });

  it('leaves out snoozed, dismissed, closed, running and muted items', () => {
    const view = build({
      proposals: [
        proposal('open'),
        proposal('prepared', { state: 'prepared' }),
        proposal('snoozed', { state: 'snoozed', snoozeUntil: NOW + DAY }),
        proposal('dismissed', { state: 'dismissed' }),
        proposal('closed', { state: 'closed' }),
        proposal('handled', { state: 'handled' }),
        proposal('handling', { state: 'handling' }),
        proposal('muted', { urgency: 'hours' }, { muted: true }),
      ],
      approvals: [approval('done', 't-open', { status: 'approved' })],
    });
    expect(ids([...view.now, ...view.decide])).toEqual([
      'proposal:open',
      'proposal:prepared',
    ]);
    expect(view.decide[1].ready).toBe('Draft reply is ready');
  });

  it('lists only waiting items past their follow-up time', () => {
    const view = build({
      waiting: [
        waiting('fresh', NOW - DAY),
        waiting('old', NOW - 5 * DAY),
        waiting('due', NOW - NUDGE_AFTER_MS),
        { ...waiting('answered', NOW - 9 * DAY), state: 'answered' },
      ],
    });
    expect(ids(view.waiting)).toEqual(['waiting:old', 'waiting:due']);
    expect(view.waiting[0]).toMatchObject({
      why: 'You asked 5 days ago.',
      who: 'Sipho',
      eventId: 'e-old',
    });
    expect(view.waiting[0].actions).toEqual([
      {
        id: 'follow_up',
        label: 'Review the follow-up',
        request: { method: 'POST', path: '/discovery/waiting/old/follow-up' },
      },
    ]);
  });

  it('maps proposal actions to the decide route', () => {
    const [card] = build({ proposals: [proposal('a')] }).decide;
    expect(card.actions.map((action) => [action.id, action.label])).toEqual([
      ['review', 'Review'],
      ['prepare', 'Prepare'],
      ['handle', 'Handle'],
      ['snooze', 'Later'],
      ['dismiss', 'Not important'],
    ]);
    expect(card.actions[0].request).toBeNull();
    expect(card.actions[3].request).toEqual({
      method: 'POST',
      path: '/proposals/a/decide',
      body: { choice: 'snooze', until: 'later' },
    });
    const [tell] = build({
      proposals: [proposal('t', { options: ['prepare', 'not_now'] })],
    }).decide;
    expect(tell.actions.map((action) => action.id)).not.toContain('handle');
    const [prepared] = build({
      proposals: [proposal('p', { state: 'prepared' })],
    }).decide;
    expect(prepared.actions.map((action) => action.id)).not.toContain(
      'prepare',
    );
  });

  it('passes the quiet counts and status through', () => {
    const view = build({
      quiet: { read: 46, kept: 41, sent: 0 },
      status: 'paused',
    });
    expect(view.quiet).toEqual({ read: 46, kept: 41, sent: 0 });
    expect(view.status).toBe('paused');
    expect(view.now).toEqual([]);
    expect(view.moreNow).toBe(0);
  });
});

describe('why templates', () => {
  const facts = {
    name: 'Thandi Nkosi',
    asked: null,
    asks: 1,
    urgency: null,
    focus: null,
  };
  it('says a reply is asked, with the count of earlier asks', () => {
    expect(whyItem({ ...facts, asked: 'reply' })).toBe(
      'Thandi Nkosi is asking for a reply.',
    );
    expect(whyItem({ ...facts, asked: 'information', asks: 2 })).toBe(
      'Thandi Nkosi has asked twice.',
    );
    expect(whyItem({ ...facts, asked: 'reply', asks: 3 })).toBe(
      'Thandi Nkosi has asked three times.',
    );
    expect(whyItem({ ...facts, asked: 'reply', asks: 5 })).toBe(
      'Thandi Nkosi has asked 5 times.',
    );
    expect(whyItem({ ...facts, name: null, asked: 'reply' })).toBe(
      'The sender is asking for a reply.',
    );
  });
  it('says a decision is asked', () => {
    expect(whyItem({ ...facts, asked: 'decision', urgency: 'tomorrow' })).toBe(
      'Only you can decide this.',
    );
  });
  it('says how soon it is needed', () => {
    const cases: [Urgency, string][] = [
      ['hours', 'Needed within hours.'],
      ['today', 'Needed today.'],
      ['tomorrow', 'Needed by tomorrow.'],
      ['days', 'Flagged as needing you.'],
    ];
    for (const [urgency, text] of cases)
      expect(whyItem({ ...facts, asked: 'nothing', urgency })).toBe(text);
  });
  it('names a focus first', () => {
    expect(
      whyItem({ ...facts, asked: 'reply', asks: 2, focus: 'GreenBasket' }),
    ).toBe('About GreenBasket, which you are focusing on.');
  });
  it('says how long ago the owner asked', () => {
    expect(whyWaiting(NOW - 5 * DAY, NOW)).toBe('You asked 5 days ago.');
    expect(whyWaiting(NOW - DAY - 1000, NOW)).toBe('You asked yesterday.');
  });
  it('labels when it is due', () => {
    expect(dueLabel('tomorrow')).toBe('Due tomorrow');
    expect(dueLabel('days')).toBeNull();
  });
});
