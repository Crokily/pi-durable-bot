import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackEvent } from "@chat-adapter/slack";
import { Chat, type Message } from "chat";
import type { AgentPort, GatewayPort, SendResult, SqlValue } from "../core/types.ts";
import { Jev } from "./jev.ts";
import { GatewaySlackAdapter, SEND_EVENT_TYPE } from "./slack.ts";
import type { LogStore, MessageRow } from "./store.ts";
import { Waker } from "./waker.ts";

export interface GatewayOptions {
  botName: string;
  slackAppToken: string;
  slackBotToken: string;
  jevApiKey: string;
  jevThreshold: number;
  debounceMs: number;
  debounceMaxMs: number;
  responsibilitiesFile: string;
  defaultPatrolMinutes: number;
  log: (message: string, data?: Record<string, unknown>) => void;
}

/** Subtypes that are not something a person said. Logged, never wake the agent. */
const SYSTEM_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "ekm_access_denied",
]);
/** Events that only say something about another message. */
const IGNORED_SUBTYPES = new Set(["message_replied", "tombstone"]);
/** Human messages older than this are not woken on after a restart or backfill. */
const RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000;

type Envelope = { event_id?: string; event?: SlackEvent & { type?: string; message?: SlackEvent; previous_message?: SlackEvent; hidden?: boolean } };

/**
 * The fixed part of the bot: receive and log, decide on waking, and the send tools.
 * Everything else the agent does itself with code mode.
 */
export class Gateway implements GatewayPort {
  readonly botName: string;
  readonly #options: GatewayOptions;
  readonly #store: LogStore;
  readonly #adapter: GatewaySlackAdapter;
  readonly #chat: Chat;
  readonly #waker: Waker;
  /** Events are applied in arrival order, one at a time, so an edit never overtakes its message. */
  #queue: Promise<void> = Promise.resolve();
  #patrolTimer?: NodeJS.Timeout;
  #patrolCheck: Promise<void> = Promise.resolve();
  readonly #channelNames = new Map<string, string | undefined>();
  readonly #userIsBot = new Map<string, boolean>();
  #agent?: AgentPort;
  #stopped = false;

