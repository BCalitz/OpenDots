import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo push tokens look like ExponentPushToken[xxxxxxxx] or ExpoPushToken[...].
export const pushTokenSchema = z
  .string()
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/);
export const pushDeviceSchema = z
  .object({
    token: pushTokenSchema,
    platform: z.enum(['ios', 'android']),
  })
  .strict();
export type PushDevice = z.infer<typeof pushDeviceSchema> & {
  createdAt: number;
};
export interface PushMessage {
  title: string;
  body: string;
  // Opened by the mobile app when the notification is tapped.
  data: { threadId?: string; url?: string };
}
type ExpoTicket = {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};
const MAX_DEVICES = 20;

export class PushService {
  private db: DatabaseSync;
  constructor(
    path: string,
    private options: {
      accessToken?: string;
      previews?: boolean;
      fetch?: typeof fetch;
    } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, platform TEXT NOT NULL, createdAt INTEGER NOT NULL);`);
  }
  get previews() {
    return this.options.previews === true;
  }
  devices(): PushDevice[] {
    return this.db
      .prepare(
        'SELECT token, platform, createdAt FROM push_devices ORDER BY createdAt',
      )
      .all() as unknown as PushDevice[];
  }
  register(device: z.infer<typeof pushDeviceSchema>) {
    this.db
      .prepare(
        'INSERT INTO push_devices VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET platform=excluded.platform',
      )
      .run(device.token, device.platform, Date.now());
    // Keep the newest devices only; stale installs stop receiving pushes.
    this.db
      .prepare(
        'DELETE FROM push_devices WHERE token NOT IN (SELECT token FROM push_devices ORDER BY createdAt DESC LIMIT ?)',
      )
      .run(MAX_DEVICES);
  }
  remove(token: string) {
    this.db.prepare('DELETE FROM push_devices WHERE token=?').run(token);
  }
  // Sends to every registered device. Failures are reported, never thrown,
  // so a notification problem cannot fail the run that triggered it.
  async send(message: PushMessage): Promise<{ sent: number; failed: number }> {
    const devices = this.devices();
    if (!devices.length) return { sent: 0, failed: 0 };
    const requestFetch = this.options.fetch ?? fetch;
    try {
      const response = await requestFetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.options.accessToken
            ? { Authorization: `Bearer ${this.options.accessToken}` }
            : {}),
        },
        body: JSON.stringify(
          devices.map((device) => ({
            to: device.token,
            title: message.title,
            body: message.body,
            data: message.data,
            sound: 'default',
            priority: 'high',
            channelId: 'default',
          })),
        ),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.error(`Push service returned HTTP ${response.status}.`);
        return { sent: 0, failed: devices.length };
      }
      const { data } = (await response.json()) as { data?: ExpoTicket[] };
      let failed = 0;
      (data ?? []).forEach((ticket, index) => {
        if (ticket.status === 'ok') return;
        failed++;
        // The app was uninstalled or the token rotated.
        if (ticket.details?.error === 'DeviceNotRegistered')
          this.remove(devices[index].token);
      });
      return { sent: devices.length - failed, failed };
    } catch {
      // Do not log message content or tokens.
      console.error('Push notification delivery failed.');
      return { sent: 0, failed: devices.length };
    }
  }
  close() {
    this.db.close();
  }
}

const PREVIEW_LENGTH = 160;
export function scheduledResultMessage(
  push: PushService,
  dotName: string,
  threadId: string,
  outcome: { text: string } | { error: string },
): PushMessage {
  const failed = 'error' in outcome;
  const preview = (failed ? outcome.error : outcome.text)
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: failed
      ? `${dotName}: scheduled task failed`
      : `${dotName} has an update`,
    body: push.previews
      ? preview.length > PREVIEW_LENGTH
        ? `${preview.slice(0, PREVIEW_LENGTH - 1)}…`
        : preview || 'Open the conversation to see the result.'
      : 'Open the conversation to see the result.',
    data: { threadId },
  };
}
