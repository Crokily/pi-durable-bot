import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createChannel } from "../src/channels/slack/index.ts";
import { GatewaySlackAdapter } from "../src/channels/slack/sdk.ts";
import type { ChannelAdapter, ChannelSink, Happening } from "../src/core/channel.ts";
import { APP_TOKEN, BOT_TOKEN, FakeSlack, VERIFICATION_TOKEN } from "./support/slack.ts";

// The Slack channel against a fake Slack on this computer (test/support/slack.ts): its Web API, Socket Mode and file
// host, so the Chat SDK's Slack client connects for real. Events are shaped as Slack's docs show them.

const ALICE = { id: "U0ALICE", team_id: "T0LAB", name: "alice", real_name: "Alice Smith", is_bot: false, profile: { display_name: "Alice", real_name: "Alice Smith" } };
const BOB = { id: "U0BOB", team_id: "T0LAB", name: "bob", real_name: "Bob Jones", is_bot: false, profile: { display_name: "", real_name: "Bob Jones" } };
const POTS = { id: "UBOT", team_id: "T0LAB", name: "pots", real_name: "Pots", is_bot: true, profile: { display_name: "", real_name: "Pots", bot_id: "BBOT" } };
const GENERAL = { id: "C0GENERAL", name: "general", is_channel: true, is_private: false, is_member: true, created: 1793000000 };
const DM = { id: "D0ALICE", is_im: true, user: ALICE.id, created: 1793000000 };
const GROUP = { id: "G0GROUP", name: "mpdm-alice--bob--pots-1", is_mpim: true, is_private: true, is_member: true, created: 1793000000 };
const TS = "1793080260.000100";

/** A message event as Slack sends it for message.channels. */
function message(fields: Record<string, unknown> = {}) {
  return { type: "message", channel: GENERAL.id, user: ALICE.id, text: "hello", ts: TS, event_ts: TS, channel_type: "channel", team: "T0LAB", ...fields };
}

