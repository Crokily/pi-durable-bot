import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { DiscordFormatConverter } from "@chat-adapter/discord";
import { convertEmojiPlaceholders, defaultEmojiResolver } from "chat";
import { Client, DiscordAPIError, Events, GatewayIntentBits, type REST, type RequestMethod } from "discord.js";
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

// Addresses (only this file parses them):
//   place               <id>:#<channel ID>                              discord:#1100  (a server channel or a DM)
//   message             <id>:#<channel ID>/<message ID>                 discord:#1100/1200
//   message in a thread <id>:#<channel ID>/<thread ID>/<message ID>     discord:#1100/1300/1400
//   person              <id>:@<user ID>                                 discord:@1500
// A thread is the address of its first message: <id>:#<channel ID>/<thread ID>. A thread started from a message has
// that message's ID, and the first message of a forum post has the post's ID, so both have this address. The place of
// a message in a thread is the channel the thread is in. A thread with no first message of its own (a private thread, or
// one started without a message) has an address of the same form, but no message has it, so the wake shows no thread
// start there.

/**
 * What the inbox stores for this channel. `at` is when the gateway event came, for events that carry no time. `parent`
 * is set when the event's channel is a thread: the channel the thread is in, known when the event came, so the event
 * gets the same addresses also when the thread cannot be looked up later.
 */
type Raw =
  | { source: "gateway"; at: number; t: string; d: any; parent?: string }
  | { source: "history"; message: ApiMessage; parent?: string }
  | { source: "sent"; sendId: string; message: ApiMessage; parent?: string };

/** An address taken apart: a place (channel), a message in it or in one of its threads, or a person. */
type Parsed = { channel: string; thread?: string; message?: string } | { user: string };

interface ApiUser {
  id: string;
  username?: string;
  global_name?: string | null;
  member?: { nick?: string | null };
}

interface ApiAttachment {
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
}

interface ApiMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  /** Sent only in gateway events. */
  channel_type?: number;
  type?: number;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  author?: ApiUser;
  mentions?: ApiUser[];
  mention_roles?: string[];
  attachments?: ApiAttachment[];
  embeds?: { type?: string; title?: string; description?: string; fields?: { name: string; value: string }[] }[];
  message_snapshots?: { message: { content?: string; attachments?: ApiAttachment[] } }[];
}

interface ApiChannel {
  id: string;
  type: number;
  name?: string | null;
  guild_id?: string;
  parent_id?: string | null;
  owner_id?: string;
  recipients?: ApiUser[];
  last_message_id?: string | null;
  thread_metadata?: { archive_timestamp?: string };
}

interface GuildInfo {
  name?: string;
  /** Role ID to name. */
  roles: Map<string, string>;
  /** The roles this bot has. */
  mine: Set<string>;
}

// Channel types (https://discord.com/developers/docs/resources/channel#channel-object-channel-types).
const DM = 1;
const GROUP_DM = 3;
/** Server channels with their own messages: text, voice, announcement and stage channels. */
const TEXT = new Set([0, 2, 5, 13]);
const THREADS = new Set([10, 11, 12]);
/** Channels that can have threads: text, announcement, forum and media channels. */
const THREAD_PARENTS = new Set([0, 5, 15, 16]);
/** Forum and media channels: their posts are threads, and a post's first message is in the thread. */
const FORUMS = new Set([15, 16]);
/** The copy of a thread's first message that Discord shows in the thread; the message itself is in the channel. */
const THREAD_STARTER_MESSAGE = 21;
/** The system message a server posts when someone joins it, when the server has its welcome messages on. */
const USER_JOIN = 7;

/** Discord counts a message's length in Unicode code points. */
const MAX_LENGTH = 2000;
const CACHE_TTL_MS = 60 * 60_000;
const DISCORD_EPOCH = 1420070400000n;
const STORED = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_DELETE_BULK",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "INTERACTION_CREATE",
  "THREAD_CREATE",
  "THREAD_UPDATE",
  "THREAD_DELETE",
]);
/** Gateway events that are not stored but tell who the bot is, which servers it is in, and its channels' names. */
const KEPT = new Set(["READY", "GUILD_CREATE", "GUILD_DELETE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_LIST_SYNC"]);
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/**
 * The Chat SDK's Markdown converter, without one step: it turns a plain "@name" into "<@name>", which Discord shows
 * as it is, and so it also breaks "@here" and "@everyone". Mentions come from person addresses instead.
 */
const converter = new DiscordFormatConverter();
(converter as unknown as { convertMentionsToDiscord(text: string): string }).convertMentionsToDiscord = (text) => text;

