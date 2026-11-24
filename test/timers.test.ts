import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Timers } from "../src/gateway/timers.ts";
import { advance, type Recorder, settle, withCore } from "./support/core.ts";

// The timers and routines on Effect's TestClock: each wake fires at its exact time, without waiting.

const SECOND = 1_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The routines' wakes so far: [routine, failed run's result or "note", when]. */
const routineWakes = (recorder: Recorder) =>
  recorder.timers.filter((entry) => entry.timer.set_by === "routine").map((entry) => [entry.timer.source, entry.timer.run?.result ?? "note", entry.at]);

/** Move the clock in steps of 10 seconds, so the routines' loop wakes at each time it waits for. */
const pass = (ms: number) => advance(ms, 10 * SECOND);

describe("timers", () => {
  it.effect("set no wake of their own: with none set, nothing fires", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        assert.deepStrictEqual(yield* timers.pending, []);
        yield* advance(DAY);
        assert.strictEqual(recorder.timers.length, 0);
      }),
    ));

  it.effect("fire the agent's wakes in time order", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.add(90 * MINUTE, "later");
        yield* timers.add(5 * MINUTE, "soon");
        yield* settle;
        assert.deepStrictEqual((yield* timers.pending).map((timer) => timer.note), ["soon", "later"]);

        yield* advance(5 * MINUTE);
        yield* advance(85 * MINUTE);
        assert.deepStrictEqual(recorder.timers.map((entry) => [entry.timer.note, entry.at]), [["soon", 5 * MINUTE], ["later", 90 * MINUTE]]);
        assert.deepStrictEqual(yield* timers.pending, []);
      }),
    ));

  it.effect("cancel a wake", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const timer = yield* timers.add(30 * MINUTE, "check");
        yield* advance(10 * MINUTE);
        assert.isTrue(yield* timers.cancel(timer.id));
        assert.isFalse(yield* timers.cancel(timer.id));
        yield* advance(30 * MINUTE);
        assert.strictEqual(recorder.timers.length, 0);
        assert.deepStrictEqual(yield* timers.pending, []);
      }),
    ));

  it.effect("try a wake again when the bot could not take it", () => {
    let failures = 1;
    return withCore({ failTimer: () => failures-- > 0 }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.add(MINUTE, "retry me");
        yield* advance(MINUTE);
        assert.strictEqual(recorder.timers.length, 0);
        assert.isTrue(recorder.prints.some((print) => print.message === "timer failed"));
        // Still pending, so the next look fires it.
        yield* advance(30_000);
        assert.deepStrictEqual(recorder.timers.map((entry) => [entry.timer.note, entry.at]), [["retry me", MINUTE + 30_000]]);
      }),
    );
  });

  it.effect("give back the first wake for a second wake with the same ID, and keep where a wake comes from", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const first = yield* timers.add(10 * MINUTE, "new mail", { source: "inbox-watch", requestId: "mail-1" });
        assert.deepStrictEqual([first.set_by, first.source, first.request_id, first.repeated], ["agent", "inbox-watch", "mail-1", undefined]);
        const again = yield* timers.add(20 * MINUTE, "new mail again", { source: "inbox-watch", requestId: "mail-1" });
        assert.deepStrictEqual([again.id, again.note, again.repeated, again.state], [first.id, "new mail", true, "pending"]);
        yield* advance(10 * MINUTE);
        assert.deepStrictEqual(recorder.timers.map((entry) => [entry.timer.note, entry.timer.source]), [["new mail", "inbox-watch"]]);
        // Also once the first has fired.
        assert.deepStrictEqual([(yield* timers.add(30 * MINUTE, "", { requestId: "mail-1" })).state, (yield* timers.pending).length], ["fired", 0]);
        const bad = yield* Effect.flip(timers.add(30 * MINUTE, "", { source: "two words" }));
        assert.strictEqual(bad.message, 'bad --from "two words": use letters, digits, "-" and "_", at most 64 characters');
      }),
    ));

  it.effect("fire nothing after stop", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.stop;
        yield* advance(10 * MINUTE);
        assert.strictEqual(recorder.timers.length, 0);
      }),
    ));
});

