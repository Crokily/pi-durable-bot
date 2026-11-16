import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createChannel, TeamsChannel, type TeamsEndpoints } from "../src/channels/teams/index.ts";
import type { SocketHandlers } from "../src/channels/teams/sdk.ts";
import type { ChannelHttp, ChannelRequest, ChannelResponse, ChannelSink, Happening } from "../src/core/channel.ts";
import { FakeTeams, Reply } from "./support/teams.ts";

// The Teams adapter against a fake of Microsoft's services on this computer (Teams' Bot Connector, Microsoft Graph and a
// file host), with Socket Mode's sockets replaced by fakes that the SDK drives as it drives real ones, and HTTP mode
// served by a fake page server. Activities are shaped as Microsoft's docs show them. Nothing here reaches Microsoft.

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const BOT = { id: `28:${CLIENT_ID}`, name: "Pots" };
const ALICE = { id: "29:alice", aadObjectId: "aad-alice", name: "Alice" };
const BOB = { id: "29:bob", aadObjectId: "aad-bob", name: "Bob" };
const TENANT = "tenant-1";
const CHANNEL = "19:general@thread.tacv2";
const CHAT = "19:chat@thread.v2";
const DM = "a:dm-alice";
const TEAM = { id: CHANNEL, aadGroupId: "team-aad-1", name: "Lab" };
const TIME = "2026-11-16T01:00:00.000Z";

