import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../lib/theme';

export function Card({
  heading,
  badge,
  children,
}: {
  heading: string;
  badge: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.heading, { color: theme.text }]} numberOfLines={2}>
          {heading}
        </Text>
        <Text style={[styles.badge, { color: theme.muted }]}>{badge}</Text>
      </View>
      {children}
    </View>
  );
}

export function CardButton({
  label,
  onPress,
  primary,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={[
        styles.button,
        primary
          ? { backgroundColor: theme.accent }
          : { borderColor: theme.border, borderWidth: 1 },
        { opacity: disabled ? 0.5 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? theme.accentText : theme.text} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            { color: primary ? theme.accentText : theme.text },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export const cardStyles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: 'monospace', fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
});

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    marginVertical: 4,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  heading: { fontSize: 15, fontWeight: '600', flex: 1 },
  badge: { fontSize: 13 },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
