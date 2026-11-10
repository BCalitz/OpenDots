import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// The server address and owner token live in the device keychain/keystore.
const SERVER_KEY = 'opendots.server';
const TOKEN_KEY = 'opendots.token';

export interface Session {
  server: string;
  token: string;
}
interface SessionState {
  session: Session | null;
  loading: boolean;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
}
const SessionContext = createContext<SessionState | null>(null);

export function normalizeServer(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  const url = new URL(
    /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter only the server address, without a path.');
  return url.origin;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void Promise.all([
      SecureStore.getItemAsync(SERVER_KEY),
      SecureStore.getItemAsync(TOKEN_KEY),
    ])
      .then(([server, token]) => {
        if (server && token) setSession({ server, token });
      })
      .finally(() => setLoading(false));
  }, []);
  const signIn = useCallback(async (value: Session) => {
    await SecureStore.setItemAsync(SERVER_KEY, value.server);
    await SecureStore.setItemAsync(TOKEN_KEY, value.token);
    setSession(value);
  }, []);
  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(SERVER_KEY);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setSession(null);
  }, []);
  const value = useMemo(
    () => ({ session, loading, signIn, signOut }),
    [session, loading, signIn, signOut],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value)
    throw new Error('useSession must be used inside SessionProvider.');
  return value;
}
