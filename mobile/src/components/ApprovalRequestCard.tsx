import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import type { ApprovalView } from '../lib/approvals';
import { useTheme } from '../lib/theme';
import { Card, CardButton, cardStyles } from './Card';

interface ApprovalRequest {
  title?: string;
  description?: string;
  output?: string;
  link?: { url: string; label?: string };
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
/** Same rule as the server: public http(s), or a page inside OpenDots. */
function linkTarget(url: string, server: string): string | null {
  if (url.startsWith('/#/')) return `${server}${url}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? url
      : null;
  } catch {
    return null;
  }
}

// Mobile version of the web ApprovalRequestCard: a Dot asking "may I?"
// with request_approval, showing what it will do and what it produced.
export function ApprovalRequestCard({
  result,
  approval,
  running,
  server,
  onDecide,
}: {
  args?: unknown;
  result?: unknown;
  approval?: ApprovalView;
  running: boolean;
  server: string;
  onDecide: (approvalId: string, approved: boolean) => Promise<unknown>;
}) {
  const theme = useTheme();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = (approval?.payload ?? {}) as ApprovalRequest;
  const outcome = result === undefined ? undefined : parse(result);
  const waiting = !outcome && approval?.status === 'pending' && running;
  const approved =
    outcome?.approved === true || approval?.status === 'approved';
  const declined =
    outcome?.status === 'declined' || approval?.status === 'declined';
  const target = request.link ? linkTarget(request.link.url, server) : null;

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

  return (
    <Card
      heading={request.title ?? 'Approval request'}
      badge={
        approved
          ? 'Approved'
          : declined
            ? 'Declined'
            : waiting
              ? 'Needs approval'
              : 'Ended'
      }
    >
      {!!request.description && (
        <Text style={[cardStyles.body, { color: theme.text }]}>
          {request.description}
        </Text>
      )}
      {!!request.output && (
        <Text
          style={[cardStyles.mono, { color: theme.text }]}
          numberOfLines={30}
        >
          {request.output}
        </Text>
      )}
      {!!target && (
        <Text
          style={[cardStyles.small, { color: theme.accent }]}
          onPress={() => void Linking.openURL(target)}
        >
          {request.link?.label ?? request.link?.url}
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
              label="Approve"
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
            The Dot waits for your answer before going ahead.
          </Text>
        </>
      )}
    </Card>
  );
}