export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with DISCORD_BOT_TOKEN`);
  return new DiscordChannel(config.id, expandHome(config.secrets), env);
}

export class DiscordChannel implements ChannelAdapter {
  readonly id: string;
  readonly #secrets: string;
  readonly #env: ChannelEnv;
  /** Discord's REST base URL. Tests point it at a fake Discord. */
  readonly #api: string;
  #client?: Client;
  #botUserId?: string;
  /** The gateway session, for event IDs: a dispatch is unique by its session and sequence number. */
  #session?: string;
  #readies = 0;
  /** When the last gateway event came, in Unix ms: where a new session's backfill starts. */
  #lastEventAt = 0;
  /** Stopped when the channel stops: after that, a store that fails is tried only once more. */
  #running = new AbortController();
  /** The newest logged message ID of each known place, by channel ID, read when the channel started. */
  #starts = new Map<string, string>();
  /** Servers the bot is in. A GUILD_CREATE for another one means the bot was added. */
  readonly #servers = new Set<string>();
  /** Gateway events are stored one after another, in the order Discord sent them. */
  #storing: Promise<void> = Promise.resolve();
  #refilling: Promise<void> = Promise.resolve();
  readonly #channels = new Map<string, { channel: ApiChannel; at: number }>();
  readonly #guilds = new Map<string, { guild: GuildInfo; at: number }>();
  readonly #people = new Map<string, { person: PersonInfo; at: number }>();
  /** The DM channel with each person the bot sent to. */
  readonly #dms = new Map<string, string>();

  constructor(id: string, secrets: string, env: ChannelEnv, api = "https://discord.com/api") {
    this.id = id;
    this.#secrets = secrets;
    this.#env = env;
    this.#api = api;
  }

  get me(): PersonInfo | undefined {
    return this.#botUserId ? { address: this.person(this.#botUserId), name: this.#env.botName } : undefined;
  }

  get #rest(): REST {
    if (!this.#client) throw new Error(`channel ${this.id} is not started`);
    return this.#client.rest;
  }

  // ---- Connect ----

  /**
   * Connect to the Discord gateway. discord.js resumes short drops itself, and Discord then sends the missed events
   * again. When a new session starts instead, events in between are lost, so a READY after the first one runs the
   * backfill again.
   */
  async start(sink: ChannelSink): Promise<void> {
    const { DISCORD_BOT_TOKEN: token } = readSecrets(this.#secrets, ["DISCORD_BOT_TOKEN"]);
    // Where the backfill starts in each known place, read before the gateway connects: live messages logged after this
    // must not move it past messages that came while the gateway was down. Overlap is harmless: the log keeps a message once.
    this.#starts = new Map();
    for (const place of await sink.places()) {
      const newest = await sink.newestMessage(place);
      const parsed = newest ? this.#tryParse(newest) : undefined;
      if (parsed && "message" in parsed && parsed.message) this.#starts.set(parsed.channel, parsed.message);
    }
    this.#running = new AbortController();
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      rest: { api: this.#api },
    });
    (client as unknown as EventEmitter).on(Events.Raw, (packet: { t: string | null; s: number | null; d: any }) => this.#receive(sink, packet));
    client.on(Events.Error, (error) => sink.log("discord.js error", { error: String(error) }));
    client.on(Events.ShardError, (error) => sink.log("gateway error", { error: String(error) }));
    client.on(Events.ShardDisconnect, (event) => sink.log("Discord closed the gateway, and it will not reconnect", { code: event.code }));
    this.#client = client;
    this.#readies = 0;
    try {
      await client.login(token);
    } catch (error) {
      if (/disallowed intents/i.test(String(error))) {
        throw new Error("Discord refused the Message Content intent: turn it on in the Developer Portal, under Bot, Privileged Gateway Intents");
      }
      throw error;
    }
    this.#botUserId ??= client.user?.id;
    if (!this.#botUserId) throw new Error("Discord did not say who the bot is");
  }

  /** Take no more events, then store the ones already taken before stop ends: Discord does not send them again. */
  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.destroy().catch(() => {});
    this.#running.abort();
    await this.#storing;
  }

  /** One gateway dispatch: keep what translation needs to know, and store the events. Never throws into discord.js. */
  #receive(sink: ChannelSink, packet: { t: string | null; s: number | null; d: any }): void {
    const { t } = packet;
    if (!t) return;
    const previous = this.#lastEventAt;
    this.#lastEventAt = Date.now();
    if (!(STORED.has(t) || KEPT.has(t))) return;
    try {
      // A copy, taken now: discord.js changes the packet's data when it handles it after this.
      const d = structuredClone(packet.d);
      switch (t) {
        case "READY":
          this.#session = d.session_id;
          this.#botUserId = d.user.id;
          this.#servers.clear();
          for (const guild of d.guilds) this.#servers.add(guild.id);
          if (this.#readies++ > 0) {
            // A new session: what came after the old one's last event is lost. Fill it in every place, from a minute
            // before that event, also on the first run, when there is no last time the gateway ran.
            const since = snowflakeAt(previous - 60_000);
            this.#refilling = this.#refilling.then(() => this.#backfill(sink, () => since)).catch((error) => sink.log("backfill failed", { error: String(error) }));
          }
          return;
        case "GUILD_CREATE":
          this.#rememberGuild(d);
          if (this.#servers.has(d.id)) return;
          this.#servers.add(d.id);
          // Added to a server. Its channels, roles and members are not kept; the bot can ask for them with call.
          this.#store(sink, `${t}:${d.id}:${d.joined_at}`, { source: "gateway", at: Date.now(), t, d: Object.fromEntries(Object.entries(d).filter(([, value]) => !Array.isArray(value))) });
          return;
        case "GUILD_DELETE":
          // Unavailable is an outage; otherwise the bot was removed.
          if (d.unavailable) return;
          this.#servers.delete(d.id);
          this.#store(sink, `${t}:${this.#session}:${packet.s}`, { source: "gateway", at: Date.now(), t, d });
          return;
        case "CHANNEL_CREATE":
        case "CHANNEL_UPDATE":
        case "THREAD_CREATE":
        case "THREAD_UPDATE":
          this.#remember(d);
          break;
        case "CHANNEL_DELETE":
        case "THREAD_DELETE":
          this.#channels.delete(d.id);
          break;
        case "THREAD_LIST_SYNC":
          for (const thread of d.threads ?? []) this.#remember({ ...thread, guild_id: d.guild_id });
          return;
      }
      if (!STORED.has(t)) return;
      // One event per edit: a later update of an edited message (a link preview, for example) has the same edit time.
      const eventId = t === "MESSAGE_UPDATE" && d.edited_timestamp ? `${t}:${d.id}:${d.edited_timestamp}` : `${t}:${this.#session}:${packet.s}`;
      const parent = this.#parentOf(d.channel_id);
      const raw: Raw = { source: "gateway", at: Date.now(), t, d, ...(parent ? { parent } : {}) };
      this.#store(sink, eventId, raw, t === "INTERACTION_CREATE" ? () => void this.#acknowledge(sink, d) : undefined);
    } catch (error) {
      sink.log("gateway event not handled", { type: t, error: String(error) });
    }
  }

  /**
   * Store an event after the ones before it. Discord does not send an event again, so one that fails is tried again,
   * later each time, until it is stored; once the channel stops, only once more. The events after it wait, so the order
   * stays.
   */
  #store(sink: ChannelSink, eventId: string, raw: Raw, then?: () => void): void {
    const { signal } = this.#running;
    this.#storing = this.#storing.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await sink.receive(eventId, raw);
          then?.();
          return;
        } catch (error) {
          if (signal.aborted) {
            sink.log("gateway event not stored, and the channel stopped", { event: eventId, attempt, error: String(error) });
            return;
          }
          const wait = Math.min(1000 * 2 ** (attempt - 1), 30_000);
          sink.log("gateway event not stored; trying again", { event: eventId, attempt, waitMs: wait, error: String(error) });
          await sleep(wait, undefined, { signal }).catch(() => {});
        }
      }
    });
  }

  /** The channel a thread is in, when the cache knows that this channel is a thread. */
  #parentOf(channelId: string | undefined): string | undefined {
    const channel = channelId ? this.#channels.get(channelId)?.channel : undefined;
    return channel && THREADS.has(channel.type) ? (channel.parent_id ?? undefined) : undefined;
  }

  /**
   * Discord shows the person an error unless an interaction is answered within 3 seconds, so once it is stored it is
   * answered with "later": a command shows that the bot is thinking, a button shows nothing. The bot answers it with
   * call, as docs/channels/discord.md says.
   */
  async #acknowledge(sink: ChannelSink, interaction: { id: string; token: string; type: number; message?: unknown }): Promise<void> {
    // 2 a command, 3 a button or menu, 5 a form; 4 (autocomplete) cannot wait.
    const type = interaction.type === 2 ? 5 : interaction.type === 3 ? 6 : interaction.type === 5 ? (interaction.message ? 6 : 5) : undefined;
    if (!type || !this.#client) return;
    await this.#rest
      .post(`/interactions/${interaction.id}/${interaction.token}/callback`, { body: { type }, auth: false })
      .catch((error) => sink.log("interaction not acknowledged", { error: String(error) }));
  }

  owns(address: Address): boolean {
    return address.startsWith(`${this.id}:`);
  }

  // ---- Addresses ----

  placeOf(address: Address): Address | undefined {
    const parsed = this.#parse(address);
    return "channel" in parsed ? this.place(parsed.channel) : undefined;
  }

  place(channel: string): Address {
    return `${this.id}:#${channel}`;
  }

  person(user: string): Address {
    return `${this.id}:@${user}`;
  }

  /** The address of a message in a channel, or in a thread whose place is `where.place`. */
  #messageAt(where: { place: string; thread?: string }, message: string): Address {
    if (!where.thread) return `${this.id}:#${where.place}/${message}`;
    return message === where.thread ? this.#threadAt(where) : `${this.id}:#${where.place}/${where.thread}/${message}`;
  }

  #threadAt(where: { place: string; thread?: string }): Address {
    return `${this.id}:#${where.place}/${where.thread}`;
  }

  #parse(address: Address): Parsed {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    const place = /^#(\d+)(?:\/(\d+))?(?:\/(\d+))?$/.exec(rest);
    if (place) {
      if (place[3]) return { channel: place[1]!, thread: place[2]!, message: place[3] };
      return { channel: place[1]!, ...(place[2] ? { message: place[2] } : {}) };
    }
    const person = /^@(\d+)$/.exec(rest);
    if (person) return { user: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  #tryParse(address: Address): Parsed | undefined {
    try {
      return this.#parse(address);
    } catch {
      return undefined;
    }
  }

  // ---- Translate ----

  async translate(value: unknown): Promise<Happening[]> {
    const raw = value as Raw;
    const parent = raw.parent;
    if (raw.source === "history") return this.#message("message", raw.message, Date.now(), parent);
    if (raw.source === "sent") return this.#message("message", raw.message, Date.now(), parent, raw.sendId);
    const { t, d, at } = raw;
    switch (t) {
      case "MESSAGE_CREATE":
        return this.#message("message", d, at, parent);
      case "MESSAGE_UPDATE":
        return d.edited_timestamp ? this.#message("edit", d, at, parent) : this.#update(d, at, parent);
      case "MESSAGE_DELETE":
        return [await this.#deleted(d.id, d.channel_id, d.guild_id, at, d, parent)];
      case "MESSAGE_DELETE_BULK":
        return Promise.all((d.ids as string[]).map((id) => this.#deleted(id, d.channel_id, d.guild_id, at, d, parent)));
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE": {
        const where = await this.#locate(d.channel_id, undefined, parent);
        const emoji = d.emoji as { id?: string | null; name?: string | null; animated?: boolean };
        return [
          {
            kind: t === "MESSAGE_REACTION_ADD" ? "reaction_added" : "reaction_removed",
            at,
            place: await this.#placeInfo(where.place, d.guild_id),
            message: this.#messageAt(where, d.message_id),
            ...(where.thread ? { thread: this.#threadAt(where) } : {}),
            person: await this.#personInfo(d.member?.user ?? d.user_id),
            fromMe: d.user_id === this.#botUserId,
            text: emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : (emoji.name ?? "?"),
            raw: d,
          },
        ];
      }
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
      case "THREAD_DELETE": {
        const thread = d as ApiChannel;
        if (!thread.parent_id) return [];
        const where = { place: thread.parent_id, thread: thread.id };
        const owner = t === "THREAD_CREATE" ? thread.owner_id : undefined;
        return [
          {
            // A deleted thread is only logged, as a deleted message is.
            kind: t === "THREAD_DELETE" ? "delete" : "update",
            at,
            place: await this.#placeInfo(thread.parent_id, thread.guild_id),
            thread: this.#threadAt(where),
            ...(owner ? { person: await this.#personInfo(owner) } : {}),
            fromMe: owner !== undefined && owner === this.#botUserId,
            ...(thread.name ? { text: thread.name } : {}),
            raw: d,
          },
        ];
      }
      case "GUILD_CREATE":
        return [{ kind: "join", at: Date.parse(d.joined_at) || at, ...this.#meAsPerson(), fromMe: false, text: `added to the server "${d.name}" (ID ${d.id})`, raw: d }];
      case "GUILD_DELETE": {
        const name = this.#guilds.get(d.id)?.guild.name;
        return [{ kind: "leave", at, ...this.#meAsPerson(), fromMe: false, text: `removed from the server ${name ? `"${name}" ` : ""}(ID ${d.id})`, raw: d }];
      }
      case "INTERACTION_CREATE":
        // An interaction names its channel's parent itself.
        return [await this.#interaction(d, at, parent ?? (THREADS.has(d.channel?.type) ? d.channel.parent_id : undefined))];
      default:
        return [];
    }
  }

  async #message(kind: "message" | "edit", message: ApiMessage, at: number, parent: string | undefined, sendId?: string): Promise<Happening[]> {
    if (message.type === THREAD_STARTER_MESSAGE) return [];
    if (message.type === USER_JOIN) return this.#joined(message, at, parent);
    const where = await this.#locate(message.channel_id, message.channel_type, parent);
    const guildId = message.guild_id ?? (await this.#channel(where.place).catch(() => undefined))?.guild_id;
    const guild = guildId ? await this.#guild(guildId).catch(() => undefined) : undefined;
    const author = message.author;
    const mentionsMe =
      (message.mentions ?? []).some((user) => user.id === this.#botUserId) || (message.mention_roles ?? []).some((role) => guild?.mine.has(role) === true);
    const time = Date.parse((kind === "edit" ? message.edited_timestamp : message.timestamp) ?? "");
    const thread = where.thread ? this.#threadAt(where) : undefined;
    return [
      {
        kind,
        at: Number.isFinite(time) ? time : at,
        place: await this.#placeInfo(where.place, guildId),
        message: this.#messageAt(where, message.id),
        ...(thread ? { thread, ...(kind === "message" ? { threadRoot: thread } : {}) } : {}),
        ...(author ? { person: await this.#personInfo(author) } : {}),
        fromMe: author !== undefined && author.id === this.#botUserId,
        mentionsMe,
        text: await this.#text(message, guild),
        mentions: (message.mentions ?? []).map((user) => this.person(user.id)),
        ...files(message),
        ...(sendId ? { sendId } : {}),
        raw: message,
      },
    ];
  }

  /**
   * Someone joined the server, from its welcome message: a join in the channel it was posted in. The bot's own is left
   * out: GUILD_CREATE already says it was added.
   */
  async #joined(message: ApiMessage, at: number, parent: string | undefined): Promise<Happening[]> {
    const author = message.author;
    if (!author || author.id === this.#botUserId) return [];
    const where = await this.#locate(message.channel_id, message.channel_type, parent);
    const time = Date.parse(message.timestamp ?? "");
    return [
      {
        kind: "join",
        at: Number.isFinite(time) ? time : at,
        place: await this.#placeInfo(where.place, message.guild_id),
        person: await this.#personInfo(author),
        fromMe: false,
        raw: message,
      },
    ];
  }

  /** A message changed but not edited: a link preview came, or it was pinned. Nobody did it, so no person. */
  async #update(message: ApiMessage, at: number, parent: string | undefined): Promise<Happening[]> {
    const where = await this.#locate(message.channel_id, message.channel_type, parent);
    return [
      {
        kind: "update",
        at,
        place: await this.#placeInfo(where.place, message.guild_id),
        message: this.#messageAt(where, message.id),
        ...(where.thread ? { thread: this.#threadAt(where) } : {}),
        fromMe: message.author !== undefined && message.author.id === this.#botUserId,
        ...files(message),
        raw: message,
      },
    ];
  }

  /** Discord does not say who deleted a message, or whose it was. */
  async #deleted(message: string, channel: string, guildId: string | undefined, at: number, raw: unknown, parent: string | undefined): Promise<Happening> {
    const where = await this.#locate(channel, undefined, parent);
    return {
      kind: "delete",
      at,
      place: await this.#placeInfo(where.place, guildId),
      message: this.#messageAt(where, message),
      ...(where.thread ? { thread: this.#threadAt(where) } : {}),
      fromMe: false,
      raw,
    };
  }

  /** Someone used a command, a button, a menu or a form of the app. */
  async #interaction(d: any, at: number, parent: string | undefined): Promise<Happening> {
    const where = d.channel_id ? await this.#locate(d.channel_id, d.channel?.type, parent) : undefined;
    const user = d.member?.user ?? d.user;
    let text: string | undefined;
    if (d.type === 2) {
      const parts = [`/${d.data?.name ?? "?"}`];
      const walk = (options: { name: string; value?: unknown; options?: unknown[] }[] = []) => {
        for (const option of options) {
          if (option.options) {
            parts.push(option.name);
            walk(option.options as typeof options);
          } else parts.push(`${option.name}: ${String(option.value)}`);
        }
      };
      walk(d.data?.options);
      text = parts.join(" ");
    } else if (d.data?.custom_id) text = d.data.custom_id;
    return {
      kind: "interaction",
      at,
      ...(where ? { place: await this.#placeInfo(where.place, d.guild_id) } : {}),
      ...(where && d.message?.id ? { message: this.#messageAt(where, d.message.id) } : {}),
      ...(where?.thread ? { thread: this.#threadAt(where) } : {}),
      ...(user ? { person: await this.#personInfo(user) } : {}),
      fromMe: false,
      ...(text ? { text } : {}),
      raw: d,
    };
  }

  #meAsPerson(): { person?: PersonInfo } {
    const me = this.me;
    return me ? { person: me } : {};
  }

  /**
   * A message's text as Discord Markdown, with mentions as names: <@id> becomes @name, <@&id> @role and <#id> #channel.
   * The text of a forwarded message and of embeds that bots and webhooks post is added after it.
   */
  async #text(message: ApiMessage, guild: GuildInfo | undefined): Promise<string> {
    const parts = [
      message.content ?? "",
      ...(message.embeds ?? [])
        .filter((embed) => embed.type === "rich")
        .flatMap((embed) => [embed.title ?? "", embed.description ?? "", ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`)]),
      ...(message.message_snapshots ?? []).map((snapshot) => snapshot.message.content ?? ""),
    ];
    let text = parts.filter(Boolean).join("\n\n");
    const users = new Map((message.mentions ?? []).map((user) => [user.id, user.member?.nick || displayName(user)]));
    text = text.replace(/<@!?(\d+)>/g, (token, id: string) => (users.has(id) ? `@${users.get(id)}` : token));
    text = text.replace(/<@&(\d+)>/g, (token, id: string) => (guild?.roles.has(id) ? `@${guild.roles.get(id)}` : token));
    const channels = new Map<string, string>();
    for (const [, id] of text.matchAll(/<#(\d+)>/g)) {
      const name = (await this.#channel(id!).catch(() => undefined))?.name;
      if (name) channels.set(id!, name);
    }
    return text.replace(/<#(\d+)>/g, (token, id: string) => (channels.has(id) ? `#${channels.get(id)}` : token));
  }

  /**
   * Where a channel's messages are: in the channel itself, or in a thread, whose place is its parent channel. The
   * parent stored with the event comes first, then the channel type the event gives, then the cache or Discord.
   */
  async #locate(channelId: string, type?: number, parent?: string): Promise<{ place: string; thread?: string }> {
    if (parent) return { place: parent, thread: channelId };
    if (type !== undefined && !THREADS.has(type)) return { place: channelId };
    const channel = await this.#channel(channelId).catch(() => undefined);
    if (channel && THREADS.has(channel.type) && channel.parent_id) return { place: channel.parent_id, thread: channel.id };
    return { place: channelId };
  }

  /** guildId: the server the event names; without one, a lookup that fails says "dm". */
  async #placeInfo(channelId: string, guildId: string | undefined): Promise<PlaceInfo> {
    const address = this.place(channelId);
    try {
      const channel = await this.#channel(channelId);
      if (channel.type === DM || channel.type === GROUP_DM) {
        const others = (channel.recipients ?? []).filter((user) => user.id !== this.#botUserId);
        const name = channel.name || others.map(displayName).join(", ");
        return { address, kind: channel.type === DM ? "dm" : "group", ...(name ? { name } : {}) };
      }
      const server = channel.guild_id ? (await this.#guild(channel.guild_id).catch(() => undefined))?.name : undefined;
      const name = channel.name ? `${server ? `${server} ` : ""}#${channel.name}` : server;
      return { address, kind: "channel", ...(name ? { name } : {}) };
    } catch (error) {
      this.#env.log("place lookup failed", { channel: channelId, error: String(error) });
      return { address, kind: guildId ? "channel" : "dm" };
    }
  }

  async #personInfo(user: ApiUser | string): Promise<PersonInfo> {
    const id = typeof user === "string" ? user : user.id;
    if (id === this.#botUserId) return this.me!;
    if (typeof user !== "string" && user.username) {
      const person = { address: this.person(id), name: displayName(user) };
      this.#people.set(id, { person, at: Date.now() });
      return person;
    }
    const cached = this.#people.get(id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.person;
    try {
      return await this.#personInfo((await this.#rest.get(`/users/${id}`)) as ApiUser);
    } catch (error) {
      this.#env.log("person lookup failed", { user: id, error: String(error) });
      return { address: this.person(id) };
    }
  }

  async #channel(id: string): Promise<ApiChannel> {
    const cached = this.#channels.get(id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.channel;
    return this.#remember((await this.#rest.get(`/channels/${id}`)) as ApiChannel);
  }

  #remember(channel: ApiChannel): ApiChannel {
    this.#channels.set(channel.id, { channel, at: Date.now() });
    return channel;
  }

  async #guild(id: string): Promise<GuildInfo> {
    const cached = this.#guilds.get(id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.guild;
    const [guild, member] = (await Promise.all([this.#rest.get(`/guilds/${id}`), this.#rest.get(`/guilds/${id}/members/${this.#botUserId}`)])) as [
      { name?: string; roles?: { id: string; name: string }[] },
      { roles?: string[] },
    ];
    const info = { ...(guild.name ? { name: guild.name } : {}), roles: new Map((guild.roles ?? []).map((role) => [role.id, role.name])), mine: new Set(member.roles ?? []) };
    this.#guilds.set(id, { guild: info, at: Date.now() });
    return info;
  }

  /** A server as GUILD_CREATE gives it: its name, roles, channels and threads, and the bot's own roles. */
  #rememberGuild(d: { id: string; name?: string; roles?: { id: string; name: string }[]; members?: { user?: { id: string }; roles?: string[] }[]; channels?: ApiChannel[]; threads?: ApiChannel[] }): void {
    for (const channel of [...(d.channels ?? []), ...(d.threads ?? [])]) this.#remember({ ...channel, guild_id: d.id });
    const mine = d.members?.find((member) => member.user?.id === this.#botUserId);
    if (!mine) return;
    const guild = { ...(d.name ? { name: d.name } : {}), roles: new Map((d.roles ?? []).map((role) => [role.id, role.name])), mine: new Set(mine.roles ?? []) };
    this.#guilds.set(d.id, { guild, at: Date.now() });
  }

  // ---- Backfill ----

  /**
   * Store the messages that came while the gateway was down: in every text channel, active thread and recently archived
   * thread of every server, and in every DM the log knows. Each place starts after its newest message that was logged
   * when the channel started; a place with nothing logged starts at the last time the gateway ran. On the first start
   * there is nothing to fill. Oldest first in each channel.
   */
  async backfill(sink: ChannelSink): Promise<void> {
    const lastAlive = sink.lastAlive();
    if (lastAlive === undefined) return;
    const starts = this.#starts;
    const since = snowflakeAt(lastAlive);
    await this.#backfill(sink, (place) => starts.get(place) ?? since);
  }

  /** startOf: the message ID after which a place's missed messages begin, by the place's channel ID. */
  async #backfill(sink: ChannelSink, startOf: (place: string) => string): Promise<void> {
    const rest = this.#rest;
    const channels: ApiChannel[] = [];
    const parents: ApiChannel[] = [];
    for (const guild of await this.#myGuilds()) {
      try {
        const listed = (await rest.get(`/guilds/${guild}/channels`)) as ApiChannel[];
        const active = (await rest.get(`/guilds/${guild}/threads/active`)) as { threads?: ApiChannel[] };
        for (const channel of [...listed, ...(active.threads ?? [])]) {
          this.#remember({ ...channel, guild_id: guild });
          if (TEXT.has(channel.type) || THREADS.has(channel.type)) channels.push(channel);
          if (THREAD_PARENTS.has(channel.type)) parents.push(channel);
        }
      } catch (error) {
        sink.log("backfill skipped a server", { server: guild, error: String(error) });
      }
    }
    const known = new Set(channels.map((channel) => channel.id));
    // A thread that got messages while the gateway was down may be archived by now, and then it is not active.
    for (const parent of parents) {
      try {
        for (const thread of await this.#archivedSince(parent.id, timeOf(startOf(parent.id)))) {
          if (known.has(thread.id)) continue;
          known.add(thread.id);
          channels.push(this.#remember({ ...thread, guild_id: parent.guild_id ?? thread.guild_id }));
        }
      } catch (error) {
        if (!noAccess(error)) sink.log("backfill skipped a place", { channel: parent.id, error: String(error) });
      }
    }
    for (const place of await sink.places()) {
      const parsed = this.#tryParse(place);
      if (!parsed || !("channel" in parsed) || known.has(parsed.channel)) continue;
      // A DM: read it again for its newest message ID. A channel of a server the bot left fails or is not a DM.
      const channel = await rest.get(`/channels/${parsed.channel}`).then((found) => this.#remember(found as ApiChannel)).catch(() => undefined);
      if (channel && (channel.type === DM || channel.type === GROUP_DM)) channels.push(channel);
    }
    let added = 0;
    for (const channel of channels) {
      const parent = THREADS.has(channel.type) && channel.parent_id ? channel.parent_id : undefined;
      try {
        added += await this.#backfillChannel(sink, channel, startOf(parent ?? channel.id), parent);
      } catch (error) {
        if (!noAccess(error)) sink.log("backfill skipped a place", { channel: channel.id, error: String(error) });
      }
    }
    sink.log("backfill done", { messages: added });
  }

  /** parent: the channel the thread is in, when this channel is a thread. */
  async #backfillChannel(sink: ChannelSink, channel: ApiChannel, after: string, parent: string | undefined): Promise<number> {
    if (!channel.last_message_id || BigInt(channel.last_message_id) <= BigInt(after)) return 0;
    let added = 0;
    for (let cursor = after; ; ) {
      const page = (await this.#rest.get(`/channels/${channel.id}/messages`, { query: new URLSearchParams({ after: cursor, limit: "100" }) })) as ApiMessage[];
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const message of page) {
        await sink.receive(`history:${message.id}:${message.edited_timestamp ?? ""}`, { source: "history", message, ...(parent ? { parent } : {}) } satisfies Raw);
        added++;
      }
      if (page.length < 100) return added;
      cursor = page.at(-1)!.id;
    }
  }

  /** The public threads of a channel archived at or after a time, in Unix ms. Discord lists the last archived first. */
  async #archivedSince(channel: string, since: number): Promise<ApiChannel[]> {
    const found: ApiChannel[] = [];
    for (let before: string | undefined; ; ) {
      const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
      const page = (await this.#rest.get(`/channels/${channel}/threads/archived/public`, { query })) as { threads?: ApiChannel[]; has_more?: boolean };
      for (const thread of page.threads ?? []) {
        before = thread.thread_metadata?.archive_timestamp;
        if (!(Date.parse(before ?? "") >= since)) return found;
        found.push(thread);
      }
      if (!page.has_more || !page.threads?.length) return found;
    }
  }

  async #myGuilds(): Promise<string[]> {
    const guilds: string[] = [];
    for (let after = "0"; ; ) {
      const page = (await this.#rest.get("/users/@me/guilds", { query: new URLSearchParams({ after, limit: "200" }) })) as { id: string }[];
      guilds.push(...page.map((guild) => guild.id));
      if (page.length < 200) return guilds;
      after = page.at(-1)!.id;
    }
  }

  // ---- Send ----

  checkText(_to: Address, text: string): string | undefined {
    return refusal(outgoing(this.id, text));
  }

  /**
   * Post the text. It carries a nonce made from the send ID, with enforce_nonce: Discord then returns the message
   * already sent with that nonce in the last few minutes instead of making a new one, so a resend after a crash does
   * not post twice. A text over Discord's limit is refused, never cut.
   */
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const content = outgoing(this.id, text);
    const refused = refusal(content);
    if (refused) throw new Error(refused);
    const target = await this.#target(to);
    const message = (await this.#rest.post(`/channels/${target.thread ?? target.place}/messages`, {
      body: {
        content,
        nonce: createHash("sha256").update(sendId).digest("base64url").slice(0, 25),
        enforce_nonce: true,
        ...(target.reply ? { message_reference: { message_id: target.reply } } : {}),
      },
    })) as ApiMessage;
    const raw: Raw = { source: "sent", sendId, message, ...(target.thread ? { parent: target.place } : {}) };
    return { message: this.#messageAt(target, message.id), place: this.place(target.place), raw };
  }

  /** Discord's API does not give nonces back when it lists messages, so a sent message cannot be found by its send ID. */
  async findSent(_to: Address, _sendId: string, _since: number): Promise<SentMessage | undefined> {
    return undefined;
  }

  /**
   * Where a send goes. A place: post in it. A person: post in the DM with them. A message: a reply to it in its channel,
   * or in its thread. A thread's first message (the thread's address): post in the thread, as a reply only when that
   * message is in the thread (a forum post); a message that has no thread gets a reply in its channel.
   */
  async #target(to: Address): Promise<{ place: string; thread?: string; reply?: string }> {
    const parsed = this.#parse(to);
    if ("user" in parsed) {
      let dm = this.#dms.get(parsed.user);
      if (!dm) {
        dm = this.#remember((await this.#rest.post("/users/@me/channels", { body: { recipient_id: parsed.user } })) as ApiChannel).id;
        this.#dms.set(parsed.user, dm);
      }
      return { place: dm };
    }
    if (!parsed.message) return this.#locate(parsed.channel);
    if (parsed.thread) return { place: parsed.channel, thread: parsed.thread, reply: parsed.message };
    const channel = await this.#channel(parsed.channel);
    if (channel.type === DM || channel.type === GROUP_DM) return { place: parsed.channel, reply: parsed.message };
    const thread = await this.#threadOf(parsed.message);
    if (thread?.parent_id === parsed.channel) return { place: parsed.channel, thread: thread.id, ...(FORUMS.has(channel.type) ? { reply: thread.id } : {}) };
    return { place: parsed.channel, reply: parsed.message };
  }

  /** The thread with this ID, if there is one the bot can see. */
  async #threadOf(id: string): Promise<ApiChannel | undefined> {
    try {
      const channel = await this.#channel(id);
      return THREADS.has(channel.type) ? channel : undefined;
    } catch (error) {
      if (error instanceof DiscordAPIError && (error.status === 404 || error.status === 403)) return undefined;
      throw error;
    }
  }

  /**
   * React with a Unicode emoji, a custom emoji as name:id or <:name:id>, or a name such as :thumbsup:. Adding a
   * reaction that is there, or removing one that is not, changes nothing and is not an error.
   */
  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("channel" in parsed) || !parsed.message) throw new Error(`not a message address: ${message}`);
    // A forum post's first message is in the post's thread.
    const channel = parsed.thread ?? (FORUMS.has((await this.#channel(parsed.channel)).type) ? parsed.message : parsed.channel);
    const route = `/channels/${channel}/messages/${parsed.message}/reactions/${encodeURIComponent(reactionEmoji(emoji))}/@me` as const;
    if (remove) await this.#rest.delete(route);
    else await this.#rest.put(route);
  }

  /**
   * The content of a file of a message. Discord's file URLs are signed and need no token; only Discord's own file
   * hosts are fetched.
   */
  async fetchFile(file: FileInfo, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const url = new URL(file.url ?? "");
    if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname)) throw new Error(`not a Discord file URL: ${url.origin}`);
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Discord answered ${response.status} ${response.statusText}`);
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  /**
   * Any Discord REST endpoint with the bot token. method is "<HTTP method> <path>", for example
   * "POST /channels/123/threads". params are the query for GET and DELETE, and the JSON body for the others. A "file"
   * param that is a local path is uploaded with the body.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/.exec(method.trim());
    if (!match) throw new Error(`call takes "<GET|POST|PUT|PATCH|DELETE> /<path>", for example "POST /channels/123/threads"; not ${JSON.stringify(method)}`);
    const verb = match[1]!;
    const request = { method: verb as RequestMethod, fullRoute: match[2]! as `/${string}` };
    const { file, ...body } = params;
    let result: unknown;
    if (verb === "GET" || verb === "DELETE") {
      const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
      result = await this.#rest.request({ ...request, ...(query.size ? { query } : {}) });
    } else {
      const files = typeof file === "string" ? [{ name: basename(file), data: await readFile(expandHome(file)) }] : undefined;
      result = await this.#rest.request({ ...request, body, ...(files ? { files } : {}) });
    }
    // An answer with no content (204).
    return result instanceof ArrayBuffer ? null : result;
  }
}

/** The text as Discord gets it: person and place addresses in angle brackets become mentions, then Markdown is converted. */
function outgoing(id: string, text: string): string {
  const prefix = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = text.replace(new RegExp(`<${prefix}:@(\\d+)>`, "g"), "<@$1>").replace(new RegExp(`<${prefix}:#(\\d+)>`, "g"), "<#$1>");
  return convertEmojiPlaceholders(converter.renderPostable({ markdown: mentions }), "discord");
}

function refusal(content: string): string | undefined {
  const length = [...content].length;
  return length > MAX_LENGTH ? `Discord allows at most ${MAX_LENGTH} characters in one message; this one has ${length}. Send it in parts.` : undefined;
}

function reactionEmoji(emoji: string): string {
  const text = emoji.trim();
  const custom = /^<?a?:?(\w+):(\d+)>?$/.exec(text);
  if (custom) return `${custom[1]}:${custom[2]}`;
  const named = /^:([\w+-]+):$/.exec(text);
  if (!named) return text;
  const unicode = defaultEmojiResolver.toDiscord(defaultEmojiResolver.fromSlack(named[1]!));
  if (/^[\w+-]+$/.test(unicode)) throw new Error(`unknown emoji ${text}: give the emoji itself, or name:id for a custom emoji`);
  return unicode;
}

function displayName(user: ApiUser): string {
  return user.global_name || user.username || user.id;
}

function files(message: ApiMessage): { files?: FileInfo[] } {
  const attachments = [...(message.attachments ?? []), ...(message.message_snapshots ?? []).flatMap((snapshot) => snapshot.message.attachments ?? [])];
  if (!attachments.length) return {};
  return {
    files: attachments.map((file) => ({
      ...(file.filename ? { name: file.filename } : {}),
      ...(file.content_type ? { type: file.content_type } : {}),
      ...(file.url ? { url: file.url } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
    })),
  };
}

/** The smallest Discord ID made at this time, for "messages after". */
function snowflakeAt(ms: number): string {
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

/** When a Discord ID was made, in Unix ms. */
function timeOf(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Discord answered that the bot may not read this. The server decides who reads what, so this is not a failure. */
function noAccess(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.status === 403;
}
