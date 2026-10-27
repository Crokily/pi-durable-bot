// The interface between the gateway core and the bot. Common words only.
import type { Address, PersonInfo, PlaceInfo } from "./channel.ts";

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
 * - "relevant": Jev judged it related and needing a response;
 * - "steer": new events in a place the bot works on now.
 */
export type PlaceWakeReason = "mention" | "dm" | "relevant" | "steer";

export interface PlaceWake {
  /** Stable for the same events, so a repeated delivery is one wake. */
  readonly id: string;
  readonly reason: PlaceWakeReason;
  readonly place: PlaceInfo;
  readonly events: readonly WakeEvent[];
  /** Jev's answers, for "relevant", or when Jev failed. */
  readonly jev?: { readonly related: number; readonly respond: number } | { readonly error: string };
}

/** The bot, as the gateway's waker sees it. */
export interface WakeTarget {
  /** True while the bot's current work is about this place. */
  isWorkingOn(place: Address): boolean;
  /** Hand the wake to the bot. Durable once it resolves. */
  deliver(wake: PlaceWake): Promise<void>;
  /** What the bot is responsible for, for Jev. */
  responsibilities(): Promise<string>;
  /** The bot's name, for Jev. */
  readonly name: string;
}
