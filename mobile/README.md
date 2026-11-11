# OpenDots mobile

An Expo / React Native app for iPhone and Android. It connects to your own OpenDots server and lets you:

- chat with your Dots, with streaming replies over the same `/api/chat` routes the web app uses;
- approve or decline connected-service actions (**Approve & run**) and page drafts (**Approve & save**);
- get a push notification when a scheduled task finishes or fails, and tap it to open that conversation.

Spaces and pages, Dot settings, connections, voice calls and the computer panel are still web-only.

## 1. Make the server reachable from your phone

The phone talks to the OpenDots server directly, so the server needs:

- an `OWNER_TOKEN` of at least 24 random characters (the app signs in with it);
- `HOST=0.0.0.0` (or another external interface);
- an HTTPS address. A tunnel works well, e.g. Cloudflare Tunnel or Tailscale Funnel pointing at port 4310.

Run the built app (`npm run build && npm start`), or `npm run dev` for development. The app only uses `/api`, so the web UI doesn't have to be exposed.

## 2. One-time Expo setup

```sh
cd mobile
npm install
npx eas-cli@latest login
npx eas-cli@latest init     # creates the Expo project and writes its projectId into app.json
```

Change `ios.bundleIdentifier` and `android.package` in `app.json` from `com.example.opendots` to an identifier you own before your first build.

Push notifications need credentials for each platform, uploaded once:

- **Android:** create a Firebase project, add an Android app with your package name, download `google-services.json` into `mobile/`, and set `"googleServicesFile": "./google-services.json"` under `android` in `app.json`. Then upload an FCM V1 service-account key with `npx eas-cli@latest credentials` (Android → Google Service Account → FCM V1).
- **iOS:** needs a paid Apple Developer account. `eas build` creates the push key for you when it asks.

## 3. Build and install

Remote push doesn't work in Expo Go, so use a development build:

```sh
npx eas-cli@latest build --profile development --platform android   # APK to install
npx eas-cli@latest build --profile development --platform ios       # register your iPhone first: eas device:create
npx expo start                                                     # then open the dev build on the phone
```

For a build you can share without the dev server, use `--profile preview`.

## 4. Sign in

Enter the server address and the owner token. The app checks them against `/api/state`, keeps them in the iOS Keychain / Android Keystore, and registers the phone for notifications. Use **••• → Send test notification** to check push end to end.

## Notifications

When a scheduled task runs, the server sends `{ title, body, data: { threadId } }` to every registered phone through Expo's push service, which relays it to Apple or Google. By default the body only says the Dot has an update. Set `PUSH_PREVIEWS=true` on the server to include the first 160 characters of the result. Disconnecting in the app removes the phone, and the server drops phones the push service reports as uninstalled.

To get notified about something like a task board: give a Dot an MCP connection to that service, start a conversation with it, and add a scheduled task there (for example "every 15 minutes, check for overdue high-priority tasks assigned to me; if there are any, summarise them and suggest what to do"). Scheduled runs can't use **Ask first** tools, so the Dot will ask you to continue in the conversation, where the approval card appears.

## Development

```sh
npm run typecheck
npx expo-doctor
```

The human-in-the-loop tool definitions in `src/lib/tools.ts` mirror the server's; `tests/mobile-tools.test.ts` at the repo root fails if they drift.
