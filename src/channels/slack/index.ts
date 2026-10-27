import { createReadStream } from "node:fs";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackEvent } from "@chat-adapter/slack";
import { Chat } from "chat";
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
import { GatewaySlackAdapter, SEND_EVENT_TYPE } from "./sdk.ts";

// Addresses (only this file parses them):
//   place    <id>:#<channel ID>               slack:#C0123
//   message  <id>:#<channel ID>/<ts>          slack:#C0123/1793080260.811919  (a thread is its first message)
//   person   <id>:@<user ID>                  slack:@U0123

/** What the inbox stores for this channel. */
type Raw =
  | { source: "socket"; envelope: { event_id?: string; event?: SlackRawEvent } }
  | { source: "history"; channel: string; message: SlackMessage }
  | { source: "sent"; channel: string; message: SlackMessage };

type SlackMessage = SlackEvent & {
  subtype?: string;
  edited?: { user?: string; ts?: string };
  bot_profile?: { user_id?: string; name?: string };
  metadata?: { event_type?: string; event_payload?: { send_id?: string } };
  latest_reply?: string;
  blocks?: unknown[];
};

type SlackRawEvent = SlackMessage & {
  type?: string;
  event_ts?: string;
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  inviter?: string;
};

const PLACE_TTL_MS = 60 * 60_000;

