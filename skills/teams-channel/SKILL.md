---
name: teams-channel
description: Microsoft Teams for a Pots bot (preview). How to connect Teams yourself with Microsoft's Teams CLI (the admin note, the person's device-code sign-in, the app, its permissions, the install link, bot.json), send and edit messages, call Teams' API and Microsoft Graph, files and limits, and how to post Adaptive Cards with buttons and inputs, get clicks and mark a question answered. Use when you connect Teams, or need more in Teams than plain text.
---

# Microsoft Teams (preview)

The Teams channel is a preview. It was tested with fakes of Microsoft's services and with Microsoft 365 Agents Playground, not yet in a real organisation. Not tested there: the live Socket Mode connection, the permissions people grant when they add the app (RSC consent), the backfill through Microsoft Graph, files, admins' policies and Teams' rate limits. Tell the person this before you connect, and tell the people who run Pots (https://github.com/Crokily/pi-durable-bot/issues) what you find.

## Connect

Written for a bot that connects itself. You run Microsoft's Teams CLI; the person only signs in on their phone or computer and adds the app in Teams. The CLI runs with npx, without a global install. In the commands below, `teams` stands for:

```sh
TEAMS_NO_INTERACTIVE=1 npx -y @microsoft/teams.cli@3.1.0 --disable-auto-update
```

By default Teams sends you events over a socket that you open (Socket Mode), so this computer needs no public address. Microsoft calls Socket Mode a preview, "recommended for developing agents"; that is fine for a bot of the person's own organisation, which is not published in Teams' store.

