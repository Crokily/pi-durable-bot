import { assert, describe, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { openDatabase } from "../src/agent/agent.ts";
import { judgeRequest } from "../src/agent/judge.ts";
import { judgeInput, judgeInputFollows, judgeInputNeeds, type NewEvent } from "../src/gateway/judge-input.ts";
import { type LoggedMessage, MessageLog } from "../src/gateway/log.ts";

// The judge's view of a place: earlier messages and new events by thread, with whom each message answers.

const BOT = { name: "Probe", responsibilities: "Pots development", place: "dev (channel)" };
const PEOPLE: Record<string, string> = { colin: "Colin", bloom: "Bloom", probe: "Probe", carol: "Carol" };

/** A logged message at minute `at`, by a person ("probe" is the bot), in a thread (its root's address). */
function logged(address: string, by: string, at: number, text: string, options: { thread?: string; replyTo?: string; deleted?: boolean } = {}): LoggedMessage {
  return {
    address,
    place: "p",
    thread: options.thread ?? null,
    person: by,
    person_name: PEOPLE[by]!,
    from_me: by === "probe" ? 1 : 0,
    text,
    at: at * 60_000,
    edited_at: null,
    deleted_at: options.deleted ? 1 : null,
    reply_to: options.replyTo ?? null,
  };
}

/** A new message event, as the waker describes it. */
function event(message: LoggedMessage): NewEvent {
  const author = PEOPLE[message.person!]!;
  return {
    item: { what: "new message", author, time: new Date(message.at).toISOString(), text: message.text },
    kind: "message",
    person: message.person,
    thread: message.thread,
    at: message.at,
    message,
  };
}

const time = (at: number) => new Date(at * 60_000).toISOString();

describe("the judge's input", () => {
  // Two bots in a channel: Colin answers Bloom in his own thread, while Probe's thread was the last before it.
  const earlier = [
    logged("a", "probe", 1, "channel topic"),
    logged("t1", "probe", 2, "@Bloom the draft", { thread: "t1" }),
    logged("b", "bloom", 3, "add a line", { thread: "t1" }),
    logged("t2", "colin", 5, "is it too strong?", { thread: "t2" }),
    logged("c", "bloom", 6, "yes, a new draft", { thread: "t2" }),
    logged("d", "probe", 7, "new draft too", { thread: "t1" }),
  ];
  const reply = logged("n", "colin", 9, "I would keep 'with'", { thread: "t2" });

  it("groups the earlier messages by thread, the thread of the new event last, and says whom each reply answers", () => {
    const input = judgeInput(BOT, earlier, new Map(), [event(reply)]);
    assert.deepStrictEqual(input.conversation, [
      { hasNew: false, messages: [{ author: "Probe (me)", time: time(1), text: "channel topic" }] },
      {
        startedBy: "Probe (me)",
        hasNew: false,
        messages: [
          { author: "Probe (me)", time: time(2), text: "@Bloom the draft" },
          { author: "Bloom", replyingTo: "Probe (me)", time: time(3), text: "add a line" },
          { author: "Probe (me)", replyingTo: "Bloom", time: time(7), text: "new draft too" },
        ],
      },
      {
        startedBy: "Colin",
        hasNew: true,
        messages: [
          { author: "Colin", time: time(5), text: "is it too strong?" },
          { author: "Bloom", replyingTo: "Colin", time: time(6), text: "yes, a new draft" },
          { new: true, author: "Colin", replyingTo: "Bloom", time: time(9), text: "I would keep 'with'" },
        ],
      },
    ]);
    assert.deepStrictEqual(input.latest, [
      { what: "new message", author: "Colin", time: time(9), text: "I would keep 'with'", threadStartedBy: "Colin", replyingTo: "Bloom" },
    ]);
  });

  it("is given to the judge as tested: threads labelled by who started them, the new event's thread marked", () => {
    const { state, questions } = judgeRequest(judgeInput(BOT, earlier, new Map(), [event(reply)]));
    const conversation = state.conversation as { thread: string; the_new_message_is_in_this_thread?: true; messages: object[] }[];
    assert.deepStrictEqual(
      conversation.map((thread) => [thread.thread, thread.the_new_message_is_in_this_thread ?? false]),
      [
        ["none: a message in the channel", false],
        ["started by Probe (me)", false],
        ["started by Colin", true],
      ],
    );
    assert.deepStrictEqual(conversation[2]!.messages.at(-1), { new: true, author: "Colin", replying_to: "Bloom", time: time(9), text: "I would keep 'with'" });
    assert.deepStrictEqual(state.new_events, [{ what: "new message", author: "Colin", time: time(9), text: "I would keep 'with'", thread: "started by Colin", replying_to: "Bloom" }]);
    assert.deepStrictEqual(Object.keys(state), ["team_member", "what_this_team_member_is_responsible_for", "place", "conversation", "new_events"]);
    assert.match(questions.respond.instructions!, /A message that replies to another team member is for that team member to answer, unless it also asks Probe\./);
  });

  it("takes whom a message answers from the platform where it says so, also outside threads", () => {
    // In Probe's thread, the last message by someone else is Probe's, but the platform says it answers Bloom.
    const answer = logged("n", "colin", 9, "agreed", { thread: "t1", replyTo: "b" });
    const inChannel = logged("m", "colin", 10, "and this", { replyTo: "t1" });
    const input = judgeInput(BOT, earlier, new Map(), [event(answer), event(inChannel)]);
    assert.deepStrictEqual(input.latest.map((item) => [item.threadStartedBy, item.replyingTo]), [
      ["Probe (me)", "Bloom"],
      [undefined, "Probe (me)"],
    ]);
  });

  it("marks every thread of a batch of new events, puts them last, and keeps the events in order", () => {
    const inT1 = logged("n1", "colin", 8, "for Probe", { thread: "t1" });
    const solo = logged("n2", "colin", 9, "anyone?");
    const inT2 = logged("n3", "colin", 10, "for Bloom", { thread: "t2" });
    const input = judgeInput(BOT, earlier, new Map(), [event(inT1), event(solo), event(inT2)]);
    assert.deepStrictEqual(
      input.conversation.map((thread) => [thread.startedBy, thread.hasNew, thread.messages.length]),
      [
        [undefined, false, 1],
        ["Probe (me)", true, 4],
        [undefined, true, 1],
        ["Colin", true, 3],
      ],
    );
    assert.deepStrictEqual(input.latest.map((item) => [item.text, item.threadStartedBy, item.replyingTo]), [
      ["for Probe", "Probe (me)", "Probe (me)"],
      ["anyone?", undefined, undefined],
      ["for Bloom", "Colin", "Bloom"],
    ]);
  });

  it("shows the start of the new event's thread when the earlier messages do not reach it, and names other threads' starters", () => {
    const root = logged("old", "bloom", 0, "an old question", { thread: "old" });
    const other = logged("t9", "colin", 0, "another old one", { thread: "t9" });
    const recent = [logged("x", "probe", 4, "a reply", { thread: "t9" })];
    const answer = logged("n", "colin", 9, "still open?", { thread: "old" });
    assert.deepStrictEqual(judgeInputNeeds(recent, [event(answer)]).sort(), ["old", "t9"]);
    const input = judgeInput(BOT, recent, new Map([root, other].map((m) => [m.address, m])), [event(answer)]);
    assert.deepStrictEqual(
      input.conversation.map((thread) => [thread.startedBy, thread.messages.map((m) => m.text)]),
      [
        ["Colin", ["a reply"]],
        ["Bloom", ["an old question", "still open?"]],
      ],
    );
    assert.strictEqual(input.conversation[1]!.messages[1]!.replyingTo, "Bloom");
  });

  it("shows the message a new one follows in an old thread, as the log finds it by thread, and says it answers that", () => {
    // Probe started t1 and Bloom answered last, long ago; the place's last messages are all elsewhere.
    const root = logged("t1", "probe", 0, "@Bloom the draft", { thread: "t1" });
    const last = logged("b", "bloom", 1, "the last answer", { thread: "t1" });
    const busy = Array.from({ length: 3 }, (_, i) => logged(`x${i}`, "colin", 2 + i, `elsewhere ${i}`));
    const answer = logged("n", "colin", 9, "and the second part?", { thread: "t1" });
    assert.deepStrictEqual(judgeInputFollows([event(answer), event(root)]), [{ thread: "t1", at: 9 * 60_000, person: "colin" }]);
    const input = judgeInput(BOT, busy, new Map([root, last].map((m) => [m.address, m])), [event(answer)]);
    assert.deepStrictEqual(
      input.conversation.at(-1)!.messages.map((m) => [m.author, m.replyingTo, m.text]),
      [
        ["Probe (me)", undefined, "@Bloom the draft"],
        ["Bloom", "Probe (me)", "the last answer"],
        ["Colin", "Bloom", "and the second part?"],
      ],
    );
  });

  it("does not take an edit or a reaction as what a message answers", () => {
    const draft = logged("d1", "bloom", 1, "the draft", { thread: "t3" });
    const root = logged("t3", "colin", 0, "a draft please", { thread: "t3" });
    const reaction: NewEvent = {
      item: { what: "reaction_added :eyes: on Bloom's message", author: "Carol", time: time(2), text: "the draft" },
      kind: "reaction_added",
      person: "carol",
      thread: "t3",
      at: 2 * 60_000,
      message: draft,
    };
    const edit: NewEvent = { ...reaction, item: { what: "edited a message", author: "Carol", time: time(3), text: "x" }, kind: "edit", at: 3 * 60_000 };
    const shipIt = logged("n", "colin", 4, "ship it", { thread: "t3" });
    const input = judgeInput(BOT, [root, draft], new Map(), [reaction, edit, event(shipIt)]);
    assert.deepStrictEqual(input.latest.map((item) => item.replyingTo), [undefined, undefined, "Bloom"]);
  });

  it("says it is unknown whom a message answers and who started a thread when the log does not have those messages", () => {
    // In a Telegram topic, an explicit reply to a message from before the bot was there, after a message of Probe's.
    const mine = logged("p", "probe", 5, "deployed", { thread: "topic" });
    const toUnlogged = logged("n", "colin", 9, "this still fails", { thread: "topic", replyTo: "old" });
    // A thread whose start is not in the log: its first message there is not who started it.
    const inUnlogged = logged("m", "bloom", 10, "any news?", { thread: "gone" });
    const input = judgeInput(BOT, [mine], new Map(), [event(toUnlogged), event(inUnlogged)]);
    assert.deepStrictEqual(input.latest.map((item) => [item.threadStartedBy, item.replyingTo]), [
      [null, null],
      [null, null],
    ]);
    const { state } = judgeRequest(input);
    const conversation = state.conversation as { thread: string; messages: { replying_to?: string }[] }[];
    assert.deepStrictEqual(conversation.map((thread) => thread.thread), [
      "started by someone unknown: its first message is not available",
      "started by someone unknown: its first message is not available",
    ]);
    assert.deepStrictEqual(conversation[0]!.messages.at(-1)!.replying_to, "unknown: the message it answers is not available");
    // With the thread's start in the log, a thread with no one else in it before has no one it answers.
    const own = judgeInput(BOT, [logged("t5", "colin", 1, "a note", { thread: "t5" })], new Map(), [event(logged("o", "colin", 2, "and another", { thread: "t5" }))]);
    assert.deepStrictEqual(own.latest[0], { what: "new message", author: "Colin", time: time(2), text: "and another", threadStartedBy: "Colin" });
  });

  it("shows the Telegram message a reply answers in the reply's thread when the log brings it into view", () => {
    // B answers A, C answers B: C's thread is B, B's thread is A. B is older than the earlier messages.
    const a = logged("A", "bloom", 0, "first", { thread: "A" });
    const b = logged("B", "probe", 1, "second", { thread: "A", replyTo: "A" });
    const c = logged("C", "colin", 9, "third", { thread: "B", replyTo: "B" });
    assert.deepStrictEqual(judgeInputNeeds([], [event(c)], [b]), ["A"]);
    const input = judgeInput(BOT, [], new Map([a, b].map((m) => [m.address, m])), [event(c)]);
    assert.deepStrictEqual(
      input.conversation.map((thread) => [thread.startedBy, thread.messages.map((m) => [m.author, m.replyingTo, m.text])]),
      [
        [
          "Probe (me)",
          [
            ["Probe (me)", "Bloom", "second"],
            ["Colin", "Probe (me)", "third"],
          ],
        ],
      ],
    );
  });

  it("shows a new message once when the log had it before the events (a backfill)", () => {
    const root = logged("t4", "colin", 1, "question", { thread: "t4" });
    const reply = logged("r", "bloom", 2, "an answer", { thread: "t4" });
    const later = logged("l", "colin", 3, "in the channel");
    const input = judgeInput(BOT, [root, reply], new Map(), [event(later), event(reply)]);
    assert.deepStrictEqual(
      input.conversation.map((thread) => thread.messages.map((m) => [m.new ?? false, m.text])),
      [
        [
          [false, "question"],
          [true, "an answer"],
        ],
        [[true, "in the channel"]],
      ],
    );
  });

  it("says when a message was deleted, and what a new event other than a message is", () => {
    const gone = logged("g", "bloom", 8, "oops", { deleted: true });
    const reaction: NewEvent = {
      item: { what: "reaction_added :+1: on Probe's message", author: "Colin", time: time(9), text: "new draft too" },
      kind: "reaction_added",
      person: "colin",
      thread: "t1",
      at: 9 * 60_000,
      message: earlier[5]!,
    };
    const input = judgeInput(BOT, [...earlier, gone], new Map(), [reaction]);
    assert.deepStrictEqual(input.conversation.at(-2)!.messages, [{ what: "message (since deleted)", author: "Bloom", time: time(8), text: "oops" }]);
    assert.deepStrictEqual(input.conversation.at(-1)!.messages.at(-1), { new: true, what: "reaction_added :+1: on Probe's message", author: "Colin", time: time(9), text: "new draft too" });
    assert.strictEqual(input.latest[0]!.replyingTo, undefined);
  });
});

const OLD_MESSAGES = `CREATE TABLE gw_messages (address TEXT PRIMARY KEY, channel TEXT NOT NULL, place TEXT, thread TEXT, person TEXT,
  from_me INTEGER NOT NULL DEFAULT 0, mentions_me INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', mentions TEXT, files TEXT,
  at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, send_id TEXT, raw TEXT)`;

const memoryLog = Effect.gen(function* () {
  const sql = yield* Effect.acquireRelease(
    Effect.promise(() => openDatabase(":memory:")),
    (db) => Effect.promise(() => db.close()),
  );
  return yield* MessageLog.pipe(Effect.provide(MessageLog.layer(sql)));
});

describe("the log", () => {
  it.effect("finds the last message in a thread before a time by someone else", () =>
    Effect.gen(function* () {
      const log = yield* memoryLog;
      const place = { address: "mem:#dev", kind: "channel" as const };
      const by = (who: string) => ({ person: { address: `mem:@${who}`, name: who } });
      const thread = { thread: "mem:#dev/1", threadRoot: "mem:#dev/1" };
      yield* log.apply("mem", "e1", [{ kind: "message", at: 1, place, message: "mem:#dev/1", fromMe: true, ...by("bot"), text: "a draft" }]);
      yield* log.apply("mem", "e2", [{ kind: "message", at: 2, place, message: "mem:#dev/2", fromMe: false, ...by("bloom"), ...thread, text: "an answer" }]);
      yield* log.apply("mem", "e3", [{ kind: "message", at: 3, place, message: "mem:#dev/3", fromMe: false, ...by("colin"), ...thread, text: "more" }]);
      yield* log.apply("mem", "e4", [{ kind: "message", at: 4, place, message: "mem:#dev/4", fromMe: false, ...by("colin"), text: "elsewhere" }]);
      assert.strictEqual((yield* log.lastInThread("mem:#dev/1", 9, "mem:@colin"))?.text, "an answer");
      assert.strictEqual((yield* log.lastInThread("mem:#dev/1", 9, null))?.text, "more");
      assert.strictEqual((yield* log.lastInThread("mem:#dev/1", 2, "mem:@colin"))?.text, "a draft");
      assert.strictEqual(yield* log.lastInThread("mem:#dev/1", 1, null), undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the message a reply answers as the platform gave it, when it does not have it, without an event", () =>
    Effect.gen(function* () {
      const log = yield* memoryLog;
      const place = { address: "mem:#dev", kind: "channel" as const };
      const carol = { address: "mem:@carol", name: "Carol" };
      const replied = { at: 1, person: carol, fromMe: false, text: "from before the bot" };
      const events = yield* log.apply("mem", "e1", [
        { kind: "message", at: 5, place, message: "mem:#dev/5", thread: "mem:#dev/1", threadRoot: "mem:#dev/1", replyTo: "mem:#dev/1", replied, fromMe: false, text: "yes" },
      ]);
      assert.strictEqual(events.length, 1);
      const [old] = yield* log.messages(["mem:#dev/1"]);
      assert.deepStrictEqual([old?.person_name, old?.text, old?.at, old?.thread, old?.from_me], ["Carol", "from before the bot", 1, "mem:#dev/1", 0]);
      // One the log has stays as it is.
      yield* log.apply("mem", "e2", [{ kind: "message", at: 6, place, message: "mem:#dev/6", replyTo: "mem:#dev/5", replied: { ...replied, text: "other" }, fromMe: false, text: "no" }]);
      assert.strictEqual((yield* log.message("mem:#dev/5"))?.text, "yes");
    }).pipe(Effect.scoped),
  );

  it("adds the new column once when another process opens the old log while this one adds it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pots-log-"));
    try {
      const path = join(dir, "log.db");
      const old = await openDatabase(path);
      await old.exec(OLD_MESSAGES);
      await old.close();
      const opener = fileURLToPath(new URL("./support/open-log.ts", import.meta.url));
      const run = (...args: string[]) => {
        const child = spawn(process.execPath, [opener, path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (chunk) => (err += chunk));
        const read = new Promise<void>((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("read") && resolve()));
        const exit = new Promise<string>((resolve) => child.on("close", (code) => resolve(`${code} ${err.trim()}`.trim())));
        return { read, exit };
      };
      // The first reads the columns and waits; the second opens the log in that time.
      const first = run("1000");
      await first.read;
      const second = run();
      assert.deepStrictEqual(await Promise.all([first.exit, second.exit]), ["0", "0"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.effect("keeps the message a reply answers, and adds the column to a log from before it", () =>
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.promise(() => openDatabase(":memory:")),
        (db) => Effect.promise(() => db.close()),
      );
      yield* Effect.promise(() => sql.exec(OLD_MESSAGES));
      const log = yield* MessageLog.pipe(Effect.provide(MessageLog.layer(sql)));
      const place = { address: "mem:#dev", kind: "channel" as const };
      yield* log.apply("mem", "e1", [{ kind: "message", at: 1, place, message: "mem:#dev/1", fromMe: false, text: "a question" }]);
      yield* log.apply("mem", "e2", [{ kind: "message", at: 2, place, message: "mem:#dev/2", replyTo: "mem:#dev/1", fromMe: false, text: "an answer" }]);
      const [first, second] = yield* log.messagesBefore("mem:#dev", 3, 10);
      assert.strictEqual(first!.reply_to, null);
      assert.strictEqual(second!.reply_to, "mem:#dev/1");
    }).pipe(Effect.scoped),
  );
});
