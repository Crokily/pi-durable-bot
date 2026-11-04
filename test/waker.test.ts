import { readdirSync, readFileSync, rmSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { JudgeAnswer, JudgeInput } from "../src/core/judge.ts";
import type { ChannelSink } from "../src/core/channel.ts";
import { Channels } from "../src/gateway/channels.ts";
import { FILE_WAIT_MS, MAX_FILE_BYTES } from "../src/gateway/files.ts";
import { MessageLog } from "../src/gateway/log.ts";
import { Waker } from "../src/gateway/waker.ts";
import { advance, FILES_DIR, logHappening, MemoryChannel, message, settle, withCore } from "./support/core.ts";

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

/**
 * Let real work, such as writing files, finish while the TestClock stands still. Up to 5 seconds on the wall clock, not
 * a number of turns: on a slow machine a download takes more turns of the event loop.
 */
const settleUntil = (done: () => boolean) =>
  Effect.gen(function* () {
    const end = Date.now() + 5_000;
    while (!done() && Date.now() < end) yield* settle;
  });

/** For each event: "decided", or null while it waits for a decision. */
const decisions = (ids: readonly number[]) =>
  MessageLog.use((log) => log.undecided).pipe(Effect.map((undecided) => ids.map((id) => (undecided.some((event) => event.id === id) ? null : "decided"))));

describe("files", () => {
  it.effect("a download that has not ended holds the wake FILE_WAIT_MS past its time, then stops, and the place's next group comes after it", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        let stopped: AbortSignal | undefined;
        const channel = new MemoryChannel();
        channel.fetchFile = (_file, signal) => {
          stopped = signal;
          return new Promise(() => {});
        };
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const url = "https://files.example/report.pdf";
        yield* waker.add(yield* logHappening({ ...message("general", "@bot the report"), files: [{ name: "report.pdf", url, size: 2_000 }] }));
        // Without the file, the wake would go out at 3 s.
        yield* advance(5_000, 1_000);
        yield* arrive("general", "@bot did you see it?");

        yield* advance(3_000 + FILE_WAIT_MS - 5_000 - 1, 1_000);
        assert.strictEqual(recorder.wakes.length, 0);
        yield* advance(1);
        assert.deepStrictEqual(
          recorder.wakes.map(({ wake, at }) => ({ text: wake.events[0]!.text, at })),
          [
            { text: "@bot the report", at: 3_000 + FILE_WAIT_MS },
            { text: "@bot did you see it?", at: 3_000 + FILE_WAIT_MS },
          ],
        );
        assert.deepStrictEqual(recorder.wakes[0]!.wake.events[0]!.files, [{ name: "report.pdf", size: 2_000, url, error: "it was not downloaded in time" }]);
        assert.strictEqual(stopped?.aborted, true);
      }),
    ));

  it.effect("a file larger than MAX_FILE_BYTES is not downloaded: the wake gives its URL", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        let fetched = 0;
        const channel = new MemoryChannel();
        channel.fetchFile = async () => {
          fetched++;
          return new Uint8Array();
        };
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const file = { name: "talk.mov", type: "video/quicktime", url: "https://files.example/talk.mov", size: MAX_FILE_BYTES + 1 };
        yield* waker.add(yield* logHappening({ ...message("general", "@bot the talk"), files: [file] }));
        yield* advance(3_000);

        assert.deepStrictEqual(recorder.wakes[0]!.wake.events[0]!.files, [{ ...file, error: "it is larger than 10 MB" }]);
        assert.strictEqual(recorder.wakes[0]!.at, 3_000);
        assert.strictEqual(fetched, 0);
      }),
    ));

  it.effect("a file that passes MAX_FILE_BYTES as it downloads, when the channel gave no size, is not saved: the wake gives its URL", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        const channel = new MemoryChannel();
        // A stream: the size is known only as the bytes come.
        channel.fetchFile = async () =>
          (async function* () {
            for (let i = 0; i < 11; i++) yield new Uint8Array(1024 * 1024);
          })();
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const file = { name: "talk.mov", url: "https://files.example/talk.mov" };
        yield* waker.add(yield* logHappening({ ...message("general", "@bot the talk"), files: [file] }));
        yield* advance(3_000);
        yield* settleUntil(() => recorder.wakes.length > 0);

        assert.deepStrictEqual(recorder.wakes[0]!.wake.events[0]!.files, [{ ...file, error: "it is larger than 10 MB" }]);
        // Neither the file nor a part of it stays.
        assert.deepStrictEqual(readdirSync(FILES_DIR, { recursive: true }).filter((name) => String(name).includes("talk")), []);
      }),
    ));

  it.effect("two files of one message never share a path, also when their names differ only in case", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        const channel = new MemoryChannel();
        channel.fetchFile = async (file) => new TextEncoder().encode(`content of ${file.url}`);
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const files = ["3-x.txt", "x.txt", "x.txt", "X.txt"].map((name, index) => ({ name, url: `url-${index}` }));
        yield* waker.add(yield* logHappening({ ...message("general", "@bot four files"), files }));
        yield* advance(3_000);
        yield* settleUntil(() => recorder.wakes.length > 0);

        const saved = recorder.wakes[0]!.wake.events[0]!.files!;
        assert.strictEqual(new Set(saved.map((file) => file.path!.toLowerCase())).size, 4);
        assert.deepStrictEqual(
          saved.map((file) => readFileSync(file.path!, "utf8")),
          files.map((file) => `content of ${file.url}`),
        );
      }),
    ));

  it.effect("two messages whose addresses differ only in punctuation never share a file", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        let fetched = 0;
        const channel = new MemoryChannel();
        channel.fetchFile = async () => new TextEncoder().encode(`download ${++fetched}`);
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        // The same name, place and URL; only the message differs, and its address in letters and digits does not.
        const file = { name: "x.txt", url: "https://files.example/x.txt" };
        for (const [index, [place, address]] of ([
          ["a_b", "mem:#a_b/c"],
          ["a", "mem:#a/b_c"],
        ] as const).entries()) {
          yield* waker.add(yield* logHappening({ ...message(place, "@bot a file"), message: address, files: [file] }));
          yield* advance(3_000);
          yield* settleUntil(() => recorder.wakes.length === index + 1);
        }

        const saved = recorder.wakes.map((wake) => wake.wake.events[0]!.files![0]!.path!);
        assert.notStrictEqual(saved[0], saved[1]);
        assert.deepStrictEqual(saved.map((path) => readFileSync(path, "utf8")), ["download 1", "download 2"]);
      }),
    ));

  it.effect("a file that an edit puts in another's place is downloaded, not taken from the one saved before", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        const channel = new MemoryChannel();
        channel.fetchFile = async (file) => new TextEncoder().encode(`content of ${file.url}`);
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const sent = message("general", "@bot two files");
        yield* waker.add(yield* logHappening({ ...sent, files: [{ name: "x.txt", url: "url-1" }, { name: "x.txt", url: "url-2" }] }));
        yield* advance(3_000);
        yield* settleUntil(() => recorder.wakes.length === 1);
        // The edit takes out the first: the second is now first, with the same name.
        yield* waker.add(yield* logHappening({ ...sent, kind: "edit", text: "@bot one file", files: [{ name: "x.txt", url: "url-2" }] }));
        yield* advance(3_000);
        yield* settleUntil(() => recorder.wakes.length === 2);

        const [edited] = recorder.wakes[1]!.wake.events.at(-1)!.files!;
        assert.strictEqual(readFileSync(edited!.path!, "utf8"), "content of url-2");
      }),
    ));

  it.effect("files of events from before a start are saved once their channel connects", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        yield* waker.add(yield* logHappening({ ...message("general", "@bot the report"), files: [{ name: "report.txt", url: "report" }] }));
        const channel = new MemoryChannel();
        channel.fetchFile = async () => new TextEncoder().encode("the numbers");
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        yield* advance(3_000);
        yield* settleUntil(() => recorder.wakes.length > 0);

        const [file] = recorder.wakes[0]!.wake.events[0]!.files!;
        assert.strictEqual(file!.error, undefined);
        assert.strictEqual(readFileSync(file!.path!, "utf8"), "the numbers");
      }),
    ));

  it.effect("a message deleted while its files download comes as deleted", () =>
    withCore({}, (recorder) =>
      Effect.gen(function* () {
        rmSync(FILES_DIR, { recursive: true, force: true });
        let finish = () => {};
        const channel = new MemoryChannel();
        channel.fetchFile = () => new Promise((resolve) => (finish = () => resolve(new TextEncoder().encode("the numbers"))));
        yield* (yield* Channels).connect([channel], () => ({}) as ChannelSink);
        const waker = yield* Waker;
        waker.setTarget(recorder.target());
        const sent = { ...message("general", "@bot the report"), files: [{ name: "report.txt", url: "report" }] };
        yield* waker.add(yield* logHappening(sent));
        yield* advance(3_000);
        yield* logHappening({ ...message("general", ""), kind: "delete", message: sent.message });
        finish();
        yield* settleUntil(() => recorder.wakes.length > 0);

        assert.strictEqual(recorder.wakes[0]!.wake.events[0]!.deleted, true);
      }),
    ));
});

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
        assert.deepStrictEqual(recorder.wakes[0]!.wake.judged, { error: "Error: the judge is down" });
      }),
    );
  });

  it.effect("gives the events to the bot when something on the way to the judge throws", () =>
    withCore({ judge: { judge: async () => ({ related: 0.9, respond: 0.9 }) } }, (recorder) =>
      Effect.gen(function* () {
        const target = recorder.target();
        (yield* Waker).setTarget({
          ...target,
          name: target.name,
          responsibilities: () => {
            throw new Error("cannot read responsibilities.md");
          },
        });
        yield* arrive("general", "something");
        yield* advance(3_000);
        assert.strictEqual(recorder.wakes[0]!.wake.reason, "relevant");
        assert.deepStrictEqual(recorder.wakes[0]!.wake.judged, { error: "Error: cannot read responsibilities.md" });
      }),
    ));
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
