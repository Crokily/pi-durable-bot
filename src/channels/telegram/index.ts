import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as wait } from "node:timers/promises";
import type { TelegramCallbackQuery, TelegramChat, TelegramMessage, TelegramMessageReactionUpdated, TelegramUser } from "@chat-adapter/telegram";
import { defaultEmojiResolver, markdownToPlainText } from "chat";
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
};

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

/** What the inbox stores for this channel: an update as Telegram sent it, or a message this bot sent. */
type Raw = Update | { sent: TgMessage; sendId: string };

/** A file of a message, as Telegram describes it. */
interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

/** Telegram's limit for the text of one message, counted after entities parsing. */
const MAX_TEXT = 4096;
/** message_reaction comes only when asked for, and only in chats where the bot is an admin. */
const UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "message_reaction", "my_chat_member", "callback_query"];
/** How long one getUpdates waits for new updates, in seconds. */
const POLL_SECONDS = 50;
/** How many entries each memory of this adapter (topics, people, chats) keeps; the oldest go first. */
const REMEMBER = 50_000;
/** Bot API parameters that take a file, and the field of an InputMedia that does. */
const FILE_FIELDS = new Set(["photo", "audio", "document", "video", "animation", "voice", "video_note", "sticker", "thumbnail", "cover", "media", "certificate"]);

