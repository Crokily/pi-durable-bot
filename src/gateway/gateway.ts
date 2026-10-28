import { Clock, Context, Effect, FiberHandle, FiberSet, Layer, ManagedRuntime, Schedule } from "effect";
import type { Address, ChannelAdapter, ChannelSink } from "../core/channel.ts";
import type { Sql } from "../core/sql.ts";
import type { WakeTarget } from "../core/wake.ts";
import { Channels } from "./channels.ts";
import { GatewayConfig, type GatewayOptions } from "./config.ts";
import { ChannelError, type LogError } from "./errors.ts";
import { Inbox } from "./inbox.ts";
import { MessageLog } from "./log.ts";
import { Outbox, type OutboxHooks, type SendResult } from "./outbox.ts";
import { type Timer, Timers } from "./timers.ts";
import { WakeSpans } from "./tracing.ts";
import { Waker } from "./waker.ts";

export type { SendResult } from "./outbox.ts";

const HEARTBEAT_MS = 60_000;

/** The gateway core of one bot as Effect services: log, channels, inbox, waker, outbox, timers. */
export function gatewayLayer(sql: Sql, options: GatewayOptions) {
  const config = Layer.succeed(GatewayConfig, options);
  const base = Layer.mergeAll(MessageLog.layer(sql), WakeSpans.layer, Channels.layer).pipe(Layer.provideMerge(config));
  const waker = Waker.layer.pipe(Layer.provideMerge(base));
  const inbox = Inbox.layer.pipe(Layer.provideMerge(waker));
  const core = Layer.mergeAll(Outbox.layer, Timers.layer(sql)).pipe(Layer.provideMerge(inbox));
  return Background.layer.pipe(Layer.provideMerge(core));
}

type Core = Channels | GatewayConfig | Inbox | MessageLog | Outbox | Timers | WakeSpans | Waker;
type Services = Core | Background;

/** Tasks of the gateway that run in the background, and effects started by adapters' callbacks. Both stop with it. */
class Background extends Context.Service<
  Background,
  {
    readonly heartbeat: FiberHandle.FiberHandle;
    readonly run: <A, E>(effect: Effect.Effect<A, E, Core>) => Promise<A>;
  }
>()("pots/gateway/Background") {
  static readonly layer = Layer.effect(
    Background,
    Effect.gen(function* () {
      return Background.of({ heartbeat: yield* FiberHandle.make(), run: yield* FiberSet.makeRuntimePromise<Core>() });
    }),
  );
}

/**
 * The gateway core of one bot, the same for every platform: inbox, message log, waker, outbox and timers. Channel
 * adapters only translate; everything they receive goes through here. The core runs on Effect; this class is its
 * face for the bot, in promises.
 */
export class Gateway {
  readonly #runtime: ManagedRuntime.ManagedRuntime<Services, LogError>;
  readonly #channels: Channels["Service"];
  readonly #outbox: Outbox["Service"];
  readonly #wakeSpans: WakeSpans["Service"];
  readonly #background: Background["Service"];
  readonly #print: GatewayOptions["print"];
  #lastAlive: number | undefined;
  #started = false;
  readonly timers: TimersHandle;

