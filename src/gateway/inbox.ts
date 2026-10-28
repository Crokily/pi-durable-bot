import { Cause, Context, Deferred, Effect, FiberHandle, Layer, Option, Queue, Schema, type Tracer } from "effect";
import { Happening } from "../core/channel.ts";
import { Channels, platform } from "./channels.ts";
import { GatewayConfig } from "./config.ts";
import { BadHappening, ChannelError, failureText, type LogError } from "./errors.ts";
import { MessageLog } from "./log.ts";
import { Waker } from "./waker.ts";

type Item =
  /** span: the receive span, so the event's apply is in the same trace. */
  | { readonly _tag: "event"; readonly channel: string; readonly eventId: string; readonly raw: unknown; readonly span?: Tracer.AnySpan }
  /** Everything queued before it is applied. */
  | { readonly _tag: "mark"; readonly done: Deferred.Deferred<void> };

const decodeHappenings = Schema.decodeUnknownEffect(Schema.Array(Happening));

/** Adapters may say null for a missing value (a person without a name); the schema says absent. The raw data stays as it is. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, key === "raw" ? item : withoutNulls(item)]),
  );
}

/**
 * Every event from every channel comes in here. It is stored before the adapter acknowledges it, then applied to the
 * log one at a time, in arrival order, so an edit never overtakes its message. A known event ID is a repeat and is
 * dropped. Events that a crash left unapplied are applied on the next start.
 */
export class Inbox extends Context.Service<
  Inbox,
  {
    /** Store a raw event. Resolves once it is on disk. */
    receive(channel: string, eventId: string, raw: unknown): Effect.Effect<void, LogError>;
    /** Queue the stored events that were not applied before the last stop or crash. */
    readonly replay: Effect.Effect<void, LogError>;
    /** Start applying queued events. Until then they wait, so the adapters can connect first. */
    readonly open: Effect.Effect<void>;
    /** Wait until every event queued so far is applied. */
    readonly drain: Effect.Effect<void>;
    /** Apply what is queued, then stop. */
    readonly close: Effect.Effect<void>;
  }
>()("pots/gateway/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const log = yield* MessageLog;
      const channels = yield* Channels;
      const waker = yield* Waker;
      const { print } = yield* GatewayConfig;
      const queue = yield* Queue.unbounded<Item>();
      const worker = yield* FiberHandle.make();
      let opened = false;

      const apply = (channel: string, eventId: string, raw: unknown, received: Tracer.AnySpan | undefined) =>
        Effect.gen(function* () {
          const adapter = channels.running(channel);
          if (!adapter) return yield* Effect.fail(ChannelError.from(channel, `channel ${channel} is not running`));
          const translated = yield* platform(channel, () => adapter.translate(raw));
          const happenings = yield* decodeHappenings(withoutNulls(translated)).pipe(
            Effect.mapError((error) => new BadHappening({ message: `${channel} gave a happening that does not fit: ${error.message}`, channel })),
          );
          const events = yield* log.apply(channel, eventId, happenings);
          yield* Effect.annotateCurrentSpan({ happenings: happenings.length, events: events.map((event) => event.id).join(",") });
          for (const event of events) yield* waker.add(event);
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const error = failureText(Cause.squash(cause));
            return Effect.sync(() => print("event failed", { channel, eventId, error })).pipe(
              Effect.andThen(log.failInbox(channel, eventId, error)),
              Effect.ignore,
            );
          }),
          // Its own trace with the receive, not the trace of whatever started the worker.
          Effect.withSpan("inbox.apply", { attributes: { channel, event: eventId }, ...(received ? { parent: received } : { root: true }) }),
        );

      // One item at a time. An item that has started is finished before the worker stops.
      const work = Effect.forever(
        Effect.flatMap(Queue.take(queue), (item) =>
          item._tag === "mark" ? Effect.asVoid(Deferred.succeed(item.done, undefined)) : Effect.uninterruptible(apply(item.channel, item.eventId, item.raw, item.span)),
        ),
      );

      const drain = Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* Queue.offer(queue, { _tag: "mark", done });
        if (opened) yield* Deferred.await(done);
      });

      return Inbox.of({
        receive: (channel, eventId, raw) =>
          log.addInbox(channel, eventId, raw).pipe(
            Effect.tap((added) =>
              added
                ? Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
                    Queue.offer(queue, { _tag: "event", channel, eventId, raw, ...(Option.isSome(span) ? { span: span.value } : {}) }),
                  )
                : Effect.void,
            ),
            Effect.tap((added) => Effect.annotateCurrentSpan({ repeat: !added })),
            Effect.asVoid,
            Effect.withSpan("inbox.receive", { attributes: { channel, event: eventId } }),
          ),
        replay: Effect.gen(function* () {
          for (const row of yield* log.unfinishedInbox) yield* Queue.offer(queue, { _tag: "event", channel: row.channel, eventId: row.event_id, raw: JSON.parse(row.raw) });
        }),
        open: Effect.suspend(() => {
          opened = true;
          return FiberHandle.run(worker, work, { onlyIfMissing: true });
        }).pipe(Effect.asVoid),
        drain,
        close: Effect.gen(function* () {
          yield* drain;
          yield* FiberHandle.clear(worker);
          opened = false;
        }),
      });
    }),
  );
}
