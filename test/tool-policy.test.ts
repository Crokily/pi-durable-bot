import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentOptions, openDatabase } from "../src/agent/agent.ts";
import { createCodemode } from "../src/agent/codemode.ts";
import { openModels } from "../src/agent/models.ts";
import { type FakeModel, type FakeReply, type FakeRequest, startFakeModel } from "./support/fake-model.ts";
import { waitFor } from "./support/gateway.ts";

// A host's tool policy (AgentOptions.toolPolicy) runs before every tool call: it can refuse a call before it runs, and
// the agent gets the reason as the result. It covers a codemode script's calls too.

describe("the host's tool policy", { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  let model: FakeModel | undefined;
  let agent: Agent | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await agent?.close();
    await close?.();
    await model?.close();
    agent = close = model = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setUp(first: FakeReply, toolPolicy?: AgentOptions["toolPolicy"]): Promise<{ workspace: string; results: () => string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "pots-policy-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    // A wake makes the one tool call; its result ends the run.
    model = await startFakeModel((request: FakeRequest) => (request.messages.at(-1)?.role === "user" ? first : { text: "done" }));
    const pi = join(dir, "pi");
    mkdirSync(pi);
    const models = { providers: { fake: { baseUrl: model.url, api: "openai-completions", apiKey: "fake", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "coworker", contextWindow: 128_000 }] } } };
    writeFileSync(join(pi, "models.json"), JSON.stringify(models));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = pi;
    const database = await openDatabase(join(dir, "bot.sqlite"));
    close = () => database.close();
    try {
      agent = await Agent.open({
        database,
        models: await openModels(),
        model: "fake/coworker",
        thinking: "off",
        compaction: () => ({}),
        workspace,
        shellEnv: process.env,
        screen: { current: () => ({ key: "none", label: "no screen", env: {} }), bot: dir, name: () => "Test" },
        sections: [{ name: "identity", render: () => "You are a test bot." }],
        children: { max: () => 1, sections: [{ name: "child", render: () => "You are a child." }], place: () => undefined, failed: async () => "0" },
        codemode: createCodemode(),
        actions: { send: async () => ({ message: "test:#general/1" }), react: async () => {}, call: async () => null },
        log: () => {},
        ...(toolPolicy ? { toolPolicy } : {}),
      });
      await agent.resume();
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
    const results = () => model!.requests.flatMap((request) => (request.messages.at(-1)?.role === "tool" ? [request.messages.at(-1)!.content] : []));
    return { workspace, results };
  }

  const refuseMarker: AgentOptions["toolPolicy"] = (call) =>
    call.name === "bash" && String(call.arguments.command).includes("marker") ? { block: "refused by the host's policy" } : undefined;

  it("refuses a call before it runs, and the agent gets the reason", async () => {
    const { workspace, results } = await setUp({ call: { name: "bash", arguments: { command: "touch marker" } } }, refuseMarker);
    await agent!.submit({ id: "w1", text: "make the marker", steer: false });
    await waitFor(() => results().length === 1, { what: "the tool result" });
    expect(results()[0]).toContain("refused by the host's policy");
    expect(existsSync(join(workspace, "marker"))).toBe(false);
  });

  it("refuses a codemode script's call too", async () => {
    const script = `try { await tools.bash({ command: "touch marker" }); return "ran"; } catch (error) { return "refused: " + error.message; }`;
    const { workspace, results } = await setUp({ call: { name: "codemode", arguments: { code: script } } }, refuseMarker);
    await agent!.submit({ id: "w1", text: "make the marker", steer: false });
    await waitFor(() => results().length === 1, { what: "the script's result" });
    expect(results()[0]).toContain("refused by the host's policy");
    expect(existsSync(join(workspace, "marker"))).toBe(false);
  });

  it("lets the calls it does not refuse run, and without a policy every call runs", async () => {
    const policy = await setUp({ call: { name: "bash", arguments: { command: "touch allowed" } } }, refuseMarker);
    await agent!.submit({ id: "w1", text: "make the file", steer: false });
    await waitFor(() => policy.results().length === 1, { what: "the tool result" });
    expect(existsSync(join(policy.workspace, "allowed"))).toBe(true);
    await agent!.close();
    await close?.();
    await model?.close();
    agent = close = model = undefined;
    const none = await setUp({ call: { name: "bash", arguments: { command: "touch marker" } } });
    await agent!.submit({ id: "w1", text: "make the marker", steer: false });
    await waitFor(() => none.results().length === 1, { what: "the tool result" });
    expect(existsSync(join(none.workspace, "marker"))).toBe(true);
  });
});
