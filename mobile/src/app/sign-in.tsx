import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '../lib/api';
import { normalizeServer, useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

export default function SignIn() {
  const theme = useTheme();
  const { session, signIn } = useSession();
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (session) return <Redirect href="/" />;

  const connect = async () => {
    setError('');
    setBusy(true);
    try {
      const candidate = {
        server: normalizeServer(server),
        token: token.trim(),
      };
      // Proves both the address and the owner token before saving them.
      await api(candidate, '/state');
      await signIn(candidate);
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  const input = [
    styles.input,
    {
      color: theme.text,
      backgroundColor: theme.surface,
      borderColor: theme.border,
    },
  ];
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.background }]}
      behavior="padding"
    >
      <View style={styles.form}>
        <Text style={[styles.title, { color: theme.text }]}>
          Connect to your OpenDots server
        </Text>
        <Text style={[styles.help, { color: theme.muted }]}>
          Use the HTTPS address your server is reachable at, and the OWNER_TOKEN
          from its .env file.
        </Text>
        <Text style={[styles.label, { color: theme.muted }]}>Server</Text>
        <TextInput
          style={input}
          value={server}
          onChangeText={setServer}
          placeholder="https://dots.example.com"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        <Text style={[styles.label, { color: theme.muted }]}>Owner token</Text>
        <TextInput
          style={input}
          value={token}
          onChangeText={setToken}
          placeholder="24+ characters"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={() => void connect()}
        />
        {!!error && (
          <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>
        )}
        <Pressable
          style={[
            styles.button,
            { backgroundColor: theme.accent, opacity: busy ? 0.6 : 1 },
          ]}
          disabled={busy || !server.trim() || !token.trim()}
          onPress={() => void connect()}
        >
          {busy ? (
            <ActivityIndicator color={theme.accentText} />
          ) : (
            <Text style={[styles.buttonText, { color: theme.accentText }]}>
              Connect
            </Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center' },
  form: { paddingHorizontal: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 4 },
  help: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  label: { fontSize: 13, marginTop: 8 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { fontSize: 14, marginTop: 8 },
  button: {
    marginTop: 20,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
