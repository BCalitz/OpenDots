import { Redirect, Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type Conversation, type Dot, type Workspace } from '../lib/api';
import { registerForPush, unregisterPush } from '../lib/push';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

export default function Home() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { session, loading, signOut } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setWorkspace(await api<Workspace>(session, '/workspace'));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load your Dots.',
      );
    }
  }, [session]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading) return <ActivityIndicator style={styles.center} />;
  if (!session) return <Redirect href="/sign-in" />;

  const dots = workspace?.dots ?? [];

  // Each Dot is one continuing chat; the server reuses it or starts it.
  const open = async (dot: Dot) => {
    setOpening(dot.id);
    try {
      const conversation = await api<Conversation>(
        session,
        '/conversations',
        'POST',
        { dotId: dot.id },
      );
      router.push({
        pathname: '/conversation/[id]',
        params: { id: conversation.id },
      });
    } catch (cause) {
      Alert.alert(
        `Could not open ${dot.name}`,
        cause instanceof Error ? cause.message : undefined,
      );
    } finally {
      setOpening(null);
    }
  };

  const menu = () =>
    Alert.alert('OpenDots', session.server, [
      {
        text: 'Send test notification',
        onPress: async () => {
          const setup = await registerForPush(session);
          if (!setup.ok) return Alert.alert('Notifications', setup.reason);
          try {
            await api(session, '/push/test', 'POST', {});
          } catch (cause) {
            Alert.alert(
              'Notifications',
              cause instanceof Error ? cause.message : 'Test failed.',
            );
          }
        },
      },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          await unregisterPush(session);
          await signOut();
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: 20 }}>
              <Pressable onPress={() => router.push('/inbox')} hitSlop={12}>
                <Text style={{ color: theme.accent, fontSize: 16 }}>Inbox</Text>
              </Pressable>
              <Pressable onPress={menu} hitSlop={12}>
                <Text style={{ color: theme.accent, fontSize: 16 }}>•••</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {!!workspace?.setup.missing.length && (
        <Text style={[styles.banner, { color: theme.danger }]}>
          Server setup incomplete: {workspace.setup.missing.join(', ')}
        </Text>
      )}
      <FlatList
        data={dots}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: 16 + insets.bottom },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          error ? (
            <Text style={[styles.banner, { color: theme.danger }]}>
              {error}
            </Text>
          ) : undefined
        }
        ListEmptyComponent={
          workspace ? (
            <Text style={[styles.empty, { color: theme.muted }]}>
              No Dots yet.
            </Text>
          ) : (
            <ActivityIndicator style={{ marginTop: 40 }} />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => void open(item)}
            disabled={!!opening}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
                borderColor: theme.border,
                opacity: opening && opening !== item.id ? 0.6 : 1,
              },
            ]}
          >
            <Text
              style={[styles.rowTitle, { color: theme.text }]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            <Text
              style={[styles.rowMeta, { color: theme.muted }]}
              numberOfLines={2}
            >
              {opening === item.id
                ? 'Opening…'
                : workspace?.mainConversations?.[item.id]
                  ? item.instructions
                  : 'Start chatting'}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingTop: 12, fontSize: 14 },
  list: { padding: 16, gap: 8 },
  row: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  rowMeta: { fontSize: 13 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
