import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import {
  discoveryCardModel,
  senderName,
  timeAgo,
  type ItemLink,
  type ParsedDiscoveryMessage,
  type RelatedItem,
} from '../lib/discovery-message';
import type { Session } from '../lib/session';
import { useTheme, type Theme } from '../lib/theme';

/** Outside text is shown as plain text, never as markdown. */
const LONG_TEXT = 320;

function ItemText({ text, theme }: { text: string; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  return (
    <>
      <Text selectable style={[styles.body, { color: theme.text }]}>
        {long && !open ? `${text.slice(0, LONG_TEXT).trimEnd()}…` : text}
      </Text>
      {long && (
        <Pressable onPress={() => setOpen((value) => !value)} hitSlop={8}>
          <Text style={[styles.action, { color: theme.accent }]}>
            {open ? 'Show less' : 'Show all'}
          </Text>
        </Pressable>
      )}
    </>
  );
}

function OriginalLink({
  href,
  theme,
}: {
  href: string | null | undefined;
  theme: Theme;
}) {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return (
    <Pressable onPress={() => Linking.openURL(href)} hitSlop={8}>
      <Text style={[styles.action, { color: theme.accent }]}>
        Open original ↗
      </Text>
    </Pressable>
  );
}

function RelatedRow({
  item,
  session,
  theme,
}: {
  item: RelatedItem;
  session: Session;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    summary: string;
    url: string | null;
  } | null>(null);
  const [error, setError] = useState('');
  const text = item.text ?? loaded?.summary;
  useEffect(() => {
    if (!open || item.text !== undefined || loaded || !item.id) return;
    const controller = new AbortController();
    api<{ event: { summary: string; url: string | null } }>(
      session,
      `/inbox/events/${encodeURIComponent(item.id)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => setLoaded(result.event))
      .catch((caught: Error) => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    return () => controller.abort();
  }, [open, item.id, item.text, loaded, session]);
  return (
    <View
      style={[
        styles.related,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text
          style={[styles.relatedTitle, { color: theme.text }]}
          numberOfLines={open ? undefined : 1}
        >
          {open ? '▾ ' : '▸ '}
          {item.title}
        </Text>
        <Text style={[styles.small, { color: theme.muted }]}>
          {senderName(item.from)} · {timeAgo(item.at)}
        </Text>
        {!!item.why && (
          <Text
            style={[styles.small, { color: theme.muted }]}
            numberOfLines={open ? undefined : 2}
          >
            {item.why}
          </Text>
        )}
      </Pressable>
      {open && (
        <View style={styles.relatedBody}>
          {text !== undefined ? (
            <ItemText text={text} theme={theme} />
          ) : (
            <Text style={[styles.small, { color: theme.muted }]}>
              {error || 'Loading…'}
            </Text>
          )}
          <OriginalLink href={item.link ?? loaded?.url} theme={theme} />
        </View>
      )}
    </View>
  );
}

/**
 * The message that started a discovery investigation, shown as a card: the
 * item, why it was flagged, and the earlier items it relates to. Same
 * content as the web app's card.
 */
export function DiscoveryCard({
  parsed,
  session,
}: {
  parsed: ParsedDiscoveryMessage;
  session: Session;
}) {
  const theme = useTheme();
  const { item } = parsed;
  const [links, setLinks] = useState<ItemLink[]>([]);
  useEffect(() => {
    if (!item.id) return;
    const controller = new AbortController();
    api<{ links: ItemLink[] }>(
      session,
      `/inbox/events/${encodeURIComponent(item.id)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => setLinks(result.links))
      // The card still shows what the message quoted.
      .catch(() => undefined);
    return () => controller.abort();
  }, [item.id, session]);
  const card = discoveryCardModel(parsed, links);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
      ]}
    >
      <View style={styles.chips}>
        <Text
          style={[
            styles.badge,
            { backgroundColor: theme.accent, color: theme.accentText },
          ]}
        >
          {card.followUp ? 'Follow-up' : 'Discovery'}
        </Text>
        {card.facts.map((fact) => (
          <Text
            key={fact}
            style={[
              styles.chip,
              { borderColor: theme.border, color: theme.muted },
            ]}
          >
            {fact}
          </Text>
        ))}
      </View>
      {!!card.reason && (
        <Text style={[styles.body, { color: theme.text }]}>{card.reason}</Text>
      )}
      {parsed.injection && (
        <Text style={[styles.small, { color: theme.danger }]}>
          ⚠ This item reads as trying to instruct an AI assistant. The Dot
          treats it as data only.
        </Text>
      )}
      <View
        style={[
          styles.item,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <View style={styles.fromRow}>
          <Text style={[styles.from, { color: theme.text }]} numberOfLines={1}>
            {card.sender}
          </Text>
          <Text style={[styles.small, { color: theme.muted }]}>
            {timeAgo(item.received)}
          </Text>
        </View>
        {!!card.address && (
          <Text style={[styles.small, { color: theme.muted }]}>
            {card.address}
          </Text>
        )}
        <Text style={[styles.title, { color: theme.text }]}>{item.title}</Text>
        <ItemText text={item.text} theme={theme} />
        {card.tags.length > 0 && (
          <View style={styles.chips}>
            {card.tags.map((tag) => (
              <Text
                key={`${tag.kind}:${tag.value}`}
                style={[
                  styles.tag,
                  { backgroundColor: theme.surfaceMuted, color: theme.muted },
                ]}
              >
                {tag.value}
              </Text>
            ))}
          </View>
        )}
        <View style={styles.actions}>
          <OriginalLink href={item.link} theme={theme} />
          <Pressable onPress={() => router.push('/inbox')} hitSlop={8}>
            <Text style={[styles.action, { color: theme.accent }]}>
              Show in Inbox
            </Text>
          </Pressable>
        </View>
      </View>
      {card.related.length > 0 && (
        <View style={styles.relatedList}>
          <Text style={[styles.section, { color: theme.muted }]}>
            Linked items ({card.related.length})
          </Text>
          {card.related.map((entry) => (
            <RelatedRow
              key={entry.key}
              item={entry}
              session={session}
              theme={theme}
            />
          ))}
        </View>
      )}
      {!!parsed.ask && (
        <Text style={[styles.small, { color: theme.muted }]}>
          Asked the Dot: {parsed.ask}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 12,
    gap: 10,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    fontSize: 12,
    fontWeight: '600',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  chip: {
    fontSize: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tag: {
    fontSize: 12,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  item: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  fromRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  from: { flex: 1, fontSize: 14, fontWeight: '600' },
  title: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 12, lineHeight: 17 },
  action: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 16, marginTop: 4 },
  section: { fontSize: 13, fontWeight: '600' },
  relatedList: { gap: 6 },
  related: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  relatedTitle: { fontSize: 14, fontWeight: '500' },
  relatedBody: { marginTop: 6, gap: 6 },
});
