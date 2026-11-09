import { Cause, Clock, Context, Effect, Fiber, FiberMap, FiberSet, Layer, Option, Result, type Tracer } from "effect";
import type { PlaceInfo } from "../core/channel.ts";
import type { Judge, JudgeItem } from "../core/judge.ts";
import type { PlaceWake, PlaceWakeReason, ThreadStart, WakeEvent, WakeFile, WakeTarget } from "../core/wake.ts";
import { Channels } from "./channels.ts";
import { GatewayConfig } from "./config.ts";
import { DeliverError, failureText, JudgeError, type LogError, message, NoWakeTarget } from "./errors.ts";
import { Attachments } from "./files.ts";
import { type LoggedMessage, MessageLog, type UndecidedEvent } from "./log.ts";
import { LINK, Telemetry } from "./telemetry.ts";
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
const JUDGE_RETRY_MS = [2_000, 8_000] as const;

/**
 * Kinds of events that come only to the bot itself: someone used a button or a menu the bot sent (on any message,
 * ephemeral or not, in a form or a home tab), a command of the bot's, or a form of the bot's (submitted, or one that did
 * not open). A platform sends these only to the app that made the button, the command or the form, so the person waits
 * for this bot, and there is nothing for the judge to decide. The adapters leave out what comes at every keystroke
 * (Discord's autocomplete, Slack's block_suggestion): those are not events.
 */
const ANSWER_KINDS = new Set(["interaction", "command", "form"]);

/** Someone used a button, a menu, a command or a form of the bot's. */
function answersMe(event: UndecidedEvent): boolean {
  return ANSWER_KINDS.has(event.kind);
}

/** An event that ends its group's wait: it mentions the bot, it is in a one-to-one DM, or it answers the bot. */
function atOnce(event: UndecidedEvent): boolean {
  return event.mentions_me === 1 || event.place_kind === "dm" || answersMe(event);
}

/** How long a group of events waits: until debounceMs after the last event, but never past debounceMaxMs after the first. */
function debounceWait(settings: Pick<WakerSettings, "debounceMs" | "debounceMaxMs">, first: number, now: number): number {
  return Math.max(0, Math.min(settings.debounceMs, first + settings.debounceMaxMs - now));
}

export interface WakerHooks {
  /** Test hook: runs after the bot took a wake and before the waker records that. */
  afterDeliver?: (wakeId: string) => void;
}

interface Batch {
  readonly events: UndecidedEvent[];
  /** The IDs of the events, so an event given twice is in the group once. */
  readonly ids: Set<number>;
  /** The span that logged each event, for the wake's links. */
  readonly spans: Tracer.AnySpan[];
  readonly first: number;
}

/**
 * Decides when new events wake the bot. Per place, it waits until people stop (debounce); an event that mentions the
 * bot, one in a DM, or one that answers the bot (its button, menu, command or form was used) ends the wait at once when
 * its channel runs. Then:
 * 1. the bot works on this place now → steer;
 * 2. an event @-mentions the bot, the place is a one-to-one DM, or an event answers the bot → wake;
 * 3. otherwise the judge decides; with no judge, every event wakes the bot.
 * A wake gives each event with its text, the start of its thread and its files. Their downloads start when the events
 * come; once the wake would go out, it waits for them at most FILE_WAIT_MS (see files.ts). The groups of a place are
 * decided one after the other, so their wakes come in order.
 */
