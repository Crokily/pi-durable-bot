import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, configure, createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, startFakeModel } from "./support/fake-model.ts";
import { ME, TestGateway, waitFor } from "./support/gateway.ts";

// Code mode and MCP servers from outside: a real gateway with a fake model, pi's mcp.json in the gateway's own pi folder
// (PI_CODING_AGENT_DIR, never ~/.pi), and a small stdio MCP server (test/support/mcp-server.ts). Tools or a system prompt
// that change from one request to the next would only show as requests the provider's cache does not serve, so they
// are checked here.

const SERVER = fileURLToPath(new URL("./support/mcp-server.ts", import.meta.url));
/** A script that calls the test server's tool. */
const SHOUT = 'const result = await tools.mcp__shouter__shout({ text: "hello" });\nreturn result.content[0].text;';
/** A script that looks the test server up by its namespace, as pi names it. */
const DESCRIBE = 'return JSON.stringify(await describeNamespace("mcp__shouter"));';
/** A grey PNG of `width` x `height` pixels. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  // Each row: filter 0, then one grey byte per pixel.
  const rows = Buffer.alloc((width + 1) * height, 128);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** A script that gives the model an image wider than models take: pi's default limit is 2000 pixels. */
const WIDE_IMAGE = `image("data:image/png;base64,${png(3000, 30).toString("base64")}");\nreturn "here it is";`;
const MAIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "send", "react", "call", "screen", "task", "codemode"];
// A child has the main agent's extensions with its own added last: its screen comes after codemode.
const CHILD_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "codemode", "screen"];

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled|could not/i.test(String(line.message)))).toEqual([]);
});

const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");
const mainRequests = () => agentRequests(model).filter((request) => !isChild(request));
/** The first result of a child's tool call that contains `text`. */
const childResult = (text: string) =>
  agentRequests(model)
    .filter(isChild)
    .flatMap((request) => request.messages.filter((message) => message.role === "tool" && message.content.includes(text)))
    .at(0);
/** Wait until the child c1 ended its last work: called once its work started, so an earlier end does not count. */
const reported = () => waitFor(() => /^c1 "[^"]*": ended/m.test(gateway.pots("children")), { what: "the child's end" });

/**
 * Give the children of the stopped gateway's bot the extensions as pots 0.8.7 stored them: a list of names, with one
 * extension mcp for every server's tools and no fit-images.
 */
