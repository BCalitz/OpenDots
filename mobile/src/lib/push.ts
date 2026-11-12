import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { registerProposalCategories } from './proposals';
import type { Session } from './session';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// The token this install registered, so signing out can remove it.
let registeredToken: string | null = null;

export type PushSetup =
  { ok: true; token: string } | { ok: false; reason: string };

// Asks for permission, gets this device's Expo push token and registers it
// with the OpenDots server. Safe to call on every launch.
export async function registerForPush(session: Session): Promise<PushSetup> {
  if (Platform.OS === 'web')
    return { ok: false, reason: 'Push notifications need the phone app.' };
  if (!Device.isDevice)
    return { ok: false, reason: 'Push notifications need a physical device.' };
  // Android 13+ only shows the permission prompt once a channel exists.
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Dot updates',
      importance: Notifications.AndroidImportance.HIGH,
    });
  // Buttons for proposal notifications; registered before any arrives.
  await registerProposalCategories().catch(() => undefined);
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted')
    status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted')
    return { ok: false, reason: 'Notifications are turned off for OpenDots.' };
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId)
    return {
      ok: false,
      reason: 'This build has no EAS project ID. Run `eas init` and rebuild.',
    };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId }))
      .data;
    await api(session, '/push/devices', 'POST', {
      token,
      platform: Platform.OS,
    });
    registeredToken = token;
    return { ok: true, token };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : 'Could not set up push.',
    };
  }
}

// Stops this phone receiving the server's notifications.
export async function unregisterPush(session: Session) {
  if (!registeredToken) return;
  const token = registeredToken;
  registeredToken = null;
  await api(session, '/push/devices', 'DELETE', { token }).catch(() => {});
}

export function threadFromNotification(
  response: Notifications.NotificationResponse | null | undefined,
): string | undefined {
  const value = response?.notification.request.content.data?.threadId;
  return typeof value === 'string' ? value : undefined;
}

/** Whether a notification points at the inbox, such as the morning brief. */
export function inboxFromNotification(
  response: Notifications.NotificationResponse | null | undefined,
) {
  const value = response?.notification.request.content.data?.url;
  return typeof value === 'string' && value.includes('inbox');
}
