---
name: telegram-channel
description: Telegram for a Pots bot. How to connect a Telegram bot yourself (BotFather, its token, groups, bot.json), topics, files and limits, and how to post buttons under a message (inline keyboards), get clicks, mark a question answered, and send tables. Use when you connect Telegram, or need more in Telegram than plain text.
---

# Telegram

## Connect

Written for a bot that connects itself; a person can follow it too. The bot gets its messages by long polling, so the computer needs no public address.

1. The person makes the Telegram bot in their own Telegram app. Only a Telegram account can make a bot, and you cannot use theirs. Ask them to open a chat with [@BotFather](https://t.me/BotFather), send `/newbot`, and give a name (what people see, for example your name) and a username that ends in `bot`. BotFather answers with the token (`123456789:AA…`).
2. In the same chat, ask them to send `/setprivacy`, choose the bot, and choose **Disable**. Without this, you get only the group messages that mention you, reply to you or are commands. The change counts only in groups the bot joins after it: in a group the bot is already in, they remove it and add it again.
3. Ask for the token with ask-secret in the terminal channel:
   `call <terminal channel id> ask-secret {"text": "…", "file": "telegram.env", "keys": ["TELEGRAM_BOT_TOKEN"]}`.
   `pots chat` writes it to `telegram.env` in the secrets folder (`~/.pots/secrets/`), readable only by this user, without showing it to you:
   ```sh
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```
   Do not put the token in a chat message, a log or any other file.
4. Add the channel to `channels` in your `bot.json`:
   ```json
   { "id": "telegram", "type": "telegram", "secrets": "~/.pots/secrets/telegram.env" }
   ```
   It connects within a few seconds. `pots status` lists it; if it fails, the reason is in `bot.json.error`. Only one process can get a bot's messages: when another one uses the same token, the gateway's output says so.
5. Ask the person to add you to their groups (the group's info → **Add members** → your username). To see reactions, you must be an admin of the group: Telegram sends reactions only to admins. To post in a Telegram channel, you must be an admin there.
6. You can write to a person only after they started a chat with you: they open `https://t.me/<your username>` and press **Start**. Until then, a send to them fails.

In a group with topics, each topic is a thread. A reply to a message in a topic stays in that topic. If that message was deleted, the reply can fail; then send to the topic or the group instead.

Turning topics on makes a group a supergroup, which is a new chat with a new address. The log has a system event in each of the two chats that gives the other's address, and a send to the old address fails with an error that gives the new one.

A second Telegram bot is a second channel entry with its own `id` (for example `telegram-shop`) and its own env file.

## call

The `call` tool, with the channel's `id` (`telegram`), calls any method of the Bot API (https://core.telegram.org/bots/api) with the bot token. The method is the method's name, and the params are its parameters. The chat ID is the number in a place address: `telegram:#-1001234567890`.

## Buttons, forms, tables and clicks

**Tables** need nothing more: `send` posts a rich message, and a Markdown table in your text shows as a table, with at most 20 columns. In a chat that does not take rich messages, it shows as plain text; a large table goes in a page (the pages skill).

**Buttons** go under a message as an inline keyboard. Post the message yourself with `call`: `sendMessage` ([reference](https://core.telegram.org/bots/api#sendmessage)) with `reply_markup.inline_keyboard` ([reference](https://core.telegram.org/bots/api#inlinekeyboardmarkup)), a list of rows, each a list of buttons. For rich formatting, use `sendRichMessage` with `"rich_message": {"markdown": "…"}` and the same `reply_markup`. In a topic, add `message_thread_id`.

`call telegram sendMessage {"chat_id": -1001234567890, "text": "Where should I deploy release 4.2?", "reply_markup": {"inline_keyboard": [[{"text": "Test", "callback_data": "deploy:test"}, {"text": "Production", "callback_data": "deploy:prod", "style": "danger"}]]}}`

- `callback_data` is 1 to 64 **bytes**, not characters ([reference](https://core.telegram.org/bots/api#inlinekeyboardbutton)): a few words or an ID, never a long text, and fewer letters in a script that takes several bytes a letter. You choose it, and it comes back with the click, so make it say what the click means.
- `style` is `primary`, `success` or `danger`. A button with a `url` instead of `callback_data` opens the link, and its click does not reach you.
- A chat has no menus or check boxes: give one button per choice, or a page for many choices.
- When Telegram refuses the message, the `call` error gives Telegram's answer. Fix what it names and call again.

**When someone clicks.** Pots answers the click to Telegram itself (`answerCallbackQuery`) at once, so the button stops spinning. Do not call `answerCallbackQuery` yourself: the click is answered already. The click wakes you straight away, not through the judge and without waiting for more messages, as an `interaction` event. The platform sends Pots only the clicks on your own buttons, also on a message the log does not have. The wake says which button (its `callback_data`) and who clicked (their person address). Telegram's callback query is the event's raw data in the log.

**Mark the question answered.** Anyone in a group can press the buttons, and a click is not an answer until you decide it counts. Whose click counts, and what it means, is your call, as with messages. When it counts, change your message with `call`:

- `editMessageReplyMarkup` ([reference](https://core.telegram.org/bots/api#editmessagereplymarkup)) changes only the buttons, for example to one disabled button that shows the answer: `{"chat_id": -1001234567890, "message_id": 42, "reply_markup": {"inline_keyboard": [[{"text": "✓ Test, chosen by @alice", "disabled": {}}]]}}`.
- `editMessageText` ([reference](https://core.telegram.org/bots/api#editmessagetext)) changes the text, with `chat_id`, `message_id` and `text`, or `rich_message` for a rich message. Give `reply_markup` with the buttons the message should keep.

Until you change it, the buttons stay, and a click days later still wakes you.

**Forms.** Telegram has no forms. Ask one short question in text; for several inputs, write a page (the pages skill) and send its link.

**Link previews.** Telegram shows a preview of a link in a message. When you send a page link, and always a password page link (the pages skill), post it with `call` `sendMessage` and `"link_preview_options": {"is_disabled": true}` ([reference](https://core.telegram.org/bots/api#linkpreviewoptions)). `send` posts a rich message, which has no such option, so send these links with `call`:

`call telegram sendMessage {"chat_id": -1001234567890, "text": "The plan: https://…/p/…/", "link_preview_options": {"is_disabled": true}}`

## Files

The files of a message are saved for you, and the wake gives their paths. The message log keeps each file's URL as `telegram-file:<file ID>`, without the token. To download a file again later:

1. `call <channel id> getFile {"file_id": "<file ID>"}` gives its `file_path`.
2. Download it from Telegram's file host with the token from its line of the env file, read in the shell, so that it stays out of messages and logs:
   ```sh
   curl -sS -o photo.jpg "https://api.telegram.org/file/bot$(grep '^TELEGRAM_BOT_TOKEN=' ~/.pots/secrets/telegram.env | cut -d= -f2-)/<file_path>"
   ```
   Never `source` the env file or `.` it in a shell, and never print the token: the file holds each value exactly as it was typed, and a value with `$(…)` in it would run as a command.
   The link works for at least an hour. Telegram gives bots files of at most 20 MB.

To send a file, give its local path to `call`: `call <channel id> sendDocument {"chat_id": -1001234567890, "document": "/path/to/report.pdf"}` (also sendPhoto, sendVideo, sendMediaGroup and the others). The chat ID is the number in a place address: `telegram:#-1001234567890`.

## Limits

- Your Markdown goes as a Telegram rich message, which shows headings, lists and tables. A message has at most 32768 characters of shown text. A longer text is refused, not cut: send it in parts.
- In a chat that does not take rich messages, the text goes as a plain message with simpler formatting, and then a message has at most 4096 characters. The send error says so; send the text in parts.
- The Bot API cannot read history. Messages that came while you were not running arrive when you connect again, but only from the last 24 hours.
- Telegram does not say when a message is deleted.
- Service messages, such as a pin, a new group name or a closed topic, are `system` events in the log, not messages; their text says what happened, and a pin is about the pinned message.
- If the computer stops between Telegram taking a message you sent and Pots recording it, the message can go out twice.
- You have at most one reaction on a message. A new one takes the place of the old one.
