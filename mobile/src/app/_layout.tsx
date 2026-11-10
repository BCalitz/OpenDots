import * as Notifications from 'expo-notifications';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { registerForPush, threadFromNotification } from '../lib/push';
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
  // Tapping a notification (also from a cold start) opens its conversation.
  useEffect(() => {
    const threadId = threadFromNotification(lastResponse);
    const id = lastResponse?.notification.request.identifier ?? null;
    if (!session || !threadId || handled.current === id) return;
    handled.current = id;
    router.push({ pathname: '/conversation/[id]', params: { id: threadId } });
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
      </Stack>
    </SessionProvider>
  );
}
