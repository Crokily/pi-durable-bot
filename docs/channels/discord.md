# Connect Discord

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

The `call` tool, with the channel's `id` (`discord`), calls any endpoint of Discord's REST API (https://discord.com/developers/docs) with the bot token. The method is the HTTP method and the path. The params are the query for GET and DELETE, and the JSON body for the others. For example:

| method | params | does |
|---|---|---|
| `POST /channels/123/messages/456/threads` | `{"name": "Release plan"}` | starts a thread on message 456 in channel 123 |
| `GET /channels/123/messages` | `{"limit": 20}` | reads the last 20 messages |
| `PATCH /channels/123/messages/456` | `{"content": "fixed text"}` | edits your message |
| `POST /channels/123/messages` | `{"content": "the report", "file": "/path/to/report.pdf"}` | posts a file: a `file` that is a local path is uploaded |

The IDs are in the addresses (`discord:#<channel ID>/<message ID>`) and in the raw data in the log.

When someone uses a command or a button of yours, you get an `interaction` event, and Discord is told that the answer comes later. Answer a command within 15 minutes, with the `application_id` and `token` from the event's raw data: method `PATCH /webhooks/<application_id>/<token>/messages/@original`, params `{"content": "…"}`.

## Limits

- A message can have at most 2000 characters. A longer text is refused, not cut: send it in parts.
- A send carries a nonce, so Discord does not post it twice when it is sent again after a crash. Discord checks this only for a few minutes; a resend after that posts a second copy.
- You get no events when people leave a server, and a join only from the server's welcome message, when the server posts one: Discord sends these events only with the Server Members intent, which this channel does not use.
- Discord's system messages, such as a pin, a new channel name or a boost, and thread starts and changes, are `system` events in the log, not messages; their text says what happened, and a pin is about the pinned message. One that came while you were not running is not read again.
- File URLs stop working after about a day. To download an old file again, get a new URL with `call`: method `POST /attachments/refresh-urls`, params `{"attachment_urls": ["<old URL>"]}`.