async function storeOldChildExtensions(): Promise<number> {
  const db = await openNodeSqliteDatabase(join(gateway.botDir, "bot.sqlite"));
  const harness = await Harness.open(await SqliteStorage.open(db, { prefix: "pi_" }), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const old = ["coding-tools", "child", "codemode", "mcp"].map((name) => defineExtension({ name }));
  let changed = 0;
  try {
    for (const { id } of gateway.query<{ id: number }>("SELECT id FROM pi_conversations WHERE id != 1")) {
      const conversation = (await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT))!;
      await conversation.commit(async (tx) => {
        const stored = (await tx.doc(AgentDoc, id as ConversationId)).extensions;
        // A child's: the change to the main agent's extensions that adds child.
        if (stored === undefined || Array.isArray(stored) || !stored.add?.includes("child")) return;
        await configure(tx, id as ConversationId, { extensions: old });
        changed++;
      }, BACKGROUND_CONTEXT);
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    db.close();
  }
  return changed;
}
/** The text of a section, as the request shows it last. */
const section = (request: FakeRequest, name: string) => request.system.split(`<${name}>\n`).at(-1)!.split(`\n</${name}>`)[0]!;
/** pots mcp against the gateway's pi folder. */
const mcp = (...args: string[]) => gateway.run(["mcp", ...args], { env: { PI_CODING_AGENT_DIR: join(gateway.home, "pi") } });

/**
 * The main agent starts a child for "please research", runs the script SHOUT for "please shout", sends "please <verb>"
 * to a child for "ask <child> to <verb>", and otherwise answers with one send; after a tool result it ends. A child
 * answers its brief at once, and runs SHOUT or WIDE_IMAGE for "please shout" or "please draw" from the main agent.
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (isChild(request)) {
    if (last?.role === "user" && last.content.startsWith("[message from the main agent]\nplease shout")) return { call: { name: "codemode", arguments: { code: SHOUT } } };
    if (last?.role === "user" && last.content.startsWith("[message from the main agent]\nplease draw")) return { call: { name: "codemode", arguments: { code: WIDE_IMAGE } } };
    return { text: "the answer is 42" };
  }
  // On an OpenAI-style API a tool result's images follow it in a user message.
  if (last?.role !== "user" || last.content.startsWith("Attached image")) return { text: "done" };
  const ask = /ask (c\d+) to (\w+)/.exec(last.content);
  if (ask) return { call: { name: "task", arguments: { action: "send", child: ask[1]!, message: `please ${ask[2]!}` } } };
  if (last.content.includes("please research")) return { call: { name: "task", arguments: { action: "start", title: "research", brief: "find the answer" } } };
  if (last.content.includes("please shout")) return { call: { name: "codemode", arguments: { code: SHOUT } } };
  if (last.content.includes("please draw")) return { call: { name: "codemode", arguments: { code: WIDE_IMAGE } } };
  if (last.content.includes("please describe")) return { call: { name: "codemode", arguments: { code: DESCRIBE } } };
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(last.content)![0];
  return { call: { name: "send", arguments: { to: place, text: "ack" } } };
}

async function setUp(options: { laterSystemMessages?: boolean } = {}): Promise<void> {
  model = await startFakeModel(script);
  gateway = new TestGateway({ model, ...options });
  await gateway.start();
}

describe("code mode and MCP servers", { timeout: 90_000 }, () => {
  it("declares codemode to the main agent and to a child from their first request, also without an MCP server", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research`);
    await waitFor(() => model.requests.some(isChild), { what: "the child" });
    const [main] = mainRequests();
    const child = model.requests.find(isChild)!;
    expect(main!.tools).toEqual(MAIN_TOOLS);
    expect(child.tools).toEqual(CHILD_TOOLS);
    // The codemode section lists the tools scripts can call: a child's has no channel action and no task tool.
    expect(section(main!, "codemode")).toMatch(/^Tools scripts can call \(`await tools\.<name>\(args\)`\):/);
    for (const tool of ["send", "react", "call", "task"]) {
      expect(section(main!, "codemode")).toContain(`### \`${tool}\``);
      expect(section(child, "codemode")).not.toContain(`### \`${tool}\``);
    }
    expect(section(child, "codemode")).toContain("### `screen`");
    expect(section(main!, "mcp_servers")).toBe("MCP servers whose tools are not declared to you: none.");
    expect(section(child, "mcp_servers")).toBe("MCP servers whose tools are not declared to you: none.");
  });

  it("calls a server that pots mcp added while the bot runs, and keeps the tools and the start of the prompt of every request", async () => {
    await setUp({ laterSystemMessages: true });
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });

    const added = await mcp("add", "shouter", "--", process.execPath, SERVER);
    expect(added.stderr).toBe("");
    expect(added.stdout).toBe(`Added global MCP server "shouter" in ${join(gateway.home, "pi", "mcp.json")}.\nCheck it with: pots mcp list\n`);
    gateway.say("general", "alice", `@${ME} please shout`);
    const shouted = () => mainRequests().find((request) => request.messages.at(-1)?.role === "tool" && request.messages.at(-1)!.content.includes("HELLO!"));
    await waitFor(() => shouted() !== undefined, { what: "the script's result" });
    // The server runs with the environment of the bot's bash: its POTS_BOT, and no screen.
    expect(shouted()!.messages.at(-1)!.content).toContain("HELLO! (bot coworker, display no)");

    // No restart: the same gateway and bot. Every request of the main agent declares the same tools and starts with the
    // same system message; the servers come later in the conversation, as pi appends a changed section.
    expect(gateway.output.filter((line) => line.message === "bot started")).toHaveLength(1);
    const requests = mainRequests();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const request of requests) {
      expect(request.tools).toEqual(MAIN_TOOLS);
      expect(request.prompt).toBe(requests[0]!.prompt);
    }
    expect(requests[0]!.prompt).toContain("MCP servers whose tools are not declared to you: none.");
    expect(requests.at(-1)!.system).toMatch(/<mcp_servers>\nMCP servers whose tools are not declared to you\. Call the tools of `codemode` servers from codemode scripts\.\n- mcp__shouter \(codemode\)/);
    // The server is a namespace of code mode: the codemode section names it, and a script finds its tools by it.
    // Its description there is pi's summary of it: without a configured description, the first line it sent.
    expect(section(requests.at(-1)!, "codemode")).toContain("## mcp__shouter\nShouts text back in capitals.");
    gateway.say("general", "alice", `@${ME} please describe`);
    const described = () => mainRequests().find((request) => request.messages.at(-1)?.role === "tool" && request.messages.at(-1)!.content.includes("mcp__shouter__shout"));
    await waitFor(() => described() !== undefined, { what: "the namespace" });
  });

  it("fits the images a script gives the model to the model's limits, as pi does", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please draw`);
    const result = () => mainRequests().flatMap((request) => request.messages.filter((message) => message.role === "tool")).at(0);
    const attached = () => mainRequests().flatMap((request) => request.messages.filter((message) => message.content.startsWith("Attached image"))).at(0);
    await waitFor(() => result() !== undefined, { what: "the script's result" });
    expect(result()!.content).toContain("here it is");
    expect(result()!.content).toContain("Resized from 3000x30 to 2000x20.");
    expect(attached()!.images).toBe(1);
  });

  it("gives a child the servers added after it started, and fits its images", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research`);
    await reported();
    expect((await mcp("add", "shouter", "--", process.execPath, SERVER)).status).toBe(0);
    gateway.say("general", "alice", `@${ME} ask c1 to shout`);
    await waitFor(() => childResult("HELLO!") !== undefined, { what: "the child's script result" });
    await reported();
    gateway.say("general", "alice", `@${ME} ask c1 to draw`);
    await waitFor(() => childResult("here it is") !== undefined, { what: "the child's image" });
    expect(childResult("here it is")!.content).toContain("Resized from 3000x30 to 2000x20.");
  });

  it("gives a child that pots 0.8.7 started the servers' tools and the fitting of images after the upgrade", async () => {
    await setUp();
    expect((await mcp("add", "shouter", "--", process.execPath, SERVER)).status).toBe(0);
    gateway.say("general", "alice", `@${ME} please research`);
    await reported();
    await gateway.stop();
    expect(await storeOldChildExtensions()).toBe(1);

    await gateway.start();
    gateway.say("general", "alice", `@${ME} ask c1 to shout`);
    await waitFor(() => childResult("HELLO!") !== undefined, { what: "the child's script result" });
    expect(childResult("HELLO!")!.content).not.toMatch(/not a function|is not defined/);
    await reported();
    gateway.say("general", "alice", `@${ME} ask c1 to draw`);
    await waitFor(() => childResult("here it is") !== undefined, { what: "the child's image" });
    expect(childResult("here it is")!.content).toContain("Resized from 3000x30 to 2000x20.");
  });

  it("names a server to the model by pi's summary of it, never a hidden one, and not after it is removed", async () => {
    model = await startFakeModel(script);
    gateway = new TestGateway({ model, laterSystemMessages: true });
    const long = `Shouts what you say. ${"Loudly. ".repeat(60)}\nSECOND LINE: details for describeNamespace.`;
    mkdirSync(join(gateway.home, "pi"), { recursive: true });
    const servers = {
      shouter: { command: process.execPath, args: [SERVER], description: long },
      quiet: { command: process.execPath, args: [SERVER], description: "QUIET SERVER", exposure: "hidden" },
    };
    writeFileSync(join(gateway.home, "pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
    await gateway.start();

    gateway.say("general", "alice", `@${ME} please describe`);
    const described = () => mainRequests().find((request) => request.messages.at(-1)?.role === "tool");
    await waitFor(() => described() !== undefined, { what: "the namespace" });
    const codemode = section(described()!, "codemode");
    const summary = /## mcp__shouter\n(.*)/.exec(codemode)![1]!;
    expect(summary.startsWith("Shouts what you say. Loudly.")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
    expect([...summary]).toHaveLength(250);
    expect(described()!.system).not.toContain("SECOND LINE");
    for (const text of ["mcp__quiet", "QUIET SERVER"]) expect(described()!.system).not.toContain(text);
    // describeNamespace() gives the whole description.
    expect(described()!.messages.at(-1)!.content).toContain("SECOND LINE: details for describeNamespace.");

    writeFileSync(join(gateway.home, "pi", "mcp.json"), JSON.stringify({ mcpServers: { quiet: servers.quiet } }));
    gateway.say("general", "alice", `@${ME} hello again`);
    const first = () => mainRequests().find((request) => request.messages.some((message) => message.content.includes("hello again")));
    await waitFor(() => first() !== undefined, { what: "the next wake" });
    expect(section(first()!, "codemode")).not.toContain("mcp__shouter");
    expect(section(first()!, "mcp_servers")).not.toContain("mcp__shouter");
  });

  it("adds, lists and removes servers with pots mcp, in pi's mcp.json", async () => {
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    const file = join(gateway.home, "pi", "mcp.json");
    expect((await mcp("--help")).stdout).toMatch(/^Usage:\n {2}pots mcp add <server> \[options\] -- <command> \[args\.\.\.\]\n/);
    expect((await mcp("list")).stdout).toBe(`No MCP servers configured. Add them to ${file} or .pi/mcp.json.\n`);

    expect((await mcp("add", "shouter", "--description", "Shouts", "--", process.execPath, SERVER)).status).toBe(0);
    const listed = await mcp("list");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe(`shouter: connected, 1 tool (codemode, global)\n  ${process.execPath} ${SERVER}\n  tools: shout\n`);
    const login = await mcp("login", "shouter");
    expect(login.status).toBe(1);
    expect(login.stderr).toBe('MCP server "shouter" does not use OAuth. Only HTTP servers without an Authorization header do.\n');

    expect((await mcp("remove", "shouter")).stdout).toBe(`Removed global MCP server "shouter" from ${file}.\n`);
    const again = await mcp("remove", "shouter");
    expect(again.status).toBe(1);
    expect(again.stderr).toBe(`No global MCP server named "shouter" in ${file}.\n`);
    expect((await mcp("list")).stdout).toBe(`No MCP servers configured. Add them to ${file} or .pi/mcp.json.\n`);
  });

  it("names pots login, not pi's commands, for a server that signs in with a pi login", async () => {
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    // A server that wants a sign-in, as one does before the pi login exists.
    const server = createServer((_request, response) => response.writeHead(401).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      mkdirSync(join(gateway.home, "pi"), { recursive: true });
      writeFileSync(join(gateway.home, "pi", "mcp.json"), JSON.stringify({ mcpServers: { radius: { url, auth: { provider: "example" } } } }));

      const listed = await mcp("list");
      expect(listed.stdout).toBe(`radius: needs sign-in (codemode, global)\n  ${url}\n  sign in with: pots login (provider example)\n`);
      const login = await mcp("login", "radius");
      expect(login.status).toBe(1);
      expect(login.stderr).toBe('MCP server "radius" uses the credentials of provider "example". Sign in to it with "pots login" (provider example).\n');
      const logout = await mcp("logout", "radius");
      expect(logout.status).toBe(1);
      expect(logout.stderr).toBe('MCP server "radius" uses the credentials of provider "example". pots mcp logout does not sign out of it.\n');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reads the .pi/mcp.json of a bot's workspace in that folder, as the bot does, and asks pi's trust elsewhere", async () => {
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    const workspace = join(gateway.botDir, "workspace");
    const other = join(gateway.home, "project");
    for (const dir of [workspace, other]) mkdirSync(dir, { recursive: true });
    const inFolder = (cwd: string, ...args: string[]) => gateway.run(["mcp", ...args], { env: { PI_CODING_AGENT_DIR: join(gateway.home, "pi") }, cwd });

    // No note that the file is ignored. pi names it by the folder as the system gives it, a real path on macOS.
    const added = await inFolder(workspace, "add", "--local", "shouter", "--", process.execPath, SERVER);
    expect(added.stdout).toMatch(/^Added project MCP server "shouter" in .+[\\/]workspace[\\/]\.pi[\\/]mcp\.json\.\nCheck it with: pots mcp list\n$/);
    const listed = await inFolder(workspace, "list");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe(`shouter: connected, 1 tool (codemode, project)\n  ${process.execPath} ${SERVER}\n  tools: shout\n`);

    // Another folder is pi's project, which pi reads only once a person trusted it.
    await inFolder(other, "add", "--local", "shouter", "--", process.execPath, SERVER);
    expect((await inFolder(other, "list")).stdout).toMatch(/[\\/]project[\\/]\.pi[\\/]mcp\.json is ignored because the project is not trusted\./);
  });
});
