import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  api,
  conversationPath,
  type ConnectionActionReceipt,
  type ConnectionActionResult,
  type PendingApproval,
} from '../lib/api';
import type { Session } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Card, CardButton, cardStyles } from './Card';

const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function parseArgs(args: unknown) {
  const value = args as { approvalId?: unknown; summary?: unknown } | undefined;
  return typeof value?.approvalId === 'string' &&
    typeof value.summary === 'string'
    ? { approvalId: value.approvalId, summary: value.summary }
    : null;
}

// Mobile version of the web ConnectionActionCard. It shows the server's stored
// record of what will run, and only the owner-only server route runs it.
export function ApprovalCard({
  session,
  threadId,
  toolCallId,
  args,
  result,
  respond,
}: {
  session: Session;
  threadId: string;
  toolCallId: string;
  args: unknown;
  result?: string;
  // Present only while the Dot is waiting on this card.
  respond?: (result: unknown) => Promise<void>;
}) {
  const theme = useTheme();
  const action = parseArgs(args);
  const [approval, setApproval] = useState<PendingApproval>();
  const [receipt, setReceipt] = useState<ConnectionActionReceipt | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!action?.approvalId) return;
    let active = true;
    void api<PendingApproval>(
      session,
      `${conversationPath(threadId)}/connection-approvals/${encodeURIComponent(action.approvalId)}`,
    )
      .then((value) => active && setApproval(value))
      .catch(
        (cause) =>
          active &&
          respond &&
          setError(
            cause instanceof Error ? cause.message : 'Could not load request.',
          ),
      );
    return () => {
      active = false;
    };
  }, [session, threadId, action?.approvalId, respond]);

  const running = receipt?.status === 'running';
  useEffect(() => {
    let active = true;
    const load = () =>
      api<ConnectionActionReceipt | null>(
        session,
        `${conversationPath(threadId)}/connection-actions/${encodeURIComponent(toolCallId)}`,
      )
        .then((value) => active && setReceipt(value))
        .catch(() => active && setReceipt(null));
    void load();
    const timer = running ? setInterval(() => void load(), 2000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session, threadId, toolCallId, running]);

  let recorded: { approved?: boolean } = {};
  try {
    if (result) recorded = JSON.parse(result);
  } catch {
    // Older or non-JSON results show as ended.
  }
  const mismatch =
    !!receipt && !!action && receipt.approvalId !== action.approvalId;
  const outcome = mismatch ? null : (receipt?.result ?? null);
  const approved = recorded.approved === true || receipt?.status === 'done';
  const declined = recorded.approved === false;
  const finished = result !== undefined;

  const decide = async (approve: boolean) => {
    if (!respond || !action || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (!approve && !outcome) {
        await respond({
          approved: false,
          message:
            'The owner declined this action. Do not perform it or try another way.',
        });
        return;
      }
      // A previous approval may have run even if its response never arrived.
      const value =
        outcome ??
        (await api<ConnectionActionResult>(
          session,
          `${conversationPath(threadId)}/connection-actions`,
          'POST',
          { toolCallId, approvalId: action.approvalId },
        ));
      setReceipt({
        approvalId: action.approvalId,
        status: 'done',
        result: value,
      });
      await respond({ approved: true, ...value });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not run this.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const badge = approved
    ? outcome?.isError
      ? 'Failed'
      : 'Approved'
    : declined
      ? 'Declined'
      : running
        ? 'Running'
        : finished
          ? 'Ended'
          : 'Needs approval';
  return (
    <Card
      heading={
        approval
          ? `${approval.connection} · ${approval.title}`
          : 'Connected service'
      }
      badge={badge}
    >
      <Text style={[cardStyles.body, { color: theme.text }]}>
        {action?.summary ?? 'Preparing the action…'}
      </Text>
      {approval &&
        Object.entries(approval.arguments).map(([key, value]) => (
          <View key={key}>
            <Text style={[cardStyles.small, { color: theme.muted }]}>
              {key}
            </Text>
            <Text style={[cardStyles.mono, { color: theme.text }]}>
              {display(value)}
            </Text>
          </View>
        ))}
      {mismatch && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>
          This card’s saved result belongs to a different approval request.
          Nothing was run for this one.
        </Text>
      )}
      {outcome && (
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
      {!!error && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>{error}</Text>
      )}
      {respond &&
        !finished &&
        !running &&
        !mismatch &&
        receipt !== undefined && (
          <View style={cardStyles.actions}>
            <CardButton
              primary
              label={outcome ? 'Continue' : 'Approve & run'}
              busy={busy}
              disabled={!action || (!outcome && !approval)}
              onPress={() => void decide(true)}
            />
            {!outcome && (
              <CardButton
                label="Decline"
                disabled={busy}
                onPress={() => void decide(false)}
              />
            )}
          </View>
        )}
      {respond && !finished && !approved && !declined && (
        <Text style={[cardStyles.small, { color: theme.muted }]}>
          Nothing runs until you approve. These are the exact arguments.
        </Text>
      )}
    </Card>
  );
}
