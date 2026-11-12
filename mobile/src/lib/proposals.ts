import * as Notifications from 'expo-notifications';
import { api } from './api';
import type { Session } from './session';

/**
 * Proposals as the app sees them; a subset of ProposalView in the server's
 * src/shared/inbox-types.ts.
 */
export type ProposalState =
  | 'open'
  | 'preparing'
  | 'prepared'
  | 'handling'
  | 'handled'
  | 'snoozed'
  | 'dismissed'
  | 'failed'
  | 'closed';
export interface Proposal {
  id: string;
  threadId: string;
  title: string;
  summary: string;
  options: ('prepare' | 'handle' | 'not_now')[];
  state: ProposalState;
  snoozeUntil: number | null;
  importance: number;
  urgency: 'days' | 'tomorrow' | 'today' | 'hours' | null;
  sender: string | null;
  error: string | null;
  updatedAt: number;
}
export type Choice = 'prepare' | 'handle' | 'snooze' | 'dismiss';

export const decide = (
  session: Session,
  id: string,
  choice: Choice,
  until?: 'later' | 'tomorrow',
) =>
  api<Proposal>(session, `/proposals/${id}/decide`, 'POST', {
    choice,
    ...(until ? { until } : {}),
  });

// Buttons on a proposal's notification. The server names the category in
// each push (src/server/push.ts, PushCategory); identifiers must not use
// '-' or ':'. Each opens the app, so the choice is sent with a live session.
const PREPARE = {
  identifier: 'prepare',
  buttonTitle: 'Prepare it',
  options: { opensAppToForeground: true },
};
const HANDLE = {
  identifier: 'handle',
  buttonTitle: 'Handle it',
  options: { opensAppToForeground: true },
};
const NOT_NOW = {
  identifier: 'not_now',
  buttonTitle: 'Not now',
  options: { opensAppToForeground: true },
};
export async function registerProposalCategories() {
  await Promise.all([
    Notifications.setNotificationCategoryAsync('proposal', [
      PREPARE,
      HANDLE,
      NOT_NOW,
    ]),
    Notifications.setNotificationCategoryAsync('proposal_prepare', [
      PREPARE,
      NOT_NOW,
    ]),
    Notifications.setNotificationCategoryAsync('proposal_prepared', [
      HANDLE,
      NOT_NOW,
    ]),
  ]);
}

/** The choice a notification button stands for, if one was tapped. */
export function choiceFromNotification(
  response: Notifications.NotificationResponse | null | undefined,
): { proposalId: string; choice: Choice } | undefined {
  const proposalId = response?.notification.request.content.data?.proposalId;
  if (typeof proposalId !== 'string') return;
  switch (response?.actionIdentifier) {
    case 'prepare':
      return { proposalId, choice: 'prepare' };
    case 'handle':
      return { proposalId, choice: 'handle' };
    case 'not_now':
      return { proposalId, choice: 'snooze' };
    default:
      return;
  }
}
