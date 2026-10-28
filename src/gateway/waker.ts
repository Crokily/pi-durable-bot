import type { PlaceInfo } from "../core/channel.ts";
import type { Judge, JudgeAnswer, JudgeItem } from "../core/judge.ts";
import type { PlaceWake, PlaceWakeReason, WakeEvent, WakeTarget } from "../core/wake.ts";
import type { LoggedMessage, MessageLog, UndecidedEvent } from "./log.ts";

export interface WakerSettings {
  /** Wait this long after the last event in a place before deciding. */
  readonly debounceMs: number;
  /** Never wait longer than this after the first event. */
  readonly debounceMaxMs: number;
  /** The judge wakes the bot when both answers are at least this probable. */
  readonly judgeThreshold: number;
  /** How many earlier messages of the place the judge sees. */
  readonly judgeContextMessages: number;
}

interface Batch {
  readonly events: UndecidedEvent[];
  readonly first: number;
  timer: NodeJS.Timeout;
}

type Log = (message: string, data?: Record<string, unknown>) => void;

/**
 * Decides when new events wake the bot. Per place, it waits until people stop (debounce), then:
 * 1. the bot works on this place now → steer;
 * 2. an event @-mentions the bot, or the place is a one-to-one DM → wake;
 * 3. otherwise the judge decides; with no judge, every event wakes the bot.
 */
export class Waker {
  readonly #batches = new Map<string, Batch>();
  readonly #deciding = new Set<Promise<void>>();
  readonly #log: MessageLog;
  readonly #judge: () => Judge | undefined;
  readonly #settings: () => WakerSettings;
  readonly #print: Log;
  target?: WakeTarget;

  constructor(log: MessageLog, judge: () => Judge | undefined, settings: () => WakerSettings, print: Log) {
    this.#log = log;
    this.#judge = judge;
    this.#settings = settings;
    this.#print = print;
  }

