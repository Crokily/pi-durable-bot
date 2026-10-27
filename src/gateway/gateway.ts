import type { Address, ChannelAdapter, ChannelSink } from "../core/channel.ts";
import type { WakeTarget } from "../core/wake.ts";
import type { Jev } from "./jev.ts";
import type { MessageLog } from "./log.ts";
import { Outbox, type SendResult } from "./outbox.ts";
import { Waker, type WakerSettings } from "./waker.ts";

type Print = (message: string, data?: Record<string, unknown>) => void;

const HEARTBEAT_MS = 60_000;

/**
 * The gateway core of one bot, the same for every platform: inbox, message log, waker and outbox.
 * Channel adapters only translate; everything they receive goes through here.
 */
export class Gateway {
  readonly log: MessageLog;
  readonly #waker: Waker;
  readonly #outbox: Outbox;
  readonly #adapters = new Map<string, ChannelAdapter>();
  readonly #print: Print;
  /** Inbox events are applied one at a time, in arrival order, so an edit never overtakes its message. */
  #queue: Promise<void> = Promise.resolve();
  #lastAlive: number | undefined;
  #heartbeat?: NodeJS.Timeout;
  #started = false;

  constructor(log: MessageLog, jev: Jev, settings: () => WakerSettings, print: Print) {
    this.log = log;
    this.#print = print;
    this.#waker = new Waker(log, jev, settings, print);
    this.#outbox = new Outbox(log, (address) => this.adapterFor(address), (channel, eventId, raw) => this.#receive(channel, eventId, raw), print);
  }

  get outbox(): Outbox {
    return this.#outbox;
  }

  get channels(): ChannelAdapter[] {
    return [...this.#adapters.values()];
  }

  /**
   * Start with the given adapters: finish what the last process left, connect, then backfill what was missed.
   * Undecided events from before go to the waker first, so nothing decided in this run is offered twice.
   */
  async start(target: WakeTarget, adapters: readonly ChannelAdapter[]): Promise<void> {
    this.#waker.target = target;
    const lastAlive = await this.log.getState("last_alive");
    this.#lastAlive = lastAlive ? Number(lastAlive) : undefined;

    let open!: () => void;
    this.#queue = new Promise<void>((resolve) => (open = resolve));
    for (const event of await this.log.undecided()) this.#waker.add(event);
    for (const row of await this.log.unfinishedInbox()) this.#enqueue(row.channel, row.event_id, JSON.parse(row.raw));
    for (const adapter of adapters) this.#adapters.set(adapter.id, adapter);
    const connected = await Promise.all(adapters.map((adapter) => this.#connect(adapter)));
    open();
    this.#started = true;

    await this.#beat();
    this.#heartbeat = setInterval(() => void this.#beat(), HEARTBEAT_MS);
    await this.#queue;
    adapters.forEach((adapter, index) => {
      if (connected[index]) void this.#backfill(adapter);
      else void this.#keepConnecting(adapter);
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.#heartbeat);
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.stop()));
    await this.#waker.stop();
    await this.#queue;
    if (this.#started) await this.#beat();
  }

  /** Add a channel account while running. */
  async addChannel(adapter: ChannelAdapter): Promise<void> {
    if (this.#adapters.has(adapter.id)) throw new Error(`channel ${adapter.id} is already running`);
    this.#adapters.set(adapter.id, adapter);
    if (await this.#connect(adapter)) void this.#backfill(adapter);
    else void this.#keepConnecting(adapter);
  }

  async removeChannel(id: string): Promise<void> {
    const adapter = this.#adapters.get(id);
    if (!adapter) return;
    this.#adapters.delete(id);
    await adapter.stop();
  }

  adapterFor(address: Address): ChannelAdapter {
    for (const adapter of this.#adapters.values()) if (adapter.owns(address)) return adapter;
    throw new Error(`no channel for address ${JSON.stringify(address)}. Copy addresses from a wake message or the log.`);
  }

  channel(id: string): ChannelAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`unknown channel ${JSON.stringify(id)}; channels: ${[...this.#adapters.keys()].join(", ")}`);
    return adapter;
  }

  // ---- Actions ----

  send(sendId: string, to: Address, text: string): Promise<SendResult> {
    return this.#outbox.send(sendId, to, text);
  }

  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    await this.adapterFor(message).react(message, emoji, remove);
  }

  call(channel: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.channel(channel).call(method, params);
  }

  // ---- Receive ----

  #sink(adapter: ChannelAdapter): ChannelSink {
    return {
      receive: (eventId, raw) => this.#receive(adapter.id, eventId, raw),
      newestMessage: (place) => this.log.newestMessage(place),
      threads: (place) => this.log.threads(place),
      lastAlive: () => this.#lastAlive,
      log: (message, data) => this.#print(`${adapter.id}: ${message}`, data),
    };
  }

  async #connect(adapter: ChannelAdapter): Promise<boolean> {
    try {
      await adapter.start(this.#sink(adapter));
      this.#print("channel connected", { channel: adapter.id, me: adapter.me?.address });
      return true;
    } catch (error) {
      this.#print("channel connect failed", { channel: adapter.id, error: String(error) });
      await adapter.stop().catch(() => {});
      return false;
    }
  }

  /** Retry a channel that failed to connect, in the background, until it connects or is removed. */
  async #keepConnecting(adapter: ChannelAdapter): Promise<void> {
    for (let attempt = 1; this.#adapters.get(adapter.id) === adapter; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5_000 * attempt)));
      if (this.#adapters.get(adapter.id) !== adapter) return;
      if (await this.#connect(adapter)) {
        await this.#backfill(adapter);
        return;
      }
    }
  }

  async #backfill(adapter: ChannelAdapter): Promise<void> {
    try {
      await adapter.backfill(this.#sink(adapter));
    } catch (error) {
      this.#print("backfill failed", { channel: adapter.id, error: String(error) });
    }
  }

  /** Store before the adapter acknowledges. A known event ID is a repeat and is dropped. */
  async #receive(channel: string, eventId: string, raw: unknown): Promise<void> {
    if (!(await this.log.addInbox(channel, eventId, raw))) return;
    this.#enqueue(channel, eventId, raw);
  }

  #enqueue(channel: string, eventId: string, raw: unknown): void {
    this.#queue = this.#queue.then(async () => {
      try {
        const adapter = this.#adapters.get(channel);
        if (!adapter) throw new Error(`channel ${channel} is not running`);
        const happenings = await adapter.translate(raw);
        for (const event of await this.log.apply(channel, eventId, happenings)) this.#waker.add(event);
      } catch (error) {
        this.#print("event failed", { channel, eventId, error: String(error) });
        await this.log.failInbox(channel, eventId, String(error)).catch(() => {});
      }
    });
  }

  async #beat(): Promise<void> {
    await this.log.setState("last_alive", String(Date.now())).catch((error) => this.#print("heartbeat failed", { error: String(error) }));
  }
}
