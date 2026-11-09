import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordChannel } from "../src/channels/discord/index.ts";
import type { ChannelSink, Happening } from "../src/core/channel.ts";
import { FakeDiscord, Reply } from "./support/discord.ts";

// The Discord adapter against a fake Discord on this computer: its REST API and its gateway WebSocket. The packets are
// shaped as Discord's docs show them.

const BOT = { id: "100", username: "pots", global_name: "Pots", discriminator: "0", avatar: null, bot: true };
const ALICE = { id: "200", username: "alice", global_name: "Alice", discriminator: "0", avatar: null };
const BOB = { id: "201", username: "bob", global_name: null, discriminator: "0", avatar: null };
const TIME = "2026-11-05T01:00:00.000000+00:00";

const role = (id: string, name: string, managed = false) => ({ id, name, color: 0, hoist: false, position: 1, permissions: "0", managed, mentionable: true, flags: 0 });
const member = (roles: string[] = []) => ({ roles, nick: null, joined_at: TIME, deaf: false, mute: false, flags: 0 });
const textChannel = (id: string, name: string, type = 0, last_message_id: string | null = null) => ({
  id,
  type,
  name,
  position: 0,
  parent_id: null,
  permission_overwrites: [],
  last_message_id,
});
const thread = (id: string, parent: string, name: string, type = 11) => ({
  id,
  type,
  name,
  guild_id: "10",
  parent_id: parent,
  owner_id: ALICE.id,
  thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: TIME, locked: false },
  message_count: 1,
  member_count: 1,
});

/** Server "Lab": #general (20), a forum (21), and the bot's own role "Pots" (30). */
const GUILD = {
  id: "10",
  name: "Lab",
  icon: null,
  owner_id: ALICE.id,
  joined_at: TIME,
  large: false,
  unavailable: false,
  member_count: 3,
  features: [],
  emojis: [],
  stickers: [],
  presences: [],
  voice_states: [],
  stage_instances: [],
  guild_scheduled_events: [],
  roles: [role("10", "@everyone"), role("30", "Pots", true), role("31", "Team")],
  members: [{ ...member(["30"]), user: BOT }],
  channels: [textChannel("20", "general"), textChannel("21", "ideas", 15)],
  threads: [],
};

function message(fields: Record<string, unknown>) {
  return {
    id: "501",
    channel_id: "20",
    guild_id: "10",
    channel_type: 0,
    type: 0,
    content: "hello",
    author: ALICE,
    member: member(),
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    attachments: [],
    embeds: [],
    components: [],
    timestamp: TIME,
    edited_timestamp: null,
    tts: false,
    pinned: false,
    flags: 0,
    ...fields,
  };
}

/** A sink like the gateway's: it drops a known event ID, and keeps raws as JSON, as the inbox does. */
/** fail: the receive of this event ID fails while it returns true. */
function memorySink(options: { lastAlive?: number; newest?: Record<string, string>; places?: string[]; fail?: (id: string) => boolean; forms?: Record<string, unknown> } = {}) {
  const events: { id: string; raw: any }[] = [];
  const logs: string[] = [];
  const forms = new Map(Object.entries(options.forms ?? {}));
  const sink: ChannelSink = {
    receive: async (id, raw) => {
      if (options.fail?.(id)) throw new Error("database is locked");
      if (!events.some((event) => event.id === id)) events.push({ id, raw: JSON.parse(JSON.stringify(raw)) });
    },
    newestMessage: async (place) => options.newest?.[place],
    threads: async () => [],
    places: async () => options.places ?? [],
    lastAlive: () => options.lastAlive,
    form: async (name) => structuredClone(forms.get(name)),
    formOpened: async () => {},
    formOpening: async () => undefined,
    log: (text, data) => logs.push(`${text} ${JSON.stringify(data ?? {})}`),
  };
  return { sink, events, logs, forms };
}

const DISCORD_EPOCH = 1420070400000n;
const snowflake = (ms: number) => String((BigInt(ms) - DISCORD_EPOCH) << 22n);
const timeOf = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

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

