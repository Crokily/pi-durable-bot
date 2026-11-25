import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { openDatabase } from "../src/agent/agent.ts";
import { judgeRequest } from "../src/agent/judge.ts";
import { judgeInput, judgeInputNeeds, type NewEvent } from "../src/gateway/judge-input.ts";
import { type LoggedMessage, MessageLog } from "../src/gateway/log.ts";

// The judge's view of a place: earlier messages and new events by thread, with whom each message answers.

const BOT = { name: "Probe", responsibilities: "Pots development", place: "dev (channel)" };
const PEOPLE: Record<string, string> = { colin: "Colin", bloom: "Bloom", probe: "Probe" };

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

describe("the log", () => {
  it.effect("keeps the message a reply answers, and adds the column to a log from before it", () =>
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.promise(() => openDatabase(":memory:")),
        (db) => Effect.promise(() => db.close()),
      );
      yield* Effect.promise(() =>
        sql.exec(`CREATE TABLE gw_messages (address TEXT PRIMARY KEY, channel TEXT NOT NULL, place TEXT, thread TEXT, person TEXT,
          from_me INTEGER NOT NULL DEFAULT 0, mentions_me INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', mentions TEXT, files TEXT,
          at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, send_id TEXT, raw TEXT)`),
      );
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
