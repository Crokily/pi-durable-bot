---
name: discord-channel
description: Discord for a Pots bot. How to connect a Discord bot yourself (the application, its token, inviting it to a server, bot.json), send and edit messages, threads, call Discord's REST API, files and limits, and how to post buttons, menus and forms (components and modals), get clicks and mark a question answered. Use when you connect Discord, or need more in Discord than plain text.
---

# Discord

## Connect

Written for a bot that connects itself; a person can follow it too. The bot connects to Discord's gateway, so the computer needs no public address.

1. Open https://discord.com/developers/applications in the browser on your screen. If Discord asks to sign in, ask the person to sign in there; they can take over the screen.
   If this computer has no screen, ask the person how they want to do it (your instructions, under the screen, say what each way costs): a virtual desktop they can watch over VNC, a browser-only tool such as agent-browser, or steps 1 to 5 and 8 in the browser on their own computer while you guide them. In the last case, ask for the token with ask-secret in the terminal channel (step 6).
2. **New Application**: give it your own name. Discord asks to agree to its Developer Terms of Service and Policy: ask the person whether they agree, and check the box only if they do. Create it. On **General Information**, copy the **Application ID**; you need it in step 5. It is not a secret.
3. **Bot → Reset Token**. Discord may ask for the person's password or a two-factor code; then ask the person. Copy the token. Discord shows it only once; if it is lost, reset it again.
4. On the same **Bot** page, under **Privileged Gateway Intents**, turn on **Message Content Intent** and save. Without it, Discord refuses the connection.
5. **OAuth2 → URL Generator**: check the scope `bot`, then these permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Attach Files, Embed Links. Copy the URL at the bottom. It is the same as this one, with your Application ID in it:
   ```
   https://discord.com/oauth2/authorize?client_id=<Application ID>&scope=bot&permissions=309237763136
   ```
   Adding a bot to a server needs the **Manage Server** permission there. Give the URL to a person who has it; they open it, pick the server, and choose **Authorize**. You are then in the server. Give the URL again for each other server.
6. Write the token to `discord.env` in the secrets folder (`~/.pots/secrets/`), readable only by this user:
   ```sh
   DISCORD_BOT_TOKEN=...
   ```
   Do not put the token in a chat message, a log or any other file. When the person copied the token, ask for it in the terminal channel instead:
   `call <terminal channel id> ask-secret {"text": "…", "file": "discord.env", "keys": ["DISCORD_BOT_TOKEN"]}`. `pots chat` writes it to this file without showing it to you.
7. Add the channel to `channels` in your `bot.json`:
   ```json
   { "id": "discord", "type": "discord", "secrets": "~/.pots/secrets/discord.env" }
   ```
   It connects within a few seconds. `pots status` lists it; if it fails, the reason is in `bot.json.error`.
8. So that nobody else can add you to their server: under **Installation**, set **Install Link** to **None** and save; then under **Bot**, turn off **Public Bot** and save. Discord refuses the second while the first is set. After this, only the person who owns the application can add you to another server, with the same URL.

You read every channel of a server that your role lets you see. A server's admins choose which channels those are. People can also send you a DM.

A second Discord bot is a second channel entry with its own `id` (for example `discord-shop`) and its own env file.

## Sending

- Send to a place to post in it, and to a person to post in a DM with them.
- Send to a message to reply to it: the reply goes in the message's channel, or in its thread when the message is in a thread.
- Send to a thread (the address of its first message) to post in the thread. A message with no thread gets a reply in its channel; a new thread is never made for you. To start one, use `call` (below).
- `<discord:@123>` in your text mentions that person, and `<discord:#123>` links that channel.

## call