describe("routines", () => {
  it.effect("wake the bot with a routine's note at each time", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const { routine } = yield* timers.addRoutine({ name: "standup", every: 20 * MINUTE, note: "ask about the release" });
        assert.strictEqual(routine.next_at, 20 * MINUTE);
        yield* pass(60 * MINUTE);
        assert.deepStrictEqual(routineWakes(recorder), [["standup", "note", 20 * MINUTE], ["standup", "note", 40 * MINUTE], ["standup", "note", 60 * MINUTE]]);
        assert.strictEqual(recorder.timers[0]!.timer.note, "ask about the release");
        assert.strictEqual(recorder.timers[0]!.timer.routine?.every_ms, 20 * MINUTE);
        const listing = yield* timers.routines;
        assert.deepStrictEqual([listing.routines[0]?.next_at, listing.routines[0]?.last?.result], [80 * MINUTE, "woke"]);
      }),
    ));

  it.effect("follow a cron expression in this computer's time zone", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "quarter", cron: "*/15 * * * *", note: "" });
        yield* pass(45 * MINUTE);
        // Time zones are whole quarters of an hour from UTC, so the quarters are the same here and there.
        assert.deepStrictEqual(routineWakes(recorder), [["quarter", "note", 15 * MINUTE], ["quarter", "note", 30 * MINUTE], ["quarter", "note", 45 * MINUTE]]);
      }),
    ));

  // Sydney's clocks go forward at 2:00 on 4 October 2026 and back at 3:00 on 5 April 2026. From 20:00 the night
  // before, the look's cron comes at 8:00 local time on the morning of the change, once.
  for (const [change, evening] of [
    ["forward", "2026-10-03T20:00:00+10:00"],
    ["back", "2026-04-04T20:00:00+11:00"],
  ] as const) {
    it.effect(`follow a cron expression across Sydney's clocks going ${change}`, () =>
      Effect.gen(function* () {
        const zone = process.env.TZ;
        process.env.TZ = "Australia/Sydney";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (zone === undefined) delete process.env.TZ;
            else process.env.TZ = zone;
          }),
        );
        yield* TestClock.setTime(Date.parse(evening));
        yield* withCore({}, (recorder) =>
          Effect.gen(function* () {
            const timers = yield* Timers;
            yield* timers.start;
            yield* timers.addRoutine({ name: "look", cron: "0 8-22/3 * * *", note: "" });
            yield* advance(16 * 60 * MINUTE, MINUTE);
            const local = (at: number) => new Date(at).toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Sydney" });
            assert.deepStrictEqual(routineWakes(recorder).map(([, , at]) => local(at as number)), ["08:00:00", "11:00:00"]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect("count a cron's next time again in the computer's time zone at the start", () =>
    Effect.gen(function* () {
      const zone = process.env.TZ;
      process.env.TZ = "UTC";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (zone === undefined) delete process.env.TZ;
          else process.env.TZ = zone;
        }),
      );
      // Kathmandu was 5:30 ahead of UTC in 1970, where the TestClock starts.
      const midnight = Date.parse("2026-11-24T00:00:00Z");
      yield* TestClock.setTime(midnight);
      yield* withCore({}, (recorder) =>
        Effect.gen(function* () {
          const timers = yield* Timers;
          yield* timers.start;
          yield* timers.addRoutine({ name: "morning", cron: "0 8 * * *", note: "" });
          assert.strictEqual((yield* timers.routines).routines[0]?.next_at, midnight + 8 * 60 * MINUTE);
          yield* timers.stop;
          // The computer moves to Kathmandu, 5:45 ahead of UTC, while the gateway is stopped.
          process.env.TZ = "Asia/Kathmandu";
          yield* timers.start;
          yield* settle;
          const morning = midnight + 8 * 60 * MINUTE - (5 * 60 + 45) * MINUTE;
          assert.strictEqual((yield* timers.routines).routines[0]?.next_at, morning);
          yield* advance(morning - midnight, MINUTE);
          assert.deepStrictEqual(routineWakes(recorder), [["morning", "note", morning]]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("run a routine's command with POTS_FROM, skip a time while it still runs, and keep each run's end", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "inbox-watch", every: 10 * MINUTE, run: "./watch.sh", timeout: 60 * MINUTE });
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(recorder.commands.map((command) => [command.command, command.env, command.at]), [["./watch.sh", { POTS_FROM: "inbox-watch" }, 10 * MINUTE]]);
        assert.strictEqual((yield* timers.routines).routines[0]?.last?.result, "running");

        // Still running at 20 minutes: that time is skipped.
        yield* pass(15 * MINUTE);
        assert.strictEqual(recorder.commands.length, 1);
        assert.isTrue(recorder.prints.some((print) => print.message === "routine skipped: its last run still runs" && print.data?.due === 20 * MINUTE));
        recorder.commands[0]!.output("checked 3 mailboxes\n");
        recorder.commands[0]!.end(0);
        yield* settle;
        const last = (yield* timers.routines).routines[0]?.last;
        assert.deepStrictEqual([last?.result, last?.exit_code, last?.output, last?.started_at, last?.ended_at], ["exit", 0, "checked 3 mailboxes", 10 * MINUTE, 25 * MINUTE]);
        yield* pass(5 * MINUTE);
        assert.deepStrictEqual(recorder.commands.map((command) => command.at), [10 * MINUTE, 30 * MINUTE]);
        // A run that works wakes nobody.
        assert.deepStrictEqual(routineWakes(recorder), []);
      }),
    ));

  it.effect("start a --child routine's child without waking the bot, skip a time while that child works, and wake the bot once when none could start", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "mail-watch", every: 10 * MINUTE, child: "look at the new mail" });
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(recorder.children, [{ id: "c1", routine: "mail-watch", brief: "look at the new mail", at: 10 * MINUTE }]);
        const last = (yield* timers.routines).routines[0]?.last;
        assert.deepStrictEqual([last?.result, last?.output], ["child", "c1"]);
        assert.deepStrictEqual(recorder.timers, []);

        // c1 still works at 20 minutes: that time is skipped. Once it ended, the next time starts the next child.
        yield* pass(10 * MINUTE);
        assert.strictEqual(recorder.children.length, 1);
        assert.isTrue(recorder.prints.some((print) => print.message === "routine skipped: its last run still runs" && print.data?.due === 20 * MINUTE));
        recorder.workingChildren.delete("c1");
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(recorder.children.map((child) => [child.id, child.at]), [["c1", 10 * MINUTE], ["c2", 30 * MINUTE]]);
        recorder.workingChildren.clear();

        // At the cap no child starts: that wakes the bot once, until a child starts again.
        recorder.refuseChildren = "2 children work now, as many as the cap";
        yield* pass(20 * MINUTE);
        assert.deepStrictEqual(routineWakes(recorder), [["mail-watch", "error", 40 * MINUTE]]);
        assert.strictEqual(recorder.timers[0]!.timer.run?.output, "the child could not start: 2 children work now, as many as the cap");
        recorder.refuseChildren = undefined;
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(recorder.children.map((child) => child.at), [10 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
        assert.strictEqual((yield* timers.routines).routines[0]?.failing, 0);
        assert.strictEqual(recorder.timers.length, 1);

        // A message made the earlier child work again after the routine looked: that time is skipped, as when the
        // routine sees it, and leaves no run and no wake.
        recorder.workingChildren.clear();
        recorder.workingAgain = "c3";
        yield* pass(10 * MINUTE);
        assert.strictEqual(recorder.children.length, 3);
        assert.isTrue(recorder.prints.some((print) => print.message === "routine skipped: its last run still runs" && print.data?.child === "c3"));
        const runs = (yield* timers.routines).routines[0]?.last;
        assert.deepStrictEqual([runs?.result, runs?.output], ["child", "c3"]);
        assert.strictEqual(recorder.timers.length, 1);
      }),
    ));

  it.effect("wake the bot once for failed runs, until a run succeeds, with the last lines of the output", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "backup", every: 10 * MINUTE, run: "./backup.sh" });
        const runAndEnd = (exitCode: number, output = "") =>
          Effect.gen(function* () {
            yield* pass(10 * MINUTE);
            const command = recorder.commands.at(-1)!;
            command.output(output);
            command.end(exitCode);
            yield* settle;
          });
        yield* runAndEnd(2, `${Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n")}\n`);
        assert.deepStrictEqual(routineWakes(recorder), [["backup", "exit", 10 * MINUTE]]);
        const failure = recorder.timers.at(-1)!.timer;
        assert.strictEqual(failure.run?.exit_code, 2);
        assert.strictEqual(failure.run?.output, Array.from({ length: 20 }, (_, line) => `line ${line + 11}`).join("\n"));
        yield* runAndEnd(1);
        yield* runAndEnd(3);
        assert.strictEqual(routineWakes(recorder).length, 1);
        yield* runAndEnd(0);
        yield* runAndEnd(4);
        assert.deepStrictEqual(routineWakes(recorder), [["backup", "exit", 10 * MINUTE], ["backup", "exit", 50 * MINUTE]]);
      }),
    ));

  it.effect("stop a command at its timeout, and count that as a failure", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "slow", every: 10 * MINUTE, run: "sleep 1000", timeout: 2 * MINUTE });
        yield* pass(10 * MINUTE);
        recorder.commands[0]!.output("still working\n");
        yield* pass(2 * MINUTE - 10 * SECOND);
        assert.isFalse(recorder.commands[0]!.aborted);
        yield* pass(10 * SECOND);
        assert.isTrue(recorder.commands[0]!.aborted);
        assert.deepStrictEqual(routineWakes(recorder), [["slow", "timeout", 12 * MINUTE]]);
        assert.strictEqual(recorder.timers[0]!.timer.run?.output, "still working");
        // The default timeout is 10 minutes.
        yield* timers.addRoutine({ name: "slow", every: 60 * MINUTE, run: "sleep 1000" });
        assert.strictEqual((yield* timers.routines).routines[0]?.timeout_ms, 10 * MINUTE);
      }),
    ));

  it.effect("stop the commands when the timers stop, and wake nobody about it", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "long", every: 10 * MINUTE, run: "sleep 1000" });
        yield* pass(10 * MINUTE);
        yield* timers.stop;
        assert.isTrue(recorder.commands[0]!.aborted);
        assert.strictEqual((yield* timers.routines).routines[0]?.last?.result, "stopped");
        assert.deepStrictEqual(routineWakes(recorder), []);
      }),
    ));

  it.effect("skip the times missed while stopped, and go on from the next one", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "tick", every: 10 * MINUTE, note: "" });
        yield* pass(10 * MINUTE);
        yield* timers.stop;
        yield* advance(45 * MINUTE);
        yield* timers.start;
        yield* settle;
        assert.deepStrictEqual(
          recorder.prints.filter((print) => print.message === "routine missed").map((print) => print.data?.due),
          [20 * MINUTE],
        );
        assert.strictEqual((yield* timers.routines).routines[0]?.next_at, 60 * MINUTE);
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(routineWakes(recorder), [["tick", "note", 10 * MINUTE], ["tick", "note", 60 * MINUTE]]);
      }),
    ));

  it.effect("skip a time that Pots could look at only long after, as when the computer slept", () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    return withCore({ holdTimer: (timer) => (timer.note === "slow" ? held : undefined) }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "tick", every: 10 * MINUTE, note: "" });
        // A wake the bot takes only much later keeps the timers busy from 5 minutes to 3 hours.
        yield* timers.add(5 * MINUTE, "slow");
        yield* pass(180 * MINUTE);
        release();
        yield* settle;
        assert.isTrue(recorder.prints.some((print) => print.message === "routine missed" && print.data?.due === 10 * MINUTE && print.data?.next === 190 * MINUTE));
        yield* pass(10 * MINUTE);
        assert.deepStrictEqual(routineWakes(recorder), [["tick", "note", 190 * MINUTE]]);
      }),
    );
  });

  it.effect("keep a replaced routine's run that still runs apart from the routine that replaced it", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "backup", every: 10 * MINUTE, run: "./old.sh" });
        yield* pass(10 * MINUTE);
        const old = recorder.commands.at(-1)!;
        assert.strictEqual(old.command, "./old.sh");
        yield* timers.addRoutine({ name: "backup", every: 10 * MINUTE, run: "./new.sh" });
        // The old command fails after the replacement: its run is kept, but it wakes nobody and does not count for the
        // new routine.
        old.end(1);
        yield* settle;
        assert.deepStrictEqual(routineWakes(recorder), []);
        assert.strictEqual((yield* timers.routines).routines[0]!.failing, 0);
        yield* pass(10 * MINUTE);
        const replacement = recorder.commands.at(-1)!;
        assert.strictEqual(replacement.command, "./new.sh");
        replacement.end(2);
        yield* settle;
        assert.deepStrictEqual(routineWakes(recorder), [["backup", "exit", 20 * MINUTE]]);
      }),
    ));

  it.effect("drop the runs older than 7 days, also when only --note routines run", () =>
    withCore({}, (recorder, sql) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* Effect.promise(() => sql.run("INSERT INTO bot_routine_runs (routine, started_at, ended_at, result) VALUES ('look', ?, ?, 'woke')", -8 * DAY, -8 * DAY));
        yield* timers.addRoutine({ name: "look", every: MINUTE, note: "look around" });
        yield* pass(MINUTE);
        assert.strictEqual(recorder.timers.length, 1);
        assert.deepStrictEqual(yield* Effect.promise(() => sql.all<{ started_at: number }>("SELECT started_at FROM bot_routine_runs")), [{ started_at: MINUTE }]);
      }),
    ));

  it.effect("replace a routine added again with the same name, and remove one", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        assert.isFalse((yield* timers.addRoutine({ name: "check", every: 10 * MINUTE, note: "one" })).replaced);
        yield* pass(5 * MINUTE);
        const again = yield* timers.addRoutine({ name: "check", every: 30 * MINUTE, note: "two" });
        assert.deepStrictEqual([again.replaced, again.routine.next_at], [true, 35 * MINUTE]);
        yield* pass(30 * MINUTE);
        assert.deepStrictEqual(recorder.timers.map((entry) => [entry.timer.note, entry.at]), [["two", 35 * MINUTE]]);
        assert.isTrue(yield* timers.removeRoutine("check"));
        assert.isFalse(yield* timers.removeRoutine("check"));
        yield* pass(60 * MINUTE);
        assert.strictEqual(recorder.timers.length, 1);
        assert.deepStrictEqual((yield* timers.routines).routines, []);
      }),
    ));

  it.effect("refuse a routine that cannot work, and say why", () =>
    withCore({}, () =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        const refused = (input: Parameters<typeof timers.addRoutine>[0]) => Effect.flip(timers.addRoutine(input)).pipe(Effect.map((error) => error.message));
        assert.strictEqual(yield* refused({ name: "a b", every: MINUTE, note: "" }), 'bad routine name "a b": use letters, digits, "-" and "_", at most 64 characters');
        assert.strictEqual(yield* refused({ name: "a", note: "" }), "give exactly one of --every and --cron");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, cron: "* * * * *", note: "" }), "give exactly one of --every and --cron");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE }), "give exactly one of --note, --run and --child");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, note: "", run: "x" }), "give exactly one of --note, --run and --child");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, run: "x", child: "y" }), "give exactly one of --note, --run and --child");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, child: " " }), "--child is empty");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, child: "y", timeout: MINUTE }), "--timeout is for --run");
        assert.strictEqual(yield* refused({ name: "a", every: 0, note: "" }), "--every must be more than 0");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, run: " " }), "--run is empty");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, note: "", timeout: MINUTE }), "--timeout is for --run");
        assert.strictEqual(yield* refused({ name: "a", cron: "61 * * * *", note: "" }), 'bad cron expression "61 * * * *": Expected a value between 0 and 59');
        assert.strictEqual(yield* refused({ name: "a", cron: "0 0 30 2 *", note: "" }), 'bad cron expression "0 0 30 2 *": its time never comes');
        assert.deepStrictEqual((yield* timers.routines).routines, []);
      }),
    ));
});
