// The interface between the gateway core and the bot. Common words only.
import type { TelemetryCarrier, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Address, PersonInfo, PlaceInfo } from "./channel.ts";
import type { JudgeAnswer } from "./judge.ts";

/** A file of a message, as a wake gives it. */
export interface WakeFile {
  readonly name?: string;
  readonly type?: string;
  /** Where the gateway saved it on this computer. */
  readonly path?: string;
  /** Where the platform has it, when it was not saved. */
  readonly url?: string;
  /** Why it was not saved. */
  readonly error?: string;
}

/** The message that starts the thread a message is in. */
export interface ThreadStart {
  readonly person?: PersonInfo;
  readonly fromMe: boolean;
  readonly text: string;
  readonly deleted?: boolean;
}

/**
 * One logged event the gateway tells the bot about, with what it says: the text, the start of its thread and its files.
 * Earlier messages and other details are in the log.
 */
export interface WakeEvent {
  /** Row ID in the log's event table. */
  readonly id: number;
  readonly kind: string;
  readonly at: number;
  readonly message?: Address;
  readonly thread?: Address;
  readonly person?: PersonInfo;
  readonly mentionsMe: boolean;
  /** The message's current text for a message or an edit; the emoji for a reaction. */
  readonly text?: string;
  /** A message whose text was edited after it came: the text is the edited one. */
  readonly edited?: boolean;
  /** The message was deleted since. */
  readonly deleted?: boolean;
  /** When the message is a reply in a thread: the message that starts it, as it is now. */
  readonly threadStart?: ThreadStart;
  readonly files?: readonly WakeFile[];
}

/**
 * Why the gateway wakes the bot:
 * - "mention": someone @-mentioned the bot;
 * - "dm": a one-to-one DM;
 * - "relevant": the judge found it related and needing a response, or could not judge;
 * - "heard": no mention, and the bot has no judge, so every event comes to it;
 * - "steer": new events in a place the bot works on now.
 */
export type PlaceWakeReason = "mention" | "dm" | "relevant" | "heard" | "steer";

export interface PlaceWake {
  /** Stable for the same events, so a repeated delivery is one wake. */
  readonly id: string;
  readonly reason: PlaceWakeReason;
  readonly place: PlaceInfo;
  readonly events: readonly WakeEvent[];
  /** The judge's answers, for "relevant", or why it failed. */
  readonly judged?: JudgeAnswer | { readonly error: string };
}

/** What the bot answers when it took a wake. */
export interface Delivered {
  /** The agent's submission for the wake. The same wake ID gives the same submission. */
  readonly submission: string;
  /** The trace context of the agent's run for it, as pi-durable stored it, also when the wake came before. */
  readonly run?: TelemetryCarrier | undefined;
}

/** The bot, as the gateway's waker sees it. */
export interface WakeTarget {
  /** True while the bot's current work is about this place. */
  isWorkingOn(place: Address): boolean;
  /**
   * Hand the wake to the bot. Durable once it resolves. caller: the wake's span, for the agent's telemetry to link its
   * run to.
   */
  deliver(wake: PlaceWake, caller?: TelemetrySpan): Promise<Delivered>;
  /** What the bot is responsible for, for the judge. */
  responsibilities(): Promise<string>;
  /** The bot's name, for the judge. */
  readonly name: string;
}