export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with TELEGRAM_BOT_TOKEN`);
  // Telegram's own Bot API server, unless the entry names another one, such as a local Bot API server or a test's.
  const apiUrl = typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : "https://api.telegram.org";
  return new TelegramChannel(config.id, expandHome(config.secrets), apiUrl);
}

class TelegramChannel implements ChannelAdapter {
  readonly id: string;
  readonly #secrets: string;
  readonly #apiUrl: string;
  #token?: string;
  #bot?: TelegramUser;
  #sdk?: GatewayTelegramAdapter;
  #stopping?: AbortController;
  #polling?: Promise<void>;
  /** The forum topic of messages seen since the start, by "<chat ID>/<message ID>", so that a reply stays in its topic. */
  readonly #topics = new Map<string, number>();
  /** People and chats seen since the start, by ID, and people by lowercase username, for mentions. */
  readonly #people = new Map<string, TelegramUser>();
  readonly #usernames = new Map<string, string>();
  readonly #chats = new Map<string, TelegramChat>();

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
    const bot = await this.#api<TelegramUser>("getMe");
    if (!bot.username) throw new Error("Telegram did not say the bot's username");
    this.#sdk = new GatewayTelegramAdapter(this.#token, { id: bot.id, username: bot.username }, quietLogger(sink.log));
    this.#bot = bot;
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
          offset = update.update_id + 1;
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        await pause("update not stored; Telegram gives it again with the next poll", error);
      }
    }
  }

  /** The Bot API cannot read history. What was missed comes with the first polls, from up to 24 hours back. */
  async backfill(sink: ChannelSink): Promise<void> {
    const lastAlive = sink.lastAlive();
    if (lastAlive === undefined) return;
    sink.log(
      Date.now() - lastAlive > 24 * 3600_000
        ? "the gateway was down for more than 24 hours; Telegram keeps missed updates only that long, so older ones are lost"
        : "missed updates come with the first polls; Telegram keeps them for 24 hours",
    );
  }

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
    if ("sent" in raw) return [this.#message("message", raw.sent, raw.sendId)];
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
   * my_chat_member, with who did it. Other service messages, such as a pin, have no text; their raw says what they are.
   */
  #posted(m: TgMessage): Happening[] {
    if (!m.new_chat_members && !m.left_chat_member) return [this.#message("message", m)];
    const others = (user: TelegramUser) => user.id !== this.#bot!.id;
    const joined = (m.new_chat_members ?? []).filter(others).map((user) => this.#member("join", m.chat, user, m.from, m.date * 1000, m));
    const left = m.left_chat_member && others(m.left_chat_member) ? [this.#member("leave", m.chat, m.left_chat_member, m.from, m.date * 1000, m)] : [];
    return [...joined, ...left];
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

  /** A press on a button under a message (an inline keyboard). The bot answers it with call answerCallbackQuery. */
  #interaction(query: NonNullable<Update["callback_query"]>): Happening {
    const m = query.message;
    if (m) this.#learnTopics(m);
    return {
      kind: "interaction",
      // A button press carries no time.
      at: Date.now(),
      ...(m ? { place: this.#place(m.chat), message: this.message(String(m.chat.id), m.message_id) } : {}),
      person: this.#person(query.from),
      fromMe: false,
      ...(query.data ? { text: query.data } : {}),
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
    return tooLong(shownLength(markdownV2(this.#outgoing(text))));
  }

  /** Markdown as MarkdownV2. A text over Telegram's limit is refused, never cut. */
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const target = this.#target(to);
    await this.#lookUp(text, target.chat);
    const markdown = this.#outgoing(text);
    const formatted = markdownV2(markdown);
    const refused = tooLong(shownLength(formatted));
    if (refused) throw new Error(refused);
    const params = {
      chat_id: target.chat,
      ...(target.topic ? { message_thread_id: target.topic } : {}),
      ...(target.reply ? { reply_parameters: { message_id: target.reply, allow_sending_without_reply: true } } : {}),
    };
    let sent: TgMessage;
    try {
      try {
        sent = await this.#api<TgMessage>("sendMessage", { ...params, text: formatted, parse_mode: "MarkdownV2" });
      } catch (error) {
        if (!(error instanceof TelegramError && /can't parse entities/i.test(error.description))) throw error;
        // Formatting Telegram could not read: the text without formatting, as the SDK does.
        const plain = markdownToPlainText(markdown);
        const refusedPlain = tooLong(plain.length);
        if (refusedPlain) throw new Error(refusedPlain);
        sent = await this.#api<TgMessage>("sendMessage", { ...params, text: plain });
      }
    } catch (error) {
      if (error instanceof TelegramError && "user" in this.#parse(to) && (error.code === 403 || /chat not found/i.test(error.description))) {
        throw new Error(`${error.message}. A bot can write to a person only after they started a chat with it: they open the bot in Telegram and press Start.`);
      }
      throw error;
    }
    const chat = String(sent.chat.id);
    return { message: this.message(chat, sent.message_id), place: this.place(chat), raw: { sent, sendId } satisfies Raw };
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
   * Telegram puts a reply in the forum topic of the message it answers. The topic, when this adapter saw it, keeps the
   * reply there also when that message is gone. A send to a topic's first message is a message in the topic, not a reply.
   */
  #target(to: Address): { chat: string; reply?: number; topic?: number } {
    const parsed = this.#parse(to);
    if ("user" in parsed) return { chat: parsed.user };
    if (parsed.message === undefined) return { chat: parsed.chat };
    const topic = this.#topics.get(`${parsed.chat}/${parsed.message}`);
    if (topic === parsed.message) return { chat: parsed.chat, topic };
    return { chat: parsed.chat, reply: parsed.message, ...(topic ? { topic } : {}) };
  }

  /** Person and place addresses in angle brackets, for #outgoing. */
  get #named(): RegExp {
    return new RegExp(`<${this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([@#])(-?\\d+)>`, "g");
  }

  /**
   * Person and place addresses in angle brackets become Telegram mentions: @username, or for a person without one, a
   * link that mentions them; a chat without a username becomes its title.
   */
  #outgoing(text: string): string {
    return text.replace(this.#named, (whole, sign: string, id: string) => {
      const user = sign === "@" && !id.startsWith("-") ? this.#people.get(id) : undefined;
      if (user) return user.username ? `@${user.username}` : `[${escapeMarkdown(fullName(user) || id)}](tg://user?id=${id})`;
      if (sign === "@" && !id.startsWith("-")) return `[${id}](tg://user?id=${id})`;
      const chat = this.#chats.get(id);
      return chat?.username ? `@${chat.username}` : chat?.title ? escapeMarkdown(chat.title) : whole;
    });
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
   * (photo, document, …, or the media of an InputMedia) given as a local path ("/…" or "~/…") is uploaded; a file ID or
   * a URL is passed on as it is.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.#api(method, await withUploads(params));
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
        parameters?: { retry_after?: number };
      };
      if (data.ok) return data.result as T;
      const error = new TelegramError(method, data.error_code ?? response.status, data.description ?? `HTTP ${response.status}`, data.parameters?.retry_after);
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

function tooLong(length: number): string | undefined {
  return length > MAX_TEXT ? `Telegram allows at most ${MAX_TEXT} characters in one message; this one has ${length}. Send it in parts.` : undefined;
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
  const isPath = (value: unknown): value is string => typeof value === "string" && (value.startsWith("/") || value.startsWith("~/"));
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
