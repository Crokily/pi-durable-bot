// The interface between the gateway core and the bot. Common words only.
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

/** The bot, as the gateway's waker sees it. */
export interface WakeTarget {
  /** True while the bot's current work is about this place. */
  isWorkingOn(place: Address): boolean;
  /** Hand the wake to the bot. Durable once it resolves. */
  deliver(wake: PlaceWake): Promise<void>;
  /** What the bot is responsible for, for the judge. */
  responsibilities(): Promise<string>;
  /** The bot's name, for the judge. */
  readonly name: string;
}
