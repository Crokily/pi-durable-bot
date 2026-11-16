# Design: a Microsoft Teams channel

Status: design only, for the owner to decide. Goal approved 2026-11-16: a Teams channel built like the Slack, Discord
and Telegram channels. No product code yet.

Checked on 2026-11-16 against the packages on npm (`@microsoft/teams.apps` 2.2.1, `@microsoft/teams.api` 2.2.1,
`@microsoft/teams.cli` 3.1.0, `@chat-adapter/teams` 4.45.0, read from their source) and Microsoft's pages. Each
claim says where it comes from when it matters. **Unverified** marks what no page or source confirmed.

## In short

- Teams sends the bot its messages over a socket that the bot opens (Socket Mode), like Slack. The computer needs no
  public address. The Teams SDK does this; Chat SDK's Teams adapter does not.
- The person needs a work Microsoft 365 organisation with Teams. An admin turns on custom apps once (up to 24 h to take
  effect). The person signs in once with a device code that the bot gives them, and adds the app to a team or chat.
- The bot does the rest itself with Microsoft's Teams CLI: one command makes the app, its secret and the bot.
- Teams is weaker than Slack in three places: no proof that a missed event is sent again, reactions only on the bot's
  own messages, and files in channels need Microsoft Graph. Backfill through Graph covers the first for channels and
  group chats.
