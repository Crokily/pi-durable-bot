import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Address, ChannelAdapter, ChannelConfig, ChannelEnv, ChannelSink, Happening, PersonInfo, PlaceInfo, SentMessage } from "../../core/channel.ts";
import { expandHome } from "../../core/env-file.ts";

/**
 * A channel that connects to no real platform. The "platform" is one append-only file, `platform.jsonl`, in a
 * directory: people (tests) append records, the adapter reads them as events, and what the bot sends is appended too.
 * It exists to show that adding a channel only adds an adapter.
 *
 * Records: { id, type, at, place, person, ... } with type
 *   message (text, thread?, send_id?), edit (message, text), delete (message),
 *   reaction_added / reaction_removed (message, emoji), join, leave.
 * Places are plain names. A name starting with "dm-" is a one-to-one DM, "group-" a group chat, others are channels.
 * Addresses: <id>:#<place>, <id>:#<place>/<message id>, <id>:@<person>.
 */
export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  if (typeof config.dir !== "string") throw new Error(`channel ${config.id}: "dir" must name the test platform directory`);
  return new TestChannel(config.id, expandHome(config.dir), typeof config.me === "string" ? config.me : "bot", env);
}

interface PlatformRecord {
  id: string;
  type: string;
  at: number;
  place: string;
  person: string;
  text?: string;
  thread?: string;
  message?: string;
  emoji?: string;
  send_id?: string;
}

const POLL_MS = 300;

class TestChannel implements ChannelAdapter {
  readonly id: string;
  readonly #file: string;
  readonly #me: string;
  readonly #env: ChannelEnv;
  #offset = 0;
  #timer?: NodeJS.Timeout;
  #reading: Promise<void> = Promise.resolve();

  constructor(id: string, dir: string, me: string, env: ChannelEnv) {
    this.id = id;
    this.#file = join(dir, "platform.jsonl");
    this.#me = me;
    this.#env = env;
    mkdirSync(dir, { recursive: true });
  }

