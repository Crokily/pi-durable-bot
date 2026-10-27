import { readFile } from "node:fs/promises";
import type { AgentPort, Wake, WakeReason } from "../core/types.ts";
import type { Jev } from "./jev.ts";
import type { LogStore, MessageRow } from "./store.ts";

export interface WakerOptions {
  botName: string;
  debounceMs: number;
  debounceMaxMs: number;
  responsibilitiesFile: string;
  log: (message: string, data?: Record<string, unknown>) => void;
}

interface Batch {
  messages: (MessageRow & { channel_type: string })[];
  first: number;
  timer: NodeJS.Timeout;
}

/**
 * Decides when new messages wake the agent. Per channel, it waits until people stop typing
 * (debounceMs after the last message, at most debounceMaxMs after the first), then:
 * 1. the agent works on this channel now → steer;
 * 2. a message @-mentions the bot or is a DM → wake;
 * 3. otherwise Jev decides.
 */
export class Waker {
  readonly #batches = new Map<string, Batch>();
  readonly #flushing = new Set<Promise<void>>();
  readonly #store: LogStore;
  readonly #jev: Jev;
  readonly #options: WakerOptions;
  readonly #channelName: (channel: string) => Promise<string | undefined>;
  agent?: AgentPort;

  constructor(store: LogStore, jev: Jev, options: WakerOptions, channelName: (channel: string) => Promise<string | undefined>) {
    this.#store = store;
    this.#jev = jev;
    this.#options = options;
    this.#channelName = channelName;
  }

  add(message: MessageRow & { channel_type: string }): void {
    const now = Date.now();
    const batch = this.#batches.get(message.channel);
    // Recovery can offer a message twice (backfill, then the undecided list).
    if (batch?.messages.some((queued) => queued.ts === message.ts)) return;
    if (batch) {
      clearTimeout(batch.timer);
      batch.messages.push(message);
    }
    const current = batch ?? { messages: [message], first: now, timer: undefined as unknown as NodeJS.Timeout };
    const wait = Math.max(0, Math.min(this.#options.debounceMs, current.first + this.#options.debounceMaxMs - now));
    current.timer = setTimeout(() => this.#flush(message.channel), wait);
    this.#batches.set(message.channel, current);
  }

  /** Stop timers. Undecided messages stay undecided in the log and are picked up on the next start. */
  async stop(): Promise<void> {
    for (const batch of this.#batches.values()) clearTimeout(batch.timer);
    this.#batches.clear();
    await Promise.allSettled(this.#flushing);
  }

  #flush(channel: string): void {
    const batch = this.#batches.get(channel);
    if (!batch) return;
    this.#batches.delete(channel);
    const task = this.#decide(channel, batch.messages)
      .catch((error) => this.#options.log("wake decision failed", { channel, error: String(error) }))
      .finally(() => this.#flushing.delete(task));
    this.#flushing.add(task);
  }

  async #decide(channel: string, batch: Batch["messages"]): Promise<void> {
    const agent = this.agent;
    if (!agent) throw new Error("no agent");
    // A message deleted while we waited is no reason to wake.
    const deleted = new Set(await this.#store.deletedAmong(channel, batch.map((message) => message.ts)));
    if (deleted.size > 0) await this.#store.setWake(channel, [...deleted], "deleted");
    const messages = batch.filter((message) => !deleted.has(message.ts));
    if (messages.length === 0) return;
    const tss = messages.map((message) => message.ts);
    const base = await this.#wakeBase(channel, messages);

    const direct: WakeReason | undefined = messages.some((message) => message.channel_type === "im")
      ? "dm"
      : messages.some((message) => message.is_mention)
        ? "mention"
        : undefined;

    if (await agent.isActiveChannel(channel)) {
      const note = direct === "mention" ? "其中有 @ 你的消息" : undefined;
      const wake: Wake = { ...base, id: `steer:${channel}:${tss.at(-1)}`, reason: "steer", ...(note ? { note } : {}) };
      await this.#store.addWake(wake.id, wake.reason, channel, { messages: tss });
      await agent.steer(wake);
      await this.#store.setWake(channel, tss, "steer");
      this.#options.log("steer", { channel, count: messages.length });
      return;
    }

    if (direct) {
      const wake: Wake = { ...base, id: `${direct}:${channel}:${tss.at(-1)}`, reason: direct };
      await this.#store.addWake(wake.id, wake.reason, channel, { messages: tss });
      await agent.wake(wake);
      await this.#store.setWake(channel, tss, direct);
      this.#options.log("wake", { reason: direct, channel, count: messages.length });
      return;
    }

    const earlier = await this.#store.recentMessages(channel, messages[0]!.ts, 15);
    const responsibilities = await readFile(this.#options.responsibilitiesFile, "utf8").catch(() => "");
    const toJev = (message: MessageRow) => ({
      author: message.is_self ? `${this.#options.botName} (me)` : (message.user_name ?? message.user_id ?? "unknown"),
      text: message.text,
      ts: message.ts,
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
    });
    const answer = await this.#jev.judge({
      botName: this.#options.botName,
      responsibilities,
      channel: base.channelName ?? channel,
      earlier: earlier.map(toJev),
      latest: messages.map(toJev),
    });
    const id = `relevant:${channel}:${tss.at(-1)}`;
    const detail = { messages: tss, related: answer.related, respond: answer.respond };
    this.#options.log("jev", { channel, count: messages.length, related: answer.related, respond: answer.respond, wake: answer.wake });
    if (!answer.wake) {
      await this.#store.setWake(channel, tss, "not_relevant");
      return;
    }
    const note = `Jev: related ${answer.related.toFixed(2)}, needs response ${answer.respond.toFixed(2)}`;
    await this.#store.addWake(id, "relevant", channel, detail);
    await agent.wake({ ...base, id, reason: "relevant", note });
    await this.#store.setWake(channel, tss, "relevant");
  }

  async #wakeBase(channel: string, messages: Batch["messages"]): Promise<Omit<Wake, "id" | "reason">> {
    const people = [...new Set(messages.map((message) => `${message.user_name ?? "unknown"} (${message.user_id ?? "?"})`))];
    const threads = new Set(messages.map((message) => message.thread_ts ?? ""));
    const thread = threads.size === 1 ? [...threads][0] : undefined;
    return {
      channel,
      channelName: await this.#channelName(channel),
      ...(thread ? { threadTs: thread } : {}),
      people,
      fromTs: messages[0]!.ts,
      toTs: messages.at(-1)!.ts,
      count: messages.length,
    };
  }
}