/** A sink like the gateway's: it drops a known event ID, and keeps raws as JSON, as the inbox does. */
/** fail: the receive of this event ID fails while it returns true. newest: the newest logged message of each place. */
function memorySink(options: { lastAlive?: number; newest?: Record<string, string>; threads?: Record<string, string[]>; fail?: (id: string) => boolean } = {}) {
  const events: { id: string; raw: any }[] = [];
  const logs: string[] = [];
  const sink: ChannelSink = {
    receive: async (id, raw) => {
      if (options.fail?.(id)) throw new Error("database is locked");
      if (!events.some((event) => event.id === id)) events.push({ id, raw: JSON.parse(JSON.stringify(raw)) });
    },
    newestMessage: async (place) => options.newest?.[place],
    threads: async (place) => options.threads?.[place] ?? [],
    places: async () => Object.keys(options.newest ?? {}),
    lastAlive: () => options.lastAlive,
    log: (text, data) => logs.push(`${text} ${JSON.stringify(data ?? {})}`),
  };
  return { sink, events, logs };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await sleep(10)) {
    if (Date.now() > end) throw new Error("timed out");
  }
}

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** A fake Slack with the workspace Lab: #general, a DM with Alice and a group DM; and a channel for it, not started. */
async function setUp() {
  const fake = await FakeSlack.start();
  for (const conversation of [GENERAL, DM, GROUP]) fake.conversations.set(conversation.id, conversation);
  for (const user of [ALICE, BOB, POTS]) fake.users.set(user.id, user);
  const dir = mkdtempSync(join(tmpdir(), "pots-slack-"));
  writeFileSync(join(dir, "slack.env"), `SLACK_APP_TOKEN=${APP_TOKEN}\nSLACK_BOT_TOKEN=${BOT_TOKEN}\n`);
  const channel: ChannelAdapter = createChannel({ id: "slack", type: "slack", secrets: join(dir, "slack.env") }, { botDir: dir, botName: "Pots", log: () => {} }, fake.api);
  cleanup.push(async () => {
    await channel.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fake, channel, dir };
}

/** A started channel on the fake Slack, and the sink it stores into. */
async function connect(options: Parameters<typeof memorySink>[0] = {}) {
  const { fake, channel, dir } = await setUp();
  const { sink, events, logs } = memorySink(options);
  await channel.start(sink);
  /** Send events over the socket and wait until the channel stored `stored` more of them. */
  const deliver = async (sent: Record<string, unknown>[], stored = sent.length) => {
    const before = events.length;
    for (const event of sent) fake.event(event);
    await until(() => events.length >= before + stored);
    return events.slice(before);
  };
  /** One event over the socket, translated. */
  const receive = async (event: Record<string, unknown>): Promise<Happening[]> => channel.translate((await deliver([event]))[0]!.raw);
  return { fake, channel, sink, events, logs, deliver, receive, dir };
}

describe("receiving", () => {
  it("connects over Socket Mode with the app token, and knows itself from the bot token", async () => {
    const { fake, channel } = await connect();
    expect(channel.me).toEqual({ address: "slack:@UBOT", name: "Pots" });
    expect(fake.connections).toBe(1);
    expect(fake.called("apps.connections.open").map((call) => call.auth)).toEqual([`Bearer ${APP_TOKEN}`]);
    expect(fake.called("auth.test").map((call) => call.auth)).toEqual([`Bearer ${BOT_TOKEN}`]);
  });

  it("stores an event before it acks it, without Slack's verification token", async () => {
    const { fake, sink, events } = await connect();
    const receive = sink.receive;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    sink.receive = async (id, raw) => {
      await held;
      return receive(id, raw);
    };
    const { envelope_id, event_id } = fake.event(message());
    await sleep(200);
    expect(fake.acks).toEqual([]);
    release();
    await until(() => fake.acked(envelope_id));
    expect(events).toEqual([{ id: event_id, raw: { source: "socket", envelope: expect.objectContaining({ event_id, team_id: "T0LAB", event: message() }) } }]);
    expect(JSON.stringify(events)).not.toContain(VERIFICATION_TOKEN);
  });

  it("does not ack an event it could not store, so Slack sends it again, and stores it then", async () => {
    let failures = 1;
    const { fake, events, logs } = await connect({ fail: (id) => id === "Ev0TEST0002" && failures-- > 0 });
    const first = fake.event(message());
    const second = fake.event(message({ ts: "1793080261.000100", text: "second" }));
    const third = fake.event(message({ ts: "1793080262.000100", text: "third" }));
    await until(() => fake.acked(first.envelope_id) && fake.acked(third.envelope_id));
    await sleep(100);
    expect(fake.acked(second.envelope_id)).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^event not stored, Slack will deliver it again .*database is locked/)]);
    // Slack sends it again in a new envelope, with the same event ID.
    const again = fake.event(message({ ts: "1793080261.000100", text: "second" }), { event_id: second.event_id, retry_attempt: 1 });
    await until(() => fake.acked(again.envelope_id));
    expect(events.map((event) => event.id)).toEqual([first.event_id, third.event_id, second.event_id]);
  });

  it("stores a slash command and an interaction before the ack, and translates them", async () => {
    const { fake, channel, events } = await connect();
    const command = fake.send("slash_commands", {
      command: "/pots",
      text: "status",
      user_id: ALICE.id,
      user_name: "alice",
      channel_id: GENERAL.id,
      channel_name: "general",
      team_id: "T0LAB",
      api_app_id: "A0TEST",
      trigger_id: "13345224609.738474920.8088930838d88f008e0",
      response_url: "https://hooks.slack.com/commands/T0LAB/1/2",
    });
    const button = fake.send("interactive", {
      type: "block_actions",
      user: { id: ALICE.id, username: "alice", team_id: "T0LAB" },
      channel: { id: GENERAL.id, name: "general" },
      container: { type: "message", message_ts: TS, channel_id: GENERAL.id },
      trigger_id: "13345224609.738474920.1",
      actions: [{ action_id: "approve", type: "button", value: "yes" }],
    });
    await until(() => fake.acked(command) && fake.acked(button));
    expect(events.map((event) => event.id)).toEqual(["slash_commands:13345224609.738474920.8088930838d88f008e0", "interactive:13345224609.738474920.1"]);
    expect(JSON.stringify(events)).not.toContain(VERIFICATION_TOKEN);
    expect(await channel.translate(events[0]!.raw)).toMatchObject([
      { kind: "command", place: { address: "slack:#C0GENERAL", name: "general" }, person: { address: "slack:@U0ALICE", name: "Alice" }, fromMe: false, text: "/pots status" },
    ]);
    expect(await channel.translate(events[1]!.raw)).toMatchObject([
      { kind: "interaction", place: { address: "slack:#C0GENERAL" }, message: `slack:#C0GENERAL/${TS}`, person: { address: "slack:@U0ALICE" }, text: "block_actions" },
    ]);
  });
});

