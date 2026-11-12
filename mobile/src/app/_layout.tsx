import * as Notifications from 'expo-notifications';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { choiceFromNotification, decide } from '../lib/proposals';
import {
  inboxFromNotification,
  registerForPush,
  threadFromNotification,
} from '../lib/push';
import { SessionProvider, useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

function PushBridge() {
  const { session } = useSession();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  // Register this device whenever someone signs in.
  useEffect(() => {
    if (session) void registerForPush(session);
  }, [session]);
  // Tapping a notification (also from a cold start) opens its conversation,
  // or the inbox for the morning brief. A proposal's buttons send the
  // owner's choice first.
  useEffect(() => {
    if (!session || !lastResponse) return;
    const id = `${lastResponse.notification.request.identifier}:${lastResponse.actionIdentifier}`;
    if (handled.current === id) return;
    handled.current = id;
    const threadId = threadFromNotification(lastResponse);
    const chosen = choiceFromNotification(lastResponse);
    const open = () => {
      if (threadId && chosen?.choice !== 'snooze')
        router.push({
          pathname: '/conversation/[id]',
          params: { id: threadId },
        });
      else if (chosen || inboxFromNotification(lastResponse))
        router.push('/inbox');
    };
    if (!chosen) return open();
    // "Not now" from a notification snoozes for three hours.
    void decide(
      session,
      chosen.proposalId,
      chosen.choice,
      chosen.choice === 'snooze' ? 'later' : undefined,
    )
      .catch((cause: unknown) =>
        Alert.alert(
          'OpenDots',
          cause instanceof Error
            ? cause.message
            : 'Could not send your choice.',
        ),
      )
      .finally(open);
  }, [session, lastResponse]);
  return null;
}

export default function RootLayout() {
  const theme = useTheme();
  return (
    <SessionProvider>
      <PushBridge />
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.surface },
          headerTintColor: theme.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'OpenDots' }} />
        <Stack.Screen
          name="sign-in"
          options={{ title: 'Connect', headerBackVisible: false }}
        />
        <Stack.Screen name="conversation/[id]" options={{ title: '' }} />
        <Stack.Screen name="inbox" options={{ title: 'For you' }} />
      </Stack>
    </SessionProvider>
  );
}
