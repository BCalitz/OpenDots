import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const PREFIX = 'enc:v1:';

/**
 * Encrypts account secrets at rest (AES-256-GCM) with a key from the
 * environment, so a copy of the database alone does not hold working logins.
 * Without a key, secrets are stored as they were before encryption existed,
 * and a secret that was already sealed cannot be read.
 */
export class Sealer {
  private key?: Buffer;
  constructor(secret?: string) {
    if (secret) this.key = scryptSync(secret, 'opendots-secrets-v1', 32);
  }
  get enabled() {
    return !!this.key;
  }
  seal(value: string) {
    if (!this.key || value.startsWith(PREFIX)) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return (
      PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    );
  }
  open(value: string) {
    if (!value.startsWith(PREFIX)) return value;
    if (!this.key)
      throw new Error(
        'This account is encrypted. Set SECRETS_KEY to the key it was saved with.',
      );
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        raw.subarray(0, 12),
      );
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        'This account could not be decrypted. SECRETS_KEY is not the key it was saved with.',
      );
    }
  }
}