The `call` tool, with the channel's `id` (`discord`), calls any endpoint of Discord's REST API (https://docs.discord.com/developers) with the bot token. The method is the HTTP method and the path. The params are the query for GET and DELETE, and the JSON body for the others. For example:

| method | params | does |
|---|---|---|
| `POST /channels/123/messages/456/threads` | `{"name": "Release plan"}` | starts a thread on message 456 in channel 123 |
| `GET /channels/123/messages` | `{"limit": 20}` | reads the last 20 messages |
| `PATCH /channels/123/messages/456` | `{"content": "fixed text"}` | edits your message |
| `POST /channels/123/messages` | `{"content": "the report", "file": "/path/to/report.pdf"}` | posts a file: a `file` that is a local path is uploaded |

The IDs are in the addresses (`discord:#<channel ID>/<message ID>`) and in the raw data in the log.

When someone uses a command or a button of yours, you get an `interaction` event, and Discord is told that the answer comes later. Answer a command within 15 minutes, with the `application_id` and `token` from the event's raw data: method `PATCH /webhooks/<application_id>/<token>/messages/@original`, params `{"content": "…"}`.

## Buttons, forms, tables and clicks

`send` posts text. For buttons and menus, post the message yourself with `call`: method `POST /channels/<channel ID>/messages` ([reference](https://docs.discord.com/developers/resources/message)) with `components` ([reference](https://docs.discord.com/developers/components/reference)). To reply to a message, add `"message_reference": {"message_id": "<message ID>"}`.

```json
{
  "content": "Where should I deploy release 4.2?",
  "components": [
    { "type": 1, "components": [
      { "type": 2, "style": 1, "label": "Test", "custom_id": "deploy:test" },
      { "type": 2, "style": 4, "label": "Production", "custom_id": "deploy:prod" }
    ] }
  ]
}
```

- A message has at most 5 action rows (type 1). A row holds up to 5 buttons (type 2) or one select menu. Button styles: 1 primary, 2 secondary, 3 success, 4 danger, 5 link (a `url` and no `custom_id`; a click on it does not reach you).
- `custom_id` is 1 to 100 characters and unique in the message. You choose it, and it comes back with the click, so make it say what the click means.
- A button's `label` is at most 80 characters. A string select menu (type 3, alone in its row) has at most 25 `options`, each with a `label` and a `value` of at most 100 characters; `min_values` and `max_values` (up to 25) let people choose several.
- Discord's newer layout, with the message flag `IS_COMPONENTS_V2` (32768), adds text, sections, containers, images and separators, up to 40 components in a message, but such a message cannot have `content` or `embeds` ([guide](https://docs.discord.com/developers/components/using-message-components)).
- **Tables**: Discord's Markdown has no tables. Send a small table as a code block with aligned columns, and a large one as a page (the pages skill).
- When Discord refuses the components, the `call` error gives Discord's answer. Fix what it names and call again.

**When someone clicks.** Pots answers the click at once, within the 3 seconds Discord allows: it tells Discord that the message may change later, so the person sees no error. The click wakes you straight away, not through the judge and without waiting for more messages, as an `interaction` event. The platform sends Pots only the clicks on your own buttons, also on a message the log does not have, such as an ephemeral one. The wake says which button or menu (its `custom_id`, and the values chosen in a menu) and who clicked (their person address). Discord's whole interaction is the event's raw data in the log.

**Mark the question answered.** Anyone who can see the message can click, and a click is not an answer until you decide it counts. Whose click counts, and what it means, is your call, as with messages. When it counts, change your message with `call` `PATCH /channels/<channel ID>/messages/<message ID>`: a new `content`, and `components` with the buttons `"disabled": true`, or `[]` to take them away. Until you change it, the buttons stay, and a click days later still wakes you.

**Forms.** Discord opens a form (a modal) only as the first answer to a click, within 3 seconds, which is too soon for you, so you store the form first and Pots opens it:

1. `pots form add <name> <JSON>`, or `-` to read the JSON from stdin: the `data` of a Discord modal ([reference](https://docs.discord.com/developers/interactions/receiving-and-responding)), with `custom_id`, `title` (at most 45 characters) and `components`: 1 to 5 [Label](https://docs.discord.com/developers/components/reference) components (type 18, `label` at most 45 characters), each holding one text input (type 4; `style` 1 for one line, 2 for several; up to 4000 characters), select menu, radio group, checkbox group or checkbox. Each one's `custom_id` names its value in the answer (Discord sends no labels back). Pots sets the modal's own `custom_id` to the button's, to find your message again, so yours is replaced. A name has letters, digits, `-` and `_`, at most 64 characters, and no `:`. Adding a name in use replaces that form.
2. Post a button whose `custom_id` is `form:<name>`, or `form:<name>:<extra>`. `<extra>` comes back with the answer, so one form serves many messages, for example `form:bug-report:4.2`.
3. Someone clicks, and Pots opens the form at once. The click itself does not wake you. When they submit the form, you are woken at once with the form's name, `<extra>`, the submitted values and who submitted it. If the form could not open (no form of that name is stored, it is not a Discord modal's data, or Discord refused it), the click wakes you with the reason. `pots form add` stores any JSON object; the form is checked only when it opens.

`pots form list` shows your forms, and `pots form remove <name>` removes one.

```sh
pots form add bug-report - <<'EOF'
{"custom_id": "bug-report", "title": "Report a bug", "components": [
  {"type": 18, "label": "What happened?", "component": {"type": 4, "custom_id": "what", "style": 2, "max_length": 1000}}]}
EOF
```

**Link previews.** Discord shows a preview (an embed) of the links in a message. `send` does not turn this off. When you send a page link, and always a password page link (the pages skill), post it with `call` and the message flag `SUPPRESS_EMBEDS`, which is 4:

`call discord POST /channels/123/messages {"content": "The plan: https://…/p/…/", "flags": 4}`

## Limits

- A message can have at most 2000 characters. A longer text is refused, not cut: send it in parts.
- A send carries a nonce, so Discord does not post it twice when it is sent again after a crash. Discord checks this only for a few minutes; a resend after that posts a second copy.
- You get no events when people leave a server, and a join only from the server's welcome message, when the server posts one: Discord sends these events only with the Server Members intent, which this channel does not use.
- Discord's system messages, such as a pin, a new channel name or a boost, and thread starts and changes, are `system` events in the log, not messages; their text says what happened, and a pin is about the pinned message. One that came while you were not running is not read again.
- File URLs stop working after about a day. To download an old file again, get a new URL with `call`: method `POST /attachments/refresh-urls`, params `{"attachment_urls": ["<old URL>"]}`.