  add(event: UndecidedEvent): void {
    const key = event.place ?? `${event.channel}:`;
    const now = Date.now();
    const settings = this.#settings();
    const batch = this.#batches.get(key);
    if (batch?.events.some((queued) => queued.id === event.id)) return;
    if (batch) {
      clearTimeout(batch.timer);
      batch.events.push(event);
    }
    const current: Batch = batch ?? { events: [event], first: now, timer: undefined as unknown as NodeJS.Timeout };
    const wait = Math.max(0, Math.min(settings.debounceMs, current.first + settings.debounceMaxMs - now));
    current.timer = setTimeout(() => this.#flush(key), wait);
    this.#batches.set(key, current);
  }

  /** Stop the timers. Undecided events stay undecided in the log and come back on the next start. */
  async stop(): Promise<void> {
    for (const batch of this.#batches.values()) clearTimeout(batch.timer);
    this.#batches.clear();
    await Promise.allSettled(this.#deciding);
  }

  #flush(key: string): void {
    const batch = this.#batches.get(key);
    if (!batch) return;
    this.#batches.delete(key);
    const task = this.#decide(batch.events)
      .catch((error) => this.#print("wake decision failed", { place: key, error: String(error) }))
      .finally(() => this.#deciding.delete(task));
    this.#deciding.add(task);
  }

  async #decide(events: UndecidedEvent[]): Promise<void> {
    const target = this.target;
    if (!target) throw new Error("no wake target");
    const first = events[0]!;
    const place: PlaceInfo = first.place
      ? { address: first.place, kind: first.place_kind ?? "channel", ...(first.place_name ? { name: first.place_name } : {}) }
      : { address: `${first.channel}:`, kind: "channel", name: first.channel };
    const ids = events.map((event) => event.id);
    const wakeEvents = events.map(toWakeEvent);
    const id = (reason: string) => `${reason}:${place.address}:${ids.at(-1)}`;

    const deliver = async (reason: PlaceWakeReason, decision: string, judged?: PlaceWake["judged"]) => {
      await target.deliver({ id: id(reason), reason, place, events: wakeEvents, ...(judged ? { judged } : {}) });
      await this.#log.setWake(ids, decision);
      this.#print("wake", { reason, place: place.address, events: ids.length });
    };

    if (target.isWorkingOn(place.address)) return deliver("steer", "steer");
    if (place.kind === "dm") return deliver("dm", "dm");
    if (events.some((event) => event.mentions_me)) return deliver("mention", "mention");

    const judge = this.#judge();
    if (!judge) return deliver("heard", "heard");
    const settings = this.#settings();
    let answer: JudgeAnswer;
    try {
      answer = await this.#askJudge(judge, target, place, events, settings);
    } catch (error) {
      // The judge could not decide. Nothing is dropped: the bot gets the events and decides itself.
      this.#print("judge failed", { place: place.address, error: String(error) });
      return deliver("relevant", "relevant", { error: String(error) });
    }
    this.#print("judge", { place: place.address, events: ids.length, related: answer.related, respond: answer.respond });
    if (answer.related >= settings.judgeThreshold && answer.respond >= settings.judgeThreshold) {
      return deliver("relevant", "relevant", answer);
    }
    // The bot may have started working on this place while the judge thought.
    if (target.isWorkingOn(place.address)) return deliver("steer", "steer");
    await this.#log.setWake(ids, "judge_no");
  }

  async #askJudge(judge: Judge, target: WakeTarget, place: PlaceInfo, events: UndecidedEvent[], settings: WakerSettings): Promise<JudgeAnswer> {
    const earlier = await this.#log.messagesBefore(place.address, events[0]!.at, settings.judgeContextMessages);
    const latest: JudgeItem[] = [];
    for (const event of events) latest.push(await this.#describe(event, target.name));
    const input = {
      name: target.name,
      responsibilities: await target.responsibilities(),
      place: `${place.name ?? place.address} (${place.kind})`,
      earlier: earlier.map((message) => messageItem(message, target.name)),
      latest,
    };
    let lastError: unknown;
    for (const delay of [0, 2_000, 8_000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        return await judge.judge(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** An event as the judge sees it: what happened, with the current state of the message it is about. */
  async #describe(event: UndecidedEvent, name: string): Promise<JudgeItem> {
    const author = event.person_name ?? event.person ?? "unknown";
    const time = new Date(event.at).toISOString();
    const message = event.message ? await this.#log.message(event.message) : undefined;
    const state = message?.deleted_at ? " (since deleted)" : "";
    const thread = event.thread ? { thread: event.thread } : {};
    switch (event.kind) {
      case "message":
        return { what: `new message${state}`, author, time, text: message?.text ?? event.text ?? "", ...thread };
      case "edit":
        return { what: `edited a message${state}`, author, time, text: message?.text ?? event.text ?? "", ...thread };
      default: {
        const about = message ? ` on ${message.from_me ? `${name}'s` : `${message.person_name ?? "someone"}'s`} message${state}` : "";
        return {
          what: `${event.kind}${event.text && event.kind !== "update" ? ` ${event.text}` : ""}${about}`,
          author,
          time,
          ...(message ? { text: message.text } : {}),
          ...thread,
        };
      }
    }
  }
}

function toWakeEvent(event: UndecidedEvent): WakeEvent {
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    mentionsMe: event.mentions_me === 1,
    ...(event.message ? { message: event.message } : {}),
    ...(event.thread ? { thread: event.thread } : {}),
    ...(event.person ? { person: { address: event.person, ...(event.person_name ? { name: event.person_name } : {}) } } : {}),
  };
}

function messageItem(message: LoggedMessage, name: string): JudgeItem {
  return {
    what: message.deleted_at ? "message (since deleted)" : "message",
    author: message.from_me ? `${name} (me)` : (message.person_name ?? message.person ?? "unknown"),
    time: new Date(message.at).toISOString(),
    text: message.text,
    ...(message.thread ? { thread: message.thread } : {}),
  };
}
