import { TelegramAdapter, TelegramFormatConverter, type TelegramMessage } from "@chat-adapter/telegram";
import type { Logger, Message } from "chat";

/**
 * The Chat SDK Telegram adapter, used only to translate: a Telegram message to text (entities as Markdown, a sticker as
 * its emoji, a location as a line) and whether it addresses the bot. The channel does the rest itself: it polls, so an
 * update is stored before Telegram forgets it (the SDK keeps its progress in memory), and it posts, so no text is cut
 * (the SDK cuts a text over Telegram's limit).
 */
export class GatewayTelegramAdapter extends TelegramAdapter {
  /** me: the bot, from getMe. A reply to the bot's own message counts as a mention: that is how people address a bot. */
  constructor(token: string, me: { id: number; username: string }, logger: Logger) {
    super({ botToken: token, userName: me.username, mentionOnReply: true, logger });
    this._botUserId = String(me.id);
  }

  /** A Telegram message as text, with whether it mentions the bot. Not cached, unlike the SDK's parseMessage. */
  translate(message: TelegramMessage): Message<TelegramMessage> {
    return this.parseTelegramMessage(message, this.encodeThreadId({ chatId: String(message.chat.id), messageThreadId: message.message_thread_id }));
  }
}

const converter = new TelegramFormatConverter();

/** Markdown as Telegram's MarkdownV2, for a plain message, with every character Telegram reserves escaped. Not cut. */
export function markdownV2(markdown: string): string {
  return converter.fromMarkdown(markdown);
}
