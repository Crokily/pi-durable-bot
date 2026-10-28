import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ChannelSink } from "../src/core/channel.ts";
import { Channels } from "../src/gateway/channels.ts";
import { Inbox } from "../src/gateway/inbox.ts";
import { MessageLog } from "../src/gateway/log.ts";
import { Outbox } from "../src/gateway/outbox.ts";
import { Timers } from "../src/gateway/timers.ts";
import { Waker } from "../src/gateway/waker.ts";
import { advance, logHappening, MemoryChannel, message, SETTINGS, settle, withCore } from "./support/core.ts";

// Properties of the gateway core, checked on many random cases with fast-check. Each case runs the real Effect services
// on an in-memory database and Effect's TestClock.

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(TestClock.layer()))));
const RUNS = { numRuns: 60 };

const sink: ChannelSink = {
  receive: async () => {},
  newestMessage: async () => undefined,
  threads: async () => [],
  lastAlive: () => undefined,
  log: () => {},
};

// ---- Debounce ----

interface Arrival {
  readonly place: number;
  /** Milliseconds after the previous arrival. */
  readonly gap: number;
}

/**
 * The grouping rule, written plainly: per place, a group takes every event until it is due, at debounceMs after its
 * last event or debounceMaxMs after its first, whichever comes first. An event at the due time starts the next group.
 */
function expectedGroups(arrivals: readonly { place: number; at: number; index: number }[]) {
  const groups: { place: number; events: number[]; at: number }[] = [];
  const open = new Map<number, { first: number; last: number; events: number[] }>();
  const due = (group: { first: number; last: number }) => Math.min(group.last + SETTINGS.debounceMs, group.first + SETTINGS.debounceMaxMs);
  for (const arrival of arrivals) {
    const group = open.get(arrival.place);
    if (group && arrival.at < due(group)) {
      group.events.push(arrival.index);
      group.last = arrival.at;
      continue;
    }
    if (group) groups.push({ place: arrival.place, events: group.events, at: due(group) });
    open.set(arrival.place, { first: arrival.at, last: arrival.at, events: [arrival.index] });
  }
  for (const [place, group] of open) groups.push({ place, events: group.events, at: due(group) });
  return groups.sort((a, b) => a.at - b.at || a.place - b.place);
}

/**
 * People talk in bursts. A burst is a pause, then messages with gaps; gaps under 3 s keep a group open, so long bursts
 * run into the 20-second limit. The exact edges (2999, 3000 and 3001 ms) come up often. Two places talk at once.
 */
const burst = fc.record({
  pause: fc.oneof(fc.integer({ min: 0, max: 25_000 }), fc.constantFrom(2_999, 3_000, 3_001, 20_000)),
  gaps: fc.array(fc.oneof({ arbitrary: fc.integer({ min: 0, max: 2_999 }), weight: 5 }, { arbitrary: fc.constantFrom(2_999, 3_000, 3_001), weight: 1 }), {
    maxLength: 13,
  }),
});
const timeline = fc.array(burst, { minLength: 1, maxLength: 3 }).map((bursts) => {
  const times: number[] = [];
  let at = 0;
  for (const { pause, gaps } of bursts) {
    times.push((at += pause));
    for (const gap of gaps) times.push((at += gap));
  }
  return times;
});
const conversations = fc.tuple(timeline, fc.option(timeline, { nil: [] })).map(([first, second]) => {
  const merged = [...first.map((at) => ({ place: 0, at })), ...second.map((at) => ({ place: 1, at }))].sort((a, b) => a.at - b.at || a.place - b.place);
  return merged.map((arrival, index): Arrival => ({ place: arrival.place, gap: arrival.at - (merged[index - 1]?.at ?? 0) }));
});

describe("debounce grouping", () => {
  it("wakes each place once per group, at min(last + 3 s, first + 20 s), with every event in exactly one wake", async () => {
    await fc.assert(
      fc.asyncProperty(conversations, async (arrivals: Arrival[]) => {
        const actual = await run(
          withCore({}, (recorder) =>
            Effect.gen(function* () {
              const waker = yield* Waker;
              waker.setTarget(recorder.target());
              const ids: number[] = [];
              for (const [index, { place, gap }] of arrivals.entries()) {
                if (gap) yield* advance(gap);
                const event = yield* logHappening(message(`place-${place}`, `@bot ${index}`));
                ids[index] = event.id;
                yield* waker.add(event);
              }
              yield* advance(SETTINGS.debounceMaxMs);
              return recorder.wakes
                .map((entry) => ({ place: Number(entry.wake.place.name!.slice(6)), events: entry.wake.events.map((event) => ids.indexOf(event.id)), at: entry.at }))
                .sort((a, b) => a.at - b.at || a.place - b.place);
            }),
          ),
        );
        let at = 0;
        const timed = arrivals.map((item, index) => ({ place: item.place, at: (at += item.gap), index }));
        expect(actual).toEqual(expectedGroups(timed));
      }),
      RUNS,
    );
  });
});

// ---- Send IDs ----

type Crash = "none" | "before the platform" | "after the platform";

