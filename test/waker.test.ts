import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { JudgeAnswer, JudgeInput } from "../src/core/judge.ts";
import { MessageLog } from "../src/gateway/log.ts";
import { Waker } from "../src/gateway/waker.ts";
import { advance, logHappening, message, settle, withCore } from "./support/core.ts";

// The waker on Effect's TestClock: the debounce and the judge's retries happen at exact times, without waiting.

/** Log a happening at the current test time and give it to the waker. */
const arrive = (place: string, text: string) =>
  Effect.gen(function* () {
    const waker = yield* Waker;
    const event = yield* logHappening(message(place, text));
    yield* waker.add(event);
    yield* settle;
    return event;
  });

/** For each event: "decided", or null while it waits for a decision. */
const decisions = (ids: readonly number[]) =>
  MessageLog.use((log) => log.undecided).pipe(Effect.map((undecided) => ids.map((id) => (undecided.some((event) => event.id === id) ? null : "decided"))));

describe("debounce", () => {
  it.effect("waits 3 seconds after the last event of a place, then wakes once for all of them", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        yield* arrive("general", "@bot one");
        yield* advance(1_000);
        yield* arrive("general", "@bot two");
        yield* advance(1_000);
        yield* arrive("general", "@bot three");

        yield* advance(2_999);
        assert.strictEqual(recorder.wakes.length, 0);
        yield* advance(1);
        assert.strictEqual(recorder.wakes.length, 1);
        assert.strictEqual(recorder.wakes[0]!.at, 5_000);
        assert.strictEqual(recorder.wakes[0]!.wake.events.length, 3);
        assert.strictEqual(recorder.wakes[0]!.wake.reason, "mention");
      }),
    ));

  it.effect("never waits longer than 20 seconds after the first event", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        for (let second = 0; second <= 24; second += 2) {
          if (recorder.wakes.length === 0) yield* arrive("general", `@bot still talking at ${second}`);
          yield* advance(2_000);
        }
        assert.strictEqual(recorder.wakes[0]!.at, 20_000);
        // Events at 0, 2, ..., 18 s; the one at 20 s came after the wake and starts the next group.
        assert.strictEqual(recorder.wakes[0]!.wake.events.length, 10);
      }),
    ));

  it.effect("keeps places apart", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        yield* arrive("general", "@bot here");
        yield* advance(2_000);
        yield* arrive("random", "@bot there");
        yield* advance(1_000);
        assert.deepStrictEqual(recorder.wakes.map((entry) => [entry.wake.place.name, entry.at]), [["general", 3_000]]);
        yield* advance(2_000);
        assert.deepStrictEqual(recorder.wakes.map((entry) => [entry.wake.place.name, entry.at]), [["general", 3_000], ["random", 5_000]]);
      }),
    ));
});

describe("reasons", () => {
  it.effect("a mention, a DM, no judge, and a place the bot works on", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        yield* arrive("general", "@bot look");
        yield* arrive("dm-alice", "hi");
        yield* arrive("random", "lunch?");
        recorder.working.add("mem:#busy");
        yield* arrive("busy", "and also this");
        yield* advance(3_000);
        const reasons = Object.fromEntries(recorder.wakes.map((entry) => [entry.wake.place.name, entry.wake.reason]));
        assert.deepStrictEqual(reasons, { general: "mention", "dm-alice": "dm", random: "heard", busy: "steer" });
      }),
    ));

  it.effect("the judge's no is logged and wakes nobody", () =>
    withCore({ judge: { judge: async () => ({ related: 0.9, respond: 0.1 }) } }, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        const event = yield* arrive("random", "lunch?");
        yield* advance(3_000);
        assert.strictEqual(recorder.wakes.length, 0);
        assert.deepStrictEqual(yield* decisions([event.id]), ["decided"]);
      }),
    ));
});

describe("the judge", () => {
  const flaky = (failures: number) => {
    const asked: { at: number; input: JudgeInput }[] = [];
    let now = () => 0;
    return {
      asked,
      setClock: (clock: () => number) => (now = clock),
      judge: {
        judge: async (input: JudgeInput): Promise<JudgeAnswer> => {
          asked.push({ at: now(), input });
          if (asked.length <= failures) throw new Error("the judge is down");
          return { related: 0.9, respond: 0.9 };
        },
      },
    };
  };

  it.effect("is asked again after 2 and 8 more seconds when it fails", () => {
    const judge = flaky(2);
    return withCore({ judge: judge.judge }, (recorder) =>
      Effect.gen(function* () {
        judge.setClock(() => recorder.now());
        (yield* Waker).setTarget(recorder.target());
        yield* arrive("general", "the pricing page is wrong");
        yield* advance(3_000);
        yield* advance(2_000);
        yield* advance(8_000);
        assert.deepStrictEqual(judge.asked.map((entry) => entry.at), [3_000, 5_000, 13_000]);
        assert.strictEqual(recorder.wakes[0]!.at, 13_000);
        assert.deepStrictEqual(recorder.wakes[0]!.wake.judged, { related: 0.9, respond: 0.9 });
        // The judge sees what the bot is responsible for and the new message.
        assert.strictEqual(judge.asked[0]!.input.responsibilities, "pricing");
        assert.strictEqual(judge.asked[0]!.input.latest[0]!.text, "the pricing page is wrong");
      }),
    );
  });

  it.effect("gives the events to the bot when it cannot decide", () => {
    const judge = flaky(3);
    return withCore({ judge: judge.judge }, (recorder) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        yield* arrive("general", "something");
        yield* advance(3_000);
        yield* advance(10_000);
        assert.strictEqual(judge.asked.length, 3);
        assert.strictEqual(recorder.wakes[0]!.wake.reason, "relevant");
        assert.deepStrictEqual(recorder.wakes[0]!.wake.judged, { error: "the judge is down" });
      }),
    );
  });
});

describe("stop", () => {
  it.effect("leaves waiting events undecided for the next start", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const event = yield* arrive("general", "@bot wait");
        yield* waker.stop;
        yield* advance(10_000);
        assert.strictEqual(recorder.wakes.length, 0);
        assert.deepStrictEqual(yield* decisions([event.id]), [null]);
      }),
    ));
});
