# Connect Slack

Written for a bot that connects itself; a person can follow it too. The app uses socket mode, so the computer needs no public address.

1. Open https://api.slack.com/apps?new_app=1 in the browser on your screen. If Slack asks to sign in, ask the person to sign in there; they can take over the screen.
   If this computer has no screen, ask the person how they want to do it (your instructions, under the screen, say what each way costs): a virtual desktop they can watch over VNC, a browser-only tool such as agent-browser, or steps 1 to 4 in the browser on their own computer while you guide them. In the last case, give them the manifest with your name already in it, and ask for the two tokens with ask-secret in the terminal channel (step 5).
2. Choose **From a manifest**, pick the workspace, and paste [slack-app-manifest.yaml](slack-app-manifest.yaml). Change `name` and `display_name` to your own name first. Create the app.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the scope `connections:write` and generate. This is the app token (`xapp-…`).
4. **Install App → Install to workspace → Allow**. Some workspaces need an admin to approve; then ask the person. Copy the **Bot User OAuth Token** (`xoxb-…`).
5. Write both tokens to `slack.env` in the secrets folder (`~/.pots/secrets/`), readable only by this user:
   ```sh
   SLACK_APP_TOKEN=xapp-...
   SLACK_BOT_TOKEN=xoxb-...
   ```
   Do not put tokens in a chat message, a log or any other file. When the person copied the tokens, ask for them in the terminal channel instead:
   `call <terminal channel id> ask-secret {"text": "…", "file": "slack.env", "keys": ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]}`. `pots chat` writes them to this file without showing them to you.
6. Add the channel to `channels` in your `bot.json`:
   ```json
   { "id": "slack", "type": "slack", "secrets": "~/.pots/secrets/slack.env" }
   ```
   It connects within a few seconds. `pots status` lists it; if it fails, the reason is in `bot.json.error`.
7. You join only the places you are invited to. Ask the person to invite you to the right channels (`/invite @yourname`) or to send you a DM in Slack.

A second Slack workspace is a second channel entry with its own `id` (for example `slack-acme`) and its own env file.

## Sending

- Your text is Markdown; Slack shows it formatted.
- Send to a place to post in it, and to a person to post in a DM with them.
- Send to a message to reply to it. On Slack a reply is always in a thread: the reply goes in the message's thread, or starts a thread under the message when it has none.
- Send to a thread (the address of its first message) to post in the thread.
- `<slack:@U123>` in your text mentions that person, and `<slack:#C123>` links that channel. A bare `@name` stays as written.
- Each send carries its send ID in the message's metadata, so Pots finds the message again after a crash and does not post it twice.

## call

The `call` tool, with the channel's `id` (`slack`), calls any method of Slack's Web API (https://docs.slack.dev/reference/methods) with the bot token. The method is the method's name, and the params are its arguments. For example:

| method | params | does |
|---|---|---|
| `chat.update` | `{"channel": "C123", "ts": "1793080260.000100", "markdown_text": "fixed text"}` | edits your message |
| `conversations.history` | `{"channel": "C123", "limit": 20}` | reads the last 20 messages |
| `conversations.replies` | `{"channel": "C123", "ts": "1793080260.000100"}` | reads the thread of that message |
| `files.uploadV2` | `{"channel_id": "C123", "file": "/path/to/report.pdf", "filename": "report.pdf", "initial_comment": "the report"}` | posts a file: a `file` that is a local path is uploaded; add `thread_ts` to post it in a thread |

The IDs are in the addresses (`slack:#<channel ID>/<ts>`; a message's `ts` is its ID) and in the raw data in the log. The app has the scopes in [slack-app-manifest.yaml](slack-app-manifest.yaml); a method that needs another scope fails.

When someone uses a slash command or a button of the app, you get a `command` or `interaction` event, with Slack's data as its raw data.

## Files

The files of a message are saved for you, and the wake gives their paths. The message log keeps each file's `url_private`. Downloading it needs the bot token (scope `files:read`), so Pots downloads only from Slack's own hosts. To download a file again later, read the token in the shell, so that it stays out of messages and logs, and send it in the `Authorization` header:

```sh
. ~/.pots/secrets/slack.env
curl -sS -o plan.png -H "Authorization: Bearer $SLACK_BOT_TOKEN" "<url_private>"
```

Do not add `-L`: Slack's docs ask you to handle redirects on purpose, so that the token goes to no other host. If you get a web page instead of the file, the app does not have the `files:read` scope.

To send a file, use `files.uploadV2` with `call` (above).

## Limits

- A message can have at most 12,000 characters: your text goes as Slack's `markdown_text`, which has that limit. A longer text is refused, not cut: send it in parts.
- Slack generally lets an app post 1 message per second in a channel.
- React with the emoji's name, with or without colons: `eyes`, `:white_check_mark:`.
- After a time when you were not running, you get the messages that came in each place you are in, and the new replies in the threads you know and in new threads. Edits, deletions and reactions from that time do not come; a message comes as it is now.
- You get a `join` when someone joins a channel you are in, with who invited them when someone did. The app does not subscribe to `member_left_channel`, so a person who leaves gives no `leave`.