1. **The account.** Teams for a bot needs a work or school Microsoft 365 account with Teams. A personal Microsoft account or free Teams cannot add a custom app. Ask the person which they have; with a personal one, stop and say why.
2. **The person signs in.** Run `teams login --device-code` in the background with its output in a file, and read the file: the CLI prints a link (https://microsoft.com/devicelogin) and a code, then waits. Send both to the person in chat: "Open https://microsoft.com/devicelogin and type ABCD-1234, then sign in with your work account." The code alone is not enough to sign in, and it works for 15 minutes. When the command ends, `teams status --json` says `"loggedIn": true`.
3. **Custom apps allowed?** `teams status --json` also gives `tdp.sideloading`: `tenant` (the organisation lets custom apps be uploaded) and `user` (this person may). When either is `false`, the person needs their admin. Write them this note to forward:
   > Please allow custom apps for <person>: in the Teams admin center, Teams apps → Setup policies → (their policy) → turn on **Upload custom apps**; and Teams apps → Manage apps → Org-wide app settings → turn on **Custom apps**. It can take up to 24 hours.

   Set a timer (`pots wake`) to check `teams status --json` again later.
4. **Make the app.** One command makes the app, its bot, and its secret, and writes the secret to your env file itself, so it never passes through you:
   ```sh
   teams app create --name "<your name>" --messaging-mode socket --env ~/.pots/secrets/teams-<your bot ID>.env --json
   chmod 600 ~/.pots/secrets/teams-<your bot ID>.env
   ```
   Your bot ID is the name of your folder. The file gets `CLIENT_ID`, `CLIENT_SECRET` and `TENANT_ID`. Never print it or read it into a message. The JSON answer has `teamsAppId` (not a secret; write it in your notes, the next commands need it) and `socketMode`. When `socketMode` is `false`, read `socketModeError`, tell the person, and use HTTP mode (below).
5. **What the app reads.** Without these permissions you get only messages that @mention you in channels and group chats. Whoever adds the app to a team or a chat grants them for that team or chat (resource-specific consent, RSC):
   ```sh
   for permission in ChannelMessage.Read.Group ChatMessage.Read.Chat TeamMember.Read.Group ChatMember.Read.Chat ChannelSettings.Read.Group; do
     teams app rsc add <teamsAppId> $permission --type Application
   done
   teams app manifest update <teamsAppId> --set-json 'bots[0].supportsFiles=true'
   ```
   `supportsFiles` lets people send you files in a DM.
6. **bot.json.** Add the channel to `channels`:
   ```json
   { "id": "teams", "type": "teams", "secrets": "~/.pots/secrets/teams-<your bot ID>.env" }
   ```
   It connects within a few seconds. `pots status` lists it; if it fails, the reason is in `bot.json.error` or in the gateway's output.
7. **The install link.** `teams app get <teamsAppId> --install-link` prints it. Send it to the person. They open it in Teams and choose **Add to a team** (and a channel), **Add to a chat**, or **Add** for a DM with you. Teams asks them to allow what the app reads; they allow it. You get a `join` event: say hello there. For each other team or chat, they add the app there too; no more sign-in.
8. **Sign the person out.** When the app works: `teams logout`. The CLI keeps the person's sign-in on this computer, for every bot here, and nothing else needs it. A later change to the app (a new permission, HTTP mode) needs a new device-code sign-in (step 2), then `teams logout` again.

When something fails: `teams app doctor <teamsAppId>` checks the app, its bot and its permissions, and says what is wrong.

**HTTP mode.** When Socket Mode is refused or does not work, Teams can post to Pots' page server instead. That needs a public address that stays the same: `publicUrl` in `~/.pots/settings.json` (a Tailscale Funnel or a domain of the person's; a Cloudflare Quick Tunnel's address changes at each start, so it does not fit). The address is `<publicUrl>/channel/<your bot ID>/<channel id>`; the gateway prints it as `taking Teams requests` when the channel starts. Then:
```sh
teams app update <teamsAppId> --messaging-mode http --endpoint <publicUrl>/channel/<your bot ID>/teams
```
and add `"mode": "http"` to the channel's entry in bot.json. Pots checks Microsoft's signature on every request.

**Agents Playground** (only to try the channel on this computer, with no Microsoft account): an entry `{ "id": "teams-playground", "type": "teams", "mode": "http", "playground": true }` takes requests without Microsoft's signature, so it takes no `secrets` (an entry with them is refused) and never sends a token. It does not use the page server: it listens on 127.0.0.1 port 3978 (`"port"` sets another), at `/api/messages`, where the Playground sends by default, and refuses requests that came through a proxy or a tunnel. Run `npx -y @microsoft/m365agentsplayground -c msteams` (with `-e http://127.0.0.1:<port>/api/messages` for another port) and open the page it prints. Remove the entry when done.

If the person made the app themselves in the Teams Developer Portal, ask for the three values in the terminal channel instead: `call <terminal channel id> ask-secret {"text": "…", "file": "teams-<your bot ID>.env", "keys": ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]}`.

A second organisation is a second channel entry with its own `id` (for example `teams-acme`) and its own env file (`teams-acme-<your bot ID>.env`), and a second app made while signed in to that organisation.

## Sending

- Send to a place to post in it: a new post in a channel, a message in a group chat or a DM.
- Send to a thread (the address of a channel post), or to a message in a thread, to reply in that thread. Send to a channel post to reply in its thread. In a group chat or a DM, sending to a message posts in that chat.
- Send to a person (`teams:@<object ID>`) to post in a DM with them. Teams makes the DM when there is none; this works for people in the organisation who have the app (installed for them, or in a team or chat with it).
- You write Markdown; Pots sends it as Teams' Markdown. `<teams:@<object ID>>` in your text mentions that person by name. A bare `@name` stays as written.

## call

The `call` tool, with the channel's `id` (`teams`), calls Teams' Bot Connector API with the bot's token, or Microsoft Graph with the app's own token. The method is the HTTP method and the path; the params are the query for GET and DELETE, and the JSON body for the others.

| method | params | does |
|---|---|---|
| `POST /v3/conversations/<conversation ID>/activities` | an activity: `{"type": "message", "text": "…"}`, or with an Adaptive Card (below) | posts a message; it is logged as yours |
| `PUT /v3/conversations/<conversation ID>/activities/<message ID>` | the whole new activity | edits your message or card |
| `DELETE /v3/conversations/<conversation ID>/activities/<message ID>` | | deletes your message |
| `GET /v3/conversations/<conversation ID>/pagedmembers` | `{"pageSize": 100}` | lists the people of a chat or a team's channel |
| `graph:GET /teams/<team ID>/channels` | | the team's channels (needs the app in the team) |
| `graph:GET /chats/<chat ID>/messages` | `{"$top": 20}` | the last messages of a group chat |

In a channel, a reply in a thread is `/v3/conversations/<channel ID>;messageid=<root message ID>/activities`. The conversation, message and root IDs are in the addresses (`teams:#<conversation ID>/<root ID>/<message ID>`); a team's ID for Graph (`channelData.team.aadGroupId`) and everything else Teams sent are in the raw data in the log. Graph lets the app read only what its permissions (step 5) cover, and only in teams and chats where it was added.

## Buttons, forms, tables and clicks

`send` posts text. For buttons and inputs, post an Adaptive Card with `call` (https://adaptivecards.io/explorer/, version 1.5):

```json
{
  "type": "message",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard", "version": "1.5",
      "body": [
        { "type": "TextBlock", "text": "Where should I deploy release 4.2?", "wrap": true },
        { "type": "Input.Text", "id": "note", "label": "Note", "isMultiline": true }
      ],
      "actions": [
        { "type": "Action.Execute", "title": "Test", "verb": "deploy", "data": { "release": "4.2", "target": "test" } },
        { "type": "Action.Execute", "title": "Production", "verb": "deploy", "data": { "release": "4.2", "target": "prod" } }
      ]
    }
  }]
}
```

- `Action.Execute` buttons: `verb` and `data` come back with the click, so make them say what the click means. `Action.OpenUrl` opens a link and does not reach you.
- **Forms**: inputs (`Input.Text`, `Input.ChoiceSet`, `Input.Toggle`, `Input.Date`, …) sit in the card itself. Each one's `id` names its value; a click on any `Action.Execute` button sends the values with its `data`. So a card with inputs and a Submit button is a form. Teams' pop-up dialogs are not supported yet, and `pots form` is not for Teams.
- **Tables**: a small table in Markdown may show; a larger one goes in a card's `Table` element, or in a page (the pages skill).
- When Teams refuses the card, the `call` error says what Teams answered.

**When someone clicks.** Pots answers Teams at once (the person sees "OK" briefly) and wakes you straight away, not through the judge, as an `interaction` event: which button (its title and verb), its data with the input values, and who clicked. An older `Action.Submit` button comes the same way. The whole activity is the event's raw data.

**Mark the question answered.** Anyone who sees the card can click, and a click is not an answer until you decide it counts. When it counts, change the card with `call` `PUT /v3/conversations/<conversation ID>/activities/<message ID>`: the same card with the answer in a `TextBlock` and no `actions`. Until you change it, the buttons stay, and a click days later still wakes you.

## Files

- A file someone sends you in a DM, and an image pasted in a message, are saved as with other channels.
- A file in a channel or a group chat is a link to SharePoint. Reading it needs Graph file permissions (`Files.Read.All` or `Sites.Read.All`) that only an admin grants for the whole organisation; Pots does not ask for them. The wake gives the link; ask the person to send the file in a DM if you need it.
- To send a file, put it in a page and send the link (the pages skill). That works everywhere without more permissions.

## Limits

- A message can have about 28 KB (as UTF-8 bytes). A longer text is refused, not cut: send it in parts, or as a page.
- Teams keeps nothing of Pots' on a message, so if the computer stops between Teams taking a message you sent and Pots recording it, the message can go out twice.
- Reactions: Teams tells you only about reactions on your own messages. You can react with 👍 ❤️ 😆 😮 😢 😠 👀 ✅ 🚀 📌; other emoji are refused.
- You never get the messages of other bots, also with the permissions of step 5.
- When an organisation does not let owners grant the permissions of step 5, you get only messages that @mention you in channels and group chats. If people say you missed messages there, that is the likely reason: tell the person to ask their admin.
- After Pots was stopped, or the socket was down, Pots reads what it missed in channels and group chats from Microsoft Graph. DMs are not read again: that needs a permission for every chat of the organisation. Messages someone sent you in a DM while Pots was down are lost; Teams is not known to send events again.
- Teams takes about 7 messages a second, 60 in 30 seconds and 1800 an hour in one conversation. Pots waits and tries again when Teams says to slow down, for up to a minute.
