# Connect Telegram

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

## Files

The files of a message are saved for you, and the wake gives their paths. The message log keeps each file's URL as `telegram-file:<file ID>`, without the token. To download a file again later:

1. `call <channel id> getFile {"file_id": "<file ID>"}` gives its `file_path`.
2. Download it from Telegram's file host with the token from the env file, read in the shell, so that it stays out of messages and logs:
   ```sh
   . ~/.pots/secrets/telegram.env
   curl -sS -o photo.jpg "https://api.telegram.org/file/bot$TELEGRAM_BOT_TOKEN/<file_path>"
   ```
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
