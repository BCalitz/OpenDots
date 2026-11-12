import { z } from 'zod';
import { ApiConnector, tool, type ApiCall } from './api.js';
import { OAuthApp, type OAuthClient } from './oauth.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 8000;

const emails = z.array(z.email()).min(1).max(20);
// Header values never contain line breaks, or a value could add headers.
const header = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (value: string) => {
  const clean = header(value);
  return /^[ -~]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean).toString('base64')}?=`;
};

/** An RFC 822 message, base64url encoded the way Gmail's API wants it. */
export function rawMessage(message: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}) {
  const lines = [
    `To: ${message.to.map(header).join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.map(header).join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    ...(message.inReplyTo
      ? [
          `In-Reply-To: ${header(message.inReplyTo)}`,
          `References: ${header(message.references ?? message.inReplyTo)}`,
        ]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.body).toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: Part & { headers?: { name: string; value: string }[] };
}
const headerOf = (message: Message, name: string) =>
  message.payload?.headers?.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  )?.value;
const summary = (message: Message) => ({
  id: message.id,
  threadId: message.threadId,
  from: headerOf(message, 'From'),
  to: headerOf(message, 'To'),
  subject: headerOf(message, 'Subject'),
  date: headerOf(message, 'Date'),
  snippet: message.snippet,
  unread: message.labelIds?.includes('UNREAD') ?? false,
});
const plainText = (part: Part | undefined): string => {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) {
    const found = plainText(child);
    if (found) return found;
  }
  return '';
};
const metadata =
  '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';

const fetchMessage = (call: ApiCall, id: string, format: string) =>
  call.json(
    `${API}/messages/${encodeURIComponent(id)}?format=${format}${format === 'metadata' ? metadata : ''}`,
  ) as Promise<Message>;

const tools = [
  tool({
    name: 'search_messages',
    title: 'Search mail',
    description:
      'Search the mailbox with Gmail search syntax (for example "from:ana is:unread newer_than:2d"). Returns sender, subject, date and a snippet.',
    readOnly: true,
    input: z.object({
      query: z.string().max(500).default(''),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    async run({ query, limit }, call) {
      const list = (await call.json(
        `${API}/messages?maxResults=${limit}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      )) as { messages?: { id: string }[] };
      return Promise.all(
        (list.messages ?? []).map(async ({ id }) =>
          summary(await fetchMessage(call, id, 'metadata')),
        ),
      );
    },
  }),
  tool({
    name: 'read_message',
    title: 'Read a message',
    description: 'Read one message by id, with its plain text body.',
    readOnly: true,
    input: z.object({ id: z.string().min(1).max(100) }),
    async run({ id }, call) {
      const message = await fetchMessage(call, id, 'full');
      return {
        ...summary(message),
        body: plainText(message.payload).slice(0, MAX_BODY),
      };
    },
  }),
  tool({
    name: 'create_draft',
    title: 'Save a draft',
    description:
      'Save a new email as a draft. Nothing is sent. The user can review and send it from Gmail.',
    readOnly: false,
    input: z.object({
      to: emails,
      cc: z.array(z.email()).max(20).optional(),
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(50_000),
    }),
    async run(input, call) {
      const draft = (await call.json(`${API}/drafts`, {
        body: { message: { raw: rawMessage(input) } },
      })) as { id: string };
      return { draftId: draft.id, saved: true };
    },
  }),
  tool({
    name: 'send_message',
    title: 'Send an email',
    description: 'Send a new email from this account.',
    readOnly: false,
    input: z.object({
      to: emails,
      cc: z.array(z.email()).max(20).optional(),
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(50_000),
    }),
    async run(input, call) {
      const sent = (await call.json(`${API}/messages/send`, {
        body: { raw: rawMessage(input) },
      })) as { id: string; threadId: string };
      return { sent: true, id: sent.id, threadId: sent.threadId };
    },
  }),
  tool({
    name: 'reply_to_message',
    title: 'Reply to a message',
    description:
      'Reply to a message by id, in the same conversation. It goes to the sender (or their reply-to address).',
    readOnly: false,
    input: z.object({
      id: z.string().min(1).max(100),
      body: z.string().min(1).max(50_000),
    }),
    async run({ id, body }, call) {
      const original = (await call.json(
        `${API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
      )) as Message;
      const replyTo =
        headerOf(original, 'Reply-To') ?? headerOf(original, 'From');
      const address = replyTo?.match(/<([^>]+)>/)?.[1] ?? replyTo?.trim();
      if (!address || !z.email().safeParse(address).success)
        throw new Error('The message has no address to reply to.');
      const subject = headerOf(original, 'Subject') ?? '';
      const messageId = headerOf(original, 'Message-ID');
      const sent = (await call.json(`${API}/messages/send`, {
        body: {
          threadId: original.threadId,
          raw: rawMessage({
            to: [address],
            subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
            body,
            inReplyTo: messageId,
            references: [headerOf(original, 'References'), messageId]
              .filter(Boolean)
              .join(' '),
          }),
        },
      })) as { id: string; threadId: string };
      return { sent: true, id: sent.id, threadId: sent.threadId };
    },
  }),
];

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];

export class GmailConnector extends ApiConnector {
  readonly kind = 'gmail';
  readonly label = 'Gmail';
  constructor(client?: OAuthClient, fetcher: typeof fetch = fetch) {
    super(
      client &&
        new OAuthApp(
          client,
          {
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: GMAIL_SCOPES,
            // Offline access plus consent is what makes Google return a refresh token.
            authorizeParams: { access_type: 'offline', prompt: 'consent' },
          },
          fetcher,
        ),
      tools,
      fetcher,
    );
  }
  protected async identity(call: ApiCall) {
    const profile = (await call.json(`${API}/profile`)) as {
      emailAddress: string;
    };
    return { name: profile.emailAddress, email: profile.emailAddress };
  }
}
