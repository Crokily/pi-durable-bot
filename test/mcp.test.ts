import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const MAIN_TOOLS = ["read", "write", "edit", "bash", "send", "react", "call", "screen", "task", "codemode"];
const CHILD_TOOLS = ["read", "write", "edit", "bash", "screen", "codemode"];

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled|could not/i.test(String(line.message)))).toEqual([]);
});

const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");
const mainRequests = () => agentRequests(model).filter((request) => !isChild(request));
/** The text of a section, as the request shows it last. */
const section = (request: FakeRequest, name: string) => request.system.split(`<${name}>\n`).at(-1)!.split(`\n</${name}>`)[0]!;
/** pots mcp against the gateway's pi folder. */
const mcp = (...args: string[]) => gateway.run(["mcp", ...args], { env: { PI_CODING_AGENT_DIR: join(gateway.home, "pi") } });

/**
 * The main agent starts a child for "please research", runs the script SHOUT for "please shout", and otherwise answers
 * with one send; after a tool result it ends. A child answers its brief at once.
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (isChild(request)) return { text: "the answer is 42" };
  if (last?.role !== "user" || last.content.startsWith("[wake] your child")) return { text: "done" };
  if (last.content.includes("please research")) return { call: { name: "task", arguments: { action: "start", title: "research", brief: "find the answer" } } };
  if (last.content.includes("please shout")) return { call: { name: "codemode", arguments: { code: SHOUT } } };
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
});