/** A started adapter on a fake Discord with the server Lab, and the sink it stores into. */
async function connect(options: Parameters<typeof memorySink>[0] = {}) {
  const fake = await FakeDiscord.start();
  const dir = mkdtempSync(join(tmpdir(), "pots-discord-"));
  writeFileSync(join(dir, "discord.env"), "DISCORD_BOT_TOKEN=test-token\n");
  const channel = new DiscordChannel("discord", join(dir, "discord.env"), { botDir: dir, botName: "Pots", log: () => {} }, fake.api);
  cleanup.push(async () => {
    await channel.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  fake.guilds = ["10"];
  fake.onReady = () => fake.dispatch("GUILD_CREATE", GUILD);
  let posted = 900;
  fake.route("POST", "/channels/(\\d+)/messages", (request, match) =>
    message({ id: String(++posted), channel_id: match[1], author: BOT, content: request.body.content, nonce: request.body.nonce, channel_type: undefined, guild_id: undefined }),
  );
  const { sink, events, logs } = memorySink(options);
  await channel.start(sink);
  /** Send gateway dispatches and wait until the adapter stored `stored` more events. */
  const gateway = async (packets: [string, unknown][], stored = packets.length) => {
    const before = events.length;
    for (const [t, d] of packets) fake.dispatch(t, d);
    await until(() => events.length >= before + stored);
    return events.slice(before);
  };
  const translate = async (raw: unknown): Promise<Happening[]> => channel.translate(raw);
  return { fake, channel, sink, events, logs, gateway, translate };
}

/** An interaction's token: it rides in the callback's URL, and must not reach an error the bot sees. */
const INTERACTION_TOKEN = "aW50ZXJhY3Rpb24tdG9rZW4tdGhhdC1tdXN0LW5vdC1sZWFr";

/** An interaction in #general by Alice, as Discord sends it. */
function interaction(id: string, type: number) {
  return {
    id,
    application_id: "100",
    type,
    token: INTERACTION_TOKEN,
    version: 1,
    guild_id: "10",
    channel_id: "20",
    channel: { id: "20", type: 0, name: "general", guild_id: "10" },
    member: { ...member(), user: ALICE, permissions: "0" },
    app_permissions: "0",
    locale: "en-US",
    entitlements: [],
    authorizing_integration_owners: { 0: "10" },
    context: 0,
    attachment_size_limit: 10_485_760,
  };
}

/** A click on a button of a message, as Discord sends it. */
function componentClick(id: string, customId: string, on: ReturnType<typeof message>) {
  return { ...interaction(id, 3), message: on, data: { custom_id: customId, component_type: 2 } };
}

describe("Discord channel", () => {
  it("connects through the gateway and stores events in Discord's order, its own messages too", async () => {
    const { fake, channel, gateway, translate } = await connect();
    expect(channel.me).toEqual({ address: "discord:@100", name: "Pots" });
    // The token goes only to Discord's API.
    expect(fake.requested("GET", "/gateway/bot")[0]!.auth).toBe("Bot test-token");

    const stored = await gateway([
      ["MESSAGE_CREATE", message({ id: "501", content: "first" })],
      ["MESSAGE_CREATE", message({ id: "502", author: BOT, content: "mine", nonce: "abc" })],
      ["TYPING_START", { channel_id: "20", user_id: ALICE.id, timestamp: 1 }],
      ["MESSAGE_CREATE", message({ id: "503", content: "third" })],
    ], 3);
    expect(stored.map((event) => event.raw.d.id)).toEqual(["501", "502", "503"]);
    expect(stored[0]!.id).toBe("MESSAGE_CREATE:session-1:3");
    const mine = (await translate(stored[1]!.raw))[0]!;
    expect(mine).toMatchObject({ kind: "message", fromMe: true, person: { address: "discord:@100" }, text: "mine" });
  });

  it("tries a failed store again, and the events after it wait for it", async () => {
    let failures = 1;
    const { gateway, logs } = await connect({ fail: (id) => id.startsWith("MESSAGE_CREATE") && failures-- > 0 });
    const stored = await gateway([
      ["MESSAGE_CREATE", message({ id: "501", content: "first" })],
      ["MESSAGE_CREATE", message({ id: "502", content: "second" })],
    ]);
    expect(stored.map((event) => event.raw.d.id)).toEqual(["501", "502"]);
    expect(logs.filter((line) => line.startsWith("gateway event not stored"))).toEqual([expect.stringContaining('"attempt":1')]);
  });

  it("stores the events it already took before it stops, and gives up a failing one then", async () => {
    const { fake, channel, sink, events, logs } = await connect();
    const receive = sink.receive;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    sink.receive = async (id, raw) => {
      if ((raw as any).d.id === "501") await held;
      if ((raw as any).d.id === "503") throw new Error("database is locked");
      return receive(id, raw);
    };
    for (const id of ["501", "502", "503"]) fake.dispatch("MESSAGE_CREATE", message({ id }));
    await sleep(200); // the dispatches reach the adapter; 501 is being stored, 502 and 503 wait behind it
    const stopping = channel.stop();
    release();
    await stopping;
    // Discord does not send an event again, so the ones taken are stored before stop ends; 503 is given up after the
    // stop, after one more try.
    expect(events.map((event) => event.raw.d.id)).toEqual(["501", "502"]);
    expect(logs.filter((line) => line.includes('"event":"MESSAGE_CREATE:session-1:5"')).at(-1)).toContain("gateway event not stored, and the channel stopped");
  });

  it("keeps a thread message's addresses when the thread cannot be looked up later", async () => {
    const first = await connect();
    const [, inThread, reaction] = await first.gateway([
      ["THREAD_CREATE", { ...thread("600", "20", "Release plan"), newly_created: true }],
      ["MESSAGE_CREATE", message({ id: "601", channel_id: "600", channel_type: 11 })],
      ["MESSAGE_REACTION_ADD", { user_id: ALICE.id, channel_id: "600", message_id: "601", guild_id: "10", member: { ...member(), user: ALICE }, emoji: { id: null, name: "👍" }, burst: false, type: 0 }],
    ]);
    expect(inThread!.raw.parent).toBe("20");
    expect(reaction!.raw.parent).toBe("20");
    // Another run, where Discord does not know the thread any more (GET /channels/600 answers 404).
    const second = await connect();
    expect(await second.translate(inThread!.raw)).toMatchObject([{ message: "discord:#20/600/601", thread: "discord:#20/600", place: { address: "discord:#20" } }]);
    expect(await second.translate(reaction!.raw)).toMatchObject([{ message: "discord:#20/600/601", thread: "discord:#20/600" }]);
    expect(second.fake.requested("GET", "/channels/600")).toEqual([]);
  });

  it("translates a channel message: names for mentions, files, and who it mentions", async () => {
    const { gateway, translate } = await connect();
    const attachment = { id: "77", filename: "plan.png", content_type: "image/png", size: 1234, url: "https://cdn.discordapp.com/attachments/20/77/plan.png?ex=1&is=2&hm=3" };
    const [event] = await gateway([
      [
        "MESSAGE_CREATE",
        message({
          content: "hi <@100> and <@!201>, see <#20>",
          mentions: [{ ...BOT, member: member(["30"]) }, BOB],
          attachments: [attachment],
        }),
      ],
    ]);
    const [happening] = await translate(event!.raw);
    expect(happening).toEqual({
      kind: "message",
      at: Date.parse(TIME),
      place: { address: "discord:#20", kind: "channel", name: "Lab #general" },
      message: "discord:#20/501",
      person: { address: "discord:@200", name: "Alice" },
      fromMe: false,
      mentionsMe: true,
      text: "hi @Pots and @bob, see #general",
      mentions: ["discord:@100", "discord:@201"],
      files: [{ name: "plan.png", type: "image/png", url: attachment.url, size: 1234 }],
      raw: event!.raw.d,
    });
  });

  it("counts a mention of the bot's role as a mention of the bot, and names roles", async () => {
    const { gateway, translate } = await connect();
    const events = await gateway([
      ["MESSAGE_CREATE", message({ id: "501", content: "<@&30> can you look?", mention_roles: ["30"] })],
      ["MESSAGE_CREATE", message({ id: "502", content: "<@&31> standup", mention_roles: ["31"] })],
    ]);
    const [own] = await translate(events[0]!.raw);
    const [other] = await translate(events[1]!.raw);
    expect(own).toMatchObject({ text: "@Pots can you look?", mentionsMe: true, mentions: [] });
    expect(other).toMatchObject({ text: "@Team standup", mentionsMe: false });
  });

  it("puts a message in a thread under the thread's first message, in the channel's place", async () => {
    const { gateway, translate } = await connect();
    const events = await gateway([
      ["MESSAGE_CREATE", message({ id: "600", content: "release plan?" })],
      ["THREAD_CREATE", { ...thread("600", "20", "Release plan"), newly_created: true }],
      ["MESSAGE_CREATE", message({ id: "601", channel_id: "600", channel_type: 11, content: "in the thread" })],
      ["THREAD_CREATE", { ...thread("800", "21", "New idea"), newly_created: true }],
      ["MESSAGE_CREATE", message({ id: "800", channel_id: "800", channel_type: 11, content: "the post itself" })],
    ]);
    const [root, created, reply, , post] = await Promise.all(events.map(async (event) => (await translate(event.raw))[0]!));
    expect(root).toMatchObject({ message: "discord:#20/600", place: { address: "discord:#20" } });
    expect(root!.thread).toBeUndefined();
    expect(created).toMatchObject({ kind: "system", thread: "discord:#20/600", person: { address: "discord:@200" }, text: 'started the thread "Release plan"', fromMe: false });
    expect(reply).toMatchObject({
      kind: "message",
      place: { address: "discord:#20", name: "Lab #general" },
      message: "discord:#20/600/601",
      thread: "discord:#20/600",
      threadRoot: "discord:#20/600",
    });
    // A forum post's first message is in the post and has its ID: its address is the thread's.
    expect(post).toMatchObject({ place: { address: "discord:#21", name: "Lab #ideas" }, message: "discord:#21/800", thread: "discord:#21/800" });
  });

  it("makes a server's welcome message a join, once, and leaves out the bot's own", async () => {
    const { gateway, translate } = await connect();
    const [mine, alice] = await gateway([
      ["MESSAGE_CREATE", message({ id: "510", type: 7, author: BOT, content: "" })],
      ["MESSAGE_CREATE", message({ id: "511", type: 7, author: ALICE, content: "" })],
    ]);
    expect(await translate(mine!.raw)).toEqual([]);
    expect(await translate(alice!.raw)).toEqual([
      expect.objectContaining({ kind: "join", place: expect.objectContaining({ address: "discord:#20" }), person: expect.objectContaining({ address: "discord:@200" }), fromMe: false }),
    ]);
    // The same welcome message read again by a backfill is no second join.
    expect(await translate({ source: "history", message: alice!.raw.d })).toEqual([]);
  });

  it("logs other system messages as system events in words, and a pin as about the pinned message", async () => {
    const { gateway, translate } = await connect();
    const events = await gateway([
      ["MESSAGE_CREATE", message({ id: "520", type: 6, content: "", message_reference: { channel_id: "20", message_id: "501" } })],
      ["MESSAGE_CREATE", message({ id: "521", type: 4, content: "launch-room" })],
      ["MESSAGE_CREATE", message({ id: "522", type: 25, content: "joined Gold" })],
      ["THREAD_UPDATE", { ...thread("600", "20", "Release plan"), thread_metadata: { archived: true } }],
    ]);
    const [pin, renamed, other, archived] = await Promise.all(events.map(async (event) => (await translate(event.raw))[0]!));
    expect(pin).toEqual(
      expect.objectContaining({ kind: "system", place: expect.objectContaining({ address: "discord:#20" }), message: "discord:#20/501", person: expect.objectContaining({ address: "discord:@200" }), fromMe: false, text: "pinned a message" }),
    );
    expect(renamed).toMatchObject({ kind: "system", message: "discord:#20/521", text: 'changed the channel\'s name to "launch-room"' });
    expect(other).toMatchObject({ kind: "system", text: "Discord system message RoleSubscriptionPurchase: joined Gold" });
    expect(archived).toMatchObject({ kind: "system", thread: "discord:#20/600", text: 'the thread "Release plan" was archived' });
    // Read again by a backfill, a system message would be a second event.
    expect(await translate({ source: "history", message: events[0]!.raw.d })).toEqual([]);
  });

  it("leaves out the system message of a thread start, which THREAD_CREATE logs", async () => {
    const { gateway, translate } = await connect();
    const [started] = await gateway([["MESSAGE_CREATE", message({ id: "512", type: 18, author: BOT, content: "Release plan" })]]);
    expect(await translate(started!.raw)).toEqual([]);
    expect(await translate({ source: "history", message: started!.raw.d })).toEqual([]);
  });

  it("translates a DM, with the person as the place's name", async () => {
    const { fake, gateway, translate } = await connect();
    fake.route("GET", "/channels/700", () => ({ id: "700", type: 1, last_message_id: "701", recipients: [ALICE] }));
    const [event] = await gateway([["MESSAGE_CREATE", message({ id: "701", channel_id: "700", channel_type: 1, guild_id: undefined, member: undefined, content: "psst" })]]);
    expect(await translate(event!.raw)).toMatchObject([
      { kind: "message", place: { address: "discord:#700", kind: "dm", name: "Alice" }, message: "discord:#700/701", person: { name: "Alice" }, text: "psst" },
    ]);
  });

  it("translates an edit once, an update, a delete and reactions", async () => {
    const { fake, gateway, translate } = await connect();
    fake.route("GET", "/users/201", () => BOB);
    const edited = "2026-11-05T01:05:00.000000+00:00";
    const events = await gateway(
      [
        ["MESSAGE_CREATE", message({ content: "see https://example.com" })],
        ["MESSAGE_UPDATE", message({ content: "see https://example.com/new", edited_timestamp: edited })],
        // The link preview of the edited text: the same edit, so not stored again.
        ["MESSAGE_UPDATE", message({ content: "see https://example.com/new", edited_timestamp: edited, embeds: [{ type: "link", url: "https://example.com/new" }] })],
        ["MESSAGE_UPDATE", message({ id: "502", content: "pinned now", pinned: true })],
        ["MESSAGE_REACTION_ADD", { user_id: ALICE.id, channel_id: "20", message_id: "501", guild_id: "10", member: { ...member(), user: ALICE }, emoji: { id: null, name: "👍" }, burst: false, type: 0 }],
        ["MESSAGE_REACTION_REMOVE", { user_id: BOB.id, channel_id: "20", message_id: "501", guild_id: "10", emoji: { id: "900", name: "blob", animated: false }, burst: false, type: 0 }],
        ["MESSAGE_DELETE", { id: "501", channel_id: "20", guild_id: "10" }],
      ],
      6,
    );
    const [, edit, update, added, removed, deleted] = await Promise.all(events.map(async (event) => (await translate(event.raw))[0]!));
    expect(edit).toMatchObject({ kind: "edit", at: Date.parse(edited), message: "discord:#20/501", text: "see https://example.com/new", person: { name: "Alice" } });
    expect(update).toMatchObject({ kind: "update", message: "discord:#20/502", fromMe: false });
    expect(update!.person).toBeUndefined();
    expect(added).toMatchObject({ kind: "reaction_added", message: "discord:#20/501", person: { address: "discord:@200" }, text: "👍", fromMe: false });
    expect(removed).toMatchObject({ kind: "reaction_removed", person: { address: "discord:@201", name: "bob" }, text: "<:blob:900>" });
    expect(deleted).toMatchObject({ kind: "delete", message: "discord:#20/501", place: { address: "discord:#20" }, fromMe: false });
  });

  it("stores the bot being added to and removed from a server, not a server coming back after an outage", async () => {
    const { gateway, translate } = await connect();
    const events = await gateway(
      [
        ["GUILD_CREATE", GUILD],
        ["GUILD_CREATE", { ...GUILD, id: "11", name: "Shop", members: [], channels: [textChannel("40", "sales")] }],
        ["GUILD_DELETE", { id: "10", unavailable: true }],
        ["GUILD_DELETE", { id: "11" }],
      ],
      2,
    );
    expect(events.map((event) => event.raw.t)).toEqual(["GUILD_CREATE", "GUILD_DELETE"]);
    // Channels, roles and members are not kept with the event.
    expect(events[0]!.raw.d.channels).toBeUndefined();
    expect(await translate(events[0]!.raw)).toMatchObject([{ kind: "join", person: { address: "discord:@100" }, fromMe: false, text: 'added to the server "Shop" (ID 11)' }]);
    expect(await translate(events[1]!.raw)).toMatchObject([{ kind: "leave", fromMe: false, text: "removed from the server (ID 11)" }]);
  });

  it("stores an interaction, then tells Discord the answer comes later", async () => {
    const { fake, gateway, translate } = await connect();
    fake.route("POST", "/interactions/950/tok/callback", () => undefined);
    const [event] = await gateway([
      [
        "INTERACTION_CREATE",
        {
          id: "950",
          application_id: "100",
          type: 2,
          token: "tok",
          version: 1,
          guild_id: "10",
          channel_id: "20",
          channel: { id: "20", type: 0, name: "general", guild_id: "10" },
          member: { ...member(), user: ALICE, permissions: "0" },
          app_permissions: "0",
          locale: "en-US",
          entitlements: [],
          authorizing_integration_owners: { 0: "10" },
          context: 0,
          attachment_size_limit: 10_485_760,
          data: { id: "960", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "why?" }] },
        },
      ],
    ]);
    await until(() => fake.requested("POST", "/interactions/950/tok/callback").length === 1);
    const callback = fake.requested("POST", "/interactions/950/tok/callback")[0]!;
    expect(callback.body).toEqual({ type: 5 });
    expect(callback.auth).toBeUndefined();
    expect(await translate(event!.raw)).toMatchObject([
      { kind: "interaction", place: { address: "discord:#20" }, person: { address: "discord:@200" }, text: "/ask question: why?", fromMe: false },
    ]);
  });

  it("answers a click on a form: button with the stored form as its one first answer, and other clicks with later", async () => {
    const form = {
      title: "Deploy",
      custom_id: "deploy",
      components: [{ type: 18, label: "Why?", component: { type: 4, custom_id: "why", style: 2 } }],
    };
    const { fake, gateway, translate } = await connect({ forms: { deploy: form, slackish: { type: "modal", title: { type: "plain_text", text: "x" }, blocks: [] } } });
    fake.route("POST", "/interactions/(\\d+)/([\\w-]+)/callback", () => undefined);
    const components = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Fill in", custom_id: "form:deploy:prod" },
          { type: 2, style: 2, label: "Test", custom_id: "deploy:test" },
          { type: 2, style: 2, label: "Ask", custom_id: "form:nope" },
          { type: 2, style: 2, label: "Slack one", custom_id: "form:slackish" },
        ],
      },
    ];
    const asked = message({ id: "700", author: BOT, content: "Where to?", components });
    const clicks = await gateway([
      ["INTERACTION_CREATE", componentClick("951", "form:deploy:prod", asked)],
      ["INTERACTION_CREATE", componentClick("952", "deploy:test", asked)],
      ["INTERACTION_CREATE", componentClick("953", "form:nope", asked)],
      ["INTERACTION_CREATE", componentClick("954", "form:slackish", asked)],
    ]);
    await until(() => fake.requested("POST", "/interactions/\\d+/[\\w-]+/callback").length === 4);
    const answers = Object.fromEntries(fake.requested("POST", "/interactions/\\d+/[\\w-]+/callback").map((request) => [request.path.split("/")[2], request.body]));
    // The form is the first answer, and the only one; its custom_id is the button's, so the submission says which form it is.
    expect(answers).toEqual({ "951": { type: 9, data: { ...form, custom_id: "form:deploy:prod" } }, "952": { type: 6 }, "953": { type: 6 }, "954": { type: 6 } });
    // The form itself is not stored with the click: pots form list has it.
    expect(clicks[0]!.raw.form).toEqual({ name: "deploy", extra: "prod", opened: true });
    expect(await translate(clicks[0]!.raw)).toMatchObject([
      { kind: "form_opened", place: { address: "discord:#20" }, message: "discord:#20/700", person: { address: "discord:@200" }, text: 'opened form deploy for them: clicked button "Fill in" (custom_id form:deploy:prod)' },
    ]);
    expect(await translate(clicks[1]!.raw)).toMatchObject([{ kind: "interaction", message: "discord:#20/700", text: 'clicked button "Test" (custom_id deploy:test)' }]);
    expect(await translate(clicks[2]!.raw)).toMatchObject([
      { kind: "interaction", text: 'clicked button "Ask" (custom_id form:nope), and no form opened: no form nope is stored (pots form list shows the forms)' },
    ]);
    expect(await translate(clicks[3]!.raw)).toMatchObject([
      { kind: "interaction", text: 'clicked button "Slack one" (custom_id form:slackish), and no form opened: the form slackish is a Slack form, and this is Discord' },
    ]);
  });

  it("makes no event of an autocomplete, which comes at every keystroke, and does not answer it", async () => {
    const { fake, gateway, translate } = await connect();
    fake.route("POST", "/interactions/(\\d+)/([\\w-]+)/callback", () => undefined);
    const [typed, sent] = await gateway([
      ["INTERACTION_CREATE", { ...interaction("980", 4), data: { id: "960", name: "deploy", type: 1, options: [{ name: "repo", type: 3, value: "po", focused: true }] } }],
      ["INTERACTION_CREATE", { ...interaction("981", 2), data: { id: "960", name: "deploy", type: 1, options: [{ name: "repo", type: 3, value: "pots" }] } }],
    ]);
    expect(await translate(typed!.raw)).toEqual([]);
    expect(await translate(sent!.raw)).toMatchObject([{ kind: "interaction", text: "/deploy repo: pots" }]);
    await until(() => fake.requested("POST", "/interactions/981/[\\w-]+/callback").length === 1);
    expect(fake.requested("POST", "/interactions/980/[\\w-]+/callback")).toEqual([]);
  });

  it("acknowledges a form's submission and gives its values, on the message of the button that opened it", async () => {
    const { fake, gateway, translate } = await connect();
    fake.route("POST", "/interactions/(\\d+)/([\\w-]+)/callback", () => undefined);
    const asked = message({ id: "700", author: BOT, content: "Where to?" });
    const [submitted] = await gateway([
      [
        "INTERACTION_CREATE",
        {
          ...interaction("960", 5),
          message: asked,
          data: {
            custom_id: "form:deploy:prod",
            components: [
              { type: 18, id: 1, component: { type: 4, id: 2, custom_id: "why", value: "the login fix\nand the logo" } },
              { type: 1, id: 3, components: [{ type: 4, id: 4, custom_id: "ticket", value: "" }] },
              { type: 18, id: 5, component: { type: 3, id: 6, custom_id: "env", values: ["prod"] } },
            ],
          },
        },
      ],
    ]);
    await until(() => fake.requested("POST", "/interactions/960/[\\w-]+/callback").length === 1);
    expect(fake.requested("POST", "/interactions/960/[\\w-]+/callback")[0]!.body).toEqual({ type: 6 });
    expect(await translate(submitted!.raw)).toEqual([
      expect.objectContaining({
        kind: "form",
        place: expect.objectContaining({ address: "discord:#20" }),
        message: "discord:#20/700",
        person: { address: "discord:@200", name: "Alice" },
        fromMe: false,
        text: ["submitted form deploy (custom_id form:deploy:prod, extra: prod)", "why: the login fix", "  and the logo", "ticket: (empty)", "env: value prod"].join("\n"),
      }),
    ]);
  });

  it("tells the bot at once, with Discord's answer and no token, when Discord refuses a form, and answers the click with later", async () => {
    const form = { title: "Deploy", components: [{ type: 18, label: "Why?", component: { type: 4, style: 2 } }] };
    const { fake, events, gateway, translate, logs } = await connect({ forms: { deploy: form } });
    const refusal = {
      code: 50035,
      message: "Invalid Form Body",
      errors: { data: { components: { 0: { component: { custom_id: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] } } } } } },
    };
    fake.route("POST", "/interactions/(\\d+)/([\\w-]+)/callback", (request) => (request.body.type === 9 ? new Reply(400, refusal) : undefined));
    await gateway([["INTERACTION_CREATE", componentClick("970", "form:deploy", message({ id: "700", author: BOT, components: [] }))]]);
    await until(() => events.length === 2 && fake.requested("POST", "/interactions/970/[\\w-]+/callback").length === 2);
    expect(fake.requested("POST", "/interactions/970/[\\w-]+/callback").map((request) => request.body.type)).toEqual([9, 6]);
    expect(events[1]!.id).toBe("form-failed:970");
    const [failed] = await translate(events[1]!.raw);
    expect(failed).toMatchObject({ kind: "form", message: "discord:#20/700", person: { address: "discord:@200" } });
    expect(failed!.text).toBe(
      "the form deploy did not open after they clicked button (custom_id form:deploy). Discord said: Discord answered 400, code 50035: Invalid Form Body\n" +
        "data.components[0].component.custom_id[BASE_TYPE_REQUIRED]: This field is required",
    );
    expect(failed!.text).not.toContain(INTERACTION_TOKEN);
    expect(JSON.stringify(logs)).not.toContain(INTERACTION_TOKEN);
  });

  it("gives Discord's code and the fields it refused when it refuses a call, and never the token or the URL", async () => {
    const { fake, channel } = await connect();
    fake.route("POST", "/channels/20/messages", () =>
      new Reply(400, {
        code: 50035,
        message: "Invalid Form Body",
        errors: { components: { 0: { components: { 0: { custom_id: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] } } } } } },
      }),
    );
    const refused = await channel
      .call("POST /channels/20/messages", { content: "Where to?", components: [{ type: 1, components: [{ type: 2, style: 1, label: "Test" }] }] })
      .then(() => undefined, (error: Error) => error.message);
    expect(refused).toBe("Discord answered 400, code 50035: Invalid Form Body\ncomponents[0].components[0].custom_id[BASE_TYPE_REQUIRED]: This field is required");
    const sent = await channel.send("discord:#20", "hello", "tool:1").then(() => undefined, (error: Error) => error.message);
    expect(sent).toContain("code 50035");
    fake.route("POST", `/webhooks/100/${INTERACTION_TOKEN}`, () => new Reply(404, { code: 10015, message: "Unknown Webhook" }));
    const hook = await channel.call(`POST /webhooks/100/${INTERACTION_TOKEN}`, { content: "late" }).then(() => undefined, (error: Error) => error.message);
    expect(hook).toBe("Discord answered 404, code 10015: Unknown Webhook");
    for (const text of [refused, sent, hook]) {
      expect(text).not.toContain("test-token");
      expect(text).not.toContain(INTERACTION_TOKEN);
    }
  });

  it("parses only its own addresses", async () => {
    const { channel } = await connect();
    expect(channel.owns("discord:#20")).toBe(true);
    expect(channel.owns("slack:#C1")).toBe(false);
    expect(channel.placeOf("discord:#20")).toBe("discord:#20");
    expect(channel.placeOf("discord:#20/501")).toBe("discord:#20");
    expect(channel.placeOf("discord:#20/600/601")).toBe("discord:#20");
    expect(channel.placeOf("discord:@200")).toBeUndefined();
    expect(() => channel.placeOf("discord:#general")).toThrow("bad discord address");
    expect(() => channel.placeOf("slack:#C1")).toThrow("not a discord address");
  });

  it("refuses a text over 2000 characters after Markdown, and send never cuts one", async () => {
    const { fake, channel } = await connect();
    expect(channel.checkText("discord:#20", "x".repeat(2000))).toBeUndefined();
    // Emoji count once each, as Discord counts them.
    expect(channel.checkText("discord:#20", "😀".repeat(2000))).toBeUndefined();
    // A person address becomes the shorter <@200> before the count.
    expect(channel.checkText("discord:#20", `${"x".repeat(1990)}<discord:@200>`)).toBeUndefined();
    const refusal = "Discord allows at most 2000 characters in one message; this one has 2001. Send it in parts.";
    expect(channel.checkText("discord:#20", "x".repeat(2001))).toBe(refusal);
    await expect(channel.send("discord:#20", "x".repeat(2001), "s1")).rejects.toThrow(refusal);
    expect(fake.requested("POST", "/channels/\\d+/messages")).toEqual([]);
  });

  it("sends with a nonce from the send ID, and replies as Discord replies", async () => {
    const { fake, channel, gateway, translate } = await connect();
    await gateway([["THREAD_CREATE", { ...thread("600", "20", "Release plan"), newly_created: true }], ["THREAD_CREATE", thread("800", "21", "New idea")]], 2);
    fake.route("POST", "/users/@me/channels", () => ({ id: "700", type: 1, last_message_id: null, recipients: [ALICE] }));
    const body = () => fake.requested("POST", "/channels/\\d+/messages").at(-1)!;

    // A place: a post in it.
    const sent = await channel.send("discord:#20", "hi **there** <discord:@200> in <discord:#20>, @here", "tool:abc");
    expect(body().path).toBe("/channels/20/messages");
    expect(body().body).toEqual({ content: "hi **there** <@200> in <#20>, @here", nonce: expect.any(String), enforce_nonce: true });
    const nonce = body().body.nonce as string;
    expect(nonce.length).toBeLessThanOrEqual(25);
    expect(sent).toMatchObject({ message: "discord:#20/901", place: "discord:#20" });
    expect(await translate(sent.raw)).toMatchObject([{ kind: "message", message: "discord:#20/901", fromMe: true, sendId: "tool:abc" }]);
    // The same send ID again: the same nonce, so Discord gives back the first message.
    await channel.send("discord:#20", "hi", "tool:abc");
    expect(body().body.nonce).toBe(nonce);

    // A message with no thread: a reply in its channel.
    await channel.send("discord:#20/501", "answer", "s2");
    expect(fake.requested("GET", "/channels/501")).toHaveLength(1);
    expect(body()).toMatchObject({ path: "/channels/20/messages", body: { message_reference: { message_id: "501" } } });

    // A message in a thread: a reply in the thread.
    const inThread = await channel.send("discord:#20/600/601", "in thread", "s3");
    expect(body()).toMatchObject({ path: "/channels/600/messages", body: { message_reference: { message_id: "601" } } });
    expect(inThread).toMatchObject({ message: "discord:#20/600/904", place: "discord:#20" });

    // The thread (its first message, which is in the channel): a post in the thread, never a new thread.
    await channel.send("discord:#20/600", "to the thread", "s4");
    expect(body().path).toBe("/channels/600/messages");
    expect(body().body.message_reference).toBeUndefined();
    expect(fake.requested("POST", "/channels/\\d+/messages/\\d+/threads")).toEqual([]);

    // A forum post's first message is in the post: a reply there.
    await channel.send("discord:#21/800", "nice idea", "s5");
    expect(body()).toMatchObject({ path: "/channels/800/messages", body: { message_reference: { message_id: "800" } } });

    // A person: a DM, opened once.
    const dm = await channel.send("discord:@200", "psst", "s6");
    await channel.send("discord:@200", "again", "s7");
    expect(fake.requested("POST", "/users/@me/channels").map((request) => request.body)).toEqual([{ recipient_id: "200" }]);
    expect(body().path).toBe("/channels/700/messages");
    expect(dm).toMatchObject({ place: "discord:#700", message: "discord:#700/907" });
    expect(await channel.findSent("discord:#20", "tool:abc", 0)).toBeUndefined();
  });

  it("reacts with Unicode, custom and named emoji, in the message's own channel", async () => {
    const { fake, channel, gateway } = await connect();
    await gateway([["THREAD_CREATE", thread("600", "20", "Release plan")], ["THREAD_CREATE", thread("800", "21", "New idea")]], 2);
    fake.route("PUT", "/channels/\\d+/messages/\\d+/reactions/[^/]+/@me", () => undefined);
    fake.route("DELETE", "/channels/\\d+/messages/\\d+/reactions/[^/]+/@me", () => undefined);
    await channel.react("discord:#20/501", "👍", false);
    await channel.react("discord:#20/501", ":thumbsup:", false);
    await channel.react("discord:#20/501", "eyes", false);
    await channel.react("discord:#20/501", "blob:900", false);
    await channel.react("discord:#20/600/601", "<a:dance:901>", false);
    await channel.react("discord:#21/800", "✅", true);
    expect(fake.requests.filter((request) => request.path.includes("/reactions/")).map((request) => `${request.method} ${request.path}`)).toEqual([
      "PUT /channels/20/messages/501/reactions/%F0%9F%91%8D/@me",
      "PUT /channels/20/messages/501/reactions/%F0%9F%91%8D/@me",
      "PUT /channels/20/messages/501/reactions/%F0%9F%91%80/@me",
      "PUT /channels/20/messages/501/reactions/blob%3A900/@me",
      "PUT /channels/600/messages/601/reactions/dance%3A901/@me",
      "DELETE /channels/800/messages/800/reactions/%E2%9C%85/@me",
    ]);
    await expect(channel.react("discord:#20/501", ":no_such_emoji:", false)).rejects.toThrow("unknown emoji :no_such_emoji:");
    await expect(channel.react("discord:#20/501", "no_such_emoji", false)).rejects.toThrow("unknown emoji no_such_emoji");
    await expect(channel.react("discord:#20", "👍", false)).rejects.toThrow("not a message address");
  });

  it("calls any REST endpoint with the bot token, and uploads a file given as a path", async () => {
    const { fake, channel } = await connect();
    fake.route("POST", "/channels/20/threads", (request) => ({ id: "650", type: 11, name: request.body.name, parent_id: "20" }));
    fake.route("GET", "/channels/20/pins", () => []);
    fake.route("DELETE", "/channels/20/messages/501", () => undefined);
    expect(await channel.call("POST /channels/20/threads", { name: "Notes", type: 11 })).toMatchObject({ id: "650", name: "Notes" });
    expect(fake.requested("POST", "/channels/20/threads")[0]).toMatchObject({ body: { name: "Notes", type: 11 }, auth: "Bot test-token" });
    expect(await channel.call("GET /channels/20/pins", { limit: 5 })).toEqual([]);
    expect(fake.requested("GET", "/channels/20/pins")[0]!.query.get("limit")).toBe("5");
    expect(await channel.call("DELETE /channels/20/messages/501", {})).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "pots-discord-file-"));
    writeFileSync(join(dir, "notes.txt"), "file content");
    await channel.call("POST /channels/20/messages", { content: "the notes", file: join(dir, "notes.txt") });
    rmSync(dir, { recursive: true, force: true });
    const upload = fake.requested("POST", "/channels/20/messages")[0]!;
    expect(upload.type).toMatch(/^multipart\/form-data/);
    expect(upload.body).toContain('filename="notes.txt"');
    expect(upload.body).toContain("file content");
    expect(upload.body).toContain('{"content":"the notes"}');

    await expect(channel.call("channels.list", {})).rejects.toThrow('call takes "<GET|POST|PUT|PATCH|DELETE> /<path>"');
  });

  it("downloads files only from Discord's file hosts", async () => {
    const { channel } = await connect();
    const signal = new AbortController().signal;
    await expect(channel.fetchFile({ url: "https://example.com/a.png" }, signal)).rejects.toThrow("not a Discord file URL");
    await expect(channel.fetchFile({ url: "http://cdn.discordapp.com/a.png" }, signal)).rejects.toThrow("not a Discord file URL");
  });

  it("backfills nothing on the first start", async () => {
    const { fake, channel, sink } = await connect();
    await channel.backfill(sink);
    expect(fake.requested("GET", "/users/@me/guilds")).toEqual([]);
  });

  it("backfills each place after its newest logged message, oldest first, and goes on past a place that fails", async () => {
    const lastAlive = Date.parse("2026-11-05T00:00:00Z");
    const since = String((BigInt(lastAlive) - 1420070400000n) << 22n);
    const { fake, channel, sink, events, logs, translate } = await connect({
      lastAlive,
      newest: { "discord:#20": "discord:#20/600/2000", "discord:#24": "discord:#24/1999" },
      places: ["discord:#20", "discord:#24", "discord:#700", "discord:#999"],
    });
    const at = (id: number) => message({ id: String(id), channel_type: undefined, guild_id: undefined, member: undefined });
    fake.route("GET", "/users/@me/guilds", () => [{ id: "10", name: "Lab" }]);
    fake.route("GET", "/guilds/10/channels", () => [
      { ...textChannel("20", "general", 0, "2101"), guild_id: "10" },
      { ...textChannel("21", "ideas", 15, "2300"), guild_id: "10" },
      { ...textChannel("22", "voice", 2, null), guild_id: "10" },
      { ...textChannel("23", "secret", 0, String(BigInt(since) + 5n)), guild_id: "10" },
      { ...textChannel("24", "quiet", 0, "1999"), guild_id: "10" },
      { ...textChannel("25", "news", 5, String(BigInt(since) + 5n)), guild_id: "10" },
    ]);
    fake.route("GET", "/guilds/10/threads/active", () => ({ threads: [{ ...thread("600", "20", "Release plan"), last_message_id: "2150" }], members: [] }));
    // Discord gives the newest first; 101 messages come in two pages.
    fake.route("GET", "/channels/20/messages", (request) => {
      const after = Number(request.query.get("after"));
      const ids = Array.from({ length: 101 }, (_, index) => 2001 + index).filter((id) => id > after).slice(0, 100);
      return ids.reverse().map((id) => at(id));
    });
    fake.route("GET", "/channels/23/messages", () => new Reply(403, { message: "Missing Access", code: 50001 }));
    fake.route("GET", "/channels/25/messages", () => new Reply(400, { message: "Bad", code: 0 }));
    fake.route("GET", "/channels/600/messages", () => [{ ...at(2150), channel_id: "600" }]);
    // Archived threads: one archived after the place's start, one before (Discord lists the last archived first).
    const archived = (id: string, when: string, last: string) => ({ ...thread(id, "20", `old ${id}`), last_message_id: last, thread_metadata: { archived: true, archive_timestamp: when } });
    fake.route("GET", "/channels/\\d+/threads/archived/public", () => ({ threads: [], members: [], has_more: false }));
    fake.route("GET", "/channels/20/threads/archived/public", () => ({
      threads: [archived("610", "2026-11-05T00:30:00.000000+00:00", "2160"), archived("611", "2014-12-01T00:00:00.000000+00:00", "2170")],
      members: [],
      has_more: false,
    }));
    fake.route("GET", "/channels/23/threads/archived/public", () => new Reply(403, { message: "Missing Access", code: 50001 }));
    fake.route("GET", "/channels/610/messages", () => [{ ...at(2160), channel_id: "610" }]);
    fake.route("GET", "/channels/700", () => ({ id: "700", type: 1, last_message_id: String(BigInt(since) + 1n), recipients: [ALICE] }));
    fake.route("GET", "/channels/700/messages", () => [{ ...at(0), id: String(BigInt(since) + 1n), channel_id: "700" }]);

    await channel.backfill(sink);
    const ids = events.map((event) => event.id);
    expect(ids.slice(0, 101)).toEqual(Array.from({ length: 101 }, (_, index) => `history:${2001 + index}:`));
    expect(ids.slice(101)).toEqual(["history:2150:", "history:2160:", `history:${BigInt(since) + 1n}:`]);
    // A message read from a thread keeps the channel the thread is in.
    expect(events[101]!.raw.parent).toBe("20");
    // A thread archived before the place's start is not read.
    expect(fake.requested("GET", "/channels/611/messages")).toEqual([]);
    expect(fake.requested("GET", "/channels/20/messages").map((request) => request.query.get("after"))).toEqual(["2000", "2100"]);
    // A thread starts where its channel's place starts.
    expect(fake.requested("GET", "/channels/600/messages")[0]!.query.get("after")).toBe("2000");
    // A place with nothing logged starts at the last time the gateway ran.
    expect(fake.requested("GET", "/channels/700/messages")[0]!.query.get("after")).toBe(since);
    // Nothing after the newest logged message, or no messages of its own: not asked.
    for (const quiet of ["21", "22", "24"]) expect(fake.requested("GET", `/channels/${quiet}/messages`)).toEqual([]);
    // A channel the bot may not read is skipped quietly; another failure is logged, and the rest goes on.
    expect(logs.filter((line) => line.startsWith("backfill skipped a place"))).toEqual([expect.stringContaining('"channel":"25"')]);
    expect(logs.at(-1)).toBe('backfill done {"messages":104}');

    expect(await translate(events[101]!.raw)).toMatchObject([
      { kind: "message", place: { address: "discord:#20", name: "Lab #general" }, message: "discord:#20/600/2150", thread: "discord:#20/600" },
    ]);
  });

  /** Server Lab with only #general, which has messages up to an hour from now. */
  function oneChannel(fake: FakeDiscord) {
    fake.route("GET", "/users/@me/guilds", () => [{ id: "10" }]);
    fake.route("GET", "/guilds/10/channels", () => [{ ...textChannel("20", "general", 0, snowflake(Date.now() + 3_600_000)), guild_id: "10" }]);
    fake.route("GET", "/guilds/10/threads/active", () => ({ threads: [], members: [] }));
    fake.route("GET", "/channels/20/threads/archived/public", () => ({ threads: [], members: [], has_more: false }));
    fake.route("GET", "/channels/20/messages", () => []);
  }

  it("starts the backfill where the log was when the channel started, not after live messages", async () => {
    const newest: Record<string, string> = { "discord:#20": "discord:#20/2000" };
    const { fake, channel, sink, gateway } = await connect({ lastAlive: Date.now() - 600_000, newest, places: ["discord:#20"] });
    oneChannel(fake);
    // A live message is stored and logged before the gateway's backfill reads.
    await gateway([["MESSAGE_CREATE", message({ id: snowflake(Date.now()) })]]);
    newest["discord:#20"] = `discord:#20/${snowflake(Date.now())}`;
    await channel.backfill(sink);
    expect(fake.requested("GET", "/channels/20/messages").map((request) => request.query.get("after"))).toEqual(["2000"]);
  });

  it("backfills every place from the old session's last event when a new session starts, also on the first run", { timeout: 20_000 }, async () => {
    // The first run: no last time the gateway ran. What the log has does not matter for a new session.
    const { fake, gateway } = await connect({ newest: { "discord:#20": "discord:#20/5" }, places: ["discord:#20"] });
    oneChannel(fake);
    const before = Date.now();
    await gateway([["MESSAGE_CREATE", message({ id: "501" })]]);
    const after = Date.now();
    fake.invalidSession();
    await until(() => fake.requested("GET", "/channels/20/messages").length === 1, 15_000);
    expect(fake.identifies).toBe(2);
    const start = timeOf(fake.requested("GET", "/channels/20/messages")[0]!.query.get("after")!);
    expect(start).toBeGreaterThanOrEqual(before - 60_000);
    expect(start).toBeLessThanOrEqual(after - 60_000);
  });
});
