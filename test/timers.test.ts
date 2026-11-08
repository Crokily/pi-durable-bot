import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Timers } from "../src/gateway/timers.ts";
import { advance, type Recorder, settle, withCore } from "./support/core.ts";

// The timers and routines on Effect's TestClock: each wake fires at its exact time, without waiting.

const SECOND = 1_000;
const MINUTE = 60_000;

/** The routines' wakes so far: [routine, failed run's result or "note", when]. */
const routineWakes = (recorder: Recorder) =>
  recorder.timers.filter((entry) => entry.timer.set_by === "routine").map((entry) => [entry.timer.source, entry.timer.run?.result ?? "note", entry.at]);

/** Move the clock in steps of 10 seconds, so the routines' loop wakes at each time it waits for. */
const pass = (ms: number) => advance(ms, 10 * SECOND);

describe("timers", () => {
  it.effect("keep one fallback wake while the agent has none, and fire it on time", () =>
    withCore({ fallbackWakeMinutes: 120 }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const [fallback] = yield* timers.pending;
        assert.deepStrictEqual([fallback?.set_by, fallback?.due_at], ["fallback", 120 * MINUTE]);

        yield* advance(120 * MINUTE - 1);
        assert.strictEqual(recorder.timers.length, 0);
        yield* advance(1);
        assert.deepStrictEqual(recorder.timers.map((entry) => [entry.timer.set_by, entry.at]), [["fallback", 120 * MINUTE]]);
        // The next fallback counts from the firing.
        assert.deepStrictEqual((yield* timers.pending).map((timer) => timer.due_at), [240 * MINUTE]);
      }),
    ));

  it.effect("fire the agent's wakes in time order, and bring the fallback back after the last one", () =>
    withCore({ fallbackWakeMinutes: 120 }, (recorder) =>
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
        const [fallback] = yield* timers.pending;
        assert.deepStrictEqual([fallback?.set_by, fallback?.due_at], ["fallback", 210 * MINUTE]);
      }),
    ));

  it.effect("cancel a wake; the fallback comes back from that moment", () =>
    withCore({ fallbackWakeMinutes: 60 }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const timer = yield* timers.add(30 * MINUTE, "check");
        yield* advance(10 * MINUTE);
        assert.isTrue(yield* timers.cancel(timer.id));
        assert.isFalse(yield* timers.cancel(timer.id));
        yield* advance(30 * MINUTE);
        assert.strictEqual(recorder.timers.length, 0);
        assert.deepStrictEqual((yield* timers.pending).map((pending) => [pending.set_by, pending.due_at]), [["fallback", 70 * MINUTE]]);
      }),
    ));

  it.effect("try a wake again when the bot could not take it", () => {
    let failures = 1;
    return withCore({ fallbackWakeMinutes: 120, failTimer: () => failures-- > 0 }, (recorder) =>
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
    withCore({ fallbackWakeMinutes: 120 }, (recorder) =>
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
        assert.deepStrictEqual([(yield* timers.add(30 * MINUTE, "", { requestId: "mail-1" })).state, (yield* timers.pending).length], ["fired", 1]);
        const bad = yield* Effect.flip(timers.add(30 * MINUTE, "", { source: "two words" }));
        assert.strictEqual(bad.message, 'bad --from "two words": use letters, digits, "-" and "_", at most 64 characters');
      }),
    ));

  it.effect("fire nothing after stop", () =>
    withCore({ fallbackWakeMinutes: 1 }, (recorder) =>
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
  it.effect("wake the bot with a routine's note at each time, and never hold back the fallback check-in", () =>
    withCore({ fallbackWakeMinutes: 60 }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        const { routine } = yield* timers.addRoutine({ name: "standup", every: 20 * MINUTE, note: "ask about the release" });
        assert.strictEqual(routine.next_at, 20 * MINUTE);
        yield* pass(60 * MINUTE);
        assert.deepStrictEqual(routineWakes(recorder), [["standup", "note", 20 * MINUTE], ["standup", "note", 40 * MINUTE], ["standup", "note", 60 * MINUTE]]);
        assert.strictEqual(recorder.timers[0]!.timer.note, "ask about the release");
        assert.strictEqual(recorder.timers[0]!.timer.routine?.every_ms, 20 * MINUTE);
        // The fallback came on its time, as if there were no routine.
        assert.deepStrictEqual(
          recorder.timers.filter((entry) => entry.timer.set_by === "fallback").map((entry) => entry.at),
          [60 * MINUTE],
        );
        const listing = yield* timers.routines;
        assert.deepStrictEqual([listing.routines[0]?.next_at, listing.routines[0]?.last?.result, listing.fallback], [80 * MINUTE, "woke", { minutes: 60, next: 120 * MINUTE }]);

        // Only a wake set with pots wake holds the fallback back.
        yield* timers.add(200 * MINUTE, "later");
        assert.deepStrictEqual((yield* timers.routines).fallback, { minutes: 60 });
        assert.deepStrictEqual((yield* timers.pending).map((timer) => timer.set_by), ["agent"]);
      }),
    ));

  it.effect("follow a cron expression in this computer's time zone", () =>
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
      Effect.gen(function* () {
        const timers = yield* Timers;
        yield* timers.start;
        yield* timers.addRoutine({ name: "quarter", cron: "*/15 * * * *", note: "" });
        yield* pass(45 * MINUTE);
        // Time zones are whole quarters of an hour from UTC, so the quarters are the same here and there.
        assert.deepStrictEqual(routineWakes(recorder), [["quarter", "note", 15 * MINUTE], ["quarter", "note", 30 * MINUTE], ["quarter", "note", 45 * MINUTE]]);
      }),
    ));

  it.effect("run a routine's command with POTS_FROM, skip a time while it still runs, and keep each run's end", () =>
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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

  it.effect("wake the bot once for failed runs, until a run succeeds, with the last lines of the output", () =>
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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
    return withCore({ fallbackWakeMinutes: 600, holdTimer: (timer) => (timer.note === "slow" ? held : undefined) }, (recorder) =>
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

  it.effect("replace a routine added again with the same name, and remove one", () =>
    withCore({ fallbackWakeMinutes: 600 }, (recorder) =>
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
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE }), "give exactly one of --note and --run");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, note: "", run: "x" }), "give exactly one of --note and --run");
        assert.strictEqual(yield* refused({ name: "a", every: 0, note: "" }), "--every must be more than 0");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, run: " " }), "--run is empty");
        assert.strictEqual(yield* refused({ name: "a", every: MINUTE, note: "", timeout: MINUTE }), "--timeout is for --run");
        assert.strictEqual(yield* refused({ name: "a", cron: "61 * * * *", note: "" }), 'bad cron expression "61 * * * *": Expected a value between 0 and 59');
        assert.strictEqual(yield* refused({ name: "a", cron: "0 0 30 2 *", note: "" }), 'bad cron expression "0 0 30 2 *": its time never comes');
        assert.deepStrictEqual((yield* timers.routines).routines, []);
      }),
    ));
});