  get me(): PersonInfo {
    return { address: `${this.id}:@${this.#me}`, name: this.#env.botName };
  }

  /**
   * Read the platform from its start, so what came while the gateway was down is filled in; the inbox drops what it
   * already has. On a bot's first start there was no "while down": it starts at the end, as the Slack adapter does.
   */
  async start(sink: ChannelSink): Promise<void> {
    this.#offset = sink.lastAlive() === undefined && existsSync(this.#file) ? (await stat(this.#file)).size : 0;
    const poll = () => {
      this.#reading = this.#reading.then(() => this.#read(sink)).catch((error) => sink.log("read failed", { error: String(error) }));
    };
    poll();
    await this.#reading;
    this.#timer = setInterval(poll, POLL_MS);
  }

  async backfill(): Promise<void> {
    // start() reads the whole platform file; nothing else is missed.
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#reading;
  }

  async #read(sink: ChannelSink): Promise<void> {
    if (!existsSync(this.#file)) return;
    const size = (await stat(this.#file)).size;
    if (size <= this.#offset) return;
    const text = (await readFile(this.#file)).subarray(this.#offset, size).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as PlatformRecord;
      await sink.receive(record.id, record);
    }
    this.#offset += Buffer.byteLength(text.slice(0, end + 1));
  }

  owns(address: Address): boolean {
    return address.startsWith(`${this.id}:`);
  }

  placeOf(address: Address): Address | undefined {
    const parsed = this.#parse(address);
    return "place" in parsed ? `${this.id}:#${parsed.place}` : undefined;
  }

  #place(name: string): PlaceInfo {
    return { address: `${this.id}:#${name}`, name, kind: name.startsWith("dm-") ? "dm" : name.startsWith("group-") ? "group" : "channel" };
  }

  #message(place: string, id: string): Address {
    return `${this.id}:#${place}/${id}`;
  }

  #parse(address: Address): { place: string; message?: string } | { person: string } {
    const rest = address.slice(this.id.length + 1);
    const place = /^#([\w-]+)(?:\/([\w-]+))?$/.exec(rest);
    if (place) return { place: place[1]!, ...(place[2] ? { message: place[2] } : {}) };
    const person = /^@([\w-]+)$/.exec(rest);
    if (person) return { person: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  async translate(raw: unknown): Promise<Happening[]> {
    const record = raw as PlatformRecord;
    const person: PersonInfo = record.person === this.#me ? this.me : { address: `${this.id}:@${record.person}`, name: record.person };
    const common = { at: record.at, place: this.#place(record.place), person, fromMe: record.person === this.#me, raw: record };
    const messageId = record.type === "message" ? record.id : record.message;
    const message = messageId ? { message: this.#message(record.place, messageId) } : {};
    const thread = record.thread ? { thread: this.#message(record.place, record.thread), threadRoot: this.#message(record.place, record.thread) } : {};
    const mentions = [...(record.text ?? "").matchAll(/@([\w-]+)/g)].map((match) => match[1]!);
    switch (record.type) {
      case "message":
      case "edit":
        return [
          {
            kind: record.type,
            ...common,
            ...message,
            ...thread,
            text: record.text ?? "",
            mentionsMe: mentions.includes(this.#me),
            mentions: mentions.map((name) => `${this.id}:@${name}`),
            ...(record.send_id ? { sendId: record.send_id } : {}),
          },
        ];
      case "reaction_added":
      case "reaction_removed":
        return [{ kind: record.type, ...common, ...message, text: `:${record.emoji ?? "?"}:` }];
      default:
        return [{ kind: record.type, ...common, ...message }];
    }
  }

  async #records(): Promise<PlatformRecord[]> {
    if (!existsSync(this.#file)) return [];
    return (await readFile(this.#file, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PlatformRecord);
  }

  async #append(record: Omit<PlatformRecord, "id" | "at" | "person"> & { id?: string }): Promise<PlatformRecord> {
    const full: PlatformRecord = { id: `${record.type === "message" ? "m" : "e"}-${randomUUID()}`, at: Date.now(), person: this.#me, ...record } as PlatformRecord;
    await appendFile(this.#file, `${JSON.stringify(full)}\n`);
    return full;
  }

  async #target(to: Address): Promise<{ place: string; thread?: string }> {
    const parsed = this.#parse(to);
    if ("person" in parsed) return { place: `dm-${parsed.person}` };
    if (!parsed.message) return { place: parsed.place };
    const target = (await this.#records()).find((record) => record.id === parsed.message);
    return { place: parsed.place, thread: target?.thread ?? parsed.message };
  }

  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const { place, thread } = await this.#target(to);
    const record = await this.#append({ type: "message", place, text, send_id: sendId, ...(thread ? { thread } : {}) });
    return { message: this.#message(place, record.id), place: this.#place(place).address, raw: record };
  }

  async findSent(to: Address, sendId: string): Promise<SentMessage | undefined> {
    const { place } = await this.#target(to);
    const record = (await this.#records()).find((item) => item.type === "message" && item.place === place && item.send_id === sendId);
    return record && { message: this.#message(place, record.id), place: this.#place(place).address, raw: record };
  }

  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("place" in parsed) || !parsed.message) throw new Error(`not a message address: ${message}`);
    await this.#append({ type: remove ? "reaction_removed" : "reaction_added", place: parsed.place, message: parsed.message, emoji: emoji.replace(/^:|:$/g, "") });
  }

  /** Platform methods: edit { message, text }, delete { message }, records {}. */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "records") return this.#records();
    const address = typeof params.message === "string" ? this.#parse(params.message) : undefined;
    if (!address || !("place" in address) || !address.message) throw new Error(`${method}: "message" must be a message address`);
    if (method === "edit") return this.#append({ type: "edit", place: address.place, message: address.message, text: String(params.text ?? "") });
    if (method === "delete") return this.#append({ type: "delete", place: address.place, message: address.message });
    throw new Error(`unknown method ${method}; methods: edit, delete, records`);
  }
}

/** For tests: the platform file of a test channel directory. */
export function platformFile(dir: string): string {
  return join(expandHome(dir), "platform.jsonl");
}

export function readPlatform(dir: string): PlatformRecord[] {
  const file = platformFile(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PlatformRecord);
}
