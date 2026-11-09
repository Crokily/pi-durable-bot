import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as wait } from "node:timers/promises";
import type { TelegramCallbackQuery, TelegramChat, TelegramMessage, TelegramMessageReactionUpdated, TelegramUser } from "@chat-adapter/telegram";
import { defaultEmojiResolver, markdownToPlainText, parseMarkdown } from "chat";
import type {
  Address,
  ChannelAdapter,
  ChannelConfig,
  ChannelEnv,
  ChannelSink,
  FileInfo,
  Happening,
  PersonInfo,
  PlaceInfo,
  SentMessage,
} from "../../core/channel.ts";
import { expandHome, readSecrets } from "../../core/env-file.ts";
import { GatewayTelegramAdapter, markdownV2 } from "./sdk.ts";

// Addresses (only this file parses them):
//   place    <id>:#<chat ID>                telegram:#-1001234567890  (a group, a channel, or the private chat with a person)
//   message  <id>:#<chat ID>/<message ID>   telegram:#-1001234567890/42
//   person   <id>:@<user ID>                telegram:@123456789       (a chat that posts as itself, such as a channel: its chat ID)
// A thread is its first message: in a forum topic, the message that started the topic; outside topics, the message that
// a reply answers. A private chat has the ID of the person in it.

/** A message as this file reads it: the SDK's type, with the service fields used here. */
type TgMessage = TelegramMessage & {
  reply_to_message?: TgMessage;
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  forum_topic_created?: { name: string };
  /** In a group that became a supergroup: the supergroup's chat ID. */
  migrate_to_chat_id?: number;
  /** In a supergroup that was a group: the group's chat ID. */
  migrate_from_chat_id?: number;
  pinned_message?: { message_id: number };
  new_chat_title?: string;
  new_chat_photo?: unknown[];
  delete_chat_photo?: true;
  group_chat_created?: true;
  supergroup_chat_created?: true;
  channel_chat_created?: true;
  message_auto_delete_timer_changed?: { message_auto_delete_time: number };
  forum_topic_edited?: { name?: string };
  forum_topic_closed?: object;
  forum_topic_reopened?: object;
  general_forum_topic_hidden?: object;
  general_forum_topic_unhidden?: object;
  video_chat_scheduled?: object;
  video_chat_started?: object;
  video_chat_ended?: { duration: number };
  boost_added?: { boost_count: number };
  chat_background_set?: object;
};

/** A chat as this file reads it: the SDK's type, with whether a supergroup has topics. */
type TgChat = TelegramChat & { is_forum?: boolean };

/** The bot, from getMe. has_topics_enabled: its private chats have topics. */
type TgBot = TelegramUser & { has_topics_enabled?: boolean };

interface ChatMember {
  status: string;
  is_member?: boolean;
  user: TelegramUser;
}

/** An update as Telegram sends it, with the types this channel asks for. */
interface Update {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  message_reaction?: TelegramMessageReactionUpdated;
  my_chat_member?: { chat: TelegramChat; from: TelegramUser; date: number; old_chat_member: ChatMember; new_chat_member: ChatMember };
  callback_query?: TelegramCallbackQuery & { message?: TgMessage };
}

/**
 * What the inbox stores for this channel: an update as Telegram sent it, or a message this bot sent, by send (with its
 * send ID) or by call.
 */
type Raw = Update | { sent: TgMessage; sendId?: string };

/** A file of a message, as Telegram describes it. */
interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

/** Telegram's limit for the text of a rich message. */
const MAX_RICH = 32768;
/** Telegram's limit for the text of a plain message, counted after entities parsing. */
const MAX_TEXT = 4096;
/** message_reaction comes only when asked for, and only in chats where the bot is an admin. */
const UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "message_reaction", "my_chat_member", "callback_query"];
/** How long one getUpdates waits for new updates, in seconds. */
const POLL_SECONDS = 50;
/** How many entries each memory of this adapter (topics, people, chats) keeps; the oldest go first. */
const REMEMBER = 50_000;
/** Bot API parameters that take a file, and the field of an InputMedia that does. */
const FILE_FIELDS = new Set(["photo", "audio", "document", "video", "animation", "voice", "video_note", "sticker", "thumbnail", "cover", "media", "certificate"]);

