import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { BOT, TestGateway, waitFor } from "./support/gateway.ts";
import { FakeTeams } from "./support/teams.ts";

// The Teams channel in a real gateway, in HTTP mode with "playground": true: Teams' requests come to the channel's own
// server on 127.0.0.1 at /api/messages, never to the page server, and the bot's answers go to the service URL the
// requests name. First against a fake of Teams'
// Bot Connector, always; then against Microsoft 365 Agents Playground, which plays Teams on this computer and needs no
// Microsoft account, only with POTS_TEST_PLAYGROUND=1, as it downloads the Playground from npm (npx):
//
//   POTS_TEST_PLAYGROUND=1 npx vitest run test/teams.playground.test.ts
//
// The Playground runs headless here: the test speaks to the API its web page uses and reads its log stream.

/** The Agents Playground version the test runs. */
const PLAYGROUND = "@microsoft/m365agentsplayground@0.2.30";

let model: FakeModel;
let gateway: TestGateway;
/** The playground's port: Agents Playground's own default, 3978, may be taken on this computer. */
let playgroundPort = 0;

beforeAll(async () => {
  model = await startFakeModel();
  gateway = new TestGateway({ model });
  playgroundPort = await freePort();
  const file = join(gateway.botDir, "bot.json");
  const definition = JSON.parse(readFileSync(file, "utf8"));
  definition.channels.push({ id: "teams", type: "teams", mode: "http", playground: true, port: playgroundPort });
  writeFileSync(file, JSON.stringify(definition, null, 2));
  await gateway.start();
}, 60_000);

afterAll(async () => {
  await gateway?.dispose();
  await model?.close();
});

const pagePort = () => (JSON.parse(readFileSync(join(gateway.home, "settings.json"), "utf8")) as { pagePort: number }).pagePort;
const endpoint = () => `http://127.0.0.1:${playgroundPort}/api/messages`;

describe("Teams in HTTP mode, through the gateway", () => {
  it("stores a request, wakes the bot, and posts its answer to the request's service URL", async () => {
    const fake = await FakeTeams.start();
    try {
      fake.route("POST", "/teams/v3/conversations/([^/]+)/activities", () => ({ id: "1731800000900" }));
      const activity = {
        type: "message",
        id: "1731800000001",
        timestamp: new Date().toISOString(),
        serviceUrl: fake.serviceUrl,
        channelId: "msteams",
        from: { id: "29:alice", aadObjectId: "aad-alice", name: "Alice" },
        recipient: { id: "28:playground-bot", name: "Pots" },
        conversation: { id: "a:dm-alice", conversationType: "personal", tenantId: "tenant-1" },
        text: "what does the pricing look like?",
      };
      const answer = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(activity) });
      expect(answer.status).toBe(200);
      // The answer is logged once Teams took it: wait for the log, not for the request.
      const logged = () => gateway.query<{ kind: string; place: string; person: string; text: string }>("SELECT kind, place, person, text FROM gw_events WHERE channel = 'teams' ORDER BY id");
      await waitFor(() => logged().some((row) => row.kind === "message" && row.text.startsWith("ack:")), { timeout: 20_000, what: "the bot's answer in the log" });
      // While the bot worked on the DM, Alice saw it typing, in the same conversation, before its answer.
      const activities = fake.requested("POST", "/teams/v3/conversations/.*/activities");
      const typing = activities.filter((request) => request.body.type === "typing");
      expect(typing.length).toBeGreaterThanOrEqual(1);
      expect(typing[0]!.path).toBe("/teams/v3/conversations/a:dm-alice/activities");
      expect(activities.indexOf(typing[0]!)).toBe(0);
      const messages = activities.filter((request) => request.body.type === "message");
      const [posted] = messages;
      expect(posted!.path).toBe("/teams/v3/conversations/a:dm-alice/activities");
      expect(posted!.body).toMatchObject({ type: "message", textFormat: "markdown" });
      expect(posted!.body.text).toContain("ack:");
      const rows = logged();
      expect(rows[0]).toEqual({ kind: "message", place: "teams:#a:dm-alice", person: "teams:@aad-alice", text: "what does the pricing look like?" });
      expect(rows.filter((row) => row.text.startsWith("ack:"))).toHaveLength(1);
      expect(messages).toHaveLength(1);
      expect(posted!.auth).toBeUndefined();
    } finally {
      await fake.close();
    }
  }, 40_000);

  it("is not on the page server, and refuses a request through a proxy", async () => {
    // The page server is what the public address reaches: playground mode serves nothing there.
    expect((await fetch(`http://127.0.0.1:${pagePort()}/channel/${BOT}/teams`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    const proxied = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: "{}" });
    expect(proxied.status).toBe(403);
  });
});