describe("translate", () => {
  it("translates a channel message: names for mentions, who it mentions, and whether it mentions the bot", async () => {
    const { receive } = await connect();
    const [happening] = await receive(message({ text: "hi <@UBOT> and <@U0BOB|bob>, *today*" }));
    expect(happening).toEqual({
      kind: "message",
      at: 1793080260_000,
      place: { address: "slack:#C0GENERAL", kind: "channel", name: "general" },
      message: `slack:#C0GENERAL/${TS}`,
      person: { address: "slack:@U0ALICE", name: "Alice", realName: "Alice Smith" },
      fromMe: false,
      mentionsMe: true,
      text: "hi @Pots and @Bob Jones, today",
      mentions: ["slack:@UBOT", "slack:@U0BOB"],
      raw: message({ text: "hi <@UBOT> and <@U0BOB|bob>, *today*" }),
    });
    // A mention in the message's blocks counts too, and a person Slack does not know keeps their ID as the name.
    const [blocks] = await receive(
      message({
        ts: "1793080261.000100",
        user: "U0GONE",
        text: "ping <@U0BOB>",
        blocks: [{ type: "rich_text", block_id: "b", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "ping " }, { type: "user", user_id: "U0BOB" }] }] }],
      }),
    );
    expect(blocks).toMatchObject({ person: { address: "slack:@U0GONE" }, mentionsMe: false, mentions: ["slack:@U0BOB"] });
    // Slack also sends app_mention for a message that mentions the bot. It is the same message.
    expect(await receive({ type: "app_mention", user: ALICE.id, text: "<@UBOT> look", ts: "1793080262.000100", channel: GENERAL.id, event_ts: "1793080262.000100" })).toMatchObject([
      { kind: "message", message: "slack:#C0GENERAL/1793080262.000100", mentionsMe: true, text: "@Pots look" },
    ]);
  });

  it("puts a reply in its thread, under the thread's first message", async () => {
    const { receive } = await connect();
    const [reply] = await receive(message({ ts: "1793080261.000100", event_ts: "1793080261.000100", thread_ts: TS, parent_user_id: ALICE.id, user: BOB.id, text: "in the thread" }));
    expect(reply).toMatchObject({
      kind: "message",
      place: { address: "slack:#C0GENERAL" },
      message: "slack:#C0GENERAL/1793080261.000100",
      thread: `slack:#C0GENERAL/${TS}`,
      threadRoot: `slack:#C0GENERAL/${TS}`,
      person: { address: "slack:@U0BOB", name: "Bob Jones", realName: "Bob Jones" },
      text: "in the thread",
    });
    // Once a thread has replies, Slack gives its first message the thread's ts: the thread is the message itself.
    expect(await receive(message({ ts: TS, thread_ts: TS, reply_count: 1, latest_reply: "1793080261.000100" }))).toMatchObject([
      { message: `slack:#C0GENERAL/${TS}`, thread: `slack:#C0GENERAL/${TS}` },
    ]);
    // A message with no replies has no thread.
    const [alone] = await receive(message({ ts: "1793080262.000100" }));
    expect(alone!.thread).toBeUndefined();
  });

  it("translates a DM, with the person as the place's name, and a group DM", async () => {
    const { receive } = await connect();
    expect(await receive(message({ channel: DM.id, channel_type: "im", text: "psst" }))).toMatchObject([
      { kind: "message", place: { address: "slack:#D0ALICE", kind: "dm", name: "Alice" }, message: `slack:#D0ALICE/${TS}`, person: { name: "Alice" }, mentionsMe: false, text: "psst" },
    ]);
    expect(await receive(message({ channel: GROUP.id, channel_type: "mpim", user: BOB.id, text: "all three" }))).toMatchObject([
      { kind: "message", place: { address: "slack:#G0GROUP", kind: "group", name: "mpdm-alice--bob--pots-1" }, person: { address: "slack:@U0BOB" } },
    ]);
  });

  it("translates an edit, a change that is no edit, a delete, and a thread start deleted while it has replies", async () => {
    const { receive } = await connect();
    const changed = (ts: string, inner: Record<string, unknown>, before: Record<string, unknown>) => ({
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: GENERAL.id,
      channel_type: "channel",
      ts,
      event_ts: ts,
      message: { type: "message", user: ALICE.id, ts: TS, ...inner },
      previous_message: { type: "message", user: ALICE.id, ts: TS, ...before },
    });
    expect(await receive(changed("1793080300.000200", { text: "hello <@U0BOB>", edited: { user: ALICE.id, ts: "1793080299.000000" } }, { text: "hello" }))).toEqual([
      expect.objectContaining({ kind: "edit", at: 1793080299_000, message: `slack:#C0GENERAL/${TS}`, person: expect.objectContaining({ name: "Alice" }), fromMe: false, text: "hello @Bob Jones", mentions: ["slack:@U0BOB"] }),
    ]);
    // A link preview: Slack changed the message, nobody edited it.
    const [preview] = await receive(
      changed("1793080301.000200", { text: "see <https://example.com>", attachments: [{ from_url: "https://example.com", title: "Example" }] }, { text: "see <https://example.com>" }),
    );
    expect(preview).toMatchObject({ kind: "update", message: `slack:#C0GENERAL/${TS}`, fromMe: false });
    expect(preview!.person).toBeUndefined();
    expect(preview!.text).toBeUndefined();
    // An edit of a reply keeps its thread.
    expect(
      await receive(changed("1793080302.000200", { ts: "1793080261.000100", thread_ts: TS, text: "fixed", edited: { user: ALICE.id, ts: "1793080302.000000" } }, { ts: "1793080261.000100", thread_ts: TS, text: "fxed" })),
    ).toMatchObject([{ kind: "edit", message: "slack:#C0GENERAL/1793080261.000100", thread: `slack:#C0GENERAL/${TS}` }]);

    expect(
      await receive({
        type: "message",
        subtype: "message_deleted",
        hidden: true,
        channel: GENERAL.id,
        channel_type: "channel",
        ts: "1793080400.000300",
        event_ts: "1793080400.000300",
        deleted_ts: "1793080261.000100",
        previous_message: { type: "message", user: BOB.id, text: "fixed", ts: "1793080261.000100", thread_ts: TS },
      }),
    ).toEqual([
      expect.objectContaining({ kind: "delete", at: 1793080400_000, message: "slack:#C0GENERAL/1793080261.000100", thread: `slack:#C0GENERAL/${TS}`, person: expect.objectContaining({ address: "slack:@U0BOB" }), fromMe: false }),
    ]);
    // A thread's first message, deleted while it has replies, stays as a tombstone: for the log it is deleted.
    expect(
      await receive(
        changed(
          "1793080500.000400",
          { subtype: "tombstone", user: "USLACKBOT", text: "This message was deleted.", thread_ts: TS, reply_count: 1, hidden: true },
          { text: "hello", thread_ts: TS, reply_count: 1 },
        ),
      ),
    ).toMatchObject([{ kind: "delete", message: `slack:#C0GENERAL/${TS}`, fromMe: false }]);
  });

  it("translates reactions, with the emoji's name", async () => {
    const { receive } = await connect();
    const reaction = (type: string, user: string, name: string) => ({ type, user, reaction: name, item_user: ALICE.id, item: { type: "message", channel: GENERAL.id, ts: TS }, event_ts: "1793080500.000400" });
    expect(await receive(reaction("reaction_added", ALICE.id, "thumbsup"))).toEqual([
      expect.objectContaining({ kind: "reaction_added", at: 1793080500_000, place: expect.objectContaining({ address: "slack:#C0GENERAL" }), message: `slack:#C0GENERAL/${TS}`, person: expect.objectContaining({ address: "slack:@U0ALICE" }), fromMe: false, text: ":thumbsup:" }),
    ]);
    expect(await receive(reaction("reaction_removed", "UBOT", "white_check_mark"))).toMatchObject([{ kind: "reaction_removed", person: { address: "slack:@UBOT", name: "Pots" }, fromMe: true, text: ":white_check_mark:" }]);
  });

  it("translates a person joining, with who invited them, and the bot being invited", async () => {
    const { receive } = await connect();
    const joined = (user: string, inviter?: string) => ({ type: "member_joined_channel", user, channel: GENERAL.id, channel_type: "C", team: "T0LAB", ...(inviter ? { inviter } : {}) });
    expect(await receive(joined(BOB.id, ALICE.id))).toEqual([
      expect.objectContaining({ kind: "join", place: expect.objectContaining({ address: "slack:#C0GENERAL" }), person: expect.objectContaining({ address: "slack:@U0BOB" }), fromMe: false, text: "invited by Alice (slack:@U0ALICE)" }),
    ]);
    const [self] = await receive(joined(BOB.id));
    expect(self).toMatchObject({ kind: "join", person: { address: "slack:@U0BOB" }, fromMe: false });
    expect(self!.text).toBeUndefined();
    // The bot invited by Alice: the bot joined, and Alice did it.
    expect(await receive(joined("UBOT", ALICE.id))).toMatchObject([{ kind: "join", person: { address: "slack:@UBOT", name: "Pots" }, fromMe: false, text: "invited by Alice (slack:@U0ALICE)" }]);
    // The bot inviting Bob, with call.
    expect(await receive(joined(BOB.id, "UBOT"))).toMatchObject([{ kind: "join", person: { address: "slack:@U0BOB" }, fromMe: true, text: "invited by Pots (slack:@UBOT)" }]);
  });

  it("gives a join the time it happened, from the envelope, as the event has no time of its own", async () => {
    const { fake, channel, events } = await connect();
    fake.event({ type: "member_joined_channel", user: BOB.id, channel: GENERAL.id, channel_type: "C", team: "T0LAB" }, { event_time: 1793080700 });
    await until(() => events.length === 1);
    expect(await channel.translate(events[0]!.raw)).toMatchObject([{ kind: "join", at: 1793080700_000 }]);
  });

  it("leaves out the message Slack posts when someone joins, which member_joined_channel already logs", async () => {
    const { channel, receive } = await connect();
    const posted = message({ subtype: "channel_join", user: BOB.id, inviter: ALICE.id, text: "<@U0BOB> has joined the channel", ts: "1793080600.000500", event_ts: "1793080600.000500" });
    expect(await receive(posted)).toEqual([]);
    // Read by a backfill, it is the only trace of a join while the gateway was down, so it stays.
    expect(await channel.translate({ source: "history", channel: GENERAL.id, message: posted })).toMatchObject([
      { kind: "message", person: { address: "slack:@U0BOB" }, text: "@Bob Jones has joined the channel" },
    ]);
  });

  it("translates the bot's own messages as its own, with the send ID from the metadata, and another app's message", async () => {
    const { receive } = await connect();
    const own = { user: "UBOT", bot_id: "BBOT", app_id: "A0TEST", bot_profile: { id: "BBOT", app_id: "A0TEST", user_id: "UBOT", name: "pots" } };
    expect(await receive(message({ ...own, text: "done", metadata: { event_type: "pi_durable_bot_send", event_payload: { send_id: "tool:7" } } }))).toEqual([
      expect.objectContaining({ kind: "message", person: { address: "slack:@UBOT", name: "Pots" }, fromMe: true, mentionsMe: false, text: "done", sendId: "tool:7" }),
    ]);
    // Metadata of another type is not a send ID.
    const [other] = await receive(message({ ...own, ts: "1793080261.000100", metadata: { event_type: "task_created", event_payload: { send_id: "x" } } }));
    expect(other).toMatchObject({ fromMe: true });
    expect(other!.sendId).toBeUndefined();
    // A message of an integration has a bot ID and a name, but no person in Slack.
    expect(await receive(message({ ts: "1793080262.000100", subtype: "bot_message", user: undefined, bot_id: "B0CI", username: "CI", text: "build failed" }))).toMatchObject([
      { kind: "message", person: { address: "slack:@B0CI", name: "CI" }, fromMe: false, text: "build failed" },
    ]);
  });

  it("gives the files of a message, and downloads them with the token only from Slack's file host", async () => {
    const { fake, receive, channel } = await connect();
    const url = `${fake.origin}/files-pri/T0LAB-F0PLAN/plan.png`;
    const [shared] = await receive(
      message({ subtype: "file_share", text: "the plan", files: [{ id: "F0PLAN", name: "plan.png", title: "plan", mimetype: "image/png", filetype: "png", size: 10, url_private: url, url_private_download: `${url}?download=1` }] }),
    );
    expect(shared).toMatchObject({ kind: "message", text: "the plan", files: [{ name: "plan.png", type: "image/png", url, size: 10 }] });

    fake.files.set("/files-pri/T0LAB-F0PLAN/plan.png", { content: "png bytes!", type: "image/png" });
    const read = async (file: { url: string; type?: string }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of (await channel.fetchFile!(file, AbortSignal.timeout(5_000))) as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    };
    expect(await read(shared!.files![0]! as { url: string })).toBe("png bytes!");
    expect(fake.fileRequests).toEqual([{ path: "/files-pri/T0LAB-F0PLAN/plan.png", auth: `Bearer ${BOT_TOKEN}` }]);

    // Another host, plain HTTP, or a host that only looks like Slack's: nothing is sent.
    for (const other of ["https://example.com/plan.png", "http://files.slack.com/files-pri/T0LAB-F1/plan.png", "https://files.slack.com.example.com/plan.png", "https://notslack.com/plan.png"]) {
      await expect(channel.fetchFile!({ url: other }, AbortSignal.timeout(5_000))).rejects.toThrow("not a Slack file URL");
    }
    // A redirect to another host does not take the token along; that host gives the sign-in page, which is refused.
    const elsewhere = await FakeSlack.start();
    cleanup.push(() => elsewhere.close());
    fake.files.set("/files-pri/T0LAB-F0MOVED/moved.png", { redirect: `${elsewhere.origin}/files-pri/T0LAB-F0MOVED/moved.png` });
    await expect(read({ url: `${fake.origin}/files-pri/T0LAB-F0MOVED/moved.png`, type: "image/png" })).rejects.toThrow("Slack sent a web page instead of the file");
    expect(elsewhere.fileRequests).toEqual([{ path: "/files-pri/T0LAB-F0MOVED/moved.png", auth: undefined }]);
  });
});