  private constructor(
    runtime: ManagedRuntime.ManagedRuntime<Services, LogError>,
    services: { channels: Channels["Service"]; outbox: Outbox["Service"]; wakeSpans: WakeSpans["Service"]; background: Background["Service"] },
    print: GatewayOptions["print"],
  ) {
    this.#runtime = runtime;
    this.#channels = services.channels;
    this.#outbox = services.outbox;
    this.#wakeSpans = services.wakeSpans;
    this.#background = services.background;
    this.#print = print;
    this.timers = new TimersHandle((effect) => this.#runtime.runPromise(effect));
  }

  /** Open the gateway's tables on the bot's connection. */
  static async open(sql: Sql, options: GatewayOptions): Promise<Gateway> {
    const runtime = ManagedRuntime.make(gatewayLayer(sql, options));
    try {
      const services = await runtime.runPromise(
        Effect.gen(function* () {
          return { channels: yield* Channels, outbox: yield* Outbox, wakeSpans: yield* WakeSpans, background: yield* Background };
        }),
      );
      return new Gateway(runtime, services, options.print);
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  get outbox(): OutboxHooks {
    return this.#outbox.hooks;
  }

  get channels(): ChannelAdapter[] {
    return this.#channels.list();
  }

  /**
   * Start with the given adapters: finish what the last process left, connect, then backfill what was missed.
   * Undecided events from before go to the waker first, so nothing decided in this run is offered twice.
   */
  start(target: WakeTarget, adapters: readonly ChannelAdapter[]): Promise<void> {
    const self = this;
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const log = yield* MessageLog;
        const waker = yield* Waker;
        const inbox = yield* Inbox;
        waker.setTarget(target);
        const lastAlive = yield* log.getState("last_alive");
        self.#lastAlive = lastAlive ? Number(lastAlive) : undefined;

        for (const event of yield* log.undecided) yield* waker.add(event);
        yield* inbox.replay;
        const connected = yield* self.#channels.connect(adapters, (adapter) => self.#sink(adapter));
        yield* inbox.open;
        self.#started = true;

        yield* self.#beat;
        yield* FiberHandle.run(self.#background.heartbeat, Effect.repeat(self.#beat, Schedule.spaced(HEARTBEAT_MS)));
        yield* inbox.drain;
        for (const [index, adapter] of adapters.entries()) yield* self.#channels.follow(adapter, connected[index]!, (each) => self.#sink(each));
      }).pipe(Effect.withSpan("gateway.start")),
    );
  }

  async stop(): Promise<void> {
    const self = this;
    try {
      await this.#runtime.runPromise(
        Effect.gen(function* () {
          yield* FiberHandle.clear(self.#background.heartbeat);
          yield* (yield* Timers).stop;
          yield* self.#channels.stop;
          yield* (yield* Inbox).close;
          yield* (yield* Waker).stop;
          if (self.#started) yield* self.#beat;
        }),
      );
    } finally {
      await this.#runtime.dispose();
    }
  }

  /** Add a channel account while running. */
  addChannel(adapter: ChannelAdapter): Promise<void> {
    return this.#runtime.runPromise(this.#channels.add(adapter, (each) => this.#sink(each)));
  }

  removeChannel(id: string): Promise<void> {
    return this.#runtime.runPromise(this.#channels.remove(id));
  }

  adapterFor(address: Address): ChannelAdapter {
    return this.#runtime.runSync(this.#channels.adapterFor(address));
  }

  channel(id: string): ChannelAdapter {
    return this.#runtime.runSync(this.#channels.get(id));
  }

  // ---- Actions ----

  /** wakes: the agent's submission IDs this send answers, so the send joins their trace. */
  send(sendId: string, to: Address, text: string, wakes: readonly string[] = []): Promise<SendResult> {
    return this.#runtime.runPromise(this.#outbox.send(sendId, to, text, this.#wakeSpans.find(wakes)));
  }

  react(message: Address, emoji: string, remove: boolean): Promise<void> {
    return this.#runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const adapter = yield* this.#channels.adapterFor(message);
        yield* Effect.tryPromise({ try: () => adapter.react(message, emoji, remove), catch: (cause) => ChannelError.from(adapter.id, cause) });
      }).pipe(Effect.withSpan("react", { attributes: { message, emoji, remove } })),
    );
  }

  call(channel: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.#runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const adapter = yield* this.#channels.get(channel);
        return yield* Effect.tryPromise({ try: () => adapter.call(method, params), catch: (cause) => ChannelError.from(adapter.id, cause) });
      }).pipe(Effect.withSpan("call", { attributes: { channel, method } })),
    );
  }

  // ---- Receive ----

  #sink(adapter: ChannelAdapter): ChannelSink {
    return {
      receive: (eventId, raw) => this.#background.run(Inbox.use((inbox) => inbox.receive(adapter.id, eventId, raw))),
      newestMessage: (place) => this.#background.run(MessageLog.use((log) => log.newestMessage(place))),
      threads: (place) => this.#background.run(MessageLog.use((log) => log.threads(place))),
      lastAlive: () => this.#lastAlive,
      log: (message, data) => this.#print(`${adapter.id}: ${message}`, data),
    };
  }

  get #beat(): Effect.Effect<void, never, Services> {
    return MessageLog.use((log) => Effect.flatMap(Clock.currentTimeMillis, (now) => log.setState("last_alive", String(now)))).pipe(
      Effect.catch((error) => Effect.sync(() => this.#print("heartbeat failed", { error: error.message }))),
    );
  }
}

/** The bot's timers, in promises. */
export class TimersHandle {
  readonly #run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;

  constructor(run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>) {
    this.#run = run;
  }

  start(): Promise<void> {
    return this.#run(Timers.use((timers) => timers.start));
  }

  stop(): Promise<void> {
    return this.#run(Timers.use((timers) => timers.stop));
  }

  add(dueAt: number, note: string): Promise<Timer> {
    return this.#run(Timers.use((timers) => timers.add(dueAt, note)));
  }

  cancel(id: number): Promise<boolean> {
    return this.#run(Timers.use((timers) => timers.cancel(id)));
  }

  resetFallback(): Promise<void> {
    return this.#run(Timers.use((timers) => timers.resetFallback));
  }

  pending(): Promise<Timer[]> {
    return this.#run(Timers.use((timers) => timers.pending));
  }
}