/** A port no program listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.runIf(process.env.POTS_TEST_PLAYGROUND === "1")("Teams with Microsoft 365 Agents Playground", () => {
  let playground: ChildProcess | undefined;
  let base = "";
  let config: any;
  const logs: any[] = [];
  let socket: WebSocket | undefined;
  /** The Playground's working folder: it writes its log (devTools/) there. Made only when this part runs. */
  let folder = "";

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "pots-playground-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // No browser opens: BROWSER is a command that does nothing, and the test has no DISPLAY.
    playground = spawn("npx", ["-y", PLAYGROUND, "-e", endpoint(), "-c", "msteams", "-p", String(port), "--dt"], {
      env: { ...process.env, BROWSER: "true", DISPLAY: "", WAYLAND_DISPLAY: "" },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: folder,
      detached: process.platform !== "win32",
    });
    let output = "";
    playground.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    playground.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await waitFor(() => /Listening on/.test(output), { timeout: 120_000, what: `Agents Playground to start: ${output}` });
    config = ((await (await fetch(`${base}/_internal/v1/config`)).json()) as { config: unknown }).config;
    socket = new WebSocket(`ws://127.0.0.1:${port}/_ws/log/stream`);
    socket.on("message", (data) => logs.push(JSON.parse(String(data)).log));
    await new Promise((resolve) => socket!.once("open", resolve));
  }, 180_000);

  afterAll(async () => {
    socket?.terminate();
    if (playground?.pid && process.platform !== "win32") {
      try {
        process.kill(-playground.pid, "SIGTERM");
      } catch {
        // gone already
      }
    } else playground?.kill();
    if (playground && playground.exitCode === null) await Promise.race([new Promise((resolve) => playground!.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  /** The messages the bot sent, as the Playground got them. */
  const fromBot = () => logs.filter((log) => log?.from === "User Application" && log.activityName === "message");

  it("a person's message in a DM reaches the bot, and its answer reaches Teams", async () => {
    const before = fromBot().length;
    const sent = await fetch(`${base}/_conversation/v1/conversations/${config.personalChat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { id: config.currentUser.id }, text: "hello from the playground", textFormat: "plain" }),
    });
    expect(sent.status).toBe(200);
    await waitFor(() => fromBot().length > before, { timeout: 30_000, what: "the bot's answer in the Playground" });
    const answer = fromBot().at(-1);
    expect(answer.request.body).toMatchObject({ type: "message", textFormat: "markdown" });
    expect(answer.request.body.text).toContain("ack:");
    expect(answer.response.statusCode).toBe(201);
    const rows = gateway.query<{ kind: string; person: string; text: string }>("SELECT kind, person, text FROM gw_events WHERE channel = 'teams' AND text = 'hello from the playground'");
    expect(rows).toEqual([{ kind: "message", person: `teams:@${config.currentUser.aadObjectId}`, text: "hello from the playground" }]);
  }, 60_000);

  it("a click on a card's Action.Execute button is answered at once and wakes the bot", async () => {
    const card = fromBot().at(-1);
    expect(card).toBeDefined();
    const before = fromBot().length;
    const clicked = await fetch(`${base}/_conversation/v1/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "adaptiveCard/action",
        value: { action: { type: "Action.Execute", verb: "deploy", title: "Production", data: { release: "4.2" } } },
        from: { id: config.currentUser.id },
        conversation: { id: config.personalChat.id },
        replyToId: card.messageId,
      }),
    });
    expect(clicked.status).toBe(200);
    // The Playground passes on the answer's type and value; Teams shows the value to the person.
    expect(await clicked.json()).toMatchObject({ type: "application/vnd.microsoft.activity.message", value: "OK" });
    await waitFor(() => fromBot().length > before, { timeout: 30_000, what: "the bot's answer to the click" });
    const rows = gateway.query<{ kind: string; text: string }>("SELECT kind, text FROM gw_events WHERE channel = 'teams' AND kind = 'interaction'");
    expect(rows).toEqual([{ kind: "interaction", text: 'clicked card button "Production" (verb deploy)\nrelease: 4.2' }]);
  }, 60_000);
});