describe("backfill", () => {
  it("backfills nothing on the first start", async () => {
    const { fake, channel, sink, logs } = await connect();
    await channel.backfill(sink);
    expect(fake.called("conversations.history")).toEqual([]);
    expect(logs.at(-1)).toBe('backfill done {"messages":0}');
  });

  it("backfills each place after its newest logged message, oldest first, with new replies in threads, and goes on past a place that fails", async () => {
    const lastAlive = Date.parse("2026-10-26T12:00:00Z");
    const since = (lastAlive / 1000).toFixed(6);
    const { fake, channel, sink, events, logs } = await connect({
      lastAlive,
      newest: { "slack:#C0GENERAL": `slack:#C0GENERAL/${TS}` },
      threads: { "slack:#C0GENERAL": ["slack:#C0GENERAL/1793080000.000100", "slack:#C0GENERAL/1793079000.000100"] },
    });
    fake.conversations.set("C0SECRET", { id: "C0SECRET", name: "secret", is_channel: true, is_member: true });
    // #general: the logged message, then 250 new ones, which Slack gives in two pages, the newest first.
    fake.post(GENERAL.id, { user: ALICE.id, text: "logged", ts: TS });
    const later = Array.from({ length: 250 }, (_, index) => `${1793080300 + index}.000100`);
    for (const ts of later) fake.post(GENERAL.id, { user: BOB.id, text: `new ${ts}`, ts });
    // A logged thread with a new reply and an old one, a new thread found from history, and a thread whose first
    // message is gone.
    fake.post(GENERAL.id, { user: ALICE.id, text: "old thread", ts: "1793080000.000100" });
    fake.post(GENERAL.id, { user: BOB.id, text: "old reply", ts: "1793080100.000100", thread_ts: "1793080000.000100" });
    fake.post(GENERAL.id, { user: BOB.id, text: "new reply", ts: "1793090000.000100", thread_ts: "1793080000.000100" });
    fake.post(GENERAL.id, { user: BOB.id, text: "reply in a new thread", ts: "1793090001.000100", thread_ts: later[0]! });
    // The DM has nothing logged: it starts when the gateway last ran.
    fake.post(DM.id, { user: ALICE.id, text: "before the downtime", ts: (lastAlive / 1000 - 60).toFixed(6) });
    fake.post(DM.id, { user: ALICE.id, text: "while you were away", ts: (lastAlive / 1000 + 60).toFixed(6) });
    fake.route("conversations.history", (params) => (params.channel === "C0SECRET" ? { ok: false, error: "not_in_channel" } : undefined));

    await channel.backfill(sink);
    const ids = events.map((event) => event.id);
    expect(ids.slice(0, 250)).toEqual(later.map((ts) => `history:C0GENERAL:${ts}:`));
    expect(ids.slice(250)).toEqual(["history:C0GENERAL:1793090000.000100:", "history:C0GENERAL:1793090001.000100:", `history:D0ALICE:${(lastAlive / 1000 + 60).toFixed(6)}:`]);
    // History is read after the place's start, with the metadata that holds send IDs.
    const histories = fake.called("conversations.history");
    expect(histories.filter((call) => call.params.channel === GENERAL.id).map((call) => [call.params.oldest, call.params.inclusive, call.params.cursor])).toEqual([
      [TS, "false", undefined],
      [TS, "false", "200"],
    ]);
    expect(histories.every((call) => call.params.include_all_metadata === "true")).toBe(true);
    expect(histories.find((call) => call.params.channel === DM.id)!.params.oldest).toBe(since);
    // Each thread is read from the place's start: the logged ones, and the one history showed with a new reply.
    expect(fake.called("conversations.replies").map((call) => [call.params.ts, call.params.oldest])).toEqual([
      ["1793080000.000100", TS],
      ["1793079000.000100", TS],
      [later[0], TS],
    ]);
    // A place that cannot be read is logged and skipped; a thread that is gone is skipped quietly.
    expect(logs.filter((line) => line.startsWith("backfill skipped a place"))).toEqual([expect.stringContaining('"channel":"C0SECRET"')]);
    expect(logs.at(-1)).toBe('backfill done {"messages":253}');

    expect(await channel.translate(events[250]!.raw)).toMatchObject([
      { kind: "message", message: "slack:#C0GENERAL/1793090000.000100", thread: "slack:#C0GENERAL/1793080000.000100", person: { address: "slack:@U0BOB" }, text: "new reply" },
    ]);
  });

  it("reads where each place's log ends before the socket connects, so a live message does not move the backfill's start", async () => {
    const { fake, channel } = await setUp();
    const newest: Record<string, string> = { "slack:#C0GENERAL": `slack:#C0GENERAL/${TS}` };
    const { sink, events } = memorySink({ lastAlive: Date.now() - 600_000, newest });
    const read: number[] = [];
    const newestMessage = sink.newestMessage;
    sink.newestMessage = async (place) => {
      read.push(fake.connections);
      return newestMessage(place);
    };
    await channel.start(sink);
    expect(read).toEqual([0]);
    // A live message is stored and logged before the gateway's backfill reads.
    fake.event(message({ ts: "1793090000.000100", event_ts: "1793090000.000100" }));
    await until(() => events.length === 1);
    newest["slack:#C0GENERAL"] = "slack:#C0GENERAL/1793090000.000100";
    await channel.backfill(sink);
    expect(fake.called("conversations.history").find((call) => call.params.channel === GENERAL.id)!.params.oldest).toBe(TS);
  });
});

