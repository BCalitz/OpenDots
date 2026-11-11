import { useState } from 'react';
import { Text, View } from 'react-native';
import type { ApprovalView } from '../lib/approvals';
import { useTheme } from '../lib/theme';
import { Card, CardButton, cardStyles } from './Card';

interface Draft {
  title: string;
  content: string;
  spaceId: string;
}
function parseDraft(value: unknown): Draft | null {
  const draft = value as Partial<Draft> | undefined;
  return typeof draft?.title === 'string' &&
    typeof draft.content === 'string' &&
    typeof draft.spaceId === 'string'
    ? { title: draft.title, content: draft.content, spaceId: draft.spaceId }
    : null;
}
function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// Mobile version of the web PageReviewCard. The draft shown is the server's
// copy; the server saves it only after the owner approves.
export function PageReviewCard({
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
  const draft = parseDraft(approval?.payload ?? args);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const outcome = result === undefined ? undefined : parse(result);
  const waiting = !outcome && approval?.status === 'pending' && running;
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';

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

  const badge =
    outcome?.approved === true
      ? 'Saved'
      : declined
        ? 'Declined'
        : waiting
          ? 'You decide'
          : 'Ended';
  return (
    <Card heading={draft?.title ?? 'Page draft'} badge={badge}>
      {draft && (
        <Text
          style={[cardStyles.body, { color: theme.text }]}
          numberOfLines={expanded ? undefined : 8}
          onPress={() => setExpanded((value) => !value)}
        >
          {draft.content}
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
        <View style={cardStyles.actions}>
          <CardButton
            primary
            label="Approve & save"
            busy={busy}
            disabled={!draft}
            onPress={() => void decide(true)}
          />
          <CardButton
            label="Decline"
            disabled={busy}
            onPress={() => void decide(false)}
          />
        </View>
      )}
    </Card>
  );
}
