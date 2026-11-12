import { z } from 'zod';
import { ApiConnector, tool, type ApiCall, type ApiTool } from './api.js';
import { OAuthApp, type OAuthClient } from './oauth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_BODY = 8000;

export interface MicrosoftClient extends OAuthClient {
  /** Directory to sign in against. "common" accepts work and personal accounts. */
  tenant?: string;
}

/** Microsoft's OAuth client; Outlook and Teams differ only in the scopes they ask for. */
const microsoftApp = (
  client: MicrosoftClient,
  scopes: string[],
  fetcher: typeof fetch,
) => {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(client.tenant || 'common')}/oauth2/v2.0`;
  return new OAuthApp(
    client,
    {
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      scopes: ['offline_access', 'User.Read', ...scopes],
    },
    fetcher,
  );
};

abstract class MicrosoftConnector extends ApiConnector {
  constructor(
    client: MicrosoftClient | undefined,
    scopes: string[],
    tools: ApiTool[],
    fetcher: typeof fetch,
  ) {
    super(client && microsoftApp(client, scopes, fetcher), tools, fetcher);
  }
  protected async identity(call: ApiCall) {
    const me = (await call.json(`${GRAPH}/me`)) as {
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    };
    const email = me.mail ?? me.userPrincipalName ?? '';
    return { name: me.displayName ?? email, email };
  }
}

const path = (value: string) => encodeURIComponent(value);
const limit = z.number().int().min(1).max(50).default(15);
const addresses = (list: string[]) =>
  list.map((address) => ({ emailAddress: { address } }));
const emails = z.array(z.email()).min(1).max(20);
const person = (
  value: { emailAddress?: { name?: string; address?: string } } | undefined,
) =>
  value?.emailAddress
    ? `${value.emailAddress.name ?? ''} <${value.emailAddress.address ?? ''}>`.trim()
    : undefined;
// Chat and channel messages arrive as HTML.
const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();

interface MailMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { content?: string };
}
const mail = (message: MailMessage) => ({
  id: message.id,
  from: person(message.from),
  to: message.toRecipients?.map(person),
  subject: message.subject,
  received: message.receivedDateTime,
  snippet: message.bodyPreview,
  unread: message.isRead === false,
});
const MAIL_FIELDS =
  '$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead';

const outlookTools = [
  tool({
    name: 'search_messages',
    title: 'Search mail',
    description:
      'Search the mailbox by words. Leave the query empty for the newest messages. Returns sender, subject, time and a preview.',
    readOnly: true,
    input: z.object({ query: z.string().max(500).default(''), limit }),
    async run({ query, limit }, call) {
      // Graph does not allow ordering together with a search.
      const find = query.replace(/"/g, '').trim();
      const url = find
        ? `${GRAPH}/me/messages?$top=${limit}&${MAIL_FIELDS}&$search=${encodeURIComponent(`"${find}"`)}`
        : `${GRAPH}/me/messages?$top=${limit}&${MAIL_FIELDS}&$orderby=receivedDateTime desc`;
      const list = (await call.json(url)) as { value?: MailMessage[] };
      return (list.value ?? []).map(mail);
    },
  }),
  tool({
    name: 'read_message',
    title: 'Read a message',
    description: 'Read one message by id, with its text body.',
    readOnly: true,
    input: z.object({ id: z.string().min(1).max(500) }),
    async run({ id }, call) {
      const message = (await call.json(
        `${GRAPH}/me/messages/${path(id)}?${MAIL_FIELDS},body`,
        { headers: { Prefer: 'outlook.body-content-type="text"' } },
      )) as MailMessage;
      return {
        ...mail(message),
        body: (message.body?.content ?? '').slice(0, MAX_BODY),
      };
    },
  }),
  tool({
    name: 'list_events',
    title: 'List calendar events',
    description:
      'Events on the calendar between two times (ISO 8601, for example 2026-03-02T00:00:00Z). Times are returned in UTC.',
    readOnly: true,
    input: z.object({
      start: z.iso.datetime(),
      end: z.iso.datetime(),
      limit: limit.default(25),
    }),
    async run({ start, end, limit }, call) {
      const list = (await call.json(
        `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${limit}&$orderby=start/dateTime&$select=subject,start,end,location,organizer,isOnlineMeeting,onlineMeetingUrl`,
        { headers: { Prefer: 'outlook.timezone="UTC"' } },
      )) as {
        value?: {
          subject?: string;
          start?: { dateTime?: string };
          end?: { dateTime?: string };
          location?: { displayName?: string };
          organizer?: { emailAddress?: { name?: string; address?: string } };
          isOnlineMeeting?: boolean;
          onlineMeetingUrl?: string;
        }[];
      };
      return (list.value ?? []).map((event) => ({
        subject: event.subject,
        start: event.start?.dateTime,
        end: event.end?.dateTime,
        location: event.location?.displayName || undefined,
        organizer: person(event.organizer),
        online: event.isOnlineMeeting ? event.onlineMeetingUrl : undefined,
      }));
    },
  }),
  tool({
    name: 'create_draft',
    title: 'Save a draft',
    description:
      'Save a new email as a draft. Nothing is sent. The user can review and send it from Outlook.',
    readOnly: false,
    input: z.object({
      to: emails,
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(50_000),
    }),
    async run({ to, subject, body }, call) {
      const draft = (await call.json(`${GRAPH}/me/messages`, {
        body: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: addresses(to),
        },
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
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(50_000),
    }),
    async run({ to, subject, body }, call) {
      await call.json(`${GRAPH}/me/sendMail`, {
        body: {
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: addresses(to),
          },
          saveToSentItems: true,
        },
      });
      return { sent: true };
    },
  }),
  tool({
    name: 'reply_to_message',
    title: 'Reply to a message',
    description: 'Reply to the sender of a message, in the same conversation.',
    readOnly: false,
    input: z.object({
      id: z.string().min(1).max(500),
      body: z.string().min(1).max(50_000),
    }),
    async run({ id, body }, call) {
      await call.json(`${GRAPH}/me/messages/${path(id)}/reply`, {
        body: { comment: body },
      });
      return { sent: true };
    },
  }),
];

export class OutlookConnector extends MicrosoftConnector {
  readonly kind = 'outlook';
  readonly label = 'Outlook';
  constructor(client?: MicrosoftClient, fetcher: typeof fetch = fetch) {
    super(
      client,
      ['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read'],
      outlookTools,
      fetcher,
    );
  }
}

interface ChatMessage {
  id: string;
  createdDateTime?: string;
  from?: { user?: { displayName?: string } };
  body?: { content?: string };
  deletedDateTime?: string | null;
}
const chatMessage = (message: ChatMessage) => ({
  id: message.id,
  from: message.from?.user?.displayName,
  at: message.createdDateTime,
  text: plain(message.body?.content ?? '').slice(0, 2000),
});
const messages = (list: { value?: ChatMessage[] }) =>
  (list.value ?? []).filter((item) => !item.deletedDateTime).map(chatMessage);
const text = z.string().min(1).max(10_000);

const teamsTools = [
  tool({
    name: 'list_teams',
    title: 'List teams',
    description: 'The teams this account has joined.',
    readOnly: true,
    input: z.object({}),
    async run(_, call) {
      const list = (await call.json(`${GRAPH}/me/joinedTeams`)) as {
        value?: { id: string; displayName: string }[];
      };
      return (list.value ?? []).map(({ id, displayName }) => ({
        id,
        name: displayName,
      }));
    },
  }),
  tool({
    name: 'list_channels',
    title: 'List channels',
    description: 'The channels of a team.',
    readOnly: true,
    input: z.object({ teamId: z.string().min(1).max(200) }),
    async run({ teamId }, call) {
      const list = (await call.json(
        `${GRAPH}/teams/${path(teamId)}/channels`,
      )) as { value?: { id: string; displayName: string }[] };
      return (list.value ?? []).map(({ id, displayName }) => ({
        id,
        name: displayName,
      }));
    },
  }),
  tool({
    name: 'list_channel_messages',
    title: 'Read a channel',
    description: 'The latest messages in a team channel.',
    readOnly: true,
    input: z.object({
      teamId: z.string().min(1).max(200),
      channelId: z.string().min(1).max(200),
      limit,
    }),
    async run({ teamId, channelId, limit }, call) {
      return messages(
        (await call.json(
          `${GRAPH}/teams/${path(teamId)}/channels/${path(channelId)}/messages?$top=${limit}`,
        )) as { value?: ChatMessage[] },
      );
    },
  }),
  tool({
    name: 'list_chats',
    title: 'List chats',
    description: 'Recent one-to-one and group chats.',
    readOnly: true,
    input: z.object({ limit }),
    async run({ limit }, call) {
      const list = (await call.json(
        `${GRAPH}/me/chats?$top=${Math.min(limit, 50)}&$orderby=lastMessagePreview/createdDateTime desc`,
      )) as {
        value?: { id: string; topic?: string | null; chatType?: string }[];
      };
      return (list.value ?? []).map(({ id, topic, chatType }) => ({
        id,
        topic: topic ?? undefined,
        type: chatType,
      }));
    },
  }),
  tool({
    name: 'list_chat_messages',
    title: 'Read a chat',
    description: 'The latest messages in a chat.',
    readOnly: true,
    input: z.object({ chatId: z.string().min(1).max(200), limit }),
    async run({ chatId, limit }, call) {
      return messages(
        (await call.json(
          `${GRAPH}/me/chats/${path(chatId)}/messages?$top=${limit}`,
        )) as { value?: ChatMessage[] },
      );
    },
  }),
  tool({
    name: 'send_chat_message',
    title: 'Send a chat message',
    description: 'Send a message to a chat as this account.',
    readOnly: false,
    input: z.object({ chatId: z.string().min(1).max(200), text }),
    async run({ chatId, text }, call) {
      const sent = (await call.json(
        `${GRAPH}/me/chats/${path(chatId)}/messages`,
        { body: { body: { contentType: 'text', content: text } } },
      )) as { id: string };
      return { sent: true, id: sent.id };
    },
  }),
  tool({
    name: 'post_channel_message',
    title: 'Post in a channel',
    description: 'Post a new message in a team channel as this account.',
    readOnly: false,
    input: z.object({
      teamId: z.string().min(1).max(200),
      channelId: z.string().min(1).max(200),
      text,
    }),
    async run({ teamId, channelId, text }, call) {
      const sent = (await call.json(
        `${GRAPH}/teams/${path(teamId)}/channels/${path(channelId)}/messages`,
        { body: { body: { contentType: 'text', content: text } } },
      )) as { id: string };
      return { posted: true, id: sent.id };
    },
  }),
];

export class TeamsConnector extends MicrosoftConnector {
  readonly kind = 'teams';
  readonly label = 'Microsoft Teams';
  constructor(client?: MicrosoftClient, fetcher: typeof fetch = fetch) {
    super(
      client,
      [
        'Team.ReadBasic.All',
        'Channel.ReadBasic.All',
        'ChannelMessage.Read.All',
        'ChannelMessage.Send',
        'Chat.Read',
        'ChatMessage.Send',
      ],
      teamsTools,
      fetcher,
    );
  }
}
