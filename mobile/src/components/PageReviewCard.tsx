import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  api,
  conversationPath,
  type PageReviewDraft,
  type ReviewedPage,
} from '../lib/api';
import type { Session } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Card, CardButton, cardStyles } from './Card';

function parseDraft(args: unknown): PageReviewDraft | null {
  const value = args as Partial<PageReviewDraft> | undefined;
  return typeof value?.title === 'string' &&
    typeof value.content === 'string' &&
    typeof value.spaceId === 'string'
    ? { title: value.title, content: value.content, spaceId: value.spaceId }
    : null;
}
const sameDraft = (page: ReviewedPage, draft: PageReviewDraft) =>
  !page.reviewDraft ||
  (page.reviewDraft.title === draft.title &&
    page.reviewDraft.content === draft.content &&
    page.reviewDraft.spaceId === draft.spaceId);

// Mobile version of the web PageReviewCard: approve saves the draft as a
// Space page through the server, then tells the Dot where it was saved.
export function PageReviewCard({
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
  respond?: (result: unknown) => Promise<void>;
}) {
  const theme = useTheme();
  const draft = parseDraft(args);
  const [saved, setSaved] = useState<ReviewedPage | null>();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const path = `${conversationPath(threadId)}/reviewed-page`;

  useEffect(() => {
    let active = true;
    void api<ReviewedPage | null>(
      session,
      `${path}/${encodeURIComponent(toolCallId)}`,
    )
      .then((value) => active && setSaved(value))
      .catch(() => active && setSaved(null));
    return () => {
      active = false;
    };
  }, [session, path, toolCallId]);

  let recorded: { approved?: boolean } = {};
  try {
    if (result) recorded = JSON.parse(result);
  } catch {
    // Non-JSON results show as ended.
  }
  const conflict = !!saved && !!draft && !sameDraft(saved, draft);

  const decide = async (approve: boolean) => {
    if (!respond || !draft || conflict || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      // A previous save may have committed even if its response never arrived.
      const page =
        saved ??
        (approve
          ? await api<ReviewedPage>(session, path, 'POST', {
              ...draft,
              toolCallId,
            })
          : null);
      if (!page) {
        await respond({
          approved: false,
          message: 'The owner declined this draft. Do not save it.',
        });
        return;
      }
      setSaved(page);
      await respond(
        page.deleted
          ? {
              approved: true,
              pageId: page.pageId,
              spaceId: page.spaceId,
              deleted: true,
              message:
                'The draft was saved, then the owner deleted the page. Do not link it.',
            }
          : {
              approved: true,
              pageId: page.id,
              spaceId: page.spaceId,
              url: `/#/spaces/${page.spaceId}/pages/${page.id}`,
            },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const badge =
    recorded.approved === true || (saved && !saved.deleted)
      ? 'Saved'
      : recorded.approved === false
        ? 'Declined'
        : result !== undefined
          ? 'Ended'
          : 'You decide';
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
      {conflict && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>
          This review was saved with a different draft. Ask for a new review.
        </Text>
      )}
      {!!error && (
        <Text style={[cardStyles.small, { color: theme.danger }]}>{error}</Text>
      )}
      {respond && result === undefined && saved !== undefined && !conflict && (
        <View style={cardStyles.actions}>
          <CardButton
            primary
            label={saved ? 'Continue' : 'Approve & save'}
            busy={busy}
            disabled={!draft}
            onPress={() => void decide(true)}
          />
          {!saved && (
            <CardButton
              label="Decline"
              disabled={busy}
              onPress={() => void decide(false)}
            />
          )}
        </View>
      )}
    </Card>
  );
}
