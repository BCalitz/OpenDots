import { useState } from 'react';
import { Text, View } from 'react-native';
import type { ApprovalView } from '../lib/approvals';
import { useTheme } from '../lib/theme';
import { Card, CardButton, cardStyles } from './Card';

const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
interface ActionPayload {
  connection?: string;
  title?: string;
  description?: string;
  arguments?: Record<string, unknown>;
}

// Mobile version of the web ConnectionActionCard. It shows the server's
// record of exactly what will run; approving lets the waiting Dot run it
// once on the server.
export function ApprovalCard({
  args,
  result,
  approval,
  running,
  onDecide,
}: {
  args: unknown;
  result?: unknown;
  approval?: ApprovalView;
  running: boolean;
  onDecide: (approvalId: string, approved: boolean) => Promise<unknown>;
}) {
  const theme = useTheme();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const payload = (approval?.payload ?? {}) as ActionPayload;
  const outcome = result === undefined ? undefined : parse(result);
  const waiting = !outcome && approval?.status === 'pending' && running;
  const approved = outcome?.approved === true;
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';
  // Threads from before server approvals passed a summary to a client tool.
  const legacy = args as { summary?: unknown } | undefined;
  const summary =
    payload.description ??
    (typeof legacy?.summary === 'string' ? legacy.summary : '');

  const decide = async (approve: boolean) => {
    if (!approval || busy) return;
    setBusy(true);
    setError('');
    try {
      await onDecide(approval.id, approve);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };

  const badge = approved
    ? outcome?.isError
      ? 'Failed'
      : 'Approved'
    : declined
      ? 'Declined'
      : waiting
        ? 'Needs approval'
        : 'Ended';
  return (
    <Card
      heading={
        payload.connection && payload.title
          ? `${payload.connection} · ${payload.title}`
          : 'Connected service'
      }
      badge={badge}
    >
      {!!summary && (
        <Text style={[cardStyles.body, { color: theme.text }]}>{summary}</Text>
      )}
      {Object.entries(payload.arguments ?? {}).map(([key, value]) => (
        <View key={key}>
          <Text style={[cardStyles.small, { color: theme.muted }]}>{key}</Text>
          <Text style={[cardStyles.mono, { color: theme.text }]}>
            {display(value)}
          </Text>
        </View>
      ))}
      {approved && typeof outcome?.text === 'string' && (
        <Text
          style={[
            cardStyles.mono,
            { color: outcome.isError ? theme.danger : theme.text },
          ]}
          numberOfLines={12}
        >
          {outcome.text}
        </Text>
      )}
      {typeof outcome?.error === 'string' && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>
          {outcome.error}
        </Text>
      )}
      {!!error && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>{error}</Text>
      )}
      {waiting && (
        <>
          <View style={cardStyles.actions}>
            <CardButton
              primary
              label="Approve & run"
              busy={busy}
              onPress={() => void decide(true)}
            />
            <CardButton
              label="Decline"
              disabled={busy}
              onPress={() => void decide(false)}
            />
          </View>
          <Text style={[cardStyles.small, { color: theme.muted }]}>
            Nothing runs until you approve. These are the exact arguments.
          </Text>
        </>
      )}
    </Card>
  );
}
