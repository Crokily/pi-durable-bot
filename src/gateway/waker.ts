import { Clock, Context, Effect, FiberMap, FiberSet, Layer, Option, Result, type Tracer } from "effect";
import type { PlaceInfo } from "../core/channel.ts";
import type { Judge, JudgeAnswer, JudgeItem } from "../core/judge.ts";
import type { PlaceWake, PlaceWakeReason, WakeEvent, WakeTarget } from "../core/wake.ts";
import { GatewayConfig } from "./config.ts";
import { DeliverError, JudgeError, type LogError, message, NoWakeTarget } from "./errors.ts";
import { type LoggedMessage, MessageLog, type UndecidedEvent } from "./log.ts";
import { WakeSpans } from "./tracing.ts";

export interface WakerSettings {
  /** Wait this long after the last event in a place before deciding. */
  readonly debounceMs: number;
  /** Never wait longer than this after the first event. */
  readonly debounceMaxMs: number;
  /** The judge wakes the bot when both answers are at least this probable. */
  readonly judgeThreshold: number;
  /** How many earlier messages of the place the judge sees. */
  readonly judgeContextMessages: number;
}

/** When the judge fails, it is asked again after these waits. */
export const JUDGE_RETRY_MS = [2_000, 8_000] as const;

/** How long a group of events waits: until debounceMs after the last event, but never past debounceMaxMs after the first. */
export function debounceWait(settings: Pick<WakerSettings, "debounceMs" | "debounceMaxMs">, first: number, now: number): number {
  return Math.max(0, Math.min(settings.debounceMs, first + settings.debounceMaxMs - now));
}

interface Batch {
  readonly events: UndecidedEvent[];
  /** The span that logged each event, for the wake's links. */
  readonly spans: Tracer.AnySpan[];
  readonly first: number;
}

/**
 * Decides when new events wake the bot. Per place, it waits until people stop (debounce), then:
 * 1. the bot works on this place now → steer;
 * 2. an event @-mentions the bot, or the place is a one-to-one DM → wake;
 * 3. otherwise the judge decides; with no judge, every event wakes the bot.
 */
export class Waker extends Context.Service<
  Waker,
  {
    setTarget(target: WakeTarget): void;
    add(event: UndecidedEvent): Effect.Effect<void>;
    /** Stop the timers and wait for decisions in progress. Undecided events stay undecided in the log and come back on the next start. */
    readonly stop: Effect.Effect<void>;
  }
