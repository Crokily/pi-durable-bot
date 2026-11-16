import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * Socket Mode's sockets: each is ready at once, or when the test lets it (hold); send gives an envelope to the first
 * one, as Teams would.
 */
function fakeSockets() {
  const sockets: { handlers: SocketHandlers; stopped: boolean }[] = [];
  const holds = new Map<number, Promise<void>>();
  let envelope = 0;
  return {
    sockets,
    /** The socket made as the index-th (from 0) is ready only once the returned function runs. */
    hold: (index: number) => {
      let release!: () => void;
      holds.set(index, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    make: (handlers: SocketHandlers) => {
      const socket = { handlers, stopped: false };
      const held = holds.get(sockets.length);
      sockets.push(socket);
      return {
        start: async () => {
          await held;
          handlers.onReady({ connectionId: `c${sockets.length}` });
        },
        stop: async () => {
          socket.stopped = true;
        },
      };
    },
    send: (payload: unknown, invoke = false) =>
      sockets[0]!.handlers.onActivity({ protocolVersion: 1, envelopeId: `e${++envelope}`, type: invoke ? "invoke" : "message", ackRequired: !invoke, payload }) as Promise<{ status: number; body?: any }>,
  };
}

/** A POST with a Host header of the test's choosing, which fetch does not send: as a proxy or a tunnel sends it. Its status. */
function postWithHost(url: string, host: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: "POST", headers: { host, "content-type": "application/json" } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on("error", reject);
    sent.end(JSON.stringify(body));
  });
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
async function connect(
  options: Parameters<typeof memorySink>[0] & { mode?: "socket" | "http"; playground?: boolean; state?: unknown; endpoints?: Partial<TeamsEndpoints>; before?: (sockets: ReturnType<typeof fakeSockets>) => void } = {},
) {
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
  options.before?.(sockets);
  const web = fakeHttp();
  const endpoints: TeamsEndpoints = { serviceUrl: fake.serviceUrl, graph: fake.graph, token: fakeToken, socket: sockets.make, ...options.endpoints };
  const mode = options.mode ?? "socket";
  const channel = new TeamsChannel(
    "teams",
    { ...(options.playground ? { port: 0 } : { secrets: join(dir, "teams.env") }), mode, playground: options.playground ?? false },
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

  it("in playground mode takes requests without a signature only on a server of its own at 127.0.0.1, never on the page server", async () => {
    const { web, events, channel, fake, dir } = await connect({ mode: "http", playground: true });
    expect(web.served()).toBe(false);
    const url = channel.playgroundUrl!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/messages$/);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post(activity({ serviceUrl: fake.serviceUrl }))).status).toBe(200);
    expect(events).toHaveLength(1);
    // Through a proxy or a tunnel, by a name of its own, from a browser page, or not JSON: refused.
    expect((await post(activity({ id: "1731800000002" }), { "x-forwarded-for": "203.0.113.5" })).status).toBe(403);
    expect(await postWithHost(url, "pots.example.ts.net", activity({ id: "1731800000003" }))).toBe(403);
    expect((await post(activity({ id: "1731800000004" }), { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(activity({ id: "1731800000005" })) })).status).toBe(415);
    expect(events).toHaveLength(1);
    // The bot learns its own ID from the first activity.
    expect(channel.me?.address).toBe(`teams:@${BOT.id}`);
    // Its answer goes to the service URL the request named, with no token: playground mode has none.
    fake.route("POST", "/teams/v3/conversations/([^/]+)/activities", () => ({ id: "1731800000900" }));
    await channel.send(`teams:#${CHAT}`, "hi", "s1");
    expect(fake.requested("POST", "/teams/v3/conversations/.*/activities")[0]!.auth).toBeUndefined();
    // What it learned is kept apart from a real app's.
    expect(readFileSync(join(dir, "channels", "teams.playground.json"), "utf8")).toContain(CHAT);
    expect(() => statSync(join(dir, "channels", "teams.json"))).toThrow();
  });

  it("playground mode takes no secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pots-teams-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "teams.env"), `CLIENT_ID=${CLIENT_ID}\nCLIENT_SECRET=secret-value\nTENANT_ID=${TENANT}\n`);
    const channel = new TeamsChannel("teams", { secrets: join(dir, "teams.env"), mode: "http", playground: true, port: 0 }, { botDir: dir, botName: "Pots", log: () => {} }, { token: fakeToken });
    cleanup.push(() => channel.stop());
    await expect(channel.start(memorySink().sink)).rejects.toThrow(/playground mode takes no secrets/);
    expect(channel.playgroundUrl).toBeUndefined();
  });

  it("checks bot.json's entry", () => {
    const env = { botDir: tmpdir(), botName: "Pots", log: () => {} };
    expect(() => createChannel({ id: "teams", type: "teams" }, env)).toThrow(/"secrets" must name the env file/);
    expect(() => createChannel({ id: "teams", type: "teams", secrets: "x", mode: "webhook" }, env)).toThrow(/"mode" must be/);
    expect(() => createChannel({ id: "teams", type: "teams", playground: true }, env)).toThrow(/needs "mode": "http"/);
    expect(() => createChannel({ id: "teams", type: "teams", mode: "http", playground: true, secrets: "x" }, env)).toThrow(/takes no "secrets"/);
    expect(() => createChannel({ id: "teams", type: "teams", mode: "http", playground: true, port: "x" }, env)).toThrow(/"port" must be/);
    expect(() => createChannel({ id: "teams", type: "teams", secrets: "x", port: 3978 }, env)).toThrow(/only for "playground"/);
    expect(createChannel({ id: "teams", type: "teams", mode: "http", playground: true, port: 3978 }, env).id).toBe("teams");
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

  it("gives the bot token only to the Bot Connector's address that Teams' events gave, never to another Traffic Manager host", async () => {
    const { channel } = await connect();
    // Anyone with Azure can make a *.trafficmanager.net name that points at a server of their own.
    const real = globalThis.fetch;
    const reached: { url: string; auth: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("trafficmanager.net")) return real(input, init);
      reached.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(new Uint8Array([1]));
    });
    cleanup.push(async () => {
      vi.restoreAllMocks();
    });
    const attempt = channel.fetchFile({ url: "https://contoso-bots.trafficmanager.net/v3/attachments/a1/views/original" }, AbortSignal.timeout(5000));
    await expect(attempt).rejects.toThrow(/not a Teams file URL/);
    expect(reached.filter((each) => each.auth !== null)).toEqual([]);
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
    // Two pages of threads, newest change first, with their replies; the second has nothing newer, so the third is not
    // read. One root gives no replies (Graph did not expand them): they are read on their own.
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", (request) => {
      if (!request.query.has("page")) expect(request.query.get("$expand")).toBe("replies");
      return request.query.get("page") === "2"
        ? { value: [graphMessage(newestChannel - 5, { replies: [] })], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/${CHANNEL}/messages?page=3` }
        : {
            value: [graphMessage(newestChannel + 20, { replies: [] }), graphMessage(newestChannel - 10)],
            "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/${encodeURIComponent(CHANNEL)}/messages?page=2`,
          };
    });
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

  it("reads a new reply under an old root that did not change, and the pages after it", async () => {
    const since = 1731800000000;
    const { channel, fake, events, sink } = await connect({ state, lastAlive: since, places: [`teams:#${CHANNEL}`] });
    // Graph orders threads by their last change, replies included: an old, unchanged root comes first for its new reply.
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", (request) =>
      request.query.get("page") === "2"
        ? { value: [graphMessage(since - 3000, { replies: [graphMessage(since + 10, { replyToId: String(since - 3000) })] })] }
        : { value: [graphMessage(since - 2000, { replies: [graphMessage(since + 20, { replyToId: String(since - 2000) }), graphMessage(since - 1000, { replyToId: String(since - 2000) })] })], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages?page=2` },
    );
    await channel.backfill(sink);
    const happenings = await translated(channel, events);
    expect(happenings.map((h) => [h.kind, h.message, h.thread])).toEqual([
      ["message", `teams:#${CHANNEL}/${since - 3000}/${since + 10}`, `teams:#${CHANNEL}/${since - 3000}`],
      ["message", `teams:#${CHANNEL}/${since - 2000}/${since + 20}`, `teams:#${CHANNEL}/${since - 2000}`],
    ]);
  });

  it("finds a channel's team through Teams when its events did not give it, and from another channel of the team", async () => {
    const other = "19:design@thread.tacv2";
    const { channel, fake, events, sink, sockets, dir, logs } = await connect({
      state: { conversations: { [other]: { type: "channel", team: { id: CHANNEL } }, "19:lone@thread.tacv2": { type: "channel" } }, people: {}, dms: {} },
      lastAlive: 1731800000000,
      places: [`teams:#${other}`, "teams:#19:lone@thread.tacv2"],
    });
    fake.route("GET", `/teams/v3/teams/${CHANNEL}`, () => ({ id: CHANNEL, name: "Lab", aadGroupId: "team-aad-1" }));
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", () => ({ value: [graphMessage(1731800000100, { replies: [] })] }));
    await channel.backfill(sink);
    expect(events.map((event) => event.id)).toEqual([`history:${other}/1731800000100:${at(1731800000100)}`]);
    expect(fake.requested("GET", "/graph/v1.0/teams/team-aad-1/channels/.*")[0]!.path).toContain(encodeURIComponent(other));
    // A channel no event put in a team: asked by its own ID, as Chat SDK does; Teams does not know it, so it is skipped.
    expect(fake.requested("GET", "/teams/v3/teams/19:lone@thread.tacv2")).toHaveLength(1);
    expect(logs.some((line) => line.includes("backfill skipped a place") && line.includes("19:lone"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "channels", "teams.json"), "utf8")).conversations[other].team).toEqual({ id: CHANNEL, aadGroupId: "team-aad-1", name: "Lab" });

    // An event of another channel of the team, with the team's group ID, gives it to every channel of the team.
    const third = "19:third@thread.tacv2";
    await sockets.send(inChannel({ id: "1731800000300", conversation: { id: third, conversationType: "channel", tenantId: TENANT }, channelData: { tenant: { id: TENANT }, team: { id: "19:team-b@thread.tacv2" } } }));
    await sockets.send(inChannel({ id: "1731800000301", conversation: { id: "19:team-b@thread.tacv2", conversationType: "channel", tenantId: TENANT }, channelData: { tenant: { id: TENANT }, team: { id: "19:team-b@thread.tacv2", aadGroupId: "team-aad-b" } } }));
    expect(JSON.parse(readFileSync(join(dir, "channels", "teams.json"), "utf8")).conversations[third].team).toEqual({ id: "19:team-b@thread.tacv2", aadGroupId: "team-aad-b" });
  });

  it("an edit made while Pots was down is an edit, also of a root from before, and a message made then is a message", async () => {
    const since = 1731800000000;
    const { channel, fake, events, sink } = await connect({ state, lastAlive: since, places: [`teams:#${CHANNEL}`, `teams:#${CHAT}`] });
    const edited = { lastModifiedDateTime: at(since + 500), lastEditedDateTime: at(since + 500), body: { contentType: "html", content: "<p>changed</p>" } };
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", () => ({ value: [graphMessage(since - 5000, { ...edited, replies: [] })] }));
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", () => ({ value: [graphMessage(since + 100, { lastModifiedDateTime: at(since + 900), lastEditedDateTime: at(since + 900) }), graphMessage(since - 100, edited)] }));
    await channel.backfill(sink);
    const happenings = await translated(channel, events);
    expect(happenings.map((h) => [h.kind, h.message, h.at, h.text])).toEqual([
      ["message", `teams:#${CHANNEL}/${since - 5000}`, since - 5000, "changed"],
      ["edit", `teams:#${CHANNEL}/${since - 5000}`, since + 500, "changed"],
      ["message", `teams:#${CHAT}/${since - 100}`, since - 100, "changed"],
      ["edit", `teams:#${CHAT}/${since - 100}`, since + 500, "changed"],
      ["message", `teams:#${CHAT}/${since + 100}`, since + 100, `message ${since + 100}`],
      ["edit", `teams:#${CHAT}/${since + 100}`, since + 900, `message ${since + 100}`],
    ]);
  });

  it("reads every page of a long backlog, so the next start does not begin past what was left", async () => {
    const since = 1731800000000;
    const { channel, fake, events, sink } = await connect({ state, lastAlive: since, places: [`teams:#${CHAT}`] });
    const all = Array.from({ length: 1001 }, (_each, index) => graphMessage(since + 1001 - index));
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", (request) => {
      const page = Number(request.query.get("page") ?? 0);
      const next = (page + 1) * 50 < all.length ? { "@odata.nextLink": `${fake.graph}/chats/${encodeURIComponent(CHAT)}/messages?page=${page + 1}` } : {};
      return { value: all.slice(page * 50, page * 50 + 50), ...next };
    });
    await channel.backfill(sink);
    expect(events).toHaveLength(1001);
    expect(events[0]!.raw.message.id).toBe(String(since + 1));
  });

  it("stores nothing of a place whose pages Graph does not give to the end", async () => {
    const since = 1731800000000;
    const { channel, fake, events, sink, logs } = await connect({ state, lastAlive: since, places: [`teams:#${CHAT}`] });
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", (request) =>
      request.query.get("page") === "1" ? new Reply(403, { error: { code: "Forbidden", message: "no" } }) : { value: [graphMessage(since + 10)], "@odata.nextLink": `${fake.graph}/chats/x/messages?page=1` },
    );
    await channel.backfill(sink);
    expect(events).toEqual([]);
    expect(logs.some((line) => line.includes("backfill skipped a place"))).toBe(true);
  });

  it("does nothing on the first start, and skips a channel whose team Teams does not give", async () => {
    const first = await connect({ places: [`teams:#${CHAT}`] });
    await first.channel.backfill(first.sink);
    expect(first.fake.requests).toEqual([]);
    const later = await connect({ lastAlive: 1731700000000, places: ["teams:#19:other@thread.tacv2"] });
    await later.channel.backfill(later.sink);
    expect(later.logs.some((line) => line.includes("backfill skipped a place") && line.includes("Teams answered 404"))).toBe(true);
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

  it("after regions' sockets drop together, each reads from its own drop, also the one that comes back later", async () => {
    let release!: () => void;
    // The first three sockets are the regions'; of the two made again, the second comes back a second later.
    const { fake, sockets } = await connect({ state, places: [`teams:#${CHAT}`], before: (made) => (release = made.hold(4)) });
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", () => ({ value: [] }));
    const dropped = Date.now();
    sockets.sockets[0]!.handlers.onClosed(new Error("connection lost"));
    sockets.sockets[1]!.handlers.onClosed(new Error("connection lost"));
    await until(() => fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages").length === 1);
    await sleep(1000);
    release();
    await until(() => fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages").length === 2);
    const starts = fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages").map((request) => Date.parse(request.query.get("$filter")!.replace("lastModifiedDateTime gt ", "")));
    for (const since of starts) {
      expect(since).toBeGreaterThanOrEqual(dropped - 61_000);
      expect(since).toBeLessThanOrEqual(dropped - 59_500);
    }
  });

  it("stop ends a backfill that waits for Graph, and its tries, at once", async () => {
    const { channel, fake, sink, events } = await connect({ state, lastAlive: 1731800000000, places: [`teams:#${CHAT}`] });
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", () => new Reply(503, { error: { code: "ServiceUnavailable", message: "busy" } }));
    const running = channel.backfill(sink);
    await until(() => fake.requests.length > 0);
    const stopping = Date.now();
    await channel.stop();
    await running;
    expect(Date.now() - stopping).toBeLessThan(2000);
    const tried = fake.requests.length;
    await sleep(1500);
    expect(fake.requests.length).toBe(tried);
    expect(events).toEqual([]);
  });

  it("a token that does not come is bounded by the request's time, as the request is", async () => {
    const { channel, fake } = await connect({ endpoints: { token: () => new Promise<string>(() => {}), timeouts: { request: 200, retry: 500 } } });
    fake.route("POST", "/teams/v3/conversations/.*/activities", () => ({ id: "1731800000200" }));
    const started = Date.now();
    await expect(channel.send(`teams:#${CHAT}`, "hi", "s1")).rejects.toThrow(/Teams did not answer: .*timeout.*gave up/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fake.requests).toEqual([]);
  });

  it("reads every page of a thread's replies, as Graph gives them in no order, and the roots after them", async () => {
    const since = 1731800000000;
    const root = since - 9000;
    const { channel, fake, events, sink } = await connect({ state, lastAlive: since, places: [`teams:#${CHANNEL}`] });
    const reply = (id: number, fields: Record<string, unknown> = {}) => graphMessage(id, { replyToId: String(root), ...fields });
    const unchanged = (from: number) => Array.from({ length: 50 }, (_each, index) => reply(from + index));
    // The expanded replies and the next page of them changed nothing; the page after has an old reply edited while Pots
    // was down. The thread is on the first page of roots for it, so the next page of roots is read too, and its page
    // after, which has nothing changed, ends the reading.
    fake.route("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages", (request) => {
      const page = request.query.get("page");
      if (page === "2") return { value: [graphMessage(since + 50, { replies: [] })], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages?page=3` };
      if (page === "3") return { value: [graphMessage(since - 20_000, { replies: [] })], "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages?page=4` };
      return {
        value: [graphMessage(root, { replies: unchanged(root + 100), "replies@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages/${root}/replies?page=2` })],
        "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages?page=2`,
      };
    });
    fake.route("GET", `/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages/${root}/replies`, (request) =>
      request.query.get("page") === "2"
        ? { value: unchanged(root + 200), "@odata.nextLink": `${fake.graph}/teams/team-aad-1/channels/x/messages/${root}/replies?page=3` }
        : { value: [reply(root + 300, { lastModifiedDateTime: at(since + 30), lastEditedDateTime: at(since + 30), body: { contentType: "html", content: "<p>changed</p>" } })] },
    );
    await channel.backfill(sink);
    expect(fake.requested("GET", `/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages/${root}/replies`).map((request) => request.query.get("page"))).toEqual(["2", "3"]);
    expect(fake.requested("GET", "/graph/v1.0/teams/team-aad-1/channels/[^/]+/messages").map((request) => request.query.get("page"))).toEqual([null, "2", "3"]);
    const happenings = await translated(channel, events);
    expect(happenings.map((h) => [h.kind, h.message, h.at, h.text])).toEqual([
      ["message", `teams:#${CHANNEL}/${root}/${root + 300}`, root + 300, "changed"],
      ["edit", `teams:#${CHANNEL}/${root}/${root + 300}`, since + 30, "changed"],
      ["message", `teams:#${CHANNEL}/${since + 50}`, since + 50, `message ${since + 50}`],
    ]);
  });

  it("keeps where a backfill that failed began, which live messages do not move, and the next start reads from there", async () => {
    const before = 1731800000000;
    const { channel, fake, sink, sockets, events, dir } = await connect({ state, lastAlive: before - 60_000, places: [`teams:#${CHAT}`], newest: { [`teams:#${CHAT}`]: `teams:#${CHAT}/${before}` } });
    const kept = () => JSON.parse(readFileSync(join(dir, "channels", "teams.json"), "utf8")).recovering;
    // While Pots was down, two messages came; Graph gives their first page, then refuses the next.
    let refuse = true;
    fake.route("GET", "/graph/v1.0/chats/[^/]+/messages", (request) =>
      request.query.get("page") === "1"
        ? refuse
          ? new Reply(403, { error: { code: "Forbidden", message: "no" } })
          : { value: [] }
        : { value: [graphMessage(before + 20), graphMessage(before + 10)], "@odata.nextLink": `${fake.graph}/chats/x/messages?page=1` },
    );
    await channel.backfill(sink);
    expect(events).toEqual([]);
    expect(kept()).toEqual({ [CHAT]: before });

    // A live message comes after: the log's newest message is now past the two that were not read.
    await sockets.send(activity({ id: String(before + 100), timestamp: at(before + 100) }));
    expect(events.map((event) => event.id)).toEqual([`message:${CHAT}/${before + 100}`]);
    expect(kept()).toEqual({ [CHAT]: before });
    await channel.stop();

    // The next start, with the live message as the newest logged one: it reads from where the failed backfill began.
    refuse = false;
    const again = new TeamsChannel("teams", { secrets: join(dir, "teams.env"), mode: "socket", playground: false }, { botDir: dir, botName: "Pots", http: fakeHttp().http, log: () => {} }, {
      serviceUrl: fake.serviceUrl,
      graph: fake.graph,
      token: fakeToken,
      socket: fakeSockets().make,
    });
    const later = memorySink({ lastAlive: before + 100, places: [`teams:#${CHAT}`], newest: { [`teams:#${CHAT}`]: `teams:#${CHAT}/${before + 100}` } });
    cleanup.push(() => again.stop());
    await again.start(later.sink);
    await again.backfill(later.sink);
    const filters = fake.requested("GET", "/graph/v1.0/chats/[^/]+/messages").flatMap((request) => request.query.get("$filter") ?? []);
    expect(filters).toEqual([`lastModifiedDateTime gt ${at(before)}`, `lastModifiedDateTime gt ${at(before)}`]);
    expect(later.events.map((event) => event.raw.message.id)).toEqual([String(before + 10), String(before + 20)]);
    // Read whole: the next backfill starts from the log again.
    expect(kept()).toEqual({});
  });

  it("requests that wait for a token wait for one getting, and what it gives after stop goes nowhere", async () => {
    const gettings: { scope: string; resolve: (token: string) => void; reject: (error: Error) => void }[] = [];
    const token = (scope: string | string[]) =>
      new Promise<string>((resolve, reject) => {
        gettings.push({ scope: String(scope), resolve: () => resolve(fakeToken(scope)), reject });
      });
    const { channel, fake } = await connect({ endpoints: { token, timeouts: { request: 30, retry: 400 } } });
    fake.route("POST", "/teams/v3/conversations/.*/activities", () => ({ id: "1731800000200" }));
    fake.route("GET", "/graph/v1.0/me", () => ({}));
    const unobserved: unknown[] = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    cleanup.push(async () => {
      process.off("unhandledRejection", onUnhandled);
    });
    const already = gettings.length;
    // Two sends and a Graph call, each tried again after each try's time runs out.
    const tries = [channel.send(`teams:#${CHAT}`, "one", "s1"), channel.send(`teams:#${CHAT}`, "two", "s2"), channel.call("graph:GET /me", {})];
    const ended = await Promise.allSettled(tries);
    expect(ended.map((each) => each.status === "rejected" && /did not answer: .*gave up/.test(String(each.reason)))).toEqual([true, true, true]);
    const started = gettings.slice(already);
    expect(started.map((each) => each.scope.includes("graph") ? "graph" : "bot").sort()).toEqual(["bot", "graph"]);
    await channel.stop();
    // The SDK takes no signal: the getting ends after stop. A token sends nothing, and an error is taken.
    started[0]!.resolve("late");
    started[1]!.reject(new Error("login refused"));
    await sleep(100);
    expect(fake.requests).toEqual([]);
    expect(gettings.length).toBe(already + 2);
    expect(unobserved).toEqual([]);
  });

  it("a request that is stopped before it begins starts no token getting, and leaves no error untaken", async () => {
    let gettings = 0;
    const { channel, fake } = await connect({
      endpoints: {
        token: (scope) => {
          gettings++;
          return fakeToken(scope);
        },
      },
    });
    const unobserved: unknown[] = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    cleanup.push(async () => {
      process.off("unhandledRejection", onUnhandled);
    });
    const file = { url: `${fake.serviceUrl}/v3/attachments/a1/views/original` };
    const already = gettings;
    await expect(channel.fetchFile(file, AbortSignal.abort(new Error("the reader went away")))).rejects.toThrow(/the reader went away/);
    expect(gettings).toBe(already);
    await channel.stop();
    await expect(channel.fetchFile(file, AbortSignal.timeout(5000))).rejects.toThrow(/stopped/);
    await sleep(100);
    expect(gettings).toBe(already);
    expect(unobserved).toEqual([]);
    expect(fake.requests).toEqual([]);
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
