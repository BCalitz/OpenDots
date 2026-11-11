import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApprovalCard } from '../../components/ApprovalCard';
import { ApprovalRequestCard } from '../../components/ApprovalRequestCard';
import { PageReviewCard } from '../../components/PageReviewCard';
import { api, type Conversation, type Workspace } from '../../lib/api';
import { isScheduledMessage, useConversation } from '../../lib/chat';
import type { Message } from '../../lib/thread-events';
import { useSession, type Session } from '../../lib/session';
import { useTheme } from '../../lib/theme';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, loading } = useSession();
  const theme = useTheme();
  const [conversation, setConversation] = useState<Conversation | null>();
  const [dotName, setDotName] = useState('');
  useEffect(() => {
    if (!session) return;
    let active = true;
    void api<Workspace>(session, '/workspace')
      .then((workspace) => {
        if (!active) return;
        const found = workspace.conversations.find((c) => c.id === id) ?? null;
        setConversation(found);
        setDotName(
          workspace.dots.find((dot) => dot.id === found?.dotId)?.name ?? '',
        );
      })
      .catch(() => active && setConversation(null));
    return () => {
      active = false;
    };
  }, [session, id]);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!session) return <Redirect href="/sign-in" />;
  return (
    <>
      <Stack.Screen options={{ title: conversation?.title ?? dotName ?? '' }} />
      {conversation === undefined ? (
        <ActivityIndicator style={{ flex: 1 }} />
      ) : conversation === null ? (
        <Text style={[styles.notice, { color: theme.muted }]}>
          This conversation is no longer available.
        </Text>
      ) : (
        <Chat
          session={session}
          threadId={conversation.id}
          dotName={dotName || 'Dot'}
        />
      )}
    </>
  );
}

const pagePrefix = /^From \[[^\]]*\]\([^)]*\):\n\n/;
const textOf = (message: Message) =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
      : '';

// Tool names from threads saved before approvals moved to the server.
const legacyReviewTool = 'review_space_page';
const legacyApprovalTool = 'request_connection_action';
const approvalRequestTool = 'request_approval';

function Chat({
  session,
  threadId,
  dotName,
}: {
  session: Session;
  threadId: string;
  dotName: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const chat = useConversation(session, threadId);
  const [draft, setDraft] = useState('');
  const list = useRef<FlatList<Message>>(null);
  const busy = chat.running;
  const waiting = useMemo(
    () =>
      Object.values(chat.approvals).filter(
        (approval) => approval.status === 'pending',
      ).length > 0 && chat.running,
    [chat.approvals, chat.running],
  );
  const results = useMemo(
    () =>
      new Map(
        chat.messages.flatMap((m) =>
          m.role === 'tool' ? [[m.toolCallId, m.content] as const] : [],
        ),
      ),
    [chat.messages],
  );
  const visible = chat.messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      (textOf(m).trim() || (m.role === 'assistant' && m.toolCalls?.length)),
  );
  const canSend = chat.ready && !chat.running && draft.trim().length > 0;

  const renderTool = (
    call: NonNullable<
      Extract<Message, { role: 'assistant' }>['toolCalls']
    >[number],
  ) => {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = undefined;
    }
    const approval = chat.approvals[call.id];
    const props = {
      args,
      result: results.get(call.id),
      approval,
      running: chat.running,
      onDecide: chat.decide,
    };
    if (
      approval?.kind === 'action' ||
      call.function.name === approvalRequestTool
    )
      return (
        <ApprovalRequestCard key={call.id} {...props} server={session.server} />
      );
    if (
      approval?.kind === 'connection_action' ||
      call.function.name === legacyApprovalTool
    )
      return <ApprovalCard key={call.id} {...props} />;
    if (
      approval?.kind === 'page_review' ||
      call.function.name === legacyReviewTool
    )
      return <PageReviewCard key={call.id} {...props} />;
    return (
      <Text key={call.id} style={[styles.tool, { color: theme.muted }]}>
        {results.has(call.id) ? '✓' : '…'}{' '}
        {call.function.name.replace(/_/g, ' ')}
      </Text>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // Android 15+ draws edge to edge, so the window no longer resizes for
      // the keyboard; pad on both platforms.
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      {!chat.ready && !chat.messages.length && !chat.connectionError ? (
        <ActivityIndicator style={{ flex: 1 }} />
      ) : !chat.ready && !chat.messages.length ? (
        <View style={styles.failed}>
          <Text style={[styles.notice, { color: theme.danger }]}>
            {chat.connectionError}
          </Text>
          <Pressable onPress={chat.retry}>
            <Text style={{ color: theme.accent, fontSize: 16 }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          ref={list}
          data={visible}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => list.current?.scrollToEnd()}
          ListEmptyComponent={
            <Text style={[styles.notice, { color: theme.muted }]}>
              Say hello to {dotName}.
            </Text>
          }
          ListFooterComponent={
            <>
              {busy && (
                <Text style={[styles.tool, { color: theme.muted }]}>
                  {dotName} is working…
                </Text>
              )}
              {!!(chat.error || chat.connectionError) && (
                <Text style={[styles.tool, { color: theme.danger }]}>
                  {chat.error || chat.connectionError}
                </Text>
              )}
            </>
          }
          renderItem={({ item }) =>
            item.role === 'user' ? (
              <View style={styles.userRow}>
                {isScheduledMessage(item) && (
                  <Text style={[styles.label, { color: theme.muted }]}>
                    Scheduled task
                  </Text>
                )}
                <View
                  style={[styles.bubble, { backgroundColor: theme.userBubble }]}
                >
                  <Text style={[styles.text, { color: theme.userText }]}>
                    {textOf(item).replace(pagePrefix, '')}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.assistant}>
                {!!textOf(item).trim() && (
                  <Text selectable style={[styles.text, { color: theme.text }]}>
                    {textOf(item)}
                  </Text>
                )}
                {item.role === 'assistant' && item.toolCalls?.map(renderTool)}
              </View>
            )
          }
        />
      )}
      <View
        style={[
          styles.composer,
          {
            borderTopColor: theme.border,
            backgroundColor: theme.surface,
            paddingBottom: Math.max(insets.bottom, 10),
          },
        ]}
      >
        <TextInput
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.surfaceMuted },
          ]}
          value={draft}
          onChangeText={setDraft}
          placeholder={
            waiting ? 'Answer the card above first' : `Message ${dotName}`
          }
          placeholderTextColor={theme.muted}
          multiline
        />
        {busy ? (
          <Pressable
            onPress={chat.stop}
            style={[styles.send, { backgroundColor: theme.surfaceMuted }]}
          >
            <Text style={{ color: theme.text, fontWeight: '600' }}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            disabled={!canSend}
            onPress={() => {
              const text = draft;
              setDraft('');
              // Put the text back if the server did not take it.
              chat.send(text).catch(() => setDraft(text));
            }}
            style={[
              styles.send,
              { backgroundColor: theme.accent, opacity: canSend ? 1 : 0.4 },
            ]}
          >
            <Text style={{ color: theme.accentText, fontWeight: '600' }}>
              Send
            </Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  messages: { padding: 16, gap: 12 },
  notice: { textAlign: 'center', marginTop: 40, fontSize: 15, padding: 16 },
  failed: { flex: 1, alignItems: 'center', gap: 12 },
  userRow: { alignItems: 'flex-end', gap: 4 },
  label: { fontSize: 12 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  assistant: { gap: 8 },
  text: { fontSize: 16, lineHeight: 23 },
  tool: { fontSize: 13, marginTop: 2 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
  },
  send: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
});