/** A token as the SDK takes one: a JWT, unsigned, which the fake never checks. */
function fakeToken(scope: string | string[]): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ aud: String(scope), exp: Math.floor(Date.now() / 1000) + 3600, appid: CLIENT_ID })}.sig`;
}

let serviceUrl = "";

function activity(fields: Record<string, unknown>): Record<string, any> {
  return {
    type: "message",
    id: "1731800000001",
    timestamp: TIME,
    serviceUrl,
    channelId: "msteams",
    from: ALICE,
    recipient: BOT,
    conversation: { id: CHAT, conversationType: "groupChat", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: "hello",
    ...fields,
  };
}

const inChannel = (fields: Record<string, unknown> = {}, root = "1731800000001") =>
  activity({
    conversation: { id: `${CHANNEL};messageid=${root}`, conversationType: "channel", tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, team: TEAM, channel: { id: CHANNEL } },
    ...fields,
  });

const inDm = (fields: Record<string, unknown> = {}) => activity({ conversation: { id: DM, conversationType: "personal", tenantId: TENANT }, ...fields });

/** A sink like the gateway's: it drops a known event ID, and keeps raws as JSON, as the inbox does. */
function memorySink(options: { lastAlive?: number; newest?: Record<string, string>; places?: string[]; fail?: (id: string) => boolean; delay?: Promise<void> } = {}) {
  const events: { id: string; raw: any }[] = [];
  const logs: string[] = [];
  const sink: ChannelSink = {
    receive: async (id, raw) => {
      await options.delay;
      if (options.fail?.(id)) throw new Error("database is locked");
      if (!events.some((event) => event.id === id)) events.push({ id, raw: JSON.parse(JSON.stringify(raw)) });
    },
    newestMessage: async (place) => options.newest?.[place],
    threads: async () => [],
    places: async () => options.places ?? [],
    lastAlive: () => options.lastAlive,
    form: async () => undefined,
    formOpened: async () => {},
    formOpening: async () => undefined,
    log: (text, data) => logs.push(`${text} ${JSON.stringify(data ?? {})}`),
  };
  return { sink, events, logs };
}

/** The fake page server: the handler the channel serves, called as the page server calls it. */
function fakeHttp() {
  let handler: ((request: ChannelRequest) => Promise<ChannelResponse>) | undefined;
  const http: ChannelHttp = {
    serve: (serve) => {
      handler = serve;
      return { path: "/channel/ada/teams", close: () => (handler = undefined) };
    },
    publicUrl: () => "https://pots.example.ts.net",
  };
  const post = (body: unknown, headers: Record<string, string> = {}) => {
    if (!handler) throw new Error("not served");
    return handler({ method: "POST", headers, body: Buffer.from(JSON.stringify(body)) });
  };
  return { http, post, served: () => handler !== undefined };
}

/** Socket Mode's sockets: each is ready at once; send gives an envelope to the first one, as Teams would. */
function fakeSockets() {
  const sockets: { handlers: SocketHandlers; stopped: boolean }[] = [];
  let envelope = 0;
  return {
    sockets,
    make: (handlers: SocketHandlers) => {
      const socket = { handlers, stopped: false };
      sockets.push(socket);
      return {
        start: async () => handlers.onReady({ connectionId: `c${sockets.length}` }),
        stop: async () => {
          socket.stopped = true;
        },
      };
    },
    send: (payload: unknown, invoke = false) =>
      sockets[0]!.handlers.onActivity({ protocolVersion: 1, envelopeId: `e${++envelope}`, type: invoke ? "invoke" : "message", ackRequired: !invoke, payload }) as Promise<{ status: number; body?: any }>,
  };
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

/** A started adapter on the fake, in Socket Mode or HTTP mode, and the sink it stores into. */
async function connect(options: Parameters<typeof memorySink>[0] & { mode?: "socket" | "http"; playground?: boolean; state?: unknown } = {}) {
  const fake = await FakeTeams.start();
  serviceUrl = fake.serviceUrl;
  const dir = mkdtempSync(join(tmpdir(), "pots-teams-"));
  writeFileSync(join(dir, "teams.env"), `CLIENT_ID=${CLIENT_ID}\nCLIENT_SECRET=secret-value\nTENANT_ID=${TENANT}\n`);
  if (options.state) {
    // What an earlier start learned.
    mkdirSync(join(dir, "channels"));
    writeFileSync(join(dir, "channels", "teams.json"), JSON.stringify(options.state));
  }
  const sockets = fakeSockets();
  const web = fakeHttp();
  const endpoints: TeamsEndpoints = { serviceUrl: fake.serviceUrl, graph: fake.graph, token: fakeToken, socket: sockets.make, fileHosts: (host) => host === "127.0.0.1" };
  const mode = options.mode ?? "socket";
  const channel = new TeamsChannel(
    "teams",
    { ...(options.playground ? {} : { secrets: join(dir, "teams.env") }), mode, playground: options.playground ?? false },
    { botDir: dir, botName: "Pots", http: web.http, log: () => {} },
    endpoints,
  );
  const { sink, events, logs } = memorySink(options);
  cleanup.push(async () => {
    await channel.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await channel.start(sink);
  return { fake, channel, sink, events, logs, sockets, web, dir };
}

/** What the adapter makes of the stored events. */
async function translated(channel: TeamsChannel, events: { raw: unknown }[]): Promise<Happening[]> {
  return (await Promise.all(events.map((event) => channel.translate(event.raw)))).flat();
}

describe("Teams: receiving", () => {
  it("acknowledges an activity on the socket only after it is stored, and an error when the store fails", async () => {
    let release!: () => void;
    const delay = new Promise<void>((resolve) => (release = resolve));
    const { sockets, events } = await connect({ delay, fail: (id) => id.includes("1731800000009") });
    expect(sockets.sockets).toHaveLength(3);
    let acked: { status: number } | undefined;
    const ack = sockets.send(activity({})).then((reply) => (acked = reply));
    await sleep(50);
    expect(acked).toBeUndefined();
    expect(events).toEqual([]);
    release();
    await ack;
    expect(acked?.status).toBe(200);
    expect(events.map((event) => event.id)).toEqual([`message:${CHAT}/1731800000001`]);
    // The same activity again is stored once.
    await sockets.send(activity({}));
    expect(events).toHaveLength(1);
    const failed = await sockets.send(activity({ id: "1731800000009" }));
    expect(failed.status).toBe(500);
    expect(events).toHaveLength(1);
  });

  it("answers a click on a card (an invoke) after it is stored, and skips typing", async () => {
    const { sockets, events } = await connect();
    const click = activity({ type: "invoke", name: "adaptiveCard/action", id: "f:click-1", replyToId: "1731800000005", value: { action: { type: "Action.Execute", verb: "deploy", title: "Production", data: { release: "4.2" } } } });
    const reply = await sockets.send(click, true);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ statusCode: 200, type: "application/vnd.microsoft.activity.message", value: "OK" });
    expect(events.map((event) => event.id)).toEqual([`invoke/adaptiveCard/action:${CHAT}/f:click-1`]);
    expect((await sockets.send(activity({ type: "typing", id: "t1" }))).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  // A request with a token would make the SDK fetch Microsoft's signing keys, so only one without is tried here.
  it("takes HTTP requests on the page server only with Microsoft's signature", async () => {
    const { web, events, logs, channel } = await connect({ mode: "http" });
    expect(channel.path).toBe("/channel/ada/teams");
    expect(logs.some((line) => line.includes("https://pots.example.ts.net/channel/ada/teams"))).toBe(true);
    const unsigned = await web.post(activity({}));
    expect(unsigned.status).toBe(401);
    expect(events).toEqual([]);
    await channel.stop();
    expect(web.served()).toBe(false);
  });

  it("in playground mode takes requests without a signature, but not through a proxy", async () => {
    const { web, events, channel } = await connect({ mode: "http", playground: true });
    expect((await web.post(activity({}))).status).toBe(200);
    expect(events).toHaveLength(1);
    expect((await web.post(activity({ id: "1731800000002" }), { "x-forwarded-for": "203.0.113.5" })).status).toBe(403);
    expect(events).toHaveLength(1);
    // The bot learns its own ID from the first activity.
    expect(channel.me?.address).toBe(`teams:@${BOT.id}`);
  });

  it("checks bot.json's entry", () => {
    const env = { botDir: tmpdir(), botName: "Pots", log: () => {} };
    expect(() => createChannel({ id: "teams", type: "teams" }, env)).toThrow(/"secrets" must name the env file/);
    expect(() => createChannel({ id: "teams", type: "teams", secrets: "x", mode: "webhook" }, env)).toThrow(/"mode" must be/);
    expect(() => createChannel({ id: "teams", type: "teams", playground: true }, env)).toThrow(/needs "mode": "http"/);
    expect(createChannel({ id: "teams", type: "teams", mode: "http", playground: true }, env).id).toBe("teams");
  });
});

describe("Teams: what each activity becomes", () => {
  it("a message in a channel, a reply in its thread, a group chat and a DM, with mentions and Markdown", async () => {
    const { sockets, events, channel } = await connect();
    await sockets.send(
      inChannel({
        text: "<at>Pots</at> look at <b>this</b>",
        attachments: [{ contentType: "text/html", content: "<p><at>Pots</at> look at <b>this</b></p><ul><li>one</li><li>two</li></ul>" }],
        entities: [
          { type: "mention", text: "<at>Pots</at>", mentioned: BOT },
          { type: "mention", text: "<at>Bob</at>", mentioned: { id: BOB.id, name: "Bob" } },
        ],
        channelData: { tenant: { id: TENANT }, team: TEAM, channel: { id: CHANNEL } },
      }),
    );
    await sockets.send(inChannel({ id: "1731800000002", text: "a reply", replyToId: "1731800000001" }));
    await sockets.send(activity({ id: "1731800000003", text: "in the chat", conversation: { id: CHAT, conversationType: "groupChat", tenantId: TENANT, name: "Release" } }));
    await sockets.send(inDm({ id: "1731800000004", text: "hi **there**", textFormat: "markdown" }));
    const [post, reply, chat, dm] = await translated(channel, events);
    expect(post).toMatchObject({
      kind: "message",
      at: Date.parse(TIME),
      place: { address: `teams:#${CHANNEL}`, kind: "channel", name: "Lab #General" },
      message: `teams:#${CHANNEL}/1731800000001`,
      person: { address: "teams:@aad-alice", name: "Alice" },
      fromMe: false,
      mentionsMe: true,
      text: "@Pots look at **this**\n\n* one\n* two",
      mentions: ["teams:@29:bob"],
    });
    expect(post!.thread).toBeUndefined();
    expect(reply).toMatchObject({ message: `teams:#${CHANNEL}/1731800000001/1731800000002`, thread: `teams:#${CHANNEL}/1731800000001`, threadRoot: `teams:#${CHANNEL}/1731800000001`, mentionsMe: false });
    expect(chat).toMatchObject({ place: { address: `teams:#${CHAT}`, kind: "group", name: "Release" }, message: `teams:#${CHAT}/1731800000003`, text: "in the chat" });
    expect(dm).toMatchObject({ place: { address: `teams:#${DM}`, kind: "dm", name: "Alice" }, text: "hi **there**" });
  });

  it("edits, deletes, reactions on the bot's messages, joins, leaves, the app added, and changes to a team", async () => {
    const { sockets, events, channel } = await connect();
    await sockets.send(activity({ type: "messageUpdate", text: "hello again", channelData: { eventType: "editMessage", tenant: { id: TENANT } } }));
    await sockets.send(activity({ type: "messageDelete", id: "1731800000001", channelData: { eventType: "softDeleteMessage", tenant: { id: TENANT } } }));
    await sockets.send(activity({ type: "messageReaction", id: "r1", replyToId: "1731800000005", reactionsAdded: [{ type: "like" }, { type: "1f440_eyes" }] }));
    await sockets.send(activity({ type: "messageReaction", id: "r2", replyToId: "1731800000005", reactionsRemoved: [{ type: "heart" }] }));
    await sockets.send(inChannel({ type: "conversationUpdate", id: "u1", membersAdded: [BOT, BOB], channelData: { tenant: { id: TENANT }, team: TEAM, eventType: "teamMemberAdded" } }));
    await sockets.send(inChannel({ type: "conversationUpdate", id: "u2", membersRemoved: [BOB], channelData: { tenant: { id: TENANT }, team: TEAM, eventType: "teamMemberRemoved" } }));
    await sockets.send(inChannel({ type: "conversationUpdate", id: "u3", channelData: { tenant: { id: TENANT }, team: TEAM, channel: { id: "19:new@thread.tacv2", name: "ideas" }, eventType: "channelCreated" } }));
    await sockets.send(inDm({ type: "installationUpdate", id: "i1", action: "add" }));
    const happenings = await translated(channel, events);
    expect(happenings.map((h) => [h.kind, h.message ?? null, h.person?.address ?? null, h.text ?? null])).toEqual([
      ["edit", `teams:#${CHAT}/1731800000001`, "teams:@aad-alice", "hello again"],
      ["delete", `teams:#${CHAT}/1731800000001`, null, null],
      ["reaction_added", `teams:#${CHAT}/1731800000005`, "teams:@aad-alice", "👍"],
      ["reaction_added", `teams:#${CHAT}/1731800000005`, "teams:@aad-alice", "👀"],
      ["reaction_removed", `teams:#${CHAT}/1731800000005`, "teams:@aad-alice", "❤️"],
      ["join", null, `teams:@${BOT.id}`, 'added to "Lab #General"'],
      ["join", null, "teams:@aad-bob", null],
      ["leave", null, "teams:@aad-bob", null],
      ["system", null, "teams:@aad-alice", 'the channel "ideas" was created'],
      ["join", null, `teams:@${BOT.id}`, 'the app was added to "Alice" by Alice'],
    ]);
  });

  it("clicks on cards: Action.Execute and Action.Submit, with the card's values", async () => {
    const { sockets, events, channel } = await connect();
    await sockets.send(inChannel({ type: "invoke", name: "adaptiveCard/action", id: "f:1", replyToId: "1731800000005", value: { action: { type: "Action.Execute", verb: "deploy", title: "Production", data: { release: "4.2", note: "line one\nline two" } } } }, "1731800000005"), true);
    await sockets.send(activity({ id: "1731800000006", text: undefined, replyToId: "1731800000005", value: { choice: "test" } }));
    const [execute, submit] = await translated(channel, events);
    expect(execute).toMatchObject({
      kind: "interaction",
      message: `teams:#${CHANNEL}/1731800000005`,
      person: { address: "teams:@aad-alice" },
      text: 'clicked card button "Production" (verb deploy)\nrelease: 4.2\nnote: line one\n  line two',
    });
    expect(submit).toMatchObject({ kind: "interaction", message: `teams:#${CHAT}/1731800000005`, text: "clicked a card's Action.Submit button\nchoice: test" });
  });

  it("files: a DM's file and a pasted image are saved, a channel's file is a SharePoint link", async () => {
    const { sockets, events, channel, fake } = await connect();
    await sockets.send(
      inDm({
        attachments: [
          { contentType: "application/vnd.microsoft.teams.file.download.info", name: "plan.pdf", content: { downloadUrl: "https://contoso.sharepoint.com/download?tempauth=abc", fileType: "pdf" } },
          { contentType: "image/*", contentUrl: `${fake.origin}/files/image-1` },
        ],
      }),
    );
    await sockets.send(inChannel({ id: "1731800000002", attachments: [{ contentType: "reference", contentUrl: "https://contoso.sharepoint.com/sites/lab/Shared%20Documents/notes.docx", name: "notes.docx" }] }));
    const [dm, post] = await translated(channel, events);
    expect(dm!.files).toEqual([
      { name: "plan.pdf", type: "application/pdf", url: "https://contoso.sharepoint.com/download?tempauth=abc" },
      { url: `${fake.origin}/files/image-1` },
    ]);
    expect(post!.files).toEqual([{ name: "notes.docx", url: "https://contoso.sharepoint.com/sites/lab/Shared%20Documents/notes.docx" }]);

    fake.route("GET", "/files/image-1", () => new Uint8Array([1, 2, 3]));
    const chunks: Uint8Array[] = [];
    for await (const chunk of await channel.fetchFile(dm!.files![1]!, AbortSignal.timeout(5000))) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(fake.requested("GET", "/files/image-1")[0]!.auth).toMatch(/^Bearer /);
    await expect(channel.fetchFile(post!.files![0]!, AbortSignal.timeout(5000))).rejects.toThrow(/SharePoint links; reading them needs Graph file permissions/);
    await expect(channel.fetchFile({ url: "https://example.com/x" }, AbortSignal.timeout(5000))).rejects.toThrow(/not a Teams file URL/);
  });
});