export class Waker extends Context.Service<
  Waker,
  {
    setTarget(target: WakeTarget): void;
    add(event: UndecidedEvent): Effect.Effect<void>;
    /** Deliver again, with the same IDs, the wakes a crash left undelivered: debounceMs after the start. */
    readonly redeliver: Effect.Effect<void, LogError>;
    readonly hooks: WakerHooks;
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
      const telemetry = yield* Telemetry;
      const attachments = yield* Attachments;
      const channels = yield* Channels;
      const batches = new Map<string, Batch>();
      /** Per place, the decision of its last group. */
      const lastDecision = new Map<string, Fiber.Fiber<void>>();
      const timers = yield* FiberMap.make<string>();
      const deciding = yield* FiberSet.make();
      let target: WakeTarget | undefined;
      let stopped = false;
      const hooks: WakerHooks = {};

      /** Hand a recorded wake to the bot, and forget it once the bot has it. */
      const handOver = (bot: WakeTarget, wake: PlaceWake) =>
        Effect.gen(function* () {
          const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
          const { submission, run } = yield* Effect.tryPromise({
            try: () => bot.deliver(wake, span && telemetry.view(span)),
            catch: (cause) => new DeliverError({ message: message(cause), cause }),
          }).pipe(Effect.withSpan("wake.deliver", { attributes: { wake: wake.id } }));
          hooks.afterDeliver?.(wake.id);
          yield* log.wakeDelivered(wake.id);
          if (span) wakeSpans.remember(submission, span, telemetry.spanOfCarrier(run));
          yield* Effect.annotateCurrentSpan({ reason: wake.reason, wake: wake.id, submission });
          config.print("wake", { reason: wake.reason, place: wake.place.address, events: wake.events.length });
        });

      const decide = (events: UndecidedEvent[], links: readonly Tracer.AnySpan[]) =>
        Effect.gen(function* () {
          if (!target) return yield* Effect.fail(new NoWakeTarget({ message: "no wake target" }));
          const bot = target;
          const first = events[0]!;
          const place: PlaceInfo = first.place
            ? { address: first.place, kind: first.place_kind ?? "channel", ...(first.place_name ? { name: first.place_name } : {}) }
            : { address: `${first.channel}:`, kind: "channel", name: first.channel };
          const ids = events.map((event) => event.id);
          const id = (reason: string) => `${reason}:${place.address}:${ids.at(-1)}`;
          yield* Effect.annotateCurrentSpan({ place: place.address, events: ids.join(",") });

          const deliver = (reason: PlaceWakeReason, decision: string, judged?: PlaceWake["judged"]) =>
            Effect.gen(function* () {
              const files = yield* Effect.forEach(events, (event) => attachments.files(event), { concurrency: "unbounded" });
              // The bot may have started working on this place while the files came.
              if (reason !== "steer" && bot.isWorkingOn(place.address)) {
                reason = "steer";
                decision = "steer";
                judged = undefined;
              }
              const wakeEvents = yield* withContent(events, files);
              const wake: PlaceWake = { id: id(reason), reason, place, events: wakeEvents, ...(judged ? { judged } : {}) };
              yield* log.recordWake(wake, ids, decision);
              yield* handOver(bot, wake);
            });

          if (bot.isWorkingOn(place.address)) return yield* deliver("steer", "steer");
          if (place.kind === "dm") return yield* deliver("dm", "dm");
          if (events.some((event) => event.mentions_me)) return yield* deliver("mention", "mention");
          if (events.some(answersMe)) return yield* deliver("interaction", "interaction");

          const judge = config.judge();
          if (!judge) return yield* deliver("heard", "heard");
          const settings = config.settings();
          const answer = yield* Effect.result(askJudge(judge, bot, place, events, settings));
          if (Result.isFailure(answer)) {
            // The judge could not decide. Nothing is dropped: the bot gets the events and decides itself.
            config.print("judge failed", { place: place.address, error: failureText(answer.failure) });
            return yield* deliver("relevant", "relevant", { error: failureText(answer.failure) });
          }
          const { related, respond } = answer.success;
          config.print("judge", { place: place.address, events: ids.length, related, respond });
          if (related >= settings.judgeThreshold && respond >= settings.judgeThreshold) return yield* deliver("relevant", "relevant", answer.success);
          // The bot may have started working on this place while the judge thought.
          if (bot.isWorkingOn(place.address)) return yield* deliver("steer", "steer");
          yield* log.setWake(ids, "judge_no");
          yield* Effect.annotateCurrentSpan({ reason: "judge_no" });
        }).pipe(
          // No wake gives the files of events the judge said no to, or of a decision that failed.
          Effect.ensuring(Effect.forEach(events, (event) => attachments.drop(event), { discard: true })),
          Effect.withSpan("wake", { root: true, links: links.map((span) => ({ span, attributes: { [LINK]: "event" } })) }),
        );

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
            const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
            const result = yield* Effect.result(Effect.tryPromise({ try: () => judge.judge(input, span && telemetry.view(span)), catch: (cause) => cause }));
            if (Result.isSuccess(result)) {
              yield* Effect.annotateCurrentSpan({ related: result.success.related, respond: result.success.respond });
              return result.success;
            }
            lastError = result.failure;
          }
          return yield* Effect.fail(new JudgeError({ message: String(lastError), cause: lastError }));
        }).pipe(
          // Anything that goes wrong on the way is the judge failing: the events still go to the bot.
          Effect.catchDefect((defect) => Effect.fail(new JudgeError({ message: String(defect), cause: defect }))),
          Effect.withSpan("wake.judge"),
        );

      /** The events as the wake gives them, with their saved files: their text and thread start as they are now. */
      const withContent = (events: UndecidedEvent[], files: readonly (readonly WakeFile[])[]) =>
        Effect.gen(function* () {
          const addresses = new Set<string>();
          for (const event of events) {
            if (event.message) addresses.add(event.message);
            if (event.thread && event.thread !== event.message) addresses.add(event.thread);
          }
          const messages = new Map((yield* log.messages([...addresses])).map((logged) => [logged.address, logged]));
          return events.map((event, index): WakeEvent => toWakeEvent(event, messages, files[index]!));
        });

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

      /** A decision that failed, in the gateway's output. */
      const reportFailure = (place: string) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(() => config.print("wake decision failed", { place, error: failureText(Cause.squash(cause)) })),
        );

      // Take the whole group at once, so an event that comes now starts the next group.
      const flush = (key: string) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            const batch = batches.get(key);
            if (!batch) return Effect.void;
            batches.delete(key);
            const previous = lastDecision.get(key);
            const decision = Effect.gen(function* () {
              if (previous) {
                yield* Fiber.await(previous);
                // Stopped while the group before waited: these events stay undecided for the next start.
                if (stopped) return;
              }
              yield* decide(batch.events, batch.spans);
            }).pipe(reportFailure(key));
            return Effect.map(FiberSet.run(deciding, decision), (fiber) => void lastDecision.set(key, fiber));
          }),
        );

      // In the place's order: a mention or a DM that comes after the start waits for the wakes from before it.
      const redeliver = Effect.gen(function* () {
        for (const wake of yield* log.pendingWakes) {
          const key = wake.place.address;
          const previous = lastDecision.get(key);
          const fiber = yield* FiberSet.run(
            deciding,
            Effect.gen(function* () {
              if (previous) yield* Fiber.await(previous);
              yield* Effect.sleep(config.settings().debounceMs);
              if (stopped) return;
              if (!target) return yield* Effect.fail(new NoWakeTarget({ message: "no wake target" }));
              yield* handOver(target, wake);
            }).pipe(
              Effect.withSpan("wake", { root: true, attributes: { place: wake.place.address, events: wake.events.map((event) => event.id).join(","), again: true } }),
              reportFailure(key),
            ),
          );
          lastDecision.set(key, fiber);
        }
      });

      return Waker.of({
        hooks,
        redeliver,
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
            if (batch?.ids.has(event.id)) return;
            yield* attachments.start(event);
            if (!batch) batches.set(key, (batch = { events: [], ids: new Set(), spans: [], first: now }));
            batch.events.push(event);
            batch.ids.add(event.id);
            if (Option.isSome(span)) batch.spans.push(span.value);
            // A mention, a DM or an answer to the bot: someone waits for the bot, so the group is decided now, with this
            // event in it. What comes after starts the next group, and reaches the bot while it works on the place
            // (steer). Before the event's channel runs, as for events from before a start, the group waits as others do,
            // so its files can be saved.
            if (atOnce(event) && channels.running(event.channel)) {
              yield* FiberMap.remove(timers, key);
              return yield* flush(key);
            }
            const wait = debounceWait(config.settings(), batch.first, now);
            yield* FiberMap.run(timers, key, Effect.andThen(Effect.sleep(wait), flush(key)));
          }),
        stop: Effect.gen(function* () {
          stopped = true;
          yield* FiberMap.clear(timers);
          batches.clear();
          // A decision that waits for files gives up; its events come back on the next start, and so do the downloads.
          yield* attachments.stop;
          yield* FiberSet.awaitEmpty(deciding);
          lastDecision.clear();
        }),
      });
    }),
  );
}

