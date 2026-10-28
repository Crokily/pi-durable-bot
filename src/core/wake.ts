// The interface between the gateway core and the bot. Common words only.
import type { TelemetryCarrier, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Address, PersonInfo, PlaceInfo } from "./channel.ts";
import type { JudgeAnswer } from "./judge.ts";

/** One logged event the gateway tells the bot about. No content: the agent reads that from the log. */
export interface WakeEvent {
  /** Row ID in the log's event table. */
  readonly id: number;
  readonly kind: string;
  readonly at: number;
  readonly message?: Address;
  readonly thread?: Address;
  readonly person?: PersonInfo;
  readonly mentionsMe: boolean;
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
