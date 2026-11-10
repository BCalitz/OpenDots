// Polyfills must run before Expo Router loads any screen.
import { randomUUID } from 'expo-crypto';

const cryptoGlobal = (globalThis.crypto ?? {}) as Crypto;
if (typeof cryptoGlobal.randomUUID !== 'function') {
  (cryptoGlobal as { randomUUID: () => string }).randomUUID = randomUUID;
  if (!globalThis.crypto)
    Object.defineProperty(globalThis, 'crypto', { value: cryptoGlobal });
}

import 'expo-router/entry';