describe("Teams: sending", () => {
  it("posts to a channel, a thread, a chat and a person, as Teams' Markdown with mentions", async () => {
    const { sockets, channel, fake } = await connect();
    // The channel learns the service URL, the team and the people from events.
    await sockets.send(inChannel({}));
    await sockets.send(activity({ id: "1731800000003", from: BOB }));
    let next = 1731800000100;
    fake.route("POST", "/teams/v3/conversations/([^/]+)/activities", () => ({ id: String(next++) }));
    fake.route("POST", "/teams/v3/conversations", () => ({ id: "a:new-dm" }));

    const post = await channel.send(`teams:#${CHANNEL}`, "Hi <teams:@aad-bob>, see **this** and file_name_here", "s1");
    expect(post).toMatchObject({ message: `teams:#${CHANNEL}/1731800000100`, place: `teams:#${CHANNEL}` });
    const [first] = fake.requested("POST", "/teams/v3/conversations/.*/activities");
    expect(first!.path).toBe(`/teams/v3/conversations/${CHANNEL}/activities`);
    expect(first!.auth).toMatch(/^Bearer /);
    expect(first!.body).toEqual({
      type: "message",
      text: "Hi <at>Bob</at>, see **this** and file_name_here",
      textFormat: "markdown",
      entities: [{ type: "mention", text: "<at>Bob</at>", mentioned: { id: BOB.id, name: "Bob" } }],
    });
    const [happening] = await channel.translate(post.raw);
    expect(happening).toMatchObject({ kind: "message", fromMe: true, sendId: "s1", text: "Hi <teams:@aad-bob>, see **this** and file_name_here", person: { address: `teams:@${BOT.id}` } });

    const reply = await channel.send(`teams:#${CHANNEL}/1731800000001`, "in the thread", "s2");
    expect(reply.message).toBe(`teams:#${CHANNEL}/1731800000001/1731800000101`);
    const inThread = await channel.send(`teams:#${CHANNEL}/1731800000001/1731800000002`, "also in the thread", "s3");
    expect(inThread.message).toBe(`teams:#${CHANNEL}/1731800000001/1731800000102`);
    await channel.send(`teams:#${CHAT}/1731800000003`, "in the chat", "s4");
    const dm = await channel.send("teams:@aad-alice", "a DM", "s5");
    expect(dm.place).toBe("teams:#a:new-dm");
    expect(fake.requested("POST", "/teams/v3/conversations").map((request) => request.body)).toEqual([
      { isGroup: false, bot: { id: BOT.id }, members: [{ id: ALICE.id }], tenantId: TENANT, channelData: { tenant: { id: TENANT } } },
    ]);
    // The DM is kept, also for the next start.
    await channel.send("teams:@aad-alice", "again", "s6");
    expect(fake.requested("POST", "/teams/v3/conversations")).toHaveLength(1);
    expect(fake.requested("POST", "/teams/v3/conversations/.*/activities").map((request) => request.path)).toEqual([
      `/teams/v3/conversations/${CHANNEL}/activities`,
      `/teams/v3/conversations/${CHANNEL};messageid=1731800000001/activities`,
      `/teams/v3/conversations/${CHANNEL};messageid=1731800000001/activities`,
      `/teams/v3/conversations/${CHAT}/activities`,
      "/teams/v3/conversations/a:new-dm/activities",
      "/teams/v3/conversations/a:new-dm/activities",
    ]);
  });

  it("refuses a text over the limit, never cuts it, and finds no sent message by its send ID", async () => {
    const { channel, fake } = await connect();
    const long = "x".repeat(28_001);
    expect(channel.checkText(`teams:#${CHAT}`, long)).toMatch(/about 28000 bytes/);
    await expect(channel.send(`teams:#${CHAT}`, long, "s1")).rejects.toThrow(/about 28000 bytes/);
    expect(fake.requests).toEqual([]);
    expect(await channel.findSent(`teams:#${CHAT}`, "s1", 0)).toBeUndefined();
  });

  it("tries a request again when Teams is busy, and says what Teams answered, never the token", async () => {
    const { channel, fake } = await connect();
    let tries = 0;
    fake.route("POST", "/teams/v3/conversations/.*/activities", () => (++tries < 3 ? new Reply(429, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "0" }) : { id: "1731800000200" }));
    expect((await channel.send(`teams:#${CHAT}`, "hi", "s1")).message).toBe(`teams:#${CHAT}/1731800000200`);
    expect(tries).toBe(3);
    fake.route("POST", "/teams/v3/conversations/.*/activities", () => new Reply(403, { error: { code: "BotNotInConversationRoster", message: "The bot is not part of the conversation roster." } }));
    const error = await channel.send(`teams:#${CHAT}`, "hi", "s2").catch((failure: Error) => failure);
    expect(String(error)).toContain("Teams answered 403: BotNotInConversationRoster: The bot is not part of the conversation roster.");
    expect(String(error)).not.toContain("eyJ");
  });

  it("reacts with the reactions Teams takes, and refuses others", async () => {
    const { channel, fake } = await connect();
    fake.route("PUT", "/teams/v3/conversations/.*/reactions/.*", () => undefined);
    fake.route("DELETE", "/teams/v3/conversations/.*/reactions/.*", () => undefined);
    await channel.react(`teams:#${CHAT}/1731800000005`, "👍", false);
    await channel.react(`teams:#${CHANNEL}/1731800000001/1731800000002`, ":eyes:", false);
    await channel.react(`teams:#${CHAT}/1731800000005`, "heart", true);
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `PUT /teams/v3/conversations/${CHAT}/activities/1731800000005/reactions/like`,
      `PUT /teams/v3/conversations/${CHANNEL};messageid=1731800000001/activities/1731800000002/reactions/1f440_eyes`,
      `DELETE /teams/v3/conversations/${CHAT}/activities/1731800000005/reactions/heart`,
    ]);
    await expect(channel.react(`teams:#${CHAT}/1731800000005`, "🦄", false)).rejects.toThrow(/does not take the reaction 🦄/);
  });

  it("call: Teams' API with the bot token, Graph with the app's, and a posted card stored as the bot's own", async () => {
    const { channel, fake, events } = await connect();
    fake.route("POST", "/teams/v3/conversations/([^/]+)/activities", () => ({ id: "1731800000300" }));
    fake.route("PUT", "/teams/v3/conversations/([^/]+)/activities/([^/]+)", () => ({ id: "1731800000300" }));
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels", () => ({ value: [{ id: CHANNEL, displayName: "General" }] }));
    const card = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "Deploy?" }] } }] };
    expect(await channel.call(`POST /v3/conversations/${CHAT}/activities`, card)).toEqual({ id: "1731800000300" });
    await channel.call(`PUT /v3/conversations/${CHAT}/activities/1731800000300`, { ...card, id: "1731800000300" });
    expect(await channel.call("graph:GET /teams/team-aad-1/channels", { $select: "id,displayName" })).toEqual({ value: [{ id: CHANNEL, displayName: "General" }] });
    const graph = fake.requested("GET", "/graph/v1.0/teams/team-aad-1/channels")[0]!;
    expect(graph.query.get("$select")).toBe("id,displayName");
    const audience = (auth: string | undefined) => JSON.parse(Buffer.from(auth!.split(".")[1]!, "base64url").toString()).aud as string;
    expect(audience(graph.auth)).toBe("https://graph.microsoft.com/.default");
    expect(audience(fake.requested("PUT", ".*")[0]!.auth)).not.toBe("https://graph.microsoft.com/.default");
    expect(events.map((event) => event.id)).toEqual([`sent:${CHAT}/1731800000300`]);
    const [own] = await translated(channel, events);
    expect(own).toMatchObject({ kind: "message", fromMe: true, message: `teams:#${CHAT}/1731800000300` });
    await expect(channel.call("GET /conversations", {})).rejects.toThrow(/starts with \/v3\//);
    await expect(channel.call("teams.send", {})).rejects.toThrow(/call takes/);
  });
});

