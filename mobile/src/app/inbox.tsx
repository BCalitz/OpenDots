import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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
import { Card, CardButton, cardStyles } from '../components/Card';
import { api } from '../lib/api';
import {
  decide,
  type Choice,
  type Proposal,
  type ProposalState,
} from '../lib/proposals';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

const stateText: Record<ProposalState, string> = {
  open: 'Waiting',
  preparing: 'Preparing…',
  prepared: 'Prepared',
  handling: 'Handling…',
  handled: 'Handled',
  snoozed: 'Snoozed',
  dismissed: 'Dismissed',
  failed: 'Did not finish',
  closed: 'No longer needed',
};
const urgencyText = {
  hours: 'Within hours',
  today: 'Today',
  tomorrow: 'By tomorrow',
  days: 'Can wait',
};

/** What Dots looked into, most important first, with the three choices. */
export default function InboxScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { session, loading } = useSession();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setProposals(await api<Proposal[]>(session, '/proposals'));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load the inbox.',
      );
    }
  }, [session]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Preparing and handling run on the server; check back while they do.
  const running = proposals?.some(
    (p) => p.state === 'preparing' || p.state === 'handling',
  );
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!session) return <Redirect href="/sign-in" />;

  const choose = async (
    proposal: Proposal,
    choice: Choice,
    until?: 'later' | 'tomorrow',
  ) => {
    setBusy(`${proposal.id}:${choice}`);
    try {
      await decide(session, proposal.id, choice, until);
      if (choice === 'prepare' || choice === 'handle')
        router.push({
          pathname: '/conversation/[id]',
          params: { id: proposal.threadId },
        });
    } catch (cause) {
      Alert.alert(
        'OpenDots',
        cause instanceof Error ? cause.message : 'Could not send your choice.',
      );
    } finally {
      setBusy(null);
      await load();
    }
  };
  const notNow = (proposal: Proposal) =>
    Alert.alert('Not now', proposal.title, [
      {
        text: 'In 3 hours',
        onPress: () => void choose(proposal, 'snooze', 'later'),
      },
      {
        text: 'Tomorrow morning',
        onPress: () => void choose(proposal, 'snooze', 'tomorrow'),
      },
      {
        text: 'Dismiss',
        style: 'destructive',
        onPress: () => void choose(proposal, 'dismiss'),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <FlatList
      data={proposals ?? []}
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
          <Text style={[styles.banner, { color: theme.danger }]}>{error}</Text>
        ) : undefined
      }
      ListEmptyComponent={
        proposals ? (
          <Text style={[styles.empty, { color: theme.muted }]}>
            Nothing needs you right now.
          </Text>
        ) : (
          <ActivityIndicator style={{ marginTop: 40 }} />
        )
      }
      renderItem={({ item }) => {
        const canChoose = ['open', 'prepared', 'failed', 'snoozed'].includes(
          item.state,
        );
        const prepare =
          item.options.includes('prepare') && item.state !== 'prepared';
        const handle = item.options.includes('handle');
        const badge = [
          stateText[item.state],
          item.urgency ? urgencyText[item.urgency] : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <Card heading={item.title} badge={badge}>
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/conversation/[id]',
                  params: { id: item.threadId },
                })
              }
            >
              <Text
                style={[cardStyles.small, { color: theme.text }]}
                numberOfLines={6}
              >
                {item.summary}
              </Text>
              {!!item.error && (
                <Text style={[cardStyles.small, { color: theme.danger }]}>
                  {item.error}
                </Text>
              )}
              <Text style={[cardStyles.small, { color: theme.accent }]}>
                Open the conversation
              </Text>
            </Pressable>
            {canChoose && (
              <View style={cardStyles.actions}>
                {prepare && (
                  <CardButton
                    label="Prepare"
                    primary
                    busy={busy === `${item.id}:prepare`}
                    disabled={!!busy}
                    onPress={() => void choose(item, 'prepare')}
                  />
                )}
                {handle && (
                  <CardButton
                    label="Handle"
                    primary={!prepare}
                    busy={busy === `${item.id}:handle`}
                    disabled={!!busy}
                    onPress={() => void choose(item, 'handle')}
                  />
                )}
                <CardButton
                  label="Not now"
                  disabled={!!busy}
                  onPress={() => notNow(item)}
                />
              </View>
            )}
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 8 },
  banner: { paddingBottom: 8, fontSize: 14 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