describe("sending", () => {
  it("refuses a text over 12000 characters as Slack gets it, and never cuts one", async () => {
    const { fake, channel } = await connect();
    expect(channel.checkText!("slack:#C0GENERAL", "x".repeat(12000))).toBeUndefined();
    // A person address becomes the shorter <@U0ALICE> before the count, and an emoji counts once.
    expect(channel.checkText!("slack:#C0GENERAL", `${"x".repeat(11990)}<slack:@U0ALICE>`)).toBeUndefined();
    expect(channel.checkText!("slack:#C0GENERAL", "😀".repeat(12000))).toBeUndefined();
    const refusal = "Slack allows at most 12000 characters in one message; this one has 12001. Send it in parts.";
    expect(channel.checkText!("slack:#C0GENERAL", "x".repeat(12001))).toBe(refusal);
    await expect(channel.send("slack:#C0GENERAL", "x".repeat(12001), "tool:1")).rejects.toThrow(refusal);
    expect(fake.called("chat.postMessage")).toEqual([]);
    // At the limit, the text goes out whole.
    await channel.send("slack:#C0GENERAL", "x".repeat(12000), "tool:2");
    expect(fake.called("chat.postMessage")[0]!.params.markdown_text).toBe("x".repeat(12000));
  });

  it("posts Markdown with mentions by address; a reply goes in the message's thread, with the send ID in the metadata", async () => {
    const { fake, channel } = await connect();
    fake.post(GENERAL.id, { user: ALICE.id, text: "release plan?", ts: TS });
    fake.post(GENERAL.id, { user: BOB.id, text: "in the thread", ts: "1793080261.000100", thread_ts: TS });
    fake.post(GENERAL.id, { user: BOB.id, text: "no thread", ts: "1793080262.000100" });
    const posted = () => fake.called("chat.postMessage").at(-1)!.params;
    const metadata = (sendId: string) => JSON.stringify({ event_type: "pi_durable_bot_send", event_payload: { send_id: sendId } });

    // A place: a post in it.
    const sent = await channel.send("slack:#C0GENERAL", "**hi** <slack:@U0BOB>, see <slack:#C0GENERAL> :tada:", "tool:1");
    expect(posted()).toEqual({ channel: GENERAL.id, markdown_text: "**hi** <@U0BOB>, see <#C0GENERAL> :tada:", unfurl_links: "false", unfurl_media: "false", metadata: metadata("tool:1") });
    expect(sent).toMatchObject({ message: expect.stringMatching(/^slack:#C0GENERAL\/\d+\.\d{6}$/), place: "slack:#C0GENERAL" });
    // What send gives back is stored as the bot's own message, with its send ID.
    expect(await channel.translate(JSON.parse(JSON.stringify(sent.raw)))).toEqual([
      expect.objectContaining({ kind: "message", message: sent.message, fromMe: true, person: { address: "slack:@UBOT", name: "Pots" }, sendId: "tool:1", mentions: ["slack:@U0BOB"] }),
    ]);

    // A reply in a thread: in the thread of its first message.
    const reply = await channel.send("slack:#C0GENERAL/1793080261.000100", "on it", "tool:2");
    expect(posted()).toMatchObject({ channel: GENERAL.id, thread_ts: TS, markdown_text: "on it", metadata: metadata("tool:2") });
    expect(fake.called("conversations.replies").at(-1)!.params).toEqual({ channel: GENERAL.id, ts: "1793080261.000100", limit: "1" });
    expect(await channel.translate(JSON.parse(JSON.stringify(reply.raw)))).toMatchObject([{ thread: `slack:#C0GENERAL/${TS}`, sendId: "tool:2" }]);
    // The thread itself (its first message), and a message with no thread yet: a reply under it.
    await channel.send(`slack:#C0GENERAL/${TS}`, "to the thread", "tool:3");
    expect(posted()).toMatchObject({ thread_ts: TS });
    await channel.send("slack:#C0GENERAL/1793080262.000100", "a new thread", "tool:4");
    expect(posted()).toMatchObject({ thread_ts: "1793080262.000100" });
    await expect(channel.send("slack:#C0NOWHERE", "hi", "tool:5")).rejects.toThrow("channel_not_found");
  });

  it("writes to a person in a DM", async () => {
    const { fake, channel } = await connect();
    const sent = await channel.send("slack:@U0ALICE", "psst", "tool:1");
    expect(fake.called("conversations.open").map((call) => call.params)).toEqual([{ users: ALICE.id }]);
    expect(fake.called("chat.postMessage")[0]!.params).toMatchObject({ channel: DM.id, markdown_text: "psst" });
    expect(sent).toMatchObject({ place: "slack:#D0ALICE", message: expect.stringMatching(/^slack:#D0ALICE\//) });
  });

  it("finds a sent message again by its send ID, in a place, a thread or a DM", async () => {
    const { fake, channel } = await connect();
    fake.post(GENERAL.id, { user: ALICE.id, text: "release plan?", ts: TS });
    const since = Date.now();
    const inPlace = await channel.send("slack:#C0GENERAL", "one", "tool:1");
    const inThread = await channel.send(`slack:#C0GENERAL/${TS}`, "two", "tool:2");
    const inDm = await channel.send("slack:@U0ALICE", "three", "tool:3");

    const found = await channel.findSent("slack:#C0GENERAL", "tool:1", since);
    expect(found).toMatchObject({ message: inPlace.message, place: "slack:#C0GENERAL" });
    expect(await channel.translate(JSON.parse(JSON.stringify(found!.raw)))).toMatchObject([{ message: inPlace.message, fromMe: true, sendId: "tool:1" }]);
    expect(await channel.findSent(`slack:#C0GENERAL/${TS}`, "tool:2", since)).toMatchObject({ message: inThread.message });
    expect(await channel.findSent("slack:@U0ALICE", "tool:3", since)).toMatchObject({ message: inDm.message, place: "slack:#D0ALICE" });
    // History is read from a minute before the send started, with the metadata.
    expect(fake.called("conversations.history")[0]!.params).toMatchObject({ channel: GENERAL.id, oldest: ((since - 60_000) / 1000).toFixed(6), include_all_metadata: "true" });
    // A send in the thread is found in the thread, not in the place's history.
    expect(await channel.findSent("slack:#C0GENERAL", "tool:2", since)).toBeUndefined();
    expect(await channel.findSent("slack:#C0GENERAL", "tool:9", since)).toBeUndefined();
  });

  it("reacts by name, with or without colons, and takes a reaction already there or already gone as done", async () => {
    const { fake, channel } = await connect();
    fake.post(GENERAL.id, { user: ALICE.id, text: "release plan?", ts: TS });
    await channel.react(`slack:#C0GENERAL/${TS}`, ":eyes:", false);
    await channel.react(`slack:#C0GENERAL/${TS}`, "eyes", false);
    await channel.react(`slack:#C0GENERAL/${TS}`, "white_check_mark", false);
    await channel.react(`slack:#C0GENERAL/${TS}`, ":eyes:", true);
    await channel.react(`slack:#C0GENERAL/${TS}`, "eyes", true);
    expect([...fake.called("reactions.add"), ...fake.called("reactions.remove")].map((call) => `${call.method} ${call.params.name}`)).toEqual([
      "reactions.add eyes",
      "reactions.add eyes",
      "reactions.add white_check_mark",
      "reactions.remove eyes",
      "reactions.remove eyes",
    ]);
    expect(fake.called("reactions.add")[0]!.params).toEqual({ channel: GENERAL.id, timestamp: TS, name: "eyes" });
    expect([...fake.reactions]).toEqual([`C0GENERAL/${TS}/white_check_mark`]);
    await expect(channel.react(`slack:#C0GENERAL/1793080999.000100`, "eyes", false)).rejects.toThrow("message_not_found");
    await expect(channel.react("slack:#C0GENERAL", "eyes", false)).rejects.toThrow("not a message address");
  });

  it("calls any Web API method with the bot token, and uploads a file given as a path", async () => {
    const { fake, channel, dir } = await connect();
    fake.post(GENERAL.id, { user: "UBOT", text: "draft", ts: TS });
    expect(await channel.call("chat.update", { channel: GENERAL.id, ts: TS, markdown_text: "final" })).toMatchObject({ ok: true, ts: TS });
    expect(fake.called("chat.update")[0]).toMatchObject({ params: { channel: GENERAL.id, ts: TS, markdown_text: "final" }, auth: `Bearer ${BOT_TOKEN}` });
    // A method the Slack SDK has no function for goes as it is.
    fake.route("pins.list", (params) => ({ items: [], channel: params.channel }));
    expect(await channel.call("pins.list", { channel: GENERAL.id })).toMatchObject({ ok: true, items: [] });
    await expect(channel.call("no.such.method", {})).rejects.toThrow("unknown_method");

    writeFileSync(join(dir, "report.txt"), "all green");
    const uploaded = await channel.call("files.uploadV2", { channel_id: GENERAL.id, thread_ts: TS, file: join(dir, "report.txt"), filename: "report.txt", title: "Report" });
    expect(uploaded).toMatchObject({ ok: true, files: [{ files: [{ id: "F0UPLOAD1" }] }] });
    expect(fake.called("files.getUploadURLExternal")[0]!.params).toEqual({ filename: "report.txt", length: "9" });
    expect(fake.uploads.get("F0UPLOAD1")).toBe("all green");
    expect(fake.called("files.completeUploadExternal")[0]!.params).toEqual({ files: JSON.stringify([{ id: "F0UPLOAD1", title: "Report" }]), channel_id: GENERAL.id, thread_ts: TS });
  });

  it("parses only its own addresses", async () => {
    const { channel } = await setUp();
    expect(channel.owns("slack:#C0GENERAL")).toBe(true);
    expect(channel.owns("slack-acme:#C0GENERAL")).toBe(false);
    expect(channel.placeOf("slack:#C0GENERAL")).toBe("slack:#C0GENERAL");
    expect(channel.placeOf(`slack:#C0GENERAL/${TS}`)).toBe("slack:#C0GENERAL");
    expect(channel.placeOf("slack:@U0ALICE")).toBeUndefined();
    expect(() => channel.placeOf("slack:#general")).toThrow("bad slack address");
    expect(() => channel.placeOf("discord:#20")).toThrow("not a slack address");
  });

  it("keeps a bare @name as text, since Slack would show <@name> for a name that is not a person's ID", () => {
    const sdk = new GatewaySlackAdapter({ mode: "socket", appToken: "xapp-test", botToken: "xoxb-test", userName: "Pots" });
    const converter = (sdk as unknown as { formatConverter: { toSlackPayload(message: { markdown: string }): unknown } }).formatConverter;
    expect(converter.toSlackPayload({ markdown: "The Telegram bot is @colyclawbot, ask <@U0CC833JMQU> {{emoji:thumbs_up}}" })).toEqual({
      markdown_text: "The Telegram bot is @colyclawbot, ask <@U0CC833JMQU> :+1:",
    });
  });

  it("keeps a bare @name as text also when it is the name of a person the channel has seen", async () => {
    const { fake, channel, receive } = await connect();
    // Alice's message makes her name known to the Slack SDK.
    await receive(message({ text: "hi" }));
    await channel.send("slack:#C0GENERAL", "ask @alice or @Alice, or <slack:@U0ALICE>", "tool:1");
    expect(fake.called("chat.postMessage")[0]!.params.markdown_text).toBe("ask @alice or @Alice, or <@U0ALICE>");
  });
});