- We have no Teams organisation. Most of it can be tested without one (fakes and Microsoft's Agents Playground). Socket
  Mode itself, permissions, backfill and files cannot.

## What the person sees, step by step

1. "Connect Teams." The bot checks that the person has a work Microsoft 365 account with Teams. A personal or free Teams
   account cannot be used, and the bot says so.
2. If the person is not an admin, the bot writes a short note for their admin: turn on **Upload custom apps** (Teams
   admin center → Teams apps → Setup policies) and **custom apps** in Org-wide app settings. It can take up to 24 hours.
   The bot sets a timer and checks again later.
3. The bot sends: "Open https://microsoft.com/devicelogin and type ABCD-1234." The person signs in with their work
   account on their phone or computer. Nothing to install, no screen on the bot's computer.
4. The bot makes the app (about a minute), turns on what it needs, and sends an install link.
5. The person opens the link in Teams and chooses **Add to a team** (and picks a channel), **Add to a chat**, or just
   **Add** for a DM. Teams asks them to allow what the app reads: messages in this team or chat. They allow it.
6. The bot says hello in that place. From now on it reads every message there, without an @mention.
7. More teams or chats: the person adds the app there too. No more sign-in.

## Receiving

### Options

| | A. Socket Mode (Teams SDK) | B. HTTP webhook at Pots' public address |
|---|---|---|
| Public address | none | `publicUrl` (Tailscale Funnel, own domain). A Quick Tunnel's address changes at each start, so it does not fit. |
| Status at Microsoft | Preview (`@experimental` in the SDK). "Only recommended for use when developing agents", not for the app store, "currently only available for new bots" (SDK source, `socket-mode/types.d.ts`; teams.ts `examples/socket`). The CLI turns it on through the production Developer Portal. | Stable, the normal way. |
| Code | `new App({ socketMode: true })`. One socket per region (amer, emea, apac), reconnects by itself. | The same `App` with its HTTP server; it checks Microsoft's JWT. |
| Agents Playground | No (it calls an HTTP endpoint) | Yes |

The 2026-11-06 "enabled for production" date from our earlier notes is **unverified**: no page states it. The CLI
3.1.0 (released 2026-11-06) does set Socket Mode through the production portal.

**Recommendation: A, with B as a setting.** Socket Mode is the only way to keep "no public address", which every Pots
channel keeps today. A bot for the person's own organisation is not published to the store, so that limit does not
matter. Because it is a preview, the channel also takes `"mode": "http"` in its bot.json entry, which runs the same
handler on the page server at `<publicUrl>/teams/<channel id>`. The CLI switches an app between the two
(`teams app update --messaging-mode`).

### Store before acknowledging

In the SDK, an event comes in a frame. For a normal event, the SDK returns the acknowledgement **after** our handler has
run, with the handler's status (`buildAckReplyFrame`, "a failed handler surfaces as a non-200 ack"). For a click
(an `invoke`), the handler's answer goes back on the socket. So the handler does what the Slack channel does:
`await sink.receive(...)` first, then return. A failed store returns an error.

What Microsoft does with an error or a missing acknowledgement is **unverified**. No page says that Teams sends an event
again, or keeps events while the socket is down. Assume it does not: Teams over HTTP is known not to send again. So
treat the acknowledgement as polite, not as safety, and rely on backfill (below), as the Discord channel does.

The SDK must not do anything else with events: no automatic replies, no Chat SDK handlers. One handler on `activity`
stores every event and returns. Translation happens later, from the stored raw event, like the other channels.

### Clicks need an answer in time

A click on an Adaptive Card button (`invoke`, `adaptiveCard/action`) needs an answer from the bot within a few seconds,
or Teams shows an error. Pots stores the click, answers at once with a plain "OK" (status 200), and wakes the bot
straight away, as Slack and Telegram clicks do. The bot changes the card later with `call`.

### Backfill after a restart

| | Option | Cost |
|---|---|---|
| 1 | No backfill | Messages sent while Pots is down are lost. |
| 2 | Graph with RSC permissions, for channels and group chats | Free with the RSC permissions below; no admin. `GET /teams/{team}/channels/{channel}/messages` (and `/replies`), `GET /chats/{chat}/messages`, newer than the last logged message. Graph gives each message as it is now, with its edits, deletion and reactions. |
| 3 | Option 2, plus DMs | DMs have no RSC permission. Reading them needs `Chat.Read.All` with admin consent: a much wider right (every chat in the organisation). |

**Recommendation: 2.** Same rule as Slack: on start, read each known place from the last logged message; store oldest
first, with event IDs that dedupe against the live copies. DMs are not backfilled; the skill says so. Teams' message ID
is the same for the bot and for Graph in channels and group chats (**verify** on a real tenant). A 1:1 chat has a
different ID in Graph (`19:…@unq.gbl.spaces`) than for the bot (`a:…`), another reason to leave DMs out.

## What arrives, and what is lost

| Event | Comes? | Notes |
|---|---|---|
| message | yes | DMs: all. Channels and group chats: all with RSC (below), else only @mentions. Messages of other bots never come, even with RSC (Microsoft Learn, "receive all messages"). |
| edit | yes | `messageUpdate` / `editMessage` (SDK routes). Only the new text; no old text, no original time. |
| delete | yes | `messageDelete` / `softDeleteMessage`; also `undeleteMessage`. Which messages it covers is **unverified**. |
| reaction | partly | Only on the bot's **own** messages (Microsoft Learn, conversation events). Reactions on other messages are lost live; backfill sees them only as part of the message. |
| join / leave | yes | `conversationUpdate` with members added or removed; the bot's own install and removal as `installationUpdate`. |
| interaction | yes | Adaptive Card `Action.Execute` (an `invoke`) and `Action.Submit` (a message with a value). |
| form | yes, simpler | Inputs sit in the card itself, so a card is a form; its submit is a click with the values. Dialogs (Teams' pop-up forms, `task/fetch`) can come later through `pots form add`, like Slack. |
| files | partly | See Files. |
| typing, read receipts | no | Not needed. |

## Addresses

Only the adapter parses them. Teams IDs contain `:` and `@` but no `/`, so `/` separates parts, as in Discord.

```
place               <id>:#<conversation ID>                      teams:#19:abc@thread.tacv2   (channel; group chat 19:…@thread.v2; DM a:…)
message             <id>:#<conversation ID>/<message ID>         teams:#19:abc@thread.v2/1731800000000
thread (channel)    <id>:#<channel ID>/<root message ID>         a thread is its first message, as in Slack
message in a thread <id>:#<channel ID>/<root ID>/<message ID>
person              <id>:@<Microsoft Entra object ID>            teams:@6f1c…
```

- Channel events carry `;messageid=<root>` in the conversation ID; the adapter strips it into the thread part. Group
  chats and DMs have no threads.
- Person: the Entra object ID (`aadObjectId`) rather than the Bot Framework ID (`29:…`), because Graph uses it and it does
  not change. The adapter keeps the `29:` ID it has seen in the log's raw data; a DM to a person who never wrote to the
  bot needs `createConversation`, which takes the object ID (**verify**).
- Tenant: one channel entry is one bot in one organisation, so the tenant is in the env file, not in addresses.
- Team: Graph needs the team's ID (`channelData.team.aadGroupId`) for a channel. The adapter takes it from the raw events
  of that place, as Discord keeps a thread's parent.
- The service URL (where to send) comes with each event; the adapter takes it from the place's last event, with the
  region's default when none is known.

## Sending

### Options

| | A. Chat SDK Teams adapter for posting | B. Teams SDK to post, Chat SDK only to convert Markdown |
|---|---|---|
| How | Like Slack: `@chat-adapter/teams` posts. It runs its own Teams SDK `App`, built for webhooks. | The channel's one `App` (the one with the socket) posts with `app.api.conversations.activities(...)`. Chat SDK's Teams format helpers (`@chat-adapter/teams/format`: `markdownToTeamsHtml`, `teamsHtmlToMarkdown`) turn Markdown into Teams' HTML and back. |
| Tokens | Two `App`s with the same secret | One |
| Fit | Its receiving is skipped anyway; mentions it does not make (README: "does not generate mention entities"). | Same shape as the Discord channel (Discord SDK + Chat SDK's format converter). |

**Recommendation: B.** Chat SDK still does the formatting, as the project rule says; the Teams SDK does the transport,
because it already holds the socket and the token.

Details:

- The bot writes Markdown; it goes to Teams as HTML (`markdownToTeamsHtml`), and incoming HTML is logged as Markdown
  (`teamsHtmlToMarkdown`). How tables show is **unverified**; a large table goes in an Adaptive Card or a page. Message size limit about 28 KB (**verify**); a longer text is refused, not cut.
- Mentions: `<teams:@<object ID>>` becomes a Teams mention entity with `<at>Name</at>` and the name from the log. A bare
  `@name` stays as written, as on Slack.
- Send to a place, a thread (a reply in a channel thread), a message (reply in its thread), or a person (DM).
- **Send ID.** Teams has no field that comes back on a message (Slack has metadata, Discord a nonce). So `findSent`
  finds nothing, and a crash between Teams taking a message and Pots recording it can post it twice. Same limit as
  Telegram; the skill says so. (Graph could look for a hidden marker in recent messages; not worth it now.)
- Reactions: the API takes a small list (`like`, `heart`, `1f440_eyes`, `2705_whiteheavycheckmark`, `launch`,
  `1f4cc_pushpin` and others). The adapter maps emoji to these and refuses the rest with a clear error. Whether bots may
  react in every tenant today is **unverified**.
- Edit and delete the bot's own messages: through `call` (`updateActivity`, `deleteActivity`).
- Rate: 50 requests a second per app per organisation; in one conversation about 7 a second, 60 in 30 seconds, 1800 an
  hour (Microsoft Learn, rate limits). The adapter backs off on 429, 412, 502 and 504 with jitter, with the same
  bounded time as Slack.
- `call`: methods of the Bot Framework conversations API (`activities.create`, `activities.update`, `members.get`, …)
  with the bot token, plus `graph:GET /…` style calls for Graph with the app's token (what RSC allows).

### Buttons and forms

Adaptive Cards through `call`, as Block Kit on Slack. The skill teaches: `Action.Execute` buttons with `verb` and `data`
(their meaning), inputs in the card for a form, and "mark answered" by updating the card. Agents Playground shows
Adaptive Cards, so this part can be tested without a tenant.

## Files

| | Receive | Send |
|---|---|---|
| DM | The event has a short-lived `downloadUrl`; Pots saves the file at once (`fetchFile`). Needs `supportsFiles: true` in the manifest. | Teams' file consent card: the person accepts, then the bot uploads. Clumsy. |
| Channel, group chat | A link to SharePoint. Reading it needs Graph file rights (`Files.Read.All` or `Sites.Read.All`) with admin consent. | Upload to SharePoint with Graph (admin consent), then post a link. |
| Images pasted in a message | `contentUrl` on Microsoft's host, read with the bot token (only to Microsoft hosts, as Slack). | An image in an Adaptive Card. |

**Recommendation for v1:** save DM files and pasted images; in channels and group chats, give the bot the SharePoint
link and say in the skill that reading it needs an admin. To send a file, share it as a page link (pages skill), which
works everywhere without new rights. Admin-consented file rights are a later choice.

## Permissions

| | RSC (resource-specific consent) | Graph application permissions |
|---|---|---|
| Who grants | Whoever adds the app to a team or chat, at install (team owner or member, chat member; Microsoft's page is not consistent here) | An admin, once, for the whole organisation |
| Reach | Only the teams and chats the app is in | Every team and chat |
| Fits Pots | Yes: like "you join only the places you are invited to" on Slack | Too wide for v1 |

**Recommendation: RSC only**, set in the manifest with the CLI (`teams app rsc add <app> <name> --type Application`):

- `ChannelMessage.Read.Group`: all channel messages without @mention, and channel backfill.
- `ChatMessage.Read.Chat`: all group chat messages without @mention, and group chat backfill.
- `TeamMember.Read.Group`, `ChatMember.Read.Chat`: names of people.
- `ChannelSettings.Read.Group`: channel names.

An organisation can stop owners from granting RSC; then the bot sees only @mentions, and the skill says how to tell.

## How the bot connects it (the skill `skills/teams-channel/SKILL.md`)

Same shape as the Slack and Telegram skills. The CLI runs with `npx -y @microsoft/teams.cli@3 …` (no global install).

1. Check: the person has a work account with Teams; else stop and say why.
2. `teams login --device-code`: the CLI prints a link and a code. The bot sends them to the person in chat (they are not
   a secret by themselves, and work for 15 minutes). `teams status` then says whether custom app upload is allowed; if
   not, give the admin note and set a timer.
3. `teams app create --name "<bot name>" --messaging-mode socket --env ~/.pots/secrets/teams-<bot ID>.env --json`.
   The CLI writes `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` to the file itself, so the secret never passes through the
   bot or ask-secret. Then `chmod 600` the file (the CLI uses the default mode). These names are the ones the Teams SDK
   reads, so the env file keeps them. The bot must not print the file. Check the JSON for `socketMode: false`: then
   Socket Mode was refused, and the bot tells the person about the HTTP way.
4. RSC permissions (above) and `supportsFiles`, with `teams app rsc add` and `teams app manifest`.
5. bot.json:
   ```json
   { "id": "teams", "type": "teams", "secrets": "~/.pots/secrets/teams-<bot ID>.env" }
   ```
   With `"mode": "http"` for the fallback.
6. `teams app get <app> --install-link` → send the link. The person adds the app (step 5 of the person's view).
7. `teams app doctor <app>` when something fails.

If the person creates the app themselves in the Developer Portal instead, they give the three values with ask-secret
(`keys: ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]`), as on Slack.

A second organisation is a second entry (`teams-acme`) with its own env file (`teams-acme-<bot ID>.env`).

## Testing

| What | How | Tenant? |
|---|---|---|
| Translate, addresses, send, mentions, reactions, retries, backfill paging | Unit tests with a fake Bot Connector and a fake Graph (HTTP servers on localhost), like the fake Slack in `test/slack.test.ts`. The `App` takes `serviceUrl` and `skipAuth`. | no |
| Store before acknowledging, invoke answers | Feed frames to the handler; also inject a fake `ISocketConnection` (the SDK's own test seam) to check the ack comes after `sink.receive`. | no |
| End to end: messages, replies, cards, clicks, edits | Microsoft 365 Agents Playground (`npx @microsoft/m365agentsplayground`, `teamsapptester start`) against the channel in `"mode": "http"` on localhost. No account needed. | no |
| Socket Mode for real, RSC consent, all-messages delivery, Graph backfill, IDs matching between bot and Graph, deletes, reactions, files, admin policies, rate limits | Only in a real organisation | **yes** |

We have no organisation. The free Microsoft 365 developer sandbox is only for Visual Studio subscribers and partners.
The cheapest real one is a Microsoft 365 Business Basic trial (one month free, then a few dollars a user a month;
**verify** the current offer). Until then, the PR says plainly that the live parts are untested and marks the Teams
channel "preview" in the README.

## Open questions

1. Does Teams send an event again after an error or a missing acknowledgement, or keep events while the socket is down?
   (Assumed no; backfill covers channels and group chats.)
2. Socket Mode's future: preview now, "for development". If Microsoft removes or limits it, the HTTP setting stays.
3. Do bot and Graph message IDs match, and does `createConversation` take an Entra object ID for a new DM?
4. Who exactly can grant RSC at install (owner only, or members), and how often organisations turn it off.
5. Bot reactions: available in every tenant, and which emoji.
6. Message size limit and how Markdown tables show.
7. Should the bot run `teams logout` after setup? The CLI keeps the person's sign-in in its cache on the bot's computer
   (shared by all bots there). Later changes to the app (new permissions) need it again.

## Decisions for the owner

1. **Receiving:** Socket Mode by default with an HTTP setting (recommended), or HTTP only (needs a public address, but
   stable and testable with the Playground)?
2. **Backfill:** channels and group chats through RSC (recommended), none, or also DMs with admin-consented
   `Chat.Read.All`?
3. **Sending:** Teams SDK to post plus Chat SDK's format converter (recommended), or Chat SDK's Teams adapter to post?
4. **Files:** DM files and images in v1, channel files as links, sending as page links (recommended); or ask for admin
   file rights now?
5. **Sign-in:** keep the person's CLI sign-in after setup, or log out at the end of setup?
6. **Testing without a tenant:** ship as "preview" after fakes and the Playground, or wait until we pay for a Business
   Basic trial to test the live parts?