>()("pots/gateway/Waker") {
  static readonly layer = Layer.effect(
    Waker,
    Effect.gen(function* () {
      const log = yield* MessageLog;
      const config = yield* GatewayConfig;
      const wakeSpans = yield* WakeSpans;
      const batches = new Map<string, Batch>();
      const timers = yield* FiberMap.make<string>();
      const deciding = yield* FiberSet.make();
      let target: WakeTarget | undefined;
      let stopped = false;

      const decide = (events: UndecidedEvent[], links: readonly Tracer.AnySpan[]) =>
        Effect.gen(function* () {
          if (!target) return yield* Effect.fail(new NoWakeTarget({ message: "no wake target" }));
          const bot = target;
          const first = events[0]!;
          const place: PlaceInfo = first.place
            ? { address: first.place, kind: first.place_kind ?? "channel", ...(first.place_name ? { name: first.place_name } : {}) }
            : { address: `${first.channel}:`, kind: "channel", name: first.channel };
          const ids = events.map((event) => event.id);
          const wakeEvents = events.map(toWakeEvent);
          const id = (reason: string) => `${reason}:${place.address}:${ids.at(-1)}`;
          yield* Effect.annotateCurrentSpan({ place: place.address, events: ids.join(",") });

          const deliver = (reason: PlaceWakeReason, decision: string, judged?: PlaceWake["judged"]) =>
            Effect.gen(function* () {
              const wake: PlaceWake = { id: id(reason), reason, place, events: wakeEvents, ...(judged ? { judged } : {}) };
              const submission = yield* Effect.tryPromise({
                try: () => bot.deliver(wake),
                catch: (cause) => new DeliverError({ message: message(cause), cause }),
              }).pipe(Effect.withSpan("wake.deliver", { attributes: { wake: wake.id } }));
              yield* log.setWake(ids, decision);
              const span = yield* Effect.currentSpan.pipe(Effect.option);
              if (Option.isSome(span)) wakeSpans.remember(submission, span.value);
              yield* Effect.annotateCurrentSpan({ reason, wake: wake.id, submission });
              config.print("wake", { reason, place: place.address, events: ids.length });
            });

          if (bot.isWorkingOn(place.address)) return yield* deliver("steer", "steer");
          if (place.kind === "dm") return yield* deliver("dm", "dm");
          if (events.some((event) => event.mentions_me)) return yield* deliver("mention", "mention");

          const judge = config.judge();
          if (!judge) return yield* deliver("heard", "heard");
          const settings = config.settings();
          const answer = yield* Effect.result(askJudge(judge, bot, place, events, settings));
          if (Result.isFailure(answer)) {
            // The judge could not decide. Nothing is dropped: the bot gets the events and decides itself.
            config.print("judge failed", { place: place.address, error: answer.failure.message });
            return yield* deliver("relevant", "relevant", { error: answer.failure.message });
          }
          const { related, respond } = answer.success;
          config.print("judge", { place: place.address, events: ids.length, related, respond });
          if (related >= settings.judgeThreshold && respond >= settings.judgeThreshold) return yield* deliver("relevant", "relevant", answer.success);
          // The bot may have started working on this place while the judge thought.
          if (bot.isWorkingOn(place.address)) return yield* deliver("steer", "steer");
          yield* log.setWake(ids, "judge_no");
          yield* Effect.annotateCurrentSpan({ reason: "judge_no" });
        }).pipe(Effect.withSpan("wake", { root: true, links: links.map((span) => ({ span, attributes: {} })) }));

      const askJudge = (judge: Judge, bot: WakeTarget, place: PlaceInfo, events: UndecidedEvent[], settings: WakerSettings) =>
        Effect.gen(function* () {
          const earlier = yield* log.messagesBefore(place.address, events[0]!.at, settings.judgeContextMessages);
          const latest: JudgeItem[] = [];
          for (const event of events) latest.push(yield* describe(event, bot.name));
          const responsibilities = yield* Effect.promise(() => bot.responsibilities());
          const input = {
            name: bot.name,
            responsibilities,
            place: `${place.name ?? place.address} (${place.kind})`,
            earlier: earlier.map((logged) => messageItem(logged, bot.name)),
            latest,
          };
          let lastError: unknown;
          for (const wait of [0, ...JUDGE_RETRY_MS]) {
            if (wait) yield* Effect.sleep(wait);
            const result = yield* Effect.result(Effect.tryPromise({ try: () => judge.judge(input), catch: (cause) => cause }));
            if (Result.isSuccess(result)) {
              yield* Effect.annotateCurrentSpan({ related: result.success.related, respond: result.success.respond });
              return result.success;
            }
            lastError = result.failure;
          }
          return yield* Effect.fail(new JudgeError({ message: message(lastError), cause: lastError }));
        }).pipe(Effect.withSpan("wake.judge"));

      /** An event as the judge sees it: what happened, with the current state of the message it is about. */
      const describe = (event: UndecidedEvent, name: string): Effect.Effect<JudgeItem, LogError> =>
        Effect.gen(function* () {
          const author = event.person_name ?? event.person ?? "unknown";
          const time = new Date(event.at).toISOString();
          const logged = event.message ? yield* log.message(event.message) : undefined;
          const state = logged?.deleted_at ? " (since deleted)" : "";
          const thread = event.thread ? { thread: event.thread } : {};
          switch (event.kind) {
            case "message":
              return { what: `new message${state}`, author, time, text: logged?.text ?? event.text ?? "", ...thread };
            case "edit":
              return { what: `edited a message${state}`, author, time, text: logged?.text ?? event.text ?? "", ...thread };
            default: {
              const about = logged ? ` on ${logged.from_me ? `${name}'s` : `${logged.person_name ?? "someone"}'s`} message${state}` : "";
              return {
                what: `${event.kind}${event.text && event.kind !== "update" ? ` ${event.text}` : ""}${about}`,
                author,
                time,
                ...(logged ? { text: logged.text } : {}),
                ...thread,
              };
            }
          }
        });

      // Take the whole group at once, so an event that comes now starts the next group.
      const flush = (key: string) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            const batch = batches.get(key);
            if (!batch) return Effect.void;
            batches.delete(key);
            return FiberSet.run(
              deciding,
              decide(batch.events, batch.spans).pipe(
                Effect.catch((error) => Effect.sync(() => config.print("wake decision failed", { place: key, error: error.message }))),
              ),
            );
          }),
        );

      return Waker.of({
        setTarget: (next) => {
          target = next;
          stopped = false;
        },
        add: (event) =>
          Effect.gen(function* () {
            if (stopped) return;
            const key = event.place ?? `${event.channel}:`;
            const now = yield* Clock.currentTimeMillis;
            const span = yield* Effect.currentSpan.pipe(Effect.option);
            let batch = batches.get(key);
            if (batch?.events.some((queued) => queued.id === event.id)) return;
            if (batch) batch.events.push(event);
            else batches.set(key, (batch = { events: [event], spans: [], first: now }));
            if (Option.isSome(span)) batch.spans.push(span.value);
            const wait = debounceWait(config.settings(), batch.first, now);
            yield* FiberMap.run(timers, key, Effect.andThen(Effect.sleep(wait), flush(key)));
          }),
        stop: Effect.gen(function* () {
          stopped = true;
          yield* FiberMap.clear(timers);
          batches.clear();
          yield* FiberSet.awaitEmpty(deciding);
        }),
      });
    }),
  );
}

function toWakeEvent(event: UndecidedEvent): WakeEvent {
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    mentionsMe: event.mentions_me === 1,
    ...(event.message ? { message: event.message } : {}),
    ...(event.thread ? { thread: event.thread } : {}),
    ...(event.person ? { person: { address: event.person, ...(event.person_name ? { name: event.person_name } : {}) } } : {}),
  };
}

function messageItem(message: LoggedMessage, name: string): JudgeItem {
  return {
    what: message.deleted_at ? "message (since deleted)" : "message",
    author: message.from_me ? `${name} (me)` : (message.person_name ?? message.person ?? "unknown"),
    time: new Date(message.at).toISOString(),
    text: message.text,
    ...(message.thread ? { thread: message.thread } : {}),
  };
}
