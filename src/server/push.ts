import { sql, type Db } from './db/index.js';
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
/**
 * Notification categories the mobile app registers, each with its own
 * buttons: proposal (Prepare / Handle / Not now), proposal_prepare
 * (Prepare / Not now) and proposal_prepared (Handle / Not now).
 */
export type PushCategory =
  'proposal' | 'proposal_prepare' | 'proposal_prepared';
export interface PushMessage {
  title: string;
  body: string;
  // Opened by the mobile app when the notification is tapped. proposalId
  // lets the app send the owner's choice from a button.
  data: { threadId?: string; url?: string; proposalId?: string };
  /** Shows the category's buttons on the notification. */
  categoryId?: PushCategory;
}
type ExpoTicket = {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};
const MAX_DEVICES = 20;

export class PushService {
  constructor(
    private db: Db,
    private options: {
      accessToken?: string;
      previews?: boolean;
      fetch?: typeof fetch;
    } = {},
  ) {}
  get previews() {
    return this.options.previews === true;
  }
  devices(): Promise<PushDevice[]> {
    return this.db.rows<PushDevice>(
      sql`SELECT token, platform, created_at FROM push_devices ORDER BY created_at`,
    );
  }
  async register(device: z.infer<typeof pushDeviceSchema>) {
    await this.db.transaction(async () => {
      await this.db.run(
        sql`INSERT INTO push_devices VALUES (${device.token}, ${device.platform}, ${Date.now()}) ON CONFLICT (token) DO UPDATE SET platform=excluded.platform`,
      );
      // Keep the newest devices only; stale installs stop receiving pushes.
      await this.db.run(
        sql`DELETE FROM push_devices WHERE token NOT IN (SELECT token FROM push_devices ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`,
      );
    });
  }
  async remove(token: string) {
    await this.db.run(sql`DELETE FROM push_devices WHERE token=${token}`);
  }
  // Sends to every registered device. Failures are reported, never thrown,
  // so a notification problem cannot fail the run that triggered it.
  async send(message: PushMessage): Promise<{ sent: number; failed: number }> {
    const requestFetch = this.options.fetch ?? fetch;
    let devices: PushDevice[] = [];
    try {
      devices = await this.devices();
      if (!devices.length) return { sent: 0, failed: 0 };
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
            ...(message.categoryId ? { categoryId: message.categoryId } : {}),
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
      for (const [index, ticket] of (data ?? []).entries()) {
        if (ticket.status === 'ok') continue;
        failed++;
        // The app was uninstalled or the token rotated.
        if (ticket.details?.error === 'DeviceNotRegistered')
          await this.remove(devices[index].token);
      }
      return { sent: devices.length - failed, failed };
    } catch {
      // Do not log message content or tokens.
      console.error('Push notification delivery failed.');
      return { sent: 0, failed: devices.length };
    }
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
