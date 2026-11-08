import { Clock, Context, Effect, FiberHandle, FiberMap, Layer, Option, Semaphore } from "effect";
import type { Sql, SqlExecutor } from "../core/sql.ts";
import { GatewayConfig, type RunCommand } from "./config.ts";
import { BadName, BadRoutine, BadTime, DeliverError, type LogError, message } from "./errors.ts";
import { db } from "./log.ts";
import {
  DEFAULT_TIMEOUT_MS,
  failed,
  nameProblem,
  nextAfter,
  OutputTail,
  ROUTINES_SCHEMA,
  RUN_DAYS,
  type Routine,
  type RoutineInput,
  type RoutineListing,
  type RoutineRun,
  routineProblem,
  type RunResult,
} from "./routines.ts";
import { Telemetry } from "./telemetry.ts";
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

/** Columns that came after the table, added to a bot.sqlite from before them. */
const ADDED_COLUMNS = [
  ["source", "TEXT"],
  ["request_id", "TEXT"],
  ["run_id", "INTEGER"],
] as const;

const COLUMNS = "id, due_at, note, set_by, source, request_id, run_id, created_at";

export interface Timer {
  id: number;
  due_at: number;
  note: string;
  /**
   * "agent": set with pots wake, by the agent, its scripts or a person. "routine": a routine's note, or a failed run of
   * a routine (run_id). "fallback": the check-in while no wake set with pots wake is pending.
   */
  set_by: "agent" | "routine" | "fallback";
  /** Where the wake comes from: pots wake --from (or $POTS_FROM), or the routine's name. */
  source: string | null;
  /** pots wake --id. */
  request_id: string | null;
  /** The routine's failed run that this wake is about. */
  run_id: number | null;
  created_at: number;
}

/** A timer as the bot gets it when it fires: with its routine and the routine's failed run, when there are. */
export interface DueTimer extends Timer {
  routine?: Routine;
  run?: RoutineRun;
}

/** What pots wake gives besides the time and the note. */
export interface WakeOptions {
  source?: string;
  requestId?: string;
}

/** A timer that add made, or the first one with the same request ID, with repeated set. */
export type AddedTimer = Timer & { repeated?: true; state?: string };

/** Look at the timers and the routines at least this often, so a changed clock or a missed change is noticed. */
const CHECK_MS = 30_000;
/** A routine's time that passed longer ago than this, for example while the computer slept, is missed, not made up. */
const LATE_MS = 60_000;
/** After a command is told to stop, wait at most this long for it to end. */
const HALT_MS = 5_000;
/** The next time of a routine whose time never comes again: the last time a Date can hold. */
const NEVER = 8_640_000_000_000_000;
const DAY_MS = 86_400_000;

const noRunner: RunCommand = async () => ({ error: "this gateway cannot run commands" });

/**
 * Timed wakes and routines. The agent sets as many wakes as it likes. While no wake set with pots wake is pending, one
 * fallback wake is kept, fallbackMinutes after the moment there was none left (the start, the last firing, or a
 * cancel); routines do not count. A routine wakes the bot with its note at its times, or runs its command, which
 * decides itself whether to wake the bot; a failed run wakes the bot once, until a run succeeds.
 */
export class Timers extends Context.Service<
  Timers,
  {
    readonly start: Effect.Effect<void, LogError>;
    /** Fire nothing more, and stop the routines' commands. */
    readonly stop: Effect.Effect<void>;
    add(dueAt: number, note: string, options?: WakeOptions): Effect.Effect<AddedTimer, LogError | BadTime | BadName>;
    /** False when there is no pending timer with this ID. */
    cancel(id: number): Effect.Effect<boolean, LogError>;
    /** The fallback interval changed: put the pending fallback wake at the new interval from now. */
    readonly resetFallback: Effect.Effect<void, LogError>;
    readonly pending: Effect.Effect<Timer[], LogError>;
    /** Add a routine, or replace the one with the same name. */
    addRoutine(input: RoutineInput): Effect.Effect<{ routine: Routine; replaced: boolean }, LogError | BadName | BadRoutine>;
    /** False when there is no routine with this name. */
    removeRoutine(name: string): Effect.Effect<boolean, LogError>;
    readonly routines: Effect.Effect<RoutineListing, LogError>;
  }