describe("Teams: backfill", () => {
  const state = {
    conversations: {
      [CHANNEL]: { type: "channel", serviceUrl: "", team: TEAM, channelName: "General" },
      [CHAT]: { type: "groupChat" },
      [DM]: { type: "personal" },
    },
    people: {},
    dms: {},
  };
  const at = (ms: number) => new Date(ms).toISOString();
  const graphMessage = (id: number, fields: Record<string, unknown> = {}) => ({
    id: String(id),
    messageType: "message",
    createdDateTime: at(id),
    lastModifiedDateTime: at(id),
    from: { user: { id: "aad-alice", displayName: "Alice" } },
    body: { contentType: "html", content: `<p>message ${id}</p>` },
    attachments: [],
    mentions: [],
    ...fields,
  });

  it("reads each channel and group chat from its newest logged message, oldest first, and no DM", async () => {
    const newestChannel = 1731800000000;
    const newestChat = 1731800001000;
    const { channel, fake, events, sink } = await connect({
      state,
      lastAlive: 1731700000000,
      places: [`teams:#${CHANNEL}`, `teams:#${CHAT}`, `teams:#${DM}`],
      newest: { [`teams:#${CHANNEL}`]: `teams:#${CHANNEL}/${newestChannel}`, [`teams:#${CHAT}`]: `teams:#${CHAT}/${newestChat}` },
    });
    // Two pages of roots, newest first; the second has nothing newer, so the third is not read.
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", (request) =>
      request.query.get("page") === "2"
        ? { value: [graphMessage(newestChannel - 5)], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/${CHANNEL}/messages?page=3` }
        : { value: [graphMessage(newestChannel + 20), graphMessage(newestChannel - 10, { lastModifiedDateTime: at(newestChannel + 30) })], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/${encodeURIComponent(CHANNEL)}/messages?page=2` },
    );
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages/([^/]+)/replies", (_request, match) =>
      match[1] === String(newestChannel - 10) ? { value: [graphMessage(newestChannel + 25, { replyToId: String(newestChannel - 10) })] } : { value: [] },
    );
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", () => ({ value: [graphMessage(newestChat + 50), graphMessage(newestChat + 40, { messageType: "systemEventMessage" })] }));
    await channel.backfill(sink);
    expect(fake.requested("GET", ".*page=3.*")).toEqual([]);
    const chatQuery = fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages")[0]!.query;
    expect(chatQuery.get("$filter")).toBe(`lastModifiedDateTime gt ${at(newestChat)}`);
    expect(fake.requests.some((request) => request.path.includes("a:dm-alice") || request.path.includes(DM))).toBe(false);
    const happenings = await translated(channel, events);
    expect(happenings.map((h) => [h.kind, h.message, h.thread ?? null, h.text])).toEqual([
      ["message", `teams:#${CHANNEL}/${newestChannel + 20}`, null, `message ${newestChannel + 20}`],
      ["message", `teams:#${CHANNEL}/${newestChannel - 10}/${newestChannel + 25}`, `teams:#${CHANNEL}/${newestChannel - 10}`, `message ${newestChannel + 25}`],
      ["message", `teams:#${CHAT}/${newestChat + 50}`, null, `message ${newestChat + 50}`],
    ]);
    expect(happenings[0]).toMatchObject({ person: { address: "teams:@aad-alice", name: "Alice" }, place: { kind: "channel", name: "Lab #General" } });
  });

  it("does nothing on the first start, and skips a channel whose team is not known", async () => {
    const first = await connect({ places: [`teams:#${CHAT}`] });
    await first.channel.backfill(first.sink);
    expect(first.fake.requests).toEqual([]);
    const later = await connect({ lastAlive: 1731700000000, places: ["teams:#19:other@thread.tacv2"] });
    await later.channel.backfill(later.sink);
    expect(later.logs.some((line) => line.includes("the team of this channel is not known yet"))).toBe(true);
  });

  it("reads again after the socket reconnects, from a minute before it dropped", async () => {
    const { fake, sockets, events } = await connect({ state, places: [`teams:#${CHAT}`] });
    const dropped = Date.now();
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", () => ({ value: [graphMessage(dropped + 1000)] }));
    sockets.sockets[0]!.handlers.onClosed(new Error("connection lost"));
    await until(() => sockets.sockets.length > 3);
    await until(() => events.length === 1);
    const filter = fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages")[0]!.query.get("$filter")!;
    const since = Date.parse(filter.replace("lastModifiedDateTime gt ", ""));
    expect(since).toBeGreaterThanOrEqual(dropped - 61_000);
    expect(since).toBeLessThanOrEqual(dropped - 59_000);
  });

  it("keeps what it learned for the next start, readable only by this user", async () => {
    const { sockets, dir } = await connect();
    await sockets.send(inChannel({}));
    const file = join(dir, "channels", "teams.json");
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(kept.conversations[CHANNEL]).toMatchObject({ type: "channel", team: TEAM, channelName: "General", tenant: TENANT });
    expect(kept.people["aad-alice"]).toEqual({ id: ALICE.id, name: "Alice" });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
