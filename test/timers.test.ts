import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Timers } from "../src/gateway/timers.ts";
import { advance, settle, withCore } from "./support/core.ts";

// The timers on Effect's TestClock: each wake fires at its exact time, without waiting.

const MINUTE = 60_000;

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