  constructor(store: LogStore, options: GatewayOptions) {
    this.botName = options.botName;
    this.#options = options;
    this.#store = store;
    this.#adapter = new GatewaySlackAdapter({
      mode: "socket",
      appToken: options.slackAppToken,
      botToken: options.slackBotToken,
      userName: options.botName,
      logger: quietLogger(options.log),
    });
    this.#adapter.onSocketEvent = (body) => this.#receive(body as Envelope);
    this.#adapter.onError = (error) => options.log("socket event not stored, Slack will retry", { error: String(error) });
    // Chat holds the adapter and its in-memory state. No handlers: Chat SDK only translates.
    this.#chat = new Chat({ userName: options.botName, adapters: { slack: this.#adapter }, state: createMemoryState(), logger: "warn" });
    this.#waker = new Waker(
      store,
      new Jev(options.jevApiKey, options.jevThreshold),
      { botName: options.botName, debounceMs: options.debounceMs, debounceMaxMs: options.debounceMaxMs, responsibilitiesFile: options.responsibilitiesFile, log: options.log },
      (channel) => this.#channelName(channel),
    );
  }

  /** Connect to Slack and recover what a previous process left. */
  async start(agent: AgentPort): Promise<void> {
    this.#agent = agent;
    this.#waker.agent = agent;
    await this.#chat.initialize();
    this.#options.log("slack connected", { botUserId: this.#adapter.botUserId });

    for (const { event_id, body } of await this.#store.unfinishedEvents()) {
      this.#enqueue(event_id, JSON.parse(body) as Envelope);
    }
    await this.#queue;
    await this.#backfill().catch((error) => this.#options.log("backfill failed", { error: String(error) }));
    for (const message of await this.#store.undecided(Date.now() - RECOVERY_WINDOW_MS)) {
      const channel = await this.#store.channel(message.channel);
      this.#waker.add({ ...message, channel_type: channel?.type ?? "channel" });
    }

    if (!(await this.#store.pendingPatrol())) await this.#defaultPatrol();
    this.#patrolTimer = setInterval(() => this.#checkPatrol(), 15_000);
    this.#checkPatrol();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#patrolTimer);
    await this.#adapter.disconnect().catch(() => {});
    await this.#waker.stop();
    await this.#queue;
    await this.#patrolCheck;
  }

  // ---- Receive ----

  /** Called before the ack. Stores the raw event; a known event ID is a redelivery and is dropped. */
  async #receive(body: Envelope): Promise<void> {
    const eventId = body.event_id;
    if (!eventId || !body.event) return;
    // Slack's legacy verification token rides along in every envelope. It is not stored.
    const { token: _token, ...stored } = body as Envelope & { token?: unknown };
    if (!(await this.#store.addEvent(eventId, stored))) return;
    this.#enqueue(eventId, stored);
  }

  #enqueue(eventId: string, body: Envelope): void {
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#apply(eventId, body);
        await this.#store.finishEvent(eventId);
      } catch (error) {
        this.#options.log("event failed", { eventId, error: String(error) });
        await this.#store.finishEvent(eventId, String(error)).catch(() => {});
      }
    });
  }

  async #apply(eventId: string, { event }: Envelope): Promise<void> {
    if (!event) return;
    if (event.type === "member_joined_channel") {
      if (event.channel) this.#channelNames.delete(event.channel);
      if (event.channel) await this.#channelName(event.channel);
      return;
    }
    if (event.type !== "message" && event.type !== "app_mention") return;
    if (!event.channel) return;
    if (event.subtype === "message_changed") return this.#applyEdit(eventId, event);
    if (event.subtype === "message_deleted") {
      const ts = event.deleted_ts ?? event.previous_message?.ts;
      if (ts) await this.#store.deleteMessage(event.channel, ts, tsToMs(event.event_ts ?? event.ts), eventId);
      return;
    }
    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return;
    await this.#logMessage(event, eventId);
  }

  async #applyEdit(eventId: string, event: NonNullable<Envelope["event"]>): Promise<void> {
    const inner = event.message;
    if (!inner?.ts || inner.subtype === "tombstone") return;
    const before = event.previous_message;
    // message_changed also reports unfurls and reply counts. Only text changes are edits.
    if (before && inner.text === before.text) return;
    const normalized = { ...inner, channel: event.channel, channel_type: event.channel_type, type: "message" };
    const translated = await this.#adapter.translate(normalized);
    await this.#store.editMessage(event.channel!, inner.ts, translated.text, tsToMs(inner.edited?.ts ?? event.event_ts), eventId);
  }

  /** Log a message. New human messages go to the waker. */
  async #logMessage(event: SlackEvent & { subtype?: string }, eventId: string | null): Promise<void> {
    const channel = event.channel!;
    const ts = event.ts!;
    const translated = await this.#adapter.translate(event);
    const isSelf = this.#adapter.isSelf(event);
    const isBot = isSelf || (await this.#rememberUser(event, translated));
    const system = event.subtype !== undefined && SYSTEM_SUBTYPES.has(event.subtype);
    const channelType = event.channel_type ?? (await this.#store.channel(channel))?.type ?? "channel";
    await this.#channelName(channel, channelType);
    const row: MessageRow & { channel_type: string } = {
      channel,
      ts,
      thread_ts: event.thread_ts ?? null,
      user_id: translated.author.userId,
      user_name: translated.author.userName,
      is_bot: isBot ? 1 : 0,
      is_self: isSelf ? 1 : 0,
      is_mention: translated.isMention ? 1 : 0,
      text: translated.text,
      created_at: tsToMs(ts),
      wake: isSelf ? "self" : isBot ? "bot" : system ? "system" : null,
      channel_type: channelType,
    };
    const files = event.files?.length ? JSON.stringify(event.files.map((file) => ({ id: file.id, name: file.name, mimetype: file.mimetype, url: file.url_private }))) : null;
    const added = await this.#store.putMessage({ ...row, subtype: event.subtype ?? null, files, event_id: eventId });
    if (added && row.wake === null && row.created_at >= Date.now() - RECOVERY_WINDOW_MS) this.#waker.add(row);
  }

  /**
   * Whether the author is a bot. A person who posts through an app (as the tests do with a user token) gets a
   * `bot_id` on the message too, so the answer comes from the author's profile, not from `bot_id`.
   */
  async #rememberUser(event: SlackEvent & { subtype?: string }, message: Message<unknown>): Promise<boolean> {
    if (!event.user) return event.subtype === "bot_message" || event.bot_id !== undefined;
    let isBot = this.#userIsBot.get(event.user);
    if (isBot === undefined) {
      try {
        const info = await this.#adapter.client.users.info({ user: event.user });
        isBot = info.user?.is_bot === true || info.user?.id === "USLACKBOT";
      } catch {
        isBot = message.author.isBot === true;
      }
      this.#userIsBot.set(event.user, isBot);
      await this.#store.putUser(event.user, message.author.userName, message.author.fullName, isBot);
    }
    return isBot;
  }

  /** Name of a channel, from cache, the log, or Slack. DMs are named after the other person. */
  async #channelName(channel: string, type?: string): Promise<string | undefined> {
    if (this.#channelNames.has(channel)) return this.#channelNames.get(channel);
    const stored = await this.#store.channel(channel);
    if (stored && stored.name) {
      this.#channelNames.set(channel, stored.name);
      return stored.name;
    }
    try {
      const info = (await this.#adapter.client.conversations.info({ channel })).channel as
        | { name?: string; user?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean }
        | undefined;
      let name = info?.name;
      if (info?.is_im && info.user) {
        const user = await this.#adapter.getUser(info.user);
        name = `dm-${user?.userName ?? info.user}`;
      }
      const kind = info?.is_im ? "im" : info?.is_mpim ? "mpim" : info?.is_private ? "group" : (type ?? "channel");
      await this.#store.putChannel(channel, name ?? null, kind);
      this.#channelNames.set(channel, name);
      return name;
    } catch (error) {
      this.#options.log("channel lookup failed", { channel, error: String(error) });
      await this.#store.putChannel(channel, null, type ?? "channel");
      return undefined;
    }
  }

  /**
   * Fill gaps from while the process was down: messages after the newest logged one in each channel the bot is in.
   * Thread replies are fetched for threads whose latest reply is newer than what the log has.
   */
  async #backfill(): Promise<void> {
    const client = this.#adapter.client;
    const list = await client.users.conversations({ types: "public_channel,private_channel,im,mpim", limit: 200 });
    for (const conversation of list.channels ?? []) {
      const channel = conversation.id!;
      const type = conversation.is_im ? "im" : conversation.is_mpim ? "mpim" : conversation.is_private ? "group" : "channel";
      if (conversation.is_im && conversation.user) {
        if (conversation.user === "USLACKBOT") continue;
        if (!(await this.#store.channel(channel))?.name) {
          const user = await this.#adapter.getUser(conversation.user);
          await this.#store.putChannel(channel, `dm-${user?.userName ?? conversation.user}`, "im");
        }
      }
      await this.#channelName(channel, type);
      const since = await this.#store.latestTs(channel);
      if (!since) continue; // A new channel: start from now, as a colleague who just joined would.
      const history = await client.conversations.history({ channel, oldest: since, inclusive: false, limit: 200 });
      const messages = (history.messages ?? []) as (SlackEvent & { reply_count?: number; latest_reply?: string })[];
      let added = 0;
      for (const message of messages.reverse()) {
        await this.#logMessage({ ...message, channel, channel_type: type }, null);
        added++;
      }
      const threads = await this.#store.sql.all<{ thread_ts: string }>(
        "SELECT DISTINCT thread_ts FROM gw_messages WHERE channel = ? AND thread_ts IS NOT NULL AND created_at >= ?",
        channel,
        Date.now() - RECOVERY_WINDOW_MS,
      );
      for (const { thread_ts } of threads) {
        const replies = await client.conversations.replies({ channel, ts: thread_ts, oldest: since, inclusive: false, limit: 200 });
        for (const reply of (replies.messages ?? []) as SlackEvent[]) {
          if (reply.ts === thread_ts || !reply.ts || reply.ts <= since) continue;
          await this.#logMessage({ ...reply, channel, channel_type: type }, null);
          added++;
        }
      }
      if (added > 0) this.#options.log("backfill", { channel, added });
    }
  }

  // ---- Patrol ----

  async #defaultPatrol(): Promise<void> {
    const minutes = this.#options.defaultPatrolMinutes;
    await this.#store.setPatrol(Date.now() + minutes * 60_000, `定时巡视（默认 ${minutes} 分钟，你还没有自己设置下一次巡视）`, "default");
  }

  #checkPatrol(): void {
    this.#patrolCheck = this.#patrolCheck.then(async () => {
      if (this.#stopped || !this.#agent) return;
      const patrol = await this.#store.pendingPatrol();
      if (!patrol || patrol.due_at > Date.now()) return;
      const id = `patrol:${patrol.id}`;
      await this.#store.addWake(id, "patrol", undefined, { note: patrol.note });
      await this.#agent.wake({ id, reason: "patrol", people: [], count: 0, note: patrol.note });
      await this.#store.firePatrol(patrol.id);
      // The loop never ends: a default next patrol, which the agent replaces when it sets its own.
      await this.#defaultPatrol();
      this.#options.log("patrol", { id });
    }).catch((error) => this.#options.log("patrol failed", { error: String(error) }));
  }

  async schedulePatrol(minutes: number, note: string): Promise<number> {
    if (!(minutes >= 1 && minutes <= 7 * 24 * 60)) throw new Error("minutes must be between 1 and 10080");
    const dueAt = Date.now() + Math.round(minutes * 60_000);
    await this.#store.setPatrol(dueAt, note, "agent");
    return dueAt;
  }

  async nextPatrol(): Promise<{ dueAt: number; note: string } | undefined> {
    const patrol = await this.#store.pendingPatrol();
    return patrol && { dueAt: patrol.due_at, note: patrol.note };
  }

  // ---- Send ----

  /**
   * Send once per send ID, across crashes:
   * - outbox says sent → return it;
   * - outbox says sending (a crash in the middle) → look on Slack for a message with this send ID in its metadata,
   *   and only send when there is none;
   * - otherwise record "sending", send, record "sent".
   */
  async send(sendId: string, input: { channel: string; text: string; threadTs?: string }): Promise<SendResult> {
    if (!input.text.trim()) throw new Error("text is empty");
    let record = await this.#store.outbox(sendId);
    if (record?.state === "sent") return { channel: record.channel, ts: record.ts! };
    if (record) {
      const found = await this.#findSent(record.channel, record.thread_ts ?? undefined, sendId, record.created_at);
      if (found) {
        await this.#store.outboxDone(sendId, found);
        this.#options.log("send recovered", { sendId });
        return { channel: record.channel, ts: found, recovered: true };
      }
    } else {
      const channel = await this.#resolveChannel(input.channel);
      await this.#store.outboxStart(sendId, channel, input.threadTs, input.text);
      record = (await this.#store.outbox(sendId))!;
    }
    const threadTs = record.thread_ts ?? undefined;
    const posted = await this.#adapter.postWithSendId(this.#adapter.threadIdFor(record.channel, threadTs), input.text, sendId);
    await this.#store.outboxDone(sendId, posted.id);
    // The event for this message arrives later too; this row makes the log complete right away.
    await this.#store.putMessage({
      channel: record.channel,
      ts: posted.id,
      thread_ts: threadTs ?? null,
      user_id: this.#adapter.botUserId ?? null,
      user_name: this.botName,
      is_bot: 1,
      is_self: 1,
      is_mention: 0,
      text: input.text,
      created_at: tsToMs(posted.id),
      send_id: sendId,
      wake: "self",
    });
    return { channel: record.channel, ts: posted.id };
  }

  async #findSent(channel: string, threadTs: string | undefined, sendId: string, since: number): Promise<string | undefined> {
    const client = this.#adapter.client;
    const oldest = ((since - 60_000) / 1000).toFixed(6);
    const result = threadTs
      ? await client.conversations.replies({ channel, ts: threadTs, oldest, limit: 200, include_all_metadata: true })
      : await client.conversations.history({ channel, oldest, limit: 200, include_all_metadata: true });
    const messages = (result.messages ?? []) as { ts?: string; metadata?: { event_type?: string; event_payload?: { send_id?: string } } }[];
    return messages.find((message) => message.metadata?.event_type === SEND_EVENT_TYPE && message.metadata.event_payload?.send_id === sendId)?.ts;
  }

  /** A channel ID, "#name", or a user ID (opens the DM). */
  async #resolveChannel(target: string): Promise<string> {
    const value = target.trim();
    if (value.startsWith("#")) {
      const name = value.slice(1);
      const known = await this.#store.channelByName(name);
      if (known) return known.id;
      const list = await this.#adapter.client.users.conversations({ types: "public_channel,private_channel", limit: 200 });
      const match = list.channels?.find((channel) => channel.name === name);
      if (!match?.id) throw new Error(`I am not in a channel named #${name}`);
      return match.id;
    }
    if (/^[UW][A-Z0-9]+$/.test(value)) return this.#adapter.channelIdFromThreadId(await this.#adapter.openDM(value));
    if (/^[CGD][A-Z0-9]+$/.test(value)) return value;
    throw new Error(`unknown channel ${JSON.stringify(target)}: use a channel ID, #name, or a user ID`);
  }

  async react(input: { channel: string; ts: string; emoji: string; remove?: boolean }): Promise<void> {
    const channel = await this.#resolveChannel(input.channel);
    const threadId = this.#adapter.threadIdFor(channel);
    const emoji = input.emoji.replace(/^:|:$/g, "");
    if (input.remove) await this.#adapter.removeReaction(threadId, input.ts, emoji);
    else await this.#adapter.addReaction(threadId, input.ts, emoji);
  }

  async query(sql: string, params: readonly SqlValue[]): Promise<Record<string, unknown>[]> {
    return this.#store.query(sql, params).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value])),
    );
  }
}

function tsToMs(ts: string | undefined): number {
  const value = ts ? Number.parseFloat(ts) : Number.NaN;
  return Number.isFinite(value) ? Math.round(value * 1000) : Date.now();
}

function quietLogger(log: GatewayOptions["log"]) {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: unknown) => log(`slack: ${message}`, { data: String(data ?? "") }),
    error: (message: string, data?: unknown) => log(`slack: ${message}`, { data: String(data ?? "") }),
    child: () => logger,
  };
  return logger;
}