const MESSAGE_KINDS = new Set(["message", "edit", "update"]);

function toWakeEvent(event: UndecidedEvent, messages: ReadonlyMap<string, LoggedMessage>, files: readonly WakeFile[]): WakeEvent {
  const logged = event.message ? messages.get(event.message) : undefined;
  const root = event.thread && event.thread !== event.message ? messages.get(event.thread) : undefined;
  // A message or an edit: the message's text as it is now. An update does not change the text. Other events: their own
  // text, such as a reaction's emoji.
  const text = event.kind === "message" || event.kind === "edit" ? (logged?.text ?? event.text) : event.kind === "update" ? null : event.text;
  const threadStart: ThreadStart | undefined = root && {
    fromMe: root.from_me === 1,
    text: root.text,
    ...(root.person ? { person: { address: root.person, ...(root.person_name ? { name: root.person_name } : {}) } } : {}),
    ...(root.deleted_at !== null ? { deleted: true } : {}),
  };
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    mentionsMe: event.mentions_me === 1,
    ...(event.message ? { message: event.message } : {}),
    ...(event.thread ? { thread: event.thread } : {}),
    ...(event.person ? { person: { address: event.person, ...(event.person_name ? { name: event.person_name } : {}) } } : {}),
    ...(text ? { text } : {}),
    ...(event.kind === "message" && logged?.edited_at != null ? { edited: true } : {}),
    ...(MESSAGE_KINDS.has(event.kind) && logged?.deleted_at != null ? { deleted: true } : {}),
    ...(threadStart ? { threadStart } : {}),
    ...(files.length ? { files } : {}),
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
