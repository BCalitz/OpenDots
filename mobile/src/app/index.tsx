import { Redirect, Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type Conversation, type Workspace } from '../lib/api';
import { registerForPush, unregisterPush } from '../lib/push';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

export default function Home() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { session, loading, signOut } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [dotFilter, setDotFilter] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);

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
  const dotName = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'Dot';
  const conversations = (workspace?.conversations ?? [])
    .filter((c) => !dotFilter || c.dotId === dotFilter)
    .sort((a, b) => b.createdAt - a.createdAt);
  const newDotId = dotFilter ?? dots[0]?.id;

  const create = async () => {
    if (!newDotId) return;
    setCreating(true);
    try {
      const conversation = await api<Conversation>(
        session,
        '/conversations',
        'POST',
        { dotId: newDotId, title: 'A new thought' },
      );
      router.push({
        pathname: '/conversation/[id]',
        params: { id: conversation.id },
      });
    } catch (cause) {
      Alert.alert(
        'Could not start a conversation',
        cause instanceof Error ? cause.message : undefined,
      );
    } finally {
      setCreating(false);
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
            <Pressable onPress={menu} hitSlop={12}>
              <Text style={{ color: theme.accent, fontSize: 16 }}>•••</Text>
            </Pressable>
          ),
        }}
      />
      {!!workspace?.setup.missing.length && (
        <Text style={[styles.banner, { color: theme.danger }]}>
          Server setup incomplete: {workspace.setup.missing.join(', ')}
        </Text>
      )}
      {dots.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsRow}
          contentContainerStyle={styles.chips}
        >
          {[{ id: null, name: 'All' }, ...dots].map((dot) => {
            const selected = dotFilter === dot.id;
            return (
              <Pressable
                key={dot.id ?? 'all'}
                onPress={() => setDotFilter(dot.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? theme.accent : theme.surface,
                    borderColor: theme.border,
                  },
                ]}
              >
                <Text
                  style={{ color: selected ? theme.accentText : theme.text }}
                >
                  {dot.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: 100 + insets.bottom },
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
              No conversations yet.
            </Text>
          ) : (
            <ActivityIndicator style={{ marginTop: 40 }} />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/conversation/[id]',
                params: { id: item.id },
              })
            }
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
                borderColor: theme.border,
              },
            ]}
          >
            <Text
              style={[styles.rowTitle, { color: theme.text }]}
              numberOfLines={1}
            >
              {item.title}
            </Text>
            <Text style={[styles.rowMeta, { color: theme.muted }]}>
              {dotName(item.dotId)} ·{' '}
              {new Date(item.createdAt).toLocaleDateString()}
            </Text>
          </Pressable>
        )}
      />
      {!!newDotId && (
        <Pressable
          onPress={() => void create()}
          disabled={creating}
          style={[
            styles.fab,
            {
              backgroundColor: theme.accent,
              opacity: creating ? 0.6 : 1,
              // Clear the Android navigation bar / iPhone home indicator.
              bottom: 16 + insets.bottom,
            },
          ]}
        >
          <Text style={[styles.fabText, { color: theme.accentText }]}>
            {creating ? 'Starting…' : `New chat with ${dotName(newDotId)}`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingTop: 12, fontSize: 14 },
  chipsRow: { flexGrow: 0 },
  chips: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  list: { padding: 16, gap: 8, paddingBottom: 100 },
  row: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  rowMeta: { fontSize: 13 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  fab: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  fabText: { fontSize: 16, fontWeight: '600' },
});