export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  if (typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with SLACK_APP_TOKEN and SLACK_BOT_TOKEN`);
  return new SlackChannel(config.id, expandHome(config.secrets), env);
}

class SlackChannel implements ChannelAdapter {
  readonly id: string;
  readonly #secrets: string;
  readonly #env: ChannelEnv;
  #sdk?: GatewaySlackAdapter;
  #chat?: Chat;
  #botUserId?: string;
  readonly #places = new Map<string, { info: PlaceInfo; at: number }>();

  constructor(id: string, secrets: string, env: ChannelEnv) {
    this.id = id;
    this.#secrets = secrets;
    this.#env = env;
  }

  get me(): PersonInfo | undefined {
    return this.#botUserId ? { address: this.person(this.#botUserId), name: this.#env.botName } : undefined;
  }

  get #client() {
    if (!this.#sdk) throw new Error(`channel ${this.id} is not started`);
    return this.#sdk.client;
  }

  async start(sink: ChannelSink): Promise<void> {
    const tokens = readSecrets(this.#secrets, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    const sdk = new GatewaySlackAdapter({
      mode: "socket",
      appToken: tokens.SLACK_APP_TOKEN!,
      botToken: tokens.SLACK_BOT_TOKEN!,
      userName: this.#env.botName,
      logger: quietLogger(sink.log),
    });
    sdk.onSocketEvent = async (body) => {
      const envelope = body as { event_id?: string; token?: unknown; event?: SlackRawEvent };
      if (!envelope.event_id) return;
      // Slack's legacy verification token rides along in every envelope. It is not stored.
      const { token: _token, ...stored } = envelope;
      await sink.receive(envelope.event_id, { source: "socket", envelope: stored } satisfies Raw);
    };
    sdk.onSocketError = (error) => sink.log("event not stored, Slack will deliver it again", { error: String(error) });
    // Chat holds the adapter and its in-memory state. No handlers: the SDK only translates.
    const chat = new Chat({ userName: this.#env.botName, adapters: { slack: sdk }, state: createMemoryState(), logger: "warn" });
    await chat.initialize();
    this.#sdk = sdk;
    this.#chat = chat;
    this.#botUserId = sdk.botUserId;
    if (!this.#botUserId) throw new Error("Slack did not say who the bot is");
  }

  async stop(): Promise<void> {
    await this.#sdk?.disconnect().catch(() => {});
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

  message(channel: string, ts: string): Address {
    return `${this.id}:#${channel}/${ts}`;
  }

  person(user: string): Address {
    return `${this.id}:@${user}`;
  }

  #parse(address: Address): { channel: string; ts?: string } | { user: string } {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    const place = /^#([A-Z0-9]+)(?:\/(\d+\.\d+))?$/.exec(rest);
    if (place) return { channel: place[1]!, ...(place[2] ? { ts: place[2] } : {}) };
    const person = /^@([A-Z0-9]+)$/.exec(rest);
    if (person) return { user: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  // ---- Translate ----

  async translate(value: unknown): Promise<Happening[]> {
    const raw = value as Raw;
    if (raw.source === "history" || raw.source === "sent") {
      return [await this.#messageHappening({ ...raw.message, channel: raw.channel })];
    }
    const event = raw.envelope.event;
    if (!event) return [];
    const at = tsToMs(event.event_ts ?? event.ts);
    switch (event.type) {
      case "message":
      case "app_mention":
        return this.#translateMessageEvent(event, at);
      case "reaction_added":
      case "reaction_removed": {
        const item = event.item ?? {};
        const place = item.channel ? await this.#placeInfo(item.channel) : undefined;
        return [
          {
            kind: event.type,
            at,
            ...(place ? { place } : {}),
            ...(item.channel && item.ts ? { message: this.message(item.channel, item.ts) } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: event.user === this.#botUserId,
            text: `:${event.reaction ?? "?"}:`,
            raw: event,
          },
        ];
      }
      case "member_joined_channel":
      case "member_left_channel": {
        if (event.channel) this.#places.delete(event.channel);
        const place = event.channel ? await this.#placeInfo(event.channel) : undefined;
        const actor = event.inviter ?? event.user;
        const inviter = event.inviter ? await this.#personInfo(event.inviter) : undefined;
        return [
          {
            kind: event.type === "member_joined_channel" ? "join" : "leave",
            at,
            ...(place ? { place } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: actor === this.#botUserId,
            ...(inviter ? { text: `invited by ${inviter.name ?? inviter.address} (${inviter.address})` } : {}),
            raw: event,
          },
        ];
      }
      default: {
        if (event.channel) this.#places.delete(event.channel);
        const place = event.channel ? await this.#placeInfo(event.channel) : undefined;
        return [
          {
            kind: event.type ?? "unknown",
            at,
            ...(place ? { place } : {}),
            ...(event.user ? { person: await this.#personInfo(event.user) } : {}),
            fromMe: event.user !== undefined && event.user === this.#botUserId,
            raw: event,
          },
        ];
      }
    }
  }

  async #translateMessageEvent(event: SlackRawEvent, at: number): Promise<Happening[]> {
    const channel = event.channel;
    if (!channel) return [];
    switch (event.subtype) {
      case "message_changed": {
        const inner = { ...event.message, channel } as SlackMessage;
        const before = event.previous_message;
        if (!inner.ts) return [];
        const author = authorOf(inner);
        const common = {
          at: tsToMs(inner.edited?.ts ?? event.event_ts ?? event.ts),
          place: await this.#placeInfo(channel),
          message: this.message(channel, inner.ts),
          ...(inner.thread_ts ? { thread: this.message(channel, inner.thread_ts) } : {}),
          fromMe: author === this.#botUserId,
          raw: inner,
        };
        const person = author ? { person: await this.#personInfo(author, inner) } : {};
        // A thread's first message, deleted while it has replies, stays as a tombstone.
        if (inner.subtype === "tombstone") return [{ kind: "delete", ...common, ...person }];
        const edited = inner.text !== before?.text || inner.edited?.ts !== before?.edited?.ts;
        // Not an edit: Slack changed the message (a link preview, the reply count). Nobody did it, so no person.
        if (!edited) return [{ kind: "update", ...common, ...files(inner) }];
        const translated = await this.#sdk!.translate(inner);
        return [{ kind: "edit", ...common, ...person, text: translated.text, mentionsMe: translated.isMention === true, mentions: this.#mentions(inner), ...files(inner) }];
      }
      case "message_deleted": {
        const before = event.previous_message;
        const ts = event.deleted_ts ?? before?.ts;
        if (!ts) return [];
        const author = before ? authorOf(before) : undefined;
        return [
          {
            kind: "delete",
            at,
            place: await this.#placeInfo(channel),
            message: this.message(channel, ts),
            ...(before?.thread_ts ? { thread: this.message(channel, before.thread_ts) } : {}),
            ...(author ? { person: await this.#personInfo(author, before) } : {}),
            fromMe: author === this.#botUserId,
            raw: event,
          },
        ];
      }
      case "message_replied": {
        const inner = event.message;
        if (!inner?.ts) return [];
        const author = authorOf(inner);
        return [
          {
            kind: "update",
            at,
            place: await this.#placeInfo(channel),
            message: this.message(channel, inner.ts),
            thread: this.message(channel, inner.thread_ts ?? inner.ts),
            fromMe: author === this.#botUserId,
            raw: inner,
          },
        ];
      }
      default:
        return [await this.#messageHappening(event)];
    }
  }

  async #messageHappening(message: SlackMessage): Promise<Happening> {
    const channel = message.channel!;
    const ts = message.ts!;
    const translated = await this.#sdk!.translate(message);
    const author = authorOf(message);
    const thread = message.thread_ts ? this.message(channel, message.thread_ts) : undefined;
    const sendId = message.metadata?.event_type === SEND_EVENT_TYPE ? message.metadata.event_payload?.send_id : undefined;
    return {
      kind: "message",
      at: tsToMs(ts),
      place: await this.#placeInfo(channel),
      message: this.message(channel, ts),
      ...(thread ? { thread, threadRoot: thread } : {}),
      ...(author ? { person: await this.#personInfo(author, message) } : {}),
      fromMe: author === this.#botUserId,
      mentionsMe: translated.isMention === true,
      text: translated.text,
      mentions: this.#mentions(message),
      ...files(message),
      ...(sendId ? { sendId } : {}),
      raw: message,
    };
  }

  #mentions(message: SlackMessage): Address[] {
    const users = new Set<string>();
    for (const match of (message.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) users.add(match[1]!);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (node.type === "user" && typeof node.user_id === "string") users.add(node.user_id);
        Object.values(node).forEach(walk);
      }
    };
    walk(message.blocks);
    return [...users].map((user) => this.person(user));
  }

  async #personInfo(user: string, message?: SlackMessage): Promise<PersonInfo> {
    if (user === this.#botUserId) return this.me!;
    if (/^[UW]/.test(user)) {
      const info = await this.#sdk!.getUser(user);
      if (info) return { address: this.person(user), name: info.userName, realName: info.fullName };
    }
    const name = message?.username ?? message?.bot_profile?.name;
    return { address: this.person(user), ...(name ? { name } : {}) };
  }

  async #placeInfo(channel: string): Promise<PlaceInfo> {
    const cached = this.#places.get(channel);
    if (cached && Date.now() - cached.at < PLACE_TTL_MS) return cached.info;
    let info: PlaceInfo;
    try {
      const result = (await this.#client.conversations.info({ channel })).channel as
        | { name?: string; user?: string; is_im?: boolean; is_mpim?: boolean; purpose?: { value?: string } }
        | undefined;
      const kind = result?.is_im ? "dm" : result?.is_mpim ? "group" : "channel";
      let name = result?.name;
      if (result?.is_im && result.user) name = (await this.#personInfo(result.user)).name ?? result.user;
      info = { address: this.place(channel), kind, ...(name ? { name } : {}) };
    } catch (error) {
      this.#env.log("place lookup failed", { channel, error: String(error) });
      info = { address: this.place(channel), kind: channel.startsWith("D") ? "dm" : "channel" };
    }
    this.#places.set(channel, { info, at: Date.now() });
    return info;
  }

  // ---- Backfill ----

  /**
   * Store the messages that came while the gateway was down: in every place the bot is in, messages after the newest
   * logged one, and replies in threads with new replies. A place with nothing logged starts at the last time the
   * gateway ran. On the first start there is nothing to fill.
   */
  async backfill(sink: ChannelSink): Promise<void> {
    const client = this.#client;
    const lastAlive = sink.lastAlive();
    let added = 0;
    for await (const conversation of paginate((cursor) =>
      client.users.conversations({ types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }),
    )) {
      for (const place of ((conversation as { channels?: { id?: string }[] }).channels ?? [])) {
        if (!place.id) continue;
        try {
          added += await this.#backfillPlace(sink, place.id, lastAlive);
        } catch (error) {
          // One place that cannot be read (for example a DM whose history the bot may not see) does not stop the rest.
          sink.log("backfill skipped a place", { channel: place.id, error: String(error) });
        }
      }
    }
    sink.log("backfill done", { messages: added });
  }

  async #backfillPlace(sink: ChannelSink, channel: string, lastAlive: number | undefined): Promise<number> {
    const client = this.#client;
    const newest = await sink.newestMessage(this.place(channel));
    const newestTs = newest ? (this.#parse(newest) as { ts?: string }).ts : undefined;
    const since = newestTs ?? (lastAlive ? (lastAlive / 1000).toFixed(6) : undefined);
    if (!since) return 0;
    let added = 0;
    const threads = new Set<string>();
    for (const address of await sink.threads(this.place(channel))) {
      const ts = (this.#parse(address) as { ts?: string }).ts;
      if (ts) threads.add(ts);
    }
    for await (const page of paginate((cursor) =>
      client.conversations.history({ channel, oldest: since, inclusive: false, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }),
    )) {
      const messages = ((page as { messages?: SlackMessage[] }).messages ?? []).slice().reverse();
      for (const message of messages) {
        if (!message.ts) continue;
        await sink.receive(`history:${channel}:${message.ts}:${message.edited?.ts ?? ""}`, { source: "history", channel, message } satisfies Raw);
        added++;
        if (message.latest_reply && message.latest_reply > since) threads.add(message.ts);
      }
    }
    for (const thread of threads) {
      try {
        for await (const page of paginate((cursor) =>
          client.conversations.replies({ channel, ts: thread, oldest: since, inclusive: false, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }),
        )) {
          for (const message of ((page as { messages?: SlackMessage[] }).messages ?? [])) {
            if (!message.ts || message.ts === thread || message.ts <= since) continue;
            await sink.receive(`history:${channel}:${message.ts}:${message.edited?.ts ?? ""}`, { source: "history", channel, message } satisfies Raw);
            added++;
          }
        }
      } catch (error) {
        // A thread whose first message is gone cannot be read any more.
        if (!/thread_not_found/.test(String(error))) throw error;
      }
    }
    return added;
  }

  // ---- Send ----

  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const { channel, threadTs } = await this.#target(to);
    const posted = await this.#sdk!.postWithSendId(this.#sdk!.threadIdFor(channel, threadTs), this.#outgoing(text), sendId);
    const response = posted.raw as { channel?: string; message?: SlackMessage };
    const message: SlackMessage = {
      metadata: { event_type: SEND_EVENT_TYPE, event_payload: { send_id: sendId } },
      ...(response.message ?? ({ type: "message", ts: posted.id, text, user: this.#botUserId } as SlackMessage)),
      ts: response.message?.ts ?? posted.id,
    };
    return { message: this.message(channel, message.ts!), place: this.place(channel), raw: { source: "sent", channel, message } satisfies Raw };
  }

  async findSent(to: Address, sendId: string, since: number): Promise<SentMessage | undefined> {
    const { channel, threadTs } = await this.#target(to);
    const oldest = ((since - 60_000) / 1000).toFixed(6);
    const pages = threadTs
      ? paginate((cursor) => this.#client.conversations.replies({ channel, ts: threadTs, oldest, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }))
      : paginate((cursor) => this.#client.conversations.history({ channel, oldest, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}) }));
    for await (const page of pages) {
      for (const message of ((page as { messages?: SlackMessage[] }).messages ?? [])) {
        if (message.metadata?.event_type === SEND_EVENT_TYPE && message.metadata.event_payload?.send_id === sendId && message.ts) {
          return { message: this.message(channel, message.ts), place: this.place(channel), raw: { source: "history", channel, message } satisfies Raw };
        }
      }
    }
    return undefined;
  }

  /** Where a send goes: a place, a thread (any message in it; replies go to its first message), or a person (DM). */
  async #target(to: Address): Promise<{ channel: string; threadTs?: string }> {
    const parsed = this.#parse(to);
    if ("user" in parsed) {
      const opened = await this.#client.conversations.open({ users: parsed.user });
      const channel = (opened.channel as { id?: string } | undefined)?.id;
      if (!channel) throw new Error(`cannot open a DM with ${to}`);
      return { channel };
    }
    if (!parsed.ts) return { channel: parsed.channel };
    const replies = await this.#client.conversations.replies({ channel: parsed.channel, ts: parsed.ts, limit: 1 }).catch(() => undefined);
    const first = (replies?.messages as SlackMessage[] | undefined)?.[0];
    return { channel: parsed.channel, threadTs: first?.thread_ts ?? parsed.ts };
  }

  /** Person and place addresses in angle brackets become Slack mentions. */
  #outgoing(text: string): string {
    const prefix = this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp(`<${prefix}:@([A-Z0-9]+)>`, "g"), "<@$1>")
      .replace(new RegExp(`<${prefix}:#([A-Z0-9]+)>`, "g"), "<#$1>");
  }

  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("channel" in parsed) || !parsed.ts) throw new Error(`not a message address: ${message}`);
    const name = emoji.trim().replace(/^:|:$/g, "");
    try {
      if (remove) await this.#client.reactions.remove({ channel: parsed.channel, timestamp: parsed.ts, name });
      else await this.#client.reactions.add({ channel: parsed.channel, timestamp: parsed.ts, name });
    } catch (error) {
      // Already there, or already gone: the reaction is as asked.
      if (!/already_reacted|no_reaction/.test(String(error))) throw error;
    }
  }

  /**
   * Any Slack Web API method with the bot token, for example chat.update or files.uploadV2.
   * Methods the Slack SDK implements as helpers (files.uploadV2) run through the helper; a "file" given as a path is read.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.#client;
    const parts = method.split(".");
    let owner: any = client;
    for (const part of parts.slice(0, -1)) owner = owner?.[part];
    const helper = owner?.[parts.at(-1)!];
    const args = { ...params };
    if (typeof args.file === "string") args.file = createReadStream(expandHome(args.file));
    if (Array.isArray(args.file_uploads)) {
      args.file_uploads = args.file_uploads.map((upload: Record<string, unknown>) =>
        typeof upload.file === "string" ? { ...upload, file: createReadStream(expandHome(upload.file)) } : upload,
      );
    }
    if (typeof helper === "function") return helper.call(owner, args);
    return client.apiCall(method, args);
  }
}

function authorOf(message: SlackMessage): string | undefined {
  return message.user ?? message.bot_profile?.user_id ?? message.bot_id;
}

function files(message: SlackMessage): { files?: FileInfo[] } {
  if (!message.files?.length) return {};
  return {
    files: message.files.map((file) => ({
      ...(file.name ? { name: file.name } : {}),
      ...(file.mimetype ? { type: file.mimetype } : {}),
      ...(file.url_private ? { url: file.url_private } : {}),
    })),
  };
}

function tsToMs(ts: string | undefined): number {
  const value = ts ? Number.parseFloat(ts) : Number.NaN;
  return Number.isFinite(value) ? Math.round(value * 1000) : Date.now();
}

async function* paginate<T extends { response_metadata?: { next_cursor?: string } }>(fetch: (cursor?: string) => Promise<T>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    yield page;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

function quietLogger(log: ChannelSink["log"]) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: unknown) => log(`slack sdk: ${message}`, { data: String(data ?? "") }),
    error: (message: string, data?: unknown) => log(`slack sdk: ${message}`, { data: String(data ?? "") }),
    child: () => logger,
  };
  return logger;
}
