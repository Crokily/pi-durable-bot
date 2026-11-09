---
name: slack-channel
description: Slack for a Pots bot. How to connect a Slack workspace yourself (the Slack app, its tokens, bot.json), send and edit messages, call Slack's Web API, files and limits, and how to post buttons, menus, tables and forms with Block Kit, get clicks and mark a question answered. Use when you connect Slack, or need more in Slack than plain text.
---

# Slack

## Connect

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

## Buttons, forms, tables and clicks

`send` posts Markdown text. For buttons, menus and tables, post the message yourself with `call` and Slack's [Block Kit](https://docs.slack.dev/block-kit/): method `chat.postMessage` ([reference](https://docs.slack.dev/reference/methods/chat.postMessage)), params `channel`, `blocks`, and a short `text`, which Slack shows in notifications. Add `thread_ts` to post in a thread. Leave out `markdown_text`: Slack does not take it with `blocks`. Put Markdown in a `markdown` block instead.

```json
{
  "channel": "C123",
  "text": "Where should I deploy release 4.2?",
  "blocks": [
    { "type": "markdown", "text": "Where should I deploy **release 4.2**?" },
    { "type": "actions", "block_id": "deploy-42", "elements": [
      { "type": "button", "action_id": "deploy:test", "value": "test", "text": { "type": "plain_text", "text": "Test" } },
      { "type": "button", "action_id": "deploy:prod", "value": "prod", "style": "danger", "text": { "type": "plain_text", "text": "Production" } }
    ] }
  ]
}
```

- **Buttons and menus** go in an `actions` block: [buttons](https://docs.slack.dev/reference/block-kit/block-elements/button-element), [select menus](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element), [checkboxes](https://docs.slack.dev/reference/block-kit/block-elements/checkboxes-element), [radio buttons](https://docs.slack.dev/reference/block-kit/block-elements/radio-button-group-element), overflow menus and date pickers. You choose each `action_id` and `value`, and they come back with the click, so make them say what the click means.
- **Tables** are a [`table` block](https://docs.slack.dev/reference/block-kit/blocks/table-block): `rows` of cells of type `raw_text`, `raw_number` or `rich_text`. A table larger than the limits below goes in a page (the pages skill).
- **Limits that bite** ([all blocks](https://docs.slack.dev/reference/block-kit/blocks)): 50 blocks in a message. 25 elements in an `actions` block. A button's text at most 75 characters (Slack may cut it after about 30), its `value` at most 2000, its `action_id` at most 255 and unique in its block. A select menu at most 100 options; checkboxes and radio buttons at most 10; an option's `value` at most 150 characters. A `section` text at most 3000 characters, and all `markdown` blocks of a message together at most 12,000. A table at most 100 rows of 20 cells, and at most 10,000 characters in all the table cells of a message. A `block_id` is unique in its message; give a block a new one when you change the message.
- When Slack refuses the blocks, the `call` error gives Slack's answer. Fix what it names and call again.

**When someone clicks.** Pots acknowledges the click to Slack at once, within the 3 seconds Slack allows, so the person sees no error. The click wakes you straight away, not through the judge and without waiting for more messages, as an `interaction` event on your message. The wake says which button (its `action_id`, `value` and text) and who clicked (their person address). Slack's whole payload is the event's raw data in the log.

**Mark the question answered.** Anyone who can see the message can click, and a click is not an answer until you decide it counts. Whose click counts, and what it means, is your call, as with messages. When it counts, change your message with `call` `chat.update` ([reference](https://docs.slack.dev/reference/methods/chat.update)): params `channel`, the `ts` of your message, and new `text` and `blocks`, for example the question and a line "✓ Test, chosen by <@U123>", without the `actions` block. Until you change it, the buttons stay, and a click days later still wakes you.

**Forms.** Slack opens a form (a modal) only within 3 seconds of a click, which is too soon for you, so you store the form first and Pots opens it:

1. `pots form add <name> <JSON>`, or `-` to read the JSON from stdin: a Slack [view](https://docs.slack.dev/reference/views/modal-views) of type `modal`, with a `title` (at most 24 characters), `submit`, and `blocks` (at most 100) with [`input` blocks](https://docs.slack.dev/reference/block-kit/blocks/input-block). Each input's `block_id` and `action_id` name its value in the answer. Pots sets `private_metadata` itself, to find your message again; leave it out. Adding a name in use replaces that form.
2. Post a button whose `action_id` is `form:<name>`, or `form:<name>:<extra>`. `<extra>` comes back with the answer, so one form serves many messages, for example `form:release-notes:4.2`.
3. Someone clicks, and Pots opens the form at once. When they submit it, you are woken at once with the form's name, `<extra>`, the submitted values and who submitted it.

`pots form list` shows your forms, and `pots form remove <name>` removes one.

```sh
pots form add release-notes - <<'EOF'
{"type": "modal", "title": {"type": "plain_text", "text": "Release notes"},
 "submit": {"type": "plain_text", "text": "Send"},
 "blocks": [{"type": "input", "block_id": "notes", "label": {"type": "plain_text", "text": "What changed?"},
             "element": {"type": "plain_text_input", "action_id": "text", "multiline": true}}]}
EOF
```

**Link previews.** Slack previews the links in a message by default, and its servers open each link to do so. `send` does not turn this off. When you send a page link, and always a password page link (the pages skill), post it with `call` `chat.postMessage` and `"unfurl_links": false, "unfurl_media": false` ([unfurling](https://docs.slack.dev/messaging/unfurling-links-in-messages)):

`call slack chat.postMessage {"channel": "C123", "text": "The plan: https://…/p/…/", "unfurl_links": false, "unfurl_media": false}`

## Files

The files of a message are saved for you, and the wake gives their paths. The message log keeps each file's `url_private`. Downloading it needs the bot token (scope `files:read`), so Pots downloads only from Slack's own hosts. To download a file again later, read the token in the shell, so that it stays out of messages and logs, and send it in the `Authorization` header:

```sh
. ~/.pots/secrets/slack.env
curl -sS -o plan.png -H "Authorization: Bearer $SLACK_BOT_TOKEN" "<url_private>"
```

Do not add `-L`: Slack's docs ask you to handle redirects on purpose, so that the token goes to no other host. If you get a web page instead of the file, the app does not have the `files:read` scope.

To send a file, use `files.uploadV2` with `call` (above).

## Limits

- Messages are in the log as Markdown: a link keeps its URL, and lists, code and emphasis stay.
- A message can have at most 12,000 characters: your text goes as Slack's `markdown_text`, which has that limit. A longer text is refused, not cut: send it in parts.
- Slack generally lets an app post 1 message per second in a channel.
- React with the emoji's name, with or without colons (`eyes`, `:white_check_mark:`), or with the emoji itself (👀), which Pots turns into its name.
- After a time when you were not running, you get the messages that came in each place you are in, and the new replies in the threads you know and in new threads. Edits, deletions and reactions from that time do not come; a message comes as it is now.
- You get a `join` when someone joins a channel you are in, with who invited them when someone did. The app does not subscribe to `member_left_channel`, so a person who leaves gives no `leave`.
