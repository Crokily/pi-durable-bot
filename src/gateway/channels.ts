import { Context, Effect, Fiber, FiberMap, Layer, Option } from "effect";
import type { Address, ChannelAdapter, ChannelSink } from "../core/channel.ts";
import { GatewayConfig } from "./config.ts";
import { ChannelError, message, NoChannelForAddress, UnknownChannel } from "./errors.ts";

/** Something an adapter does on its platform. A failure is a ChannelError of its channel. */
export const platform = <A>(channel: string, run: () => Promise<A>): Effect.Effect<A, ChannelError> =>
  Effect.tryPromise({ try: run, catch: (cause) => ChannelError.from(channel, cause) });

/** How long to wait before the next attempt to connect a channel: 5 s more each time, at most a minute. */
const reconnectDelay = (attempt: number) => Math.min(60_000, 5_000 * attempt);

/**
 * How long connect waits for a channel. A channel still connecting then goes on in the background, so one slow or
 * stuck connection does not hold up its bot and the bots that start after it.
 */
export const CONNECT_WAIT_MS = 30_000;

/**
 * The channel adapters of one bot and their life: connect, backfill what was missed, keep trying a channel that does
 * not connect, stop. Each adapter has one background task (backfill or reconnect), which ends when it is removed.
 */
export class Channels extends Context.Service<
  Channels,
  {
    /** The running adapters. */
    list(): ChannelAdapter[];
    /** The running adapter with this ID, if any. */
    running(id: string): ChannelAdapter | undefined;
    adapterFor(address: Address): Effect.Effect<ChannelAdapter, NoChannelForAddress>;
    get(id: string): Effect.Effect<ChannelAdapter, UnknownChannel>;
    /**
     * Add adapters and try to connect each once, all at the same time, waiting at most CONNECT_WAIT_MS. Resolves with,
     * for each, whether it connected: at once for a connect that ended, later for one still going on.
     */
    connect(adapters: readonly ChannelAdapter[], sink: (adapter: ChannelAdapter) => ChannelSink): Effect.Effect<Effect.Effect<boolean>[]>;
    /**
     * In the background: wait for the adapter's connect, then backfill it, or keep trying to connect it when it did not
     * connect, then backfill.
     */
    follow(adapter: ChannelAdapter, connected: Effect.Effect<boolean>, sink: (adapter: ChannelAdapter) => ChannelSink): Effect.Effect<void>;
    /** Add a channel account while running. */
    add(adapter: ChannelAdapter, sink: (adapter: ChannelAdapter) => ChannelSink): Effect.Effect<void, ChannelError>;
    remove(id: string): Effect.Effect<void, ChannelError>;
    /** Stop every adapter and its background task. */
    readonly stop: Effect.Effect<void>;
  }
>()("pots/gateway/Channels") {
  static readonly layer = Layer.effect(
    Channels,
    Effect.gen(function* () {
      const { print } = yield* GatewayConfig;
      const adapters = new Map<string, ChannelAdapter>();
      const tasks = yield* FiberMap.make<string>();
      /** The first connect of each adapter, which may go on after connect stopped waiting for it. */
      const connecting = yield* FiberMap.make<string, boolean>();

      const connectOne = (adapter: ChannelAdapter, sink: ChannelSink) =>
        platform(adapter.id, () => adapter.start(sink)).pipe(
          Effect.tap(() => Effect.sync(() => print("channel connected", { channel: adapter.id, me: adapter.me?.address }))),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => print("channel connect failed", { channel: adapter.id, error: error.message })).pipe(
              Effect.andThen(Effect.promise(() => adapter.stop().catch(() => {}))),
              Effect.as(false),
            ),
          ),
          Effect.withSpan("channel.connect", { attributes: { channel: adapter.id } }),
        );

      const backfill = (adapter: ChannelAdapter, sink: ChannelSink) =>
        platform(adapter.id, () => adapter.backfill(sink)).pipe(
          Effect.catch((error) => Effect.sync(() => print("backfill failed", { channel: adapter.id, error: error.message }))),
          Effect.withSpan("channel.backfill", { attributes: { channel: adapter.id } }),
        );

      const follow = (adapter: ChannelAdapter, connection: Effect.Effect<boolean>, sink: (adapter: ChannelAdapter) => ChannelSink) =>
        Effect.gen(function* () {
          let connected = yield* connection;
          for (let attempt = 1; !connected; attempt++) {
            yield* Effect.sleep(reconnectDelay(attempt));
            connected = yield* connectOne(adapter, sink(adapter));
          }
          yield* backfill(adapter, sink(adapter));
        }).pipe(FiberMap.run(tasks, adapter.id), Effect.asVoid);

      const connect = (list: readonly ChannelAdapter[], sink: (adapter: ChannelAdapter) => ChannelSink) =>
        Effect.suspend(() => {
          for (const adapter of list) adapters.set(adapter.id, adapter);
          return Effect.forEach(
            list,
            (adapter) =>
              Effect.gen(function* () {
                const fiber = yield* FiberMap.run(connecting, adapter.id, connectOne(adapter, sink(adapter)));
                // A time limit on the waiting only: the connect itself goes on.
                const ended = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(CONNECT_WAIT_MS));
                if (Option.isSome(ended)) return Effect.succeed(ended.value);
                print("channel still connecting; the bot starts without it", { channel: adapter.id, waitedSeconds: CONNECT_WAIT_MS / 1000 });
                return Fiber.join(fiber);
              }),
            { concurrency: "unbounded" },
          );
        });

      return Channels.of({
        list: () => [...adapters.values()],
        running: (id) => adapters.get(id),
        adapterFor: (address) =>
          Effect.suspend(() => {
            for (const adapter of adapters.values()) if (adapter.owns(address)) return Effect.succeed(adapter);
            return Effect.fail(NoChannelForAddress.of(address));
          }),
        get: (id) =>
          Effect.suspend(() => {
            const adapter = adapters.get(id);
            if (adapter) return Effect.succeed(adapter);
            const channels = [...adapters.keys()].join(", ");
            return Effect.fail(new UnknownChannel({ message: `unknown channel ${JSON.stringify(id)}; channels: ${channels}`, channel: id }));
          }),
        connect,
        follow,
        add: (adapter, sink) =>
          Effect.gen(function* () {
            if (adapters.has(adapter.id)) {
              return yield* Effect.fail(ChannelError.from(adapter.id, `channel ${adapter.id} is already running`));
            }
            const [connected] = yield* connect([adapter], sink);
            yield* follow(adapter, connected!, sink);
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const adapter = adapters.get(id);
            if (!adapter) return;
            adapters.delete(id);
            yield* FiberMap.remove(tasks, id);
            yield* FiberMap.remove(connecting, id);
            yield* platform(id, () => adapter.stop());
          }),
        stop: Effect.gen(function* () {
          yield* FiberMap.clear(tasks);
          yield* FiberMap.clear(connecting);
          yield* Effect.forEach(
            [...adapters.values()],
            (adapter) => Effect.promise(() => adapter.stop().catch((error) => print("channel stop failed", { channel: adapter.id, error: message(error) }))),
            { concurrency: "unbounded", discard: true },
          );
        }),
      });
    }),
  );
}