>()("pots/gateway/Timers") {
  static layer(sql: Sql): Layer.Layer<Timers, LogError, GatewayConfig | WakeSpans | Telemetry> {
    return Layer.effect(
      Timers,
      Effect.gen(function* () {
        const config = yield* GatewayConfig;
        const wakeSpans = yield* WakeSpans;
        const telemetry = yield* Telemetry;
        yield* db(async () => {
          await sql.exec(SCHEMA);
          const columns = new Set((await sql.all<{ name: string }>("PRAGMA table_info(bot_timers)")).map((column) => column.name));
          for (const [name, type] of ADDED_COLUMNS) if (!columns.has(name)) await sql.exec(`ALTER TABLE bot_timers ADD COLUMN ${name} ${type}`);
          await sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS bot_timers_request ON bot_timers (request_id) WHERE request_id IS NOT NULL");
          await sql.exec(ROUTINES_SCHEMA);
        });
        const loop = yield* FiberHandle.make();
        const routineLoop = yield* FiberHandle.make();
        /** The routines' commands that run now, by routine. */
        const runs = yield* FiberMap.make<string>();
        /** Firing, changes to the pending timers and changes to the routines happen one at a time. */
        const lock = yield* Semaphore.make(1);
        let stopped = true;

        const pending = db(() => sql.all<Timer>(`SELECT ${COLUMNS} FROM bot_timers WHERE state = 'pending' ORDER BY due_at`));

        const insertWake = async (tx: SqlExecutor, wake: { dueAt: number; note: string; setBy: Timer["set_by"]; now: number; source?: string; requestId?: string; runId?: number }) => {
          await tx.run(
            "INSERT INTO bot_timers (due_at, note, state, set_by, source, request_id, run_id, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
            wake.dueAt,
            wake.note,
            wake.setBy,
            wake.source ?? null,
            wake.requestId ?? null,
            wake.runId ?? null,
            wake.now,
          );
          return (await tx.get<Timer>(`SELECT ${COLUMNS} FROM bot_timers WHERE id = last_insert_rowid()`))!;
        };

        /** Keep a fallback wake while no wake set with pots wake is pending. Routines do not count. */
        const ensureFallback = Effect.gen(function* () {
          if ((yield* pending).some((timer) => timer.set_by !== "routine")) return;
          const now = yield* Clock.currentTimeMillis;
          const dueAt = now + config.fallbackWakeMinutes() * 60_000;
          yield* db(() => sql.run("INSERT INTO bot_timers (due_at, note, state, set_by, created_at) VALUES (?, '', 'pending', 'fallback', ?)", dueAt, now));
        });

        /** A routine's wake with its routine, and the failed run it is about. */
        const withRoutine = (timer: Timer): Effect.Effect<DueTimer, LogError> =>
          timer.set_by !== "routine"
            ? Effect.succeed(timer)
            : db(async () => {
                const routine = await sql.get<Routine>("SELECT * FROM bot_routines WHERE name = ?", timer.source ?? "");
                const run = timer.run_id === null ? undefined : await sql.get<RoutineRun>("SELECT * FROM bot_routine_runs WHERE id = ?", timer.run_id);
                return { ...timer, ...(routine ? { routine } : {}), ...(run ? { run } : {}) };
              });

        const fire = (timer: Timer) =>
          Effect.gen(function* () {
            const due = yield* withRoutine(timer);
            const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
            const { submission, run } = yield* Effect.tryPromise({
              try: () => config.fireTimer(due, span && telemetry.view(span)),
              catch: (cause) => new DeliverError({ message: message(cause), cause }),
            });
            const now = yield* Clock.currentTimeMillis;
            yield* db(() => sql.run("UPDATE bot_timers SET state = 'fired', fired_at = ? WHERE id = ?", now, timer.id));
            if (span) wakeSpans.remember(submission, span, telemetry.spanOfCarrier(run));
            yield* Effect.annotateCurrentSpan({ submission });
            config.print("timer fired", { id: timer.id, setBy: timer.set_by, ...(timer.source ? { source: timer.source } : {}) });
          }).pipe(Effect.withSpan("wake", { root: true, attributes: { reason: timer.set_by === "agent" ? "timer" : timer.set_by, timer: timer.id } }));

        /** Fire what is due. False when a wake could not be handed to the bot; it stays pending. */
        const fireDue = Effect.gen(function* () {
          if (stopped) return true;
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

        const changed = <A, E>(change: Effect.Effect<A, E>) => change.pipe(lock.withPermits(1), Effect.tap(() => schedule));

        // ---- Routines ----

        /**
         * A run ended: keep how, and wake the bot about a failure, once until a run of the routine succeeds. A run the
         * gateway stopped changes nothing else.
         */
        const finish = (name: string, runId: number, end: { result: RunResult; exitCode?: number; output: string }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const ended = { result: end.result, exit_code: end.exitCode ?? null };
            const woke = yield* db(() =>
              sql.transaction(async (tx) => {
                await tx.run("UPDATE bot_routine_runs SET ended_at = ?, result = ?, exit_code = ?, output = ? WHERE id = ?", now, ended.result, ended.exit_code, end.output, runId);
                await tx.run("DELETE FROM bot_routine_runs WHERE started_at < ? AND result != 'running'", now - RUN_DAYS * DAY_MS);
                if (end.result === "stopped") return false;
                if (!failed(ended)) {
                  await tx.run("UPDATE bot_routines SET failing = 0 WHERE name = ?", name);
                  return false;
                }
                const routine = await tx.get<{ failing: number }>("SELECT failing FROM bot_routines WHERE name = ?", name);
                if (!routine || routine.failing) return false;
                await tx.run("UPDATE bot_routines SET failing = 1 WHERE name = ?", name);
                await insertWake(tx, { dueAt: now, note: "", setBy: "routine", source: name, runId, now });
                return true;
              }),
            ).pipe(lock.withPermits(1));
            config.print("routine ended", { routine: name, run: runId, result: end.result, ...(end.exitCode === undefined ? {} : { exitCode: end.exitCode }) });
            if (woke) yield* schedule;
          }).pipe(
            Effect.catch((error) => Effect.sync(() => config.print("routine run failed", { routine: name, run: runId, error: error.message }))),
            Effect.uninterruptible,
          );

        /** Run a routine's command, until it ends, its timeout comes or the gateway stops. */
        const execute = (routine: Routine & { run: string }, runId: number) =>
          Effect.gen(function* () {
            const output = new OutputTail();
            const controller = new AbortController();
            const runCommand = config.runCommand ?? noRunner;
            let ended: Promise<{ exitCode: number } | { error: string }>;
            try {
              ended = runCommand(routine.run, { POTS_FROM: routine.name }, controller.signal, (text) => output.push(text)).catch((cause: unknown) => ({ error: message(cause) }));
            } catch (cause) {
              ended = Promise.resolve({ error: message(cause) });
            }
            const end = () => ended;
            const halt = Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.promise(end).pipe(Effect.timeoutOption(HALT_MS))));
            const outcome = yield* Effect.promise(end).pipe(
              Effect.timeoutOption(routine.timeout_ms),
              Effect.onInterrupt(() => halt.pipe(Effect.andThen(finish(routine.name, runId, { result: "stopped", output: output.text })))),
            );
            yield* Effect.uninterruptible(
              Option.match(outcome, {
                onNone: () => halt.pipe(Effect.andThen(finish(routine.name, runId, { result: "timeout", output: output.text }))),
                onSome: (result) =>
                  "error" in result
                    ? finish(routine.name, runId, { result: "error", output: result.error })
                    : finish(routine.name, runId, { result: "exit", exitCode: result.exitCode, output: output.text }),
              }),
            );
          });

        /** Start what is due: a --note routine's wake, or a --run routine's command. Missed times are skipped. */
        const routinesDue = Effect.gen(function* () {
          // The time it woke up for: before any read of the database, which lets the clock move on.
          const now = yield* Clock.currentTimeMillis;
          if (stopped) return false;
          const due = yield* db(() => sql.all<Routine>("SELECT * FROM bot_routines WHERE next_at <= ? ORDER BY next_at, name", now));
          let woke = false;
          for (const routine of due) {
            const next = nextAfter(routine, now) ?? NEVER;
            const setNext = (tx: SqlExecutor) => tx.run("UPDATE bot_routines SET next_at = ? WHERE name = ?", next, routine.name);
            const late = now - routine.next_at > LATE_MS;
            // The last run still runs: its command, or its wake that the bot has not taken yet.
            const busy =
              !late &&
              (routine.run !== null
                ? yield* FiberMap.has(runs, routine.name)
                : (yield* db(() => sql.get("SELECT 1 AS x FROM bot_timers WHERE state = 'pending' AND set_by = 'routine' AND source = ? AND run_id IS NULL", routine.name))) !== undefined);
            if (late || busy) {
              yield* db(() => setNext(sql));
              config.print(late ? "routine missed" : "routine skipped: its last run still runs", { routine: routine.name, due: routine.next_at, next });
            } else if (routine.run === null) {
              yield* db(() =>
                sql.transaction(async (tx) => {
                  await setNext(tx);
                  await tx.run("INSERT INTO bot_routine_runs (routine, started_at, ended_at, result) VALUES (?, ?, ?, 'woke')", routine.name, now, now);
                  await insertWake(tx, { dueAt: now, note: routine.note ?? "", setBy: "routine", source: routine.name, now });
                }),
              );
              woke = true;
            } else {
              const runId = yield* db(() =>
                sql.transaction(async (tx) => {
                  await setNext(tx);
                  await tx.run("INSERT INTO bot_routine_runs (routine, started_at, result) VALUES (?, ?, 'running')", routine.name, now);
                  return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
                }),
              );
              config.print("routine started", { routine: routine.name, run: runId });
              yield* FiberMap.run(runs, routine.name)(execute({ ...routine, run: routine.run }, runId));
            }
          }
          return woke;
        }).pipe(lock.withPermits(1), Effect.uninterruptible);

        // Sleep until the next routine is due (or CHECK_MS), start what is due, again.
        const runRoutines = Effect.forever(
          Effect.gen(function* () {
            const next = yield* db(() => sql.get<{ at: number | null }>("SELECT min(next_at) AS at FROM bot_routines"));
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(next?.at != null ? Math.max(0, Math.min(CHECK_MS, next.at - now)) : CHECK_MS);
            if (yield* routinesDue) yield* schedule;
          }).pipe(Effect.catch((error) => Effect.sync(() => config.print("routine schedule failed", { error: error.message })).pipe(Effect.andThen(Effect.sleep(CHECK_MS))))),
        );

        /** Look at the routines again now. */
        const scheduleRoutines = Effect.suspend(() => (stopped ? Effect.void : FiberHandle.run(routineLoop, runRoutines).pipe(Effect.asVoid)));

        /**
         * At the start: runs a stop or a crash cut off are stopped, and times that passed while the gateway was stopped
         * are missed, so each routine's next time is its next one from now.
         */
        const settleRoutines = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const missed = yield* db(() =>
            sql.transaction(async (tx) => {
              await tx.run("UPDATE bot_routine_runs SET result = 'stopped' WHERE result = 'running'");
              await tx.run("DELETE FROM bot_routine_runs WHERE started_at < ?", now - RUN_DAYS * DAY_MS);
              const missed = await tx.all<Routine>("SELECT * FROM bot_routines WHERE next_at <= ?", now);
              for (const routine of missed) await tx.run("UPDATE bot_routines SET next_at = ? WHERE name = ?", nextAfter(routine, now) ?? NEVER, routine.name);
              return missed;
            }),
          );
          for (const routine of missed) config.print("routine missed", { routine: routine.name, due: routine.next_at });
        });

        return Timers.of({
          start: Effect.gen(function* () {
            stopped = false;
            yield* ensureFallback.pipe(lock.withPermits(1));
            yield* settleRoutines.pipe(lock.withPermits(1));
            yield* schedule;
            yield* scheduleRoutines;
          }),
          // A loop that was replaced may still be firing: taking the lock waits for it. Stopping a command records its
          // run, which takes the lock too.
          stop: Effect.suspend(() => {
            stopped = true;
            return FiberHandle.clear(loop).pipe(
              Effect.andThen(FiberHandle.clear(routineLoop)),
              Effect.andThen(FiberMap.clear(runs)),
              Effect.andThen(lock.withPermits(1)(Effect.void)),
            );
          }),
          add: (dueAt, note, options = {}) => {
            if (!Number.isFinite(dueAt)) return Effect.fail(new BadTime({ message: "bad time" }));
            const problem = options.source === undefined ? undefined : nameProblem(options.source, "--from");
            if (problem) return Effect.fail(new BadName({ message: problem }));
            return changed(
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                db(() =>
                  sql.transaction(async (tx): Promise<AddedTimer> => {
                    if (options.requestId !== undefined) {
                      const first = await tx.get<Timer & { state: string }>(`SELECT ${COLUMNS}, state FROM bot_timers WHERE request_id = ?`, options.requestId);
                      if (first) return { ...first, repeated: true };
                    }
                    await tx.run("UPDATE bot_timers SET state = 'replaced' WHERE state = 'pending' AND set_by = 'fallback'");
                    return insertWake(tx, { dueAt, note, setBy: "agent", now, ...options });
                  }),
                ),
              ),
            );
          },
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
          addRoutine: (input) =>
            Effect.gen(function* () {
              const name = nameProblem(input.name, "routine name");
              if (name) return yield* Effect.fail(new BadName({ message: name }));
              const now = yield* Clock.currentTimeMillis;
              const problem = routineProblem(input, now);
              if (problem) return yield* Effect.fail(new BadRoutine({ message: problem }));
              const schedule = { every_ms: input.every ?? null, cron: input.cron ?? null, created_at: now };
              const routine: Routine = {
                name: input.name,
                ...schedule,
                note: input.note ?? null,
                run: input.run ?? null,
                timeout_ms: input.timeout ?? DEFAULT_TIMEOUT_MS,
                next_at: nextAfter(schedule, now) ?? NEVER,
                failing: 0,
              };
              const replaced = yield* db(() =>
                sql.transaction(async (tx) => {
                  const before = await tx.get("SELECT 1 AS x FROM bot_routines WHERE name = ?", routine.name);
                  await tx.run(
                    "INSERT OR REPLACE INTO bot_routines (name, every_ms, cron, note, run, timeout_ms, created_at, next_at, failing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
                    routine.name,
                    routine.every_ms,
                    routine.cron,
                    routine.note,
                    routine.run,
                    routine.timeout_ms,
                    routine.created_at,
                    routine.next_at,
                  );
                  return before !== undefined;
                }),
              );
              return { routine, replaced };
            }).pipe(lock.withPermits(1), Effect.tap(() => scheduleRoutines)),
          removeRoutine: (name) =>
            db(() =>
              sql.transaction(async (tx) => {
                const found = await tx.get("SELECT 1 AS x FROM bot_routines WHERE name = ?", name);
                if (found) await tx.run("DELETE FROM bot_routines WHERE name = ?", name);
                return found !== undefined;
              }),
            ).pipe(lock.withPermits(1), Effect.tap(() => scheduleRoutines)),
          routines: Effect.gen(function* () {
            const routines = yield* db(async () => {
              const list: RoutineListing["routines"] = [];
              for (const routine of await sql.all<Routine>("SELECT * FROM bot_routines ORDER BY name")) {
                const last = await sql.get<RoutineRun>("SELECT * FROM bot_routine_runs WHERE routine = ? ORDER BY id DESC LIMIT 1", routine.name);
                list.push(last ? { ...routine, last } : routine);
              }
              return list;
            });
            const fallback = (yield* pending).find((timer) => timer.set_by === "fallback");
            return { routines, fallback: { minutes: config.fallbackWakeMinutes(), ...(fallback ? { next: fallback.due_at } : {}) } };
          }),
        });
      }),
    );
  }
}
