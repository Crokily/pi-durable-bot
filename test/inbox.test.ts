import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ChannelSink, Happening } from "../src/core/channel.ts";
import { Channels } from "../src/gateway/channels.ts";
import { Inbox } from "../src/gateway/inbox.ts";
import { MessageLog } from "../src/gateway/log.ts";
import { Waker } from "../src/gateway/waker.ts";
import { MemoryChannel, message, withCore } from "./support/core.ts";

// What the inbox does with what adapters give it: the gateway checks happenings, and one bad event stops nothing.

const sink: ChannelSink = { receive: async () => {}, newestMessage: async () => undefined, threads: async () => [], lastAlive: () => undefined, log: () => {} };

/** A memory channel whose translate returns whatever the test says for a raw event. */
class Scripted extends MemoryChannel {
  readonly happenings: (raw: { id: string }) => unknown[];

  constructor(happenings: (raw: { id: string }) => unknown[]) {
    super();
    this.happenings = happenings;
  }

  override async translate(raw: unknown): Promise<Happening[]> {
    return this.happenings(raw as { id: string }) as Happening[];
  }
}

const deliver = (channel: MemoryChannel, ids: readonly string[]) =>
  Effect.gen(function* () {
    yield* (yield* Channels).connect([channel], () => sink);
    const inbox = yield* Inbox;
    yield* inbox.open;
    for (const id of ids) yield* inbox.receive("mem", id, { id });
    yield* inbox.drain;
    const log = yield* MessageLog;
    return { logged: (yield* log.undecided).map((event) => event.text) };
  });

describe("inbox", () => {
  it.effect("logs a happening whose adapter says null for a missing name", () =>
    withCore({}, (recorder, sql) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        const channel = new Scripted((raw) => [
          { ...message("general", raw.id), person: { address: "mem:@u1", name: null, realName: null }, files: null, mentionsMe: null },
        ]);
        const { logged } = yield* deliver(channel, ["hello"]);
        assert.deepStrictEqual(logged, ["hello"]);
        const people = yield* Effect.promise(() => sql.all<{ name: string | null }>("SELECT name FROM gw_people WHERE address = 'mem:@u1'"));
        assert.deepStrictEqual(people.map((person) => person.name), [null]);
      }),
    ));

  it.effect("marks a bad event as failed, says why, and goes on with the next ones", () =>
    withCore({}, (recorder, sql) =>
      Effect.gen(function* () {
        (yield* Waker).setTarget(recorder.target());
        const channel = new Scripted((raw) => {
          if (raw.id === "throws") throw new Error("cannot read this event");
          if (raw.id === "no-time") return [{ ...message("general", raw.id), at: 1e20 }];
          return [message("general", raw.id)];
        });
        const { logged } = yield* deliver(channel, ["first", "throws", "no-time", "last"]);
        assert.deepStrictEqual(logged, ["first", "last"]);
        const rows = yield* Effect.promise(() => sql.all<{ event_id: string; state: string; error: string | null }>("SELECT event_id, state, error FROM gw_inbox ORDER BY rowid"));
        assert.deepStrictEqual(
          rows.map((row) => [row.event_id, row.state]),
          [["first", "done"], ["throws", "error"], ["no-time", "error"], ["last", "done"]],
        );
        assert.strictEqual(rows[1]!.error, "Error: cannot read this event");
        assert.match(rows[2]!.error!, /^mem gave a happening that does not fit: /);
        assert.deepStrictEqual(
          recorder.prints.filter((print) => print.message === "event failed").map((print) => print.data?.eventId),
          ["throws", "no-time"],
        );
      }),
    ));
});
