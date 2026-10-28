import { Clock, Context, Effect, FiberHandle, Layer, Option, Semaphore } from "effect";
import type { Sql } from "../core/sql.ts";
import { GatewayConfig } from "./config.ts";
import { BadTime, DeliverError, LogError, message } from "./errors.ts";
import { WakeSpans } from "./tracing.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_timers_pending ON bot_timers (due_at) WHERE state = 'pending';
`;

export interface Timer {
  id: number;
  due_at: number;
  note: string;
  /** "agent": set by the agent. "fallback": the default patrol while the agent has none set. */
  set_by: "agent" | "fallback";
  created_at: number;
}

/** Look at the timers at least this often, so a changed clock or a missed change is noticed. */
export const CHECK_MS = 30_000;

/**
 * Timed wakes. The agent sets as many as it likes. While it has none pending, one fallback wake is kept,
 * fallbackMinutes after the moment it had none left (the start, the last firing, or a cancel).
 */
export class Timers extends Context.Service<
  Timers,
  {
    readonly start: Effect.Effect<void, LogError>;
    readonly stop: Effect.Effect<void>;
    add(dueAt: number, note: string): Effect.Effect<Timer, LogError | BadTime>;
    /** False when there is no pending timer with this ID. */
    cancel(id: number): Effect.Effect<boolean, LogError>;
    /** The fallback interval changed: put the pending fallback wake at the new interval from now. */
    readonly resetFallback: Effect.Effect<void, LogError>;
    readonly pending: Effect.Effect<Timer[], LogError>;
  }
>()("pots/gateway/Timers") {
  static layer(sql: Sql): Layer.Layer<Timers, LogError, GatewayConfig | WakeSpans> {
    return Layer.effect(
      Timers,
      Effect.gen(function* () {
        const config = yield* GatewayConfig;
        const wakeSpans = yield* WakeSpans;
        const db = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: LogError.from });
        yield* db(() => sql.exec(SCHEMA));
        const loop = yield* FiberHandle.make();
        /** Firing and changes to the pending timers happen one at a time. */
        const lock = yield* Semaphore.make(1);
        let stopped = true;

        const pending = db(() => sql.all<Timer>("SELECT id, due_at, note, set_by, created_at FROM bot_timers WHERE state = 'pending' ORDER BY due_at"));

        /** Keep a fallback wake while the agent has none of its own. */
        const ensureFallback = Effect.gen(function* () {
          if ((yield* pending).length > 0) return;
          const now = yield* Clock.currentTimeMillis;
          const dueAt = now + config.fallbackWakeMinutes() * 60_000;
          yield* db(() => sql.run("INSERT INTO bot_timers (due_at, note, state, set_by, created_at) VALUES (?, '', 'pending', 'fallback', ?)", dueAt, now));
        });

        const fire = (timer: Timer) =>
          Effect.gen(function* () {
            const submission = yield* Effect.tryPromise({
              try: () => config.fireTimer(timer),
              catch: (cause) => new DeliverError({ message: message(cause), cause }),
            });
            const now = yield* Clock.currentTimeMillis;
            yield* db(() => sql.run("UPDATE bot_timers SET state = 'fired', fired_at = ? WHERE id = ?", now, timer.id));
            const span = yield* Effect.currentSpan.pipe(Effect.option);
            if (Option.isSome(span)) wakeSpans.remember(submission, span.value);
            yield* Effect.annotateCurrentSpan({ submission });
            config.print("timer fired", { id: timer.id, setBy: timer.set_by });
          }).pipe(Effect.withSpan("wake", { root: true, attributes: { reason: timer.set_by === "fallback" ? "fallback" : "timer", timer: timer.id } }));

        /** Fire what is due. False when a wake could not be handed to the bot; it stays pending. */
        const fireDue = Effect.gen(function* () {
          for (const timer of yield* pending) {
            if (stopped || timer.due_at > (yield* Clock.currentTimeMillis)) break;
            yield* fire(timer);
          }
          yield* ensureFallback;
          return true;
        }).pipe(
          Effect.catch((error) => Effect.sync(() => config.print("timer failed", { error: error.message })).pipe(Effect.as(false))),
          lock.withPermits(1),
          Effect.uninterruptible,
        );

        // Sleep until the next timer is due (or CHECK_MS), fire what is due, again. After a failure, wait CHECK_MS
        // before the next try, so a bot that cannot take wakes is not asked again at once, over and over.
        const run = Effect.forever(
          Effect.gen(function* () {
            const next = (yield* pending)[0];
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(next ? Math.max(0, Math.min(CHECK_MS, next.due_at - now)) : CHECK_MS);
            if (!(yield* fireDue)) yield* Effect.sleep(CHECK_MS);
          }).pipe(Effect.catch((error) => Effect.sync(() => config.print("timer schedule failed", { error: error.message })).pipe(Effect.andThen(Effect.sleep(CHECK_MS))))),
        );

        /** Look at the pending timers again now. */
        const schedule = Effect.suspend(() => (stopped ? Effect.void : FiberHandle.run(loop, run).pipe(Effect.asVoid)));

        const changed = <A>(change: Effect.Effect<A, LogError>) => change.pipe(lock.withPermits(1), Effect.tap(() => schedule));

        return Timers.of({
          start: Effect.gen(function* () {
            stopped = false;
            yield* ensureFallback.pipe(lock.withPermits(1));
            yield* schedule;
          }),
          stop: Effect.suspend(() => {
            stopped = true;
            return FiberHandle.clear(loop);
          }),
          add: (dueAt, note) =>
            Number.isFinite(dueAt)
              ? changed(
                  Effect.flatMap(Clock.currentTimeMillis, (now) =>
                    db(() =>
                      sql.transaction(async (tx) => {
                        await tx.run("UPDATE bot_timers SET state = 'replaced' WHERE state = 'pending' AND set_by = 'fallback'");
                        await tx.run("INSERT INTO bot_timers (due_at, note, state, set_by, created_at) VALUES (?, ?, 'pending', 'agent', ?)", dueAt, note, now);
                        return (await tx.get<Timer>("SELECT id, due_at, note, set_by, created_at FROM bot_timers WHERE id = last_insert_rowid()"))!;
                      }),
                    ),
                  ),
                )
              : Effect.fail(new BadTime({ message: "bad time" })),
          cancel: (id) =>
            changed(
              Effect.gen(function* () {
                const found = yield* db(() => sql.get("SELECT 1 AS x FROM bot_timers WHERE id = ? AND state = 'pending'", id));
                if (!found) return false;
                yield* db(() => sql.run("UPDATE bot_timers SET state = 'cancelled' WHERE id = ?", id));
                yield* ensureFallback;
                return true;
              }),
            ),
          resetFallback: changed(
            Effect.gen(function* () {
              yield* db(() => sql.run("UPDATE bot_timers SET state = 'replaced' WHERE state = 'pending' AND set_by = 'fallback'"));
              yield* ensureFallback;
            }),
          ),
          pending,
        });
      }),
    );
  }
}
