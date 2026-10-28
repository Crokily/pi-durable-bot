// The interface between the gateway core and the channel adapters.
// Only the five common words: channel, place, thread, message, person. No platform concepts.
import { Schema } from "effect";

/**
 * An opaque string that points to a place, a thread, a message or a person. It includes the channel account.
 * Only the adapter that made it parses it. Everyone else copies it.
 */
export type Address = string;

/** A channel, a DM or a group chat. "dm" is a one-to-one direct message; a DM with more people is a "group". */
export const PlaceKind = Schema.Literals(["channel", "dm", "group"]);
export type PlaceKind = typeof PlaceKind.Type;

export const PlaceInfo = Schema.Struct({
  address: Schema.String,
  name: Schema.optional(Schema.String),
  kind: PlaceKind,
});
export type PlaceInfo = typeof PlaceInfo.Type;

export const PersonInfo = Schema.Struct({
  address: Schema.String,
  name: Schema.optional(Schema.String),
  realName: Schema.optional(Schema.String),
});
export type PersonInfo = typeof PersonInfo.Type;

export const FileInfo = Schema.Struct({
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
export type FileInfo = typeof FileInfo.Type;

/**
 * One thing that happened in a channel, in common words. The adapter makes these from the raw events it stored, and
 * the gateway checks them against this schema before it logs them.
 * kind: "message", "edit", "delete", "reaction_added", "reaction_removed", "join", "leave", "update", or another plain word.
 */
export const Happening = Schema.Struct({
  kind: Schema.NonEmptyString,
  /** Unix ms. */
  at: Schema.Finite,
  place: Schema.optional(PlaceInfo),
  /** The thread the message is in. */
  thread: Schema.optional(Schema.String),
  /** The message that starts the thread, when the adapter knows it. */
  threadRoot: Schema.optional(Schema.String),
  /** The message this is, or is about. */
  message: Schema.optional(Schema.String),
  /** Who did it. */
  person: Schema.optional(PersonInfo),
  /** Done by this channel account itself. */
  fromMe: Schema.Boolean,
  mentionsMe: Schema.optional(Schema.Boolean),
  /** Message text for "message" and "edit"; the emoji for reactions. */
  text: Schema.optional(Schema.String),
  /** People mentioned in the text. */
  mentions: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.optional(Schema.Array(FileInfo)),
  /** Set on messages this bot sent through the outbox. */
  sendId: Schema.optional(Schema.String),
  /** The platform data this happening comes from. Kept in the log next to the common fields. */
  raw: Schema.optional(Schema.Unknown),
});
export type Happening = typeof Happening.Type;

/** What the gateway gives an adapter. */
export interface ChannelSink {
  /**
   * Store a raw event before it is acknowledged. Resolves once it is in the inbox. A known event ID is dropped.
   * Messages found by backfill go through here too.
   */
  receive(eventId: string, raw: unknown): Promise<void>;
  /** The newest logged message in a place, for backfill. */
  newestMessage(place: Address): Promise<Address | undefined>;
  /** Threads the log knows in a place. */
  threads(place: Address): Promise<Address[]>;
  /** When the gateway last ran, in Unix ms. Undefined on the first start. */
  lastAlive(): number | undefined;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface SentMessage {
  readonly message: Address;
  /** The place the message is in. */
  readonly place: Address;
  /** Platform data of the sent message, stored as an inbox event so the log gets it. */
  readonly raw: unknown;
}

/** One channel account. Only translation: receive, backfill, send, react, direct platform calls, find a sent message. */
export interface ChannelAdapter {
  /** The channel account ID, for example "slack". Addresses of this account start with it. */
  readonly id: string;
  /** This account's own person address, once started. */
  readonly me: PersonInfo | undefined;
  /** Connect and deliver events to the sink. */
  start(sink: ChannelSink): Promise<void>;
  /** Store what was missed while the gateway was down, as events through the sink. */
  backfill(sink: ChannelSink): Promise<void>;
  stop(): Promise<void>;
  /** True when this adapter made the address. */
  owns(address: Address): boolean;
  /** The place a place, thread or message address is in. Undefined for a person. */
  placeOf(address: Address): Address | undefined;
  /** Turn a stored raw event into happenings. */
  translate(raw: unknown): Promise<Happening[]>;
  /** Send text to a place, thread, message (reply in its thread) or person (DM), with the send ID attached. */
  send(to: Address, text: string, sendId: string): Promise<SentMessage>;
  /** Look for a message with this send ID, sent to `to` after `since`. */
  findSent(to: Address, sendId: string, since: number): Promise<SentMessage | undefined>;
  react(message: Address, emoji: string, remove: boolean): Promise<void>;
  /** Call a platform API method directly. The token stays in the adapter. */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** What a channel module exports: a factory from the channel's entry in bot.json. */
export interface ChannelModule {
  createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter | Promise<ChannelAdapter>;
}

export interface ChannelConfig {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ChannelEnv {
  /** The bot's folder. */
  readonly botDir: string;
  /** The bot's name, for adapters that need one. */
  readonly botName: string;
  log(message: string, data?: Record<string, unknown>): void;
}