describe("send IDs", () => {
  it("one message per send ID on the platform, whatever crashes in between", async () => {
    const send = fc.record({ id: fc.integer({ min: 0, max: 2 }), crash: fc.constantFrom<Crash>("none", "before the platform", "after the platform") });
    await fc.assert(
      fc.asyncProperty(fc.array(send, { minLength: 1, maxLength: 15 }), async (sends) => {
        const channel = new MemoryChannel();
        const results = await run(
          withCore({}, () =>
            Effect.gen(function* () {
              const outbox = yield* Outbox;
              yield* (yield* Channels).connect([channel], () => sink);
              const results = new Map<string, string[]>();
              const attempt = (sendId: string, crash: Crash) =>
                Effect.gen(function* () {
                  channel.failBeforeSend = crash === "before the platform";
                  outbox.hooks.afterPlatformSend =
                    crash === "after the platform"
                      ? () => {
                          throw new Error("crash");
                        }
                      : undefined;
                  const exit = yield* Effect.exit(outbox.send(sendId, "mem:#general", `text of ${sendId}`));
                  if (Exit.isSuccess(exit)) results.set(sendId, [...(results.get(sendId) ?? []), exit.value.message]);
                });
              for (const { id, crash } of sends) yield* attempt(`send-${id}`, crash);
              // After the crashes, every send ID is sent once more without one.
              for (const id of new Set(sends.map((item) => item.id))) yield* attempt(`send-${id}`, "none");
              return results;
            }),
          ),
        );
        for (const sendId of new Set(sends.map((item) => `send-${item.id}`))) {
          expect(channel.platform.filter((record) => record.sendId === sendId)).toHaveLength(1);
          // Every answer for one send ID names the same message.
          expect(new Set(results.get(sendId))).toEqual(new Set([`mem:#general/${channel.platform.find((record) => record.sendId === sendId)!.id}`]));
        }
      }),
      RUNS,
    );
  });
});

// ---- Timers ----

const MINUTE = 60_000;

type TimerOp = { kind: "add"; inMinutes: number } | { kind: "cancel"; pick: number } | { kind: "wait"; minutes: number };

describe("timers", () => {
  it("fire each wake once, on time and in order, never after a cancel, and keep exactly one fallback while there is no wake", async () => {
    const op: fc.Arbitrary<TimerOp> = fc.oneof(
      fc.record({ kind: fc.constant("add" as const), inMinutes: fc.integer({ min: 0, max: 90 }) }),
      fc.record({ kind: fc.constant("cancel" as const), pick: fc.nat(5) }),
      fc.record({ kind: fc.constant("wait" as const), minutes: fc.integer({ min: 0, max: 60 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 20 }), async (ops) => {
        await run(
          withCore({ fallbackWakeMinutes: 60 }, (recorder) =>
            Effect.gen(function* () {
              const timers = yield* Timers;
              yield* timers.start;
              const added: { id: number; due: number; cancelled: boolean }[] = [];
              const check = Effect.gen(function* () {
                const pending = yield* timers.pending;
                const fallbacks = pending.filter((timer) => timer.set_by === "fallback");
                const agent = pending.filter((timer) => timer.set_by === "agent");
                // Exactly one fallback while the agent has none, and none while it has some.
                expect(fallbacks).toHaveLength(agent.length === 0 ? 1 : 0);
              });
              for (const item of ops) {
                if (item.kind === "add") {
                  const timer = yield* timers.add(recorder.now() + item.inMinutes * 60_000, "");
                  added.push({ id: timer.id, due: timer.due_at, cancelled: false });
                } else if (item.kind === "cancel") {
                  const open = added.filter((timer) => !timer.cancelled && !recorder.timers.some((fired) => fired.timer.id === timer.id));
                  const target = open[item.pick % Math.max(1, open.length)];
                  if (target) {
                    expect(yield* timers.cancel(target.id)).toBe(true);
                    target.cancelled = true;
                  }
                } else {
                  yield* advance(item.minutes * 60_000, MINUTE);
                }
                yield* settle;
                yield* check;
              }
              yield* advance(91 * MINUTE, MINUTE);
              const fired = recorder.timers.filter((entry) => entry.timer.set_by === "agent");
              // On time: each at its due time. In order of due time.
              for (const entry of fired) expect(entry.at).toBe(entry.timer.due_at);
              expect(fired.map((entry) => entry.at)).toEqual([...fired.map((entry) => entry.at)].sort((a, b) => a - b));
              // Once each, all that were not cancelled, none that were.
              expect(fired.map((entry) => entry.timer.id).sort((a, b) => a - b)).toEqual(
                added.filter((timer) => !timer.cancelled).map((timer) => timer.id).sort((a, b) => a - b),
              );
            }),
          ),
        );
      }),
      RUNS,
    );
  });
});

// ---- Inbox ----

describe("inbox", () => {
  it("logs each event once, in the order it first came, however often the platform delivers it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 30 }), async (deliveries) => {
        const channel = new MemoryChannel();
        const logged = await run(
          withCore({}, (recorder) =>
            Effect.gen(function* () {
              (yield* Waker).setTarget(recorder.target());
              yield* (yield* Channels).connect([channel], () => sink);
              const inbox = yield* Inbox;
              yield* inbox.open;
              for (const event of deliveries) yield* inbox.receive("mem", `event-${event}`, { id: `e${event}`, place: "general", text: `${event}`, person: "alice" });
              yield* inbox.drain;
              const log = yield* MessageLog;
              return (yield* log.undecided).map((event) => event.message);
            }),
          ),
        );
        const firsts = [...new Set(deliveries)];
        expect(logged).toEqual(firsts.map((event) => `mem:#general/e${event}`));
      }),
      RUNS,
    );
  });
});