/** apiUrl: Telegram's Bot API server. Only tests give another one, a fake server. */
export function createChannel(config: ChannelConfig, _env: ChannelEnv, apiUrl = "https://api.telegram.org"): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with TELEGRAM_BOT_TOKEN`);
  return new TelegramChannel(config.id, expandHome(config.secrets), apiUrl);
}

class TelegramChannel implements ChannelAdapter {
  readonly id: string;
  readonly #secrets: string;
  readonly #apiUrl: string;
  #token?: string;
  #bot?: TgBot;
  #sdk?: GatewayTelegramAdapter;
  #stopping?: AbortController;
  #polling?: Promise<void>;
  /** Where messages the bot sends with call are stored: Telegram does not send the bot its own messages. */
  #sink?: ChannelSink;
  /** The forum topic of messages seen since the start, by "<chat ID>/<message ID>", so that a reply stays in its topic. */
  readonly #topics = new Map<string, number>();
  /** People and chats seen since the start, by ID, and people by lowercase username, for mentions. */
  readonly #people = new Map<string, TelegramUser>();
  readonly #usernames = new Map<string, string>();
  readonly #chats = new Map<string, TgChat>();

  constructor(id: string, secrets: string, apiUrl: string) {
    this.id = id;
    this.#secrets = secrets;
    this.#apiUrl = apiUrl;
  }

  get me(): PersonInfo | undefined {
    const bot = this.#bot;
    return bot ? { address: this.person(String(bot.id)), name: bot.username ?? bot.first_name, realName: bot.first_name } : undefined;
  }

  async start(sink: ChannelSink): Promise<void> {
    this.#token = readSecrets(this.#secrets, ["TELEGRAM_BOT_TOKEN"]).TELEGRAM_BOT_TOKEN!;
    const bot = await this.#api<TgBot>("getMe").catch((error: unknown) => {
      // Telegram answers a token it does not know with 401 or 404.
      if (error instanceof TelegramError && (error.code === 401 || error.code === 404)) {
        throw new Error(`Telegram does not know the token in ${this.#secrets} (${error.message}); copy it again from @BotFather`);
      }
      throw error;
    });
    if (!bot.username) throw new Error("Telegram did not say the bot's username");
    this.#sdk = new GatewayTelegramAdapter(this.#token, { id: bot.id, username: bot.username }, quietLogger(sink.log));
    this.#bot = bot;
    this.#sink = sink;
    remember(this.#usernames, bot.username.toLowerCase(), String(bot.id));
    // getUpdates does not work while a webhook is set. The updates that wait are kept.
    await this.#api("deleteWebhook", { drop_pending_updates: false });
    const stopping = new AbortController();
    this.#stopping = stopping;
    this.#polling = this.#poll(sink, stopping.signal);
  }

  async stop(): Promise<void> {
    this.#stopping?.abort();
    await this.#polling;
  }

  /**
   * Long polling. Each update is stored before the next getUpdates asks for the ones after it: Telegram takes an update
   * as confirmed only when getUpdates asks from a higher offset, and keeps one that is not confirmed for up to 24 hours.
   * So an update that was not stored, because of a crash or a failed store, comes again.
   */
  async #poll(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let failures = 0;
    const pause = async (message: string, error: unknown) => {
      failures++;
      const retryAfter = error instanceof TelegramError ? error.retryAfter : undefined;
      const delay = retryAfter !== undefined ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** (failures - 1));
      sink.log(message, { error: error instanceof Error ? error.message : String(error), retryInSeconds: delay / 1000 });
      await wait(delay, undefined, { signal }).catch(() => {});
    };
    while (!signal.aborted) {
      let updates: Update[];
      try {
        const params = { ...(offset === undefined ? {} : { offset }), timeout: POLL_SECONDS, allowed_updates: UPDATES };
        updates = await this.#api<Update[]>("getUpdates", params, AbortSignal.any([signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)]));
      } catch (error) {
        if (signal.aborted) return;
        const conflict = error instanceof TelegramError && error.code === 409;
        await pause(conflict ? "another process gets this bot's updates with the same token, and only one can: stop it, or give this bot its own token" : "getting updates failed", error);
        continue;
      }
      try {
        for (const update of updates) {
          await sink.receive(`update:${update.update_id}`, update);
          if (update.callback_query) this.#answerCallback(sink, update.callback_query.id);
          offset = update.update_id + 1;
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        await pause("update not stored; Telegram gives it again with the next poll", error);
      }
    }
  }

  /**
   * Answer a button press as soon as it is stored, with no text: until it is answered, Telegram shows the button
   * loading. A press is answered once; Telegram refuses a second answer, so the bot shows a result with call instead
   * (editMessageText, editMessageReplyMarkup or sendMessage). A press given again after a crash is answered again, and
   * Telegram refusing that is only logged.
   */
  #answerCallback(sink: ChannelSink, id: string): void {
    void this.#api("answerCallbackQuery", { callback_query_id: id }).catch((error: unknown) =>
      sink.log("button press not answered", { error: error instanceof Error ? error.message : String(error) }),
    );
  }

  /** The Bot API cannot read history. What was missed comes with the first polls, from up to 24 hours back. */
  async backfill(): Promise<void> {}

  owns(address: Address): boolean {
    return address.startsWith(`${this.id}:`);
  }

  // ---- Addresses ----

  placeOf(address: Address): Address | undefined {
    const parsed = this.#parse(address);
    return "chat" in parsed ? this.place(parsed.chat) : undefined;
  }

  place(chat: string): Address {
    return `${this.id}:#${chat}`;
  }

  message(chat: string, message: number): Address {
    return `${this.id}:#${chat}/${message}`;
  }

  person(user: string): Address {
    return `${this.id}:@${user}`;
  }

  #parse(address: Address): { chat: string; message?: number } | { user: string } {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    const place = /^#(-?\d+)(?:\/(\d+))?$/.exec(rest);
    if (place) return { chat: place[1]!, ...(place[2] ? { message: Number(place[2]) } : {}) };
    const person = /^@(-?\d+)$/.exec(rest);
    if (person) return { user: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  // ---- Translate ----

  /** Telegram sends no event when a message is deleted, so there are no deletes. */
  async translate(value: unknown): Promise<Happening[]> {
    if (!this.#sdk) throw new Error(`channel ${this.id} is not started`);
    const raw = value as Raw;
    if ("sent" in raw) return [this.#message(raw.sent.edit_date ? "edit" : "message", raw.sent, raw.sendId)];
    const posted = raw.message ?? raw.channel_post;
    if (posted) return this.#posted(posted);
    const edited = raw.edited_message ?? raw.edited_channel_post;
    if (edited) return [this.#message("edit", edited)];
    if (raw.message_reaction) return this.#reactions(raw.message_reaction);
    if (raw.my_chat_member) return this.#membership(raw.my_chat_member);
    if (raw.callback_query) return [this.#interaction(raw.callback_query)];
    return [];
  }

  /**
   * A new message. A service message about people who came or left is a join or a leave; the bot's own come as
   * my_chat_member, with who did it. Other service messages, such as a pin or a new group name, are system events: a
   * notice from Telegram, not words someone wrote. A service message of a kind not known here is a message without
   * text; its raw says what it is.
   */
  #posted(m: TgMessage): Happening[] {
    const notice = this.#notice(m);
    if (notice !== undefined) return [this.#system(m, notice)];
    if (!m.new_chat_members && !m.left_chat_member) return [this.#message("message", m)];
    const others = (user: TelegramUser) => user.id !== this.#bot!.id;
    const joined = (m.new_chat_members ?? []).filter(others).map((user) => this.#member("join", m.chat, user, m.from, m.date * 1000, m));
    const left = m.left_chat_member && others(m.left_chat_member) ? [this.#member("leave", m.chat, m.left_chat_member, m.from, m.date * 1000, m)] : [];
    return [...joined, ...left];
  }

  /**
   * What a service message says, in words, or undefined when it is not one of these. A group becomes a supergroup
   * when, for example, topics are turned on: the supergroup is a new chat with a new ID, so a new address, and the group
   * takes no more messages. Telegram says so with a service message in each chat.
   */
  #notice(m: TgMessage): string | undefined {
    if (m.migrate_to_chat_id !== undefined) return `became a supergroup with a new address: ${this.place(String(m.migrate_to_chat_id))}`;
    if (m.migrate_from_chat_id !== undefined) return `was the group ${this.place(String(m.migrate_from_chat_id))}`;
    if (m.pinned_message) return "pinned a message";
    if (m.new_chat_title !== undefined) return `changed the name to "${m.new_chat_title}"`;
    if (m.new_chat_photo) return "changed the photo";
    if (m.delete_chat_photo) return "deleted the photo";
    if (m.group_chat_created || m.supergroup_chat_created) return "created the group";
    if (m.channel_chat_created) return "created the channel";
    if (m.message_auto_delete_timer_changed) {
      const seconds = m.message_auto_delete_timer_changed.message_auto_delete_time;
      return seconds ? `set new messages to be deleted after ${seconds} seconds` : "turned off deleting messages after a time";
    }
    if (m.forum_topic_edited) return m.forum_topic_edited.name ? `renamed the topic to "${m.forum_topic_edited.name}"` : "changed the topic's icon";
    if (m.forum_topic_closed) return "closed the topic";
    if (m.forum_topic_reopened) return "opened the topic again";
    if (m.general_forum_topic_hidden) return "hid the General topic";
    if (m.general_forum_topic_unhidden) return "showed the General topic again";
    if (m.video_chat_scheduled) return "scheduled a video chat";
    if (m.video_chat_started) return "started a video chat";
    if (m.video_chat_ended) return `ended the video chat after ${m.video_chat_ended.duration} seconds`;
    if (m.boost_added) return `boosted the group ${m.boost_added.boost_count === 1 ? "once" : `${m.boost_added.boost_count} times`}`;
    if (m.chat_background_set) return "changed the chat's background";
    return undefined;
  }

  /** A service message as a system event. A pin is about the message that was pinned. */
  #system(m: TgMessage, text: string): Happening {
    const chat = String(m.chat.id);
    this.#learnTopics(m);
    const thread = this.#threadOf(m);
    return {
      kind: "system",
      at: m.date * 1000,
      place: this.#place(m.chat),
      message: this.message(chat, m.pinned_message?.message_id ?? m.message_id),
      ...(thread ? { thread } : {}),
      // A service message on behalf of a chat (a channel, an anonymous admin, an upgraded group) names no person.
      ...(m.from && !m.sender_chat ? { person: this.#person(m.from) } : {}),
      fromMe: m.from?.id === this.#bot!.id && !m.sender_chat,
      text,
      raw: m,
    };
  }

  #message(kind: "message" | "edit", m: TgMessage, sendId?: string): Happening {
    const chat = String(m.chat.id);
    this.#learnTopics(m);
    const parsed = this.#sdk!.translate(m);
    const thread = this.#threadOf(m);
    // A message on behalf of a chat (a channel post, an anonymous admin) has that chat as its sender.
    const author = m.sender_chat ? this.#chatAsPerson(m.sender_chat) : m.from ? this.#person(m.from) : undefined;
    return {
      kind,
      at: (kind === "edit" ? (m.edit_date ?? m.date) : m.date) * 1000,
      place: this.#place(m.chat),
      message: this.message(chat, m.message_id),
      ...(thread ? { thread, threadRoot: thread } : {}),
      ...(author ? { person: author } : {}),
      fromMe: sendId !== undefined || m.from?.id === this.#bot!.id,
      mentionsMe: parsed.isMention === true,
      // A topic's first message is the service message that created it; its text is the topic's name.
      text: m.forum_topic_created?.name ?? parsed.text,
      mentions: this.#mentions(m),
      ...files(m),
      ...(sendId ? { sendId } : {}),
      raw: m,
    };
  }

  /**
   * The thread of a message. In a forum topic, it is the topic, as its first message. This holds also for a reply to
   * another message in the topic: Telegram shows each topic as its own conversation, and a message has one thread in
   * the log; what the reply answers is in its raw (reply_to_message). Outside topics, a reply's thread is the message it
   * answers, so the wake shows what it answers. Telegram's replies form chains, not threads: the thread of a reply to a
   * reply is the message it answers, not the first message of the chain.
   */
  #threadOf(m: TgMessage): Address | undefined {
    const chat = String(m.chat.id);
    if (m.is_topic_message && m.message_thread_id) return this.message(chat, m.message_thread_id);
    // Telegram gives reply_to_message only for a reply in the same chat.
    if (m.reply_to_message) return this.message(chat, m.reply_to_message.message_id);
    return undefined;
  }

  /** Remember the forum topic of a message and of the message it answers, for replies to them. */
  #learnTopics(m: TgMessage): void {
    for (const each of [m, m.reply_to_message]) {
      if (!each?.is_topic_message || !each.message_thread_id) continue;
      const chat = String(each.chat.id);
      remember(this.#topics, `${chat}/${each.message_id}`, each.message_thread_id);
      remember(this.#topics, `${chat}/${each.message_thread_id}`, each.message_thread_id);
    }
  }

  /** People the text mentions: with a text_mention (a person without a username), or with an @username seen before. */
  #mentions(m: TgMessage): Address[] {
    const text = m.text ?? m.caption ?? "";
    const people = new Set<string>();
    for (const entity of m.entities ?? m.caption_entities ?? []) {
      if (entity.type === "text_mention" && entity.user) people.add(String(entity.user.id));
      if (entity.type === "mention") {
        const user = this.#usernames.get(text.slice(entity.offset + 1, entity.offset + entity.length).toLowerCase());
        if (user) people.add(user);
      }
    }
    return [...people].map((user) => this.person(user));
  }

  /** Someone's reactions to a message changed: one happening per reaction added or removed. Bots' reactions do not come. */
  #reactions(r: TelegramMessageReactionUpdated): Happening[] {
    const key = (reaction: { type: string; emoji?: string; custom_emoji_id?: string }) =>
      reaction.type === "emoji" ? reaction.emoji! : reaction.type === "custom_emoji" ? `custom:${reaction.custom_emoji_id}` : reaction.type;
    const before = new Set(r.old_reaction.map(key));
    const after = new Set(r.new_reaction.map(key));
    const person = r.user ? this.#person(r.user) : r.actor_chat ? this.#chatAsPerson(r.actor_chat) : undefined;
    const common = {
      at: r.date * 1000,
      place: this.#place(r.chat),
      message: this.message(String(r.chat.id), r.message_id),
      ...(person ? { person } : {}),
      fromMe: false,
      raw: r,
    };
    return [
      ...[...after].filter((emoji) => !before.has(emoji)).map((text) => ({ kind: "reaction_added", ...common, text })),
      ...[...before].filter((emoji) => !after.has(emoji)).map((text) => ({ kind: "reaction_removed", ...common, text })),
    ];
  }

  /**
   * The bot was added to or removed from a chat, or, in a private chat, unblocked or blocked. Other changes, such as
   * becoming an admin, give nothing.
   */
  #membership(update: NonNullable<Update["my_chat_member"]>): Happening[] {
    const was = isMember(update.old_chat_member);
    const is = isMember(update.new_chat_member);
    if (was === is) return [];
    return [this.#member(is ? "join" : "leave", update.chat, update.new_chat_member.user, update.from, update.date * 1000, update)];
  }

  #member(kind: "join" | "leave", chat: TelegramChat, member: TelegramUser, by: TelegramUser | undefined, at: number, raw: unknown): Happening {
    const actor = by && by.id !== member.id ? this.#person(by) : undefined;
    const done = chat.type === "private" ? (kind === "join" ? "unblocked" : "blocked") : kind === "join" ? "added" : "removed";
    return {
      kind,
      at,
      place: this.#place(chat),
      person: this.#person(member),
      fromMe: (by ?? member).id === this.#bot!.id,
      ...(actor ? { text: `${done} by ${actor.name ?? actor.address} (${actor.address})` } : {}),
      raw,
    };
  }

  /**
   * A press on a button under a message (an inline keyboard), already answered when it was stored. The text names the
   * button: its label, found in the message's keyboard, and its callback_data.
   */
  #interaction(query: NonNullable<Update["callback_query"]>): Happening {
    const m = query.message;
    if (m) this.#learnTopics(m);
    const thread = m ? this.#threadOf(m) : undefined;
    const keyboard = (m as { reply_markup?: { inline_keyboard?: { text?: string; callback_data?: string }[][] } } | undefined)?.reply_markup?.inline_keyboard;
    const label = query.data === undefined ? undefined : keyboard?.flat().find((button) => button.callback_data === query.data)?.text;
    const button = `button${label !== undefined ? ` "${label}"` : ""} (callback_data ${query.data ?? "none"})`;
    return {
      kind: "interaction",
      // A button press carries no time.
      at: Date.now(),
      ...(m ? { place: this.#place(m.chat), message: this.message(String(m.chat.id), m.message_id) } : {}),
      ...(thread ? { thread } : {}),
      person: this.#person(query.from),
      fromMe: false,
      text: `clicked ${button}`,
      raw: query,
    };
  }

  #person(user: TelegramUser): PersonInfo {
    if (user.id === this.#bot?.id) return this.me!;
    remember(this.#people, String(user.id), user);
    if (user.username) remember(this.#usernames, user.username.toLowerCase(), String(user.id));
    const full = fullName(user);
    const name = user.username ?? full;
    return { address: this.person(String(user.id)), ...(name ? { name } : {}), ...(full && full !== name ? { realName: full } : {}) };
  }

  #chatAsPerson(chat: TelegramChat): PersonInfo {
    remember(this.#chats, String(chat.id), chat);
    const name = chat.title ?? chat.username;
    return { address: this.person(String(chat.id)), ...(name ? { name } : {}) };
  }

  #place(chat: TelegramChat): PlaceInfo {
    remember(this.#chats, String(chat.id), chat);
    const name = chat.title ?? (fullName(chat) || chat.username);
    return { address: this.place(String(chat.id)), kind: chat.type === "private" ? "dm" : "channel", ...(name ? { name } : {}) };
  }

  // ---- Send ----

  checkText(_to: Address, text: string): string | undefined {
    return tooLong(richLength(this.#outgoing(text)), MAX_RICH);
  }

  /**
   * The bot's Markdown as a rich message (Bot API 10.1). When Telegram does not take a rich message for this send, it
   * goes as a plain message with MarkdownV2, whose limit is lower. A text over the limit is refused, never cut.
   */
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const target = await this.#target(to);
    await this.#lookUp(text, target.chat);
    const markdown = this.#outgoing(text);
    const refused = tooLong(richLength(markdown), MAX_RICH);
    if (refused) throw new Error(refused);
    const params = {
      chat_id: target.chat,
      ...(target.topic ? { message_thread_id: target.topic } : {}),
      ...(target.reply ? { reply_parameters: { message_id: target.reply, ...(target.anyway ? { allow_sending_without_reply: true } : {}) } } : {}),
    };
    let sent: TgMessage;
    try {
      try {
        sent = await this.#api<TgMessage>("sendRichMessage", { ...params, rich_message: { markdown } });
      } catch (error) {
        if (!(error instanceof TelegramError && richNotTaken(error))) throw error;
        sent = await this.#sendPlain(params, markdown, error);
      }
    } catch (error) {
      if (error instanceof TelegramError && "user" in this.#parse(to) && (error.code === 403 || /chat not found/i.test(error.description))) {
        throw new Error(`${error.message}. A bot can write to a person only after they started a chat with it: they open the bot in Telegram and press Start.`);
      }
      if (error instanceof TelegramError && target.reply && /repl(y|ied)\b.*not found/i.test(error.description)) {
        throw new Error(`${error.message}. The message ${to} is gone; send to its place (${this.place(target.chat)}) or to its topic instead.`);
      }
      throw error;
    }
    const chat = String(sent.chat.id);
    return { message: this.message(chat, sent.message_id), place: this.place(chat), raw: { sent, sendId } satisfies Raw };
  }

  /**
   * A plain message with MarkdownV2, for a send Telegram did not take as a rich message (why). When Telegram cannot
   * read the MarkdownV2 either, the text goes without formatting, as the SDK does.
   */
  async #sendPlain(params: Record<string, unknown>, markdown: string, why: TelegramError): Promise<TgMessage> {
    const check = (length: number) => {
      if (length <= MAX_TEXT) return;
      throw new Error(
        `This chat does not take rich messages (${why.message}), so the text goes as a plain message, and Telegram allows at most ${MAX_TEXT} characters in one of those; this one has ${length}. Send it in parts.`,
      );
    };
    const formatted = markdownV2(markdown);
    check(shownLength(formatted));
    try {
      return await this.#api<TgMessage>("sendMessage", { ...params, text: formatted, parse_mode: "MarkdownV2" });
    } catch (error) {
      if (!(error instanceof TelegramError && /can't parse entities/i.test(error.description))) throw error;
      const plain = markdownToPlainText(markdown);
      check(plain.length);
      return await this.#api<TgMessage>("sendMessage", { ...params, text: plain });
    }
  }

  /**
   * Always undefined: the Bot API cannot read messages, so a sent message cannot be found again. When a crash comes
   * between Telegram taking a message and the outbox recording it, the message is sent again.
   */
  async findSent(): Promise<SentMessage | undefined> {
    return undefined;
  }

  /**
   * Where a send goes: a chat; a reply to a message; or the private chat with a person, which has the person's ID.
   * Telegram puts a reply in the forum topic of the message it answers. A send to a topic's first message is a message
   * in the topic, not a reply.
   * anyway: send also when the message replied to is gone (allow_sending_without_reply). Telegram then sends to the
   * topic given here, or to the chat's General topic. So only when this adapter knows the message's topic (it saw the
   * message since the start), or the chat has no topics; otherwise Telegram refuses, and the bot sends elsewhere.
   */
  async #target(to: Address): Promise<{ chat: string; reply?: number; topic?: number; anyway?: boolean }> {
    const parsed = this.#parse(to);
    if ("user" in parsed) return { chat: parsed.user };
    if (parsed.message === undefined) return { chat: parsed.chat };
    const topic = this.#topics.get(`${parsed.chat}/${parsed.message}`);
    if (topic === parsed.message) return { chat: parsed.chat, topic };
    if (topic) return { chat: parsed.chat, reply: parsed.message, topic, anyway: true };
    return { chat: parsed.chat, reply: parsed.message, anyway: (await this.#hasTopics(parsed.chat)) === false };
  }

  /**
   * Whether a chat has forum topics: a supergroup that is a forum, or a private chat when the bot has topics in them.
   * A chat this adapter has not seen is looked up once. Undefined when Telegram does not say.
   */
  async #hasTopics(chat: string): Promise<boolean | undefined> {
    // Only private chats have positive IDs.
    if (!chat.startsWith("-")) return this.#bot?.has_topics_enabled === true;
    let known = this.#chats.get(chat);
    if (!known) {
      try {
        known = await this.#api<TgChat>("getChat", { chat_id: chat });
        remember(this.#chats, chat, known);
      } catch {
        return undefined;
      }
    }
    return known.is_forum === true;
  }

  /** Person and place addresses in angle brackets, for #outgoing. */
  get #named(): RegExp {
    return new RegExp(`<${this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([@#])(-?\\d+)>`, "g");
  }

  /**
   * Person and place addresses in angle brackets become Telegram mentions: @username, or for a person without one, a
   * link that mentions them; a chat without a username becomes its title. Each line break stays a line break.
   */
  #outgoing(text: string): string {
    const named = text.replace(this.#named, (whole, sign: string, id: string) => {
      const user = sign === "@" && !id.startsWith("-") ? this.#people.get(id) : undefined;
      if (user) return user.username ? `@${user.username}` : `[${escapeMarkdown(fullName(user) || id)}](tg://user?id=${id})`;
      if (sign === "@" && !id.startsWith("-")) return `[${id}](tg://user?id=${id})`;
      const chat = this.#chats.get(id);
      return chat?.username ? `@${chat.username}` : chat?.title ? escapeMarkdown(chat.title) : whole;
    });
    return keepLineBreaks(named);
  }

  /** Look up the people and chats a text names that this adapter has not seen: a person as a member of the chat sent to. */
  async #lookUp(text: string, chat: string): Promise<void> {
    for (const [, sign, id] of text.matchAll(this.#named)) {
      const person = sign === "@" && !id!.startsWith("-");
      if (person ? this.#people.has(id!) : this.#chats.has(id!)) continue;
      try {
        if (person) this.#person((await this.#api<{ user: TelegramUser }>("getChatMember", { chat_id: chat, user_id: Number(id) })).user);
        else this.#place(await this.#api<TelegramChat>("getChat", { chat_id: id }));
      } catch {
        // Not found: the mention is written without a name.
      }
    }
  }

  /**
   * Set the bot's reaction on a message. A bot has at most one reaction on a message: a new one takes the place of the
   * old one, and remove takes it away, whichever emoji it is. A name such as :eyes: becomes its emoji.
   */
  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("chat" in parsed) || parsed.message === undefined) throw new Error(`not a message address: ${message}`);
    const reaction = remove ? [] : [{ type: "emoji", emoji: toEmoji(emoji) }];
    try {
      await this.#api("setMessageReaction", { chat_id: parsed.chat, message_id: parsed.message, reaction });
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      // Already as asked.
      if (/not modified/i.test(error.description)) return;
      if (/REACTION_INVALID/.test(error.description)) {
        throw new Error(`${error.message}: Telegram allows only some emoji as reactions, such as 👍 ❤ 🔥 🎉 🙏 👀 🤔 👌, and a chat can allow fewer`);
      }
      throw error;
    }
  }

  /**
   * Any Bot API method, with the token kept here, for example sendPhoto, getFile or pinChatMessage. A file parameter
   * (photo, document, …, or the media of an InputMedia) given as a local path ("/…", "C:\…" on Windows, or "~/…") is
   * uploaded; a file ID or a URL is passed on as it is.
   */
  /**
   * Call a Bot API method. A message it sends or edits (sendPhoto, sendMediaGroup, editMessageText…) is stored as the
   * bot's own, as Discord and Slack send theirs back; a store that fails is logged, and the call still succeeds.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const result = await this.#api(method, await withUploads(params));
    const isOwn = (value: unknown): value is TgMessage => {
      const m = value as TgMessage | undefined;
      return typeof m?.message_id === "number" && m.chat !== undefined && m.from?.id === this.#bot?.id;
    };
    for (const m of (Array.isArray(result) ? result : [result]).filter(isOwn)) {
      // Two edits in one second have the same edit_date, so an edit is told apart by what it holds.
      const edit = m.edit_date ? `:${m.edit_date}:${createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16)}` : "";
      const eventId = `call:${m.chat.id}:${m.message_id}${edit}`;
      await this.#sink?.receive(eventId, { sent: m } satisfies Raw).catch((error: unknown) => this.#sink?.log("sent message not stored", { method, event: eventId, error: String(error) }));
    }
    return result;
  }

  /**
   * The content of a file of a message: getFile, then Telegram's file host, with the token in the path as Telegram
   * wants it. The Bot API gives files of at most 20 MB.
   */
  async fetchFile(file: FileInfo, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const id = /^telegram-file:(.+)$/.exec(file.url ?? "")?.[1];
    if (!id) throw new Error(`not a Telegram file URL: ${file.url}`);
    const info = await this.#api<{ file_path?: string }>("getFile", { file_id: id }, signal);
    if (!info.file_path) throw new Error("Telegram gave no path for the file");
    const response = await fetch(`${this.#apiUrl}/file/bot${this.#token}/${info.file_path}`, { signal });
    if (!response.ok || !response.body) throw new Error(`Telegram's file host answered ${response.status} ${response.statusText}`);
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  /** Call a Bot API method. Too many requests (429): wait as long as Telegram says, up to a minute, and try twice more. */
  async #api<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    if (!this.#token) throw new Error(`channel ${this.id} is not started`);
    for (let attempt = 1; ; attempt++) {
      const json = !(params instanceof FormData);
      let response: Response;
      try {
        response = await fetch(`${this.#apiUrl}/bot${this.#token}/${method}`, {
          method: "POST",
          ...(json ? { headers: { "content-type": "application/json" } } : {}),
          body: json ? JSON.stringify(params) : params,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // fetch names the host in its cause, never the URL with the token.
        throw new Error(`Telegram ${method}: ${String((error as { cause?: unknown }).cause ?? error)}`);
      }
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number; migrate_to_chat_id?: number };
      };
      if (data.ok) return data.result as T;
      // A group that became a supergroup: Telegram gives the new chat ID only here, not in the description.
      const moved = data.parameters?.migrate_to_chat_id;
      const description = (data.description ?? `HTTP ${response.status}`) + (moved !== undefined ? `; its new address is ${this.place(String(moved))}` : "");
      const error = new TelegramError(method, data.error_code ?? response.status, description, data.parameters?.retry_after);
      if (error.code !== 429 || error.retryAfter === undefined || error.retryAfter > 60 || attempt === 3) throw error;
      await wait(error.retryAfter * 1000, undefined, signal ? { signal } : {});
    }
  }
}

/** An error answer of the Bot API. */
class TelegramError extends Error {
  readonly code: number;
  readonly description: string;
  /** Seconds to wait, for too many requests. */
  readonly retryAfter: number | undefined;

  constructor(method: string, code: number, description: string, retryAfter: number | undefined) {
    super(`Telegram ${method}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

function isMember(member: ChatMember): boolean {
  return ["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member === true);
}

function fullName(who: { first_name?: string; last_name?: string }): string {
  return [who.first_name, who.last_name].filter(Boolean).join(" ");
}

/**
 * The files of a message, with a name and type where Telegram gives none. The URL names the file by its ID, and
 * fetchFile understands it, so the URL never holds the token.
 */
function files(m: TgMessage): { files?: FileInfo[] } {
  const sticker = m.sticker?.is_video ? ["sticker.webm", "video/webm"] : m.sticker?.is_animated ? ["sticker.tgs", "application/x-tgsticker"] : ["sticker.webp", "image/webp"];
  const all: [TgFile | undefined, string | undefined, string | undefined][] = [
    // Telegram gives a photo in several sizes, the largest last.
    [m.photo?.at(-1), "photo.jpg", "image/jpeg"],
    [m.animation, "animation.mp4", "video/mp4"],
    // An animation comes as a document as well.
    [m.animation ? undefined : m.document, undefined, undefined],
    [m.audio, undefined, undefined],
    [m.video, "video.mp4", "video/mp4"],
    [m.voice, "voice.ogg", "audio/ogg"],
    [m.video_note, "video_note.mp4", "video/mp4"],
    [m.sticker, sticker[0], sticker[1]],
  ];
  const list = all.flatMap(([file, name, type]): FileInfo[] => {
    if (!file) return [];
    const fileName = file.file_name ?? name;
    const fileType = file.mime_type ?? type;
    return [
      {
        ...(fileName ? { name: fileName } : {}),
        ...(fileType ? { type: fileType } : {}),
        url: `telegram-file:${file.file_id}`,
        ...(typeof file.file_size === "number" ? { size: file.file_size } : {}),
      },
    ];
  });
  return list.length ? { files: list } : {};
}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Markdown with each line break inside a paragraph made a hard break (two spaces before it). Telegram reads rich
 * Markdown as GitHub does, where a single line break is a space, so a bot's lines, one per item as people write in a
 * chat, would show as one line. Line breaks inside inline code or HTML stay as they are.
 */
function keepLineBreaks(markdown: string): string {
  const at: number[] = [];
  const range = (node: MarkdownNode) => [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0] as const;
  const visit = (node: MarkdownNode) => {
    if (node.type !== "paragraph") {
      node.children?.forEach(visit);
      return;
    }
    const skip: (readonly [number, number])[] = [];
    const inline = (child: MarkdownNode) => (child.type === "inlineCode" || child.type === "html" ? skip.push(range(child)) : child.children?.forEach(inline));
    node.children?.forEach(inline);
    const [start, end] = range(node);
    for (let i = markdown.indexOf("\n", start); i !== -1 && i < end; i = markdown.indexOf("\n", i + 1)) {
      if (skip.some(([from, to]) => i >= from && i < to)) continue;
      const lineEnd = markdown[i - 1] === "\r" ? i - 1 : i;
      let backslashes = 0;
      while (markdown[lineEnd - 1 - backslashes] === "\\") backslashes++;
      // Already a hard break: two spaces, or a backslash that is not itself escaped.
      if (!markdown.endsWith("  ", lineEnd) && backslashes % 2 === 0) at.push(lineEnd);
    }
  };
  visit(parseMarkdown(markdown) as MarkdownNode);
  let out = "";
  let from = 0;
  for (const i of at) {
    out += `${markdown.slice(from, i)}  `;
    from = i;
  }
  return out + markdown.slice(from);
}

function tooLong(length: number, limit: number): string | undefined {
  return length > limit ? `Telegram allows at most ${limit} characters in one message; this one has ${length}. Send it in parts.` : undefined;
}

/**
 * How many characters Telegram counts in a rich message: the text it shows, without Markdown marks and link URLs, in
 * Unicode characters. HTML tags count here too, which is on the safe side.
 */
function richLength(markdown: string): number {
  return Array.from(markdownToPlainText(markdown)).length;
}

/**
 * Whether an error means that Telegram does not take a rich message for this send, as the SDK reads it
 * (canFallbackFromRichMessage): no sendRichMessage method, rich messages not supported here, rich Markdown it cannot
 * read, or reply parameters it does not take with a rich message. Telegram's error codes may use "_" for spaces.
 */
function richNotTaken(error: TelegramError): boolean {
  if (error.code === 404) return true;
  if (error.code < 400 || error.code >= 500 || [401, 403, 429].includes(error.code)) return false;
  const text = error.description.toLowerCase().replace(/_/g, " ");
  return (
    text.includes("can't parse") ||
    (text.includes("method") && text.includes("not found")) ||
    (text.includes("rich message") && text.includes("unsupported")) ||
    text.includes("reply parameters")
  );
}

/**
 * How many characters Telegram counts in a MarkdownV2 text: the text it shows, without formatting marks, escapes and
 * link URLs. Counted in UTF-16 code units, as Telegram counts entity offsets; if Telegram counts emoji as one character,
 * this is on the safe side.
 */
function shownLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\") {
      i++;
      length++;
    } else if (char === "`") {
      const mark = text.startsWith("```", i) ? "```" : "`";
      let j = i + mark.length;
      if (mark === "```") {
        // The first line of a code block names its language.
        const line = text.indexOf("\n", j);
        const end = text.indexOf(mark, j);
        if (line !== -1 && (end === -1 || line < end)) j = line + 1;
      }
      for (; j < text.length && !text.startsWith(mark, j); j++) {
        if (text[j] === "\\") j++;
        length++;
      }
      i = j + mark.length - 1;
    } else if (char === "]" && text[i + 1] === "(") {
      for (i += 2; i < text.length && text[i] !== ")"; i++) if (text[i] === "\\") i++;
    } else if (!"*_~|[>".includes(char)) {
      length++;
    }
  }
  return length;
}

/** A name put into Markdown, so that it stays plain text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~<>]/g, "\\$&");
}

/** The emoji Telegram expects: a name such as :thumbsup: or eyes as its emoji, without the variation selector (❤️ is ❤). */
function toEmoji(emoji: string): string {
  const given = emoji.trim();
  const name = /^:?([\w+-]+):?$/.exec(given)?.[1];
  const value = name ? defaultEmojiResolver.toGChat(defaultEmojiResolver.fromSlack(name)) : given;
  if (/^[\w+-]+$/.test(value)) throw new Error(`no emoji is known by the name ${given}; give the emoji itself`);
  return value.replace(/️/g, "");
}

/**
 * The parameters of a call, as multipart form data when a file parameter is a local path: a top-level one under its
 * own name, one inside an InputMedia as attach://<name>. Other values that are not text are sent as JSON.
 */
async function withUploads(params: Record<string, unknown>): Promise<Record<string, unknown> | FormData> {
  const uploads: { field: string; path: string }[] = [];
  const isPath = (value: unknown): value is string => typeof value === "string" && (isAbsolute(value) || value.startsWith("~/"));
  const inner = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(inner);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (!FILE_FIELDS.has(key) || !isPath(item)) return [key, inner(item)];
        const field = `file${uploads.length + 1}`;
        uploads.push({ field, path: item });
        return [key, `attach://${field}`];
      }),
    );
  };
  const fields: [string, unknown][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (FILE_FIELDS.has(key) && isPath(value)) uploads.push({ field: key, path: value });
    else fields.push([key, inner(value)]);
  }
  if (uploads.length === 0) return params;
  const form = new FormData();
  for (const [key, value] of fields) if (value !== undefined) form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  for (const { field, path } of uploads) {
    const file = expandHome(path);
    form.append(field, await openAsBlob(file), basename(file));
  }
  return form;
}

/** Keep a value in a map of at most REMEMBER entries; the oldest goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBER) map.delete(map.keys().next().value!);
}

function quietLogger(log: ChannelSink["log"]) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: unknown) => log(`telegram sdk: ${message}`, { data: String(data ?? "") }),
    error: (message: string, data?: unknown) => log(`telegram sdk: ${message}`, { data: String(data ?? "") }),
    child: () => logger,
  };
  return logger;
}
