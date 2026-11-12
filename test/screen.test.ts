import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, openDatabase } from "../src/agent/agent.ts";
import { createCodemode } from "../src/agent/codemode.ts";
import { openModels } from "../src/agent/models.ts";
import { ScreenLeases } from "../src/agent/screen.ts";
import { type FakeModel, type FakeRequest, startFakeModel } from "./support/fake-model.ts";
import { waitFor } from "./support/gateway.ts";

// The screen lease: one agent at a time on a screen, across conversations, bots and processes, and a lease never stays
// with a holder that is gone. A lease that does not free, or two agents on one screen, would show nowhere.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pots-screen-"));
  dirs.push(dir);
  return join(dir, "screens.sqlite");
}

const main = { bot: "/bots/a", name: "A", agent: "the main agent", conversation: "root" };
const child = { bot: "/bots/a", name: "A", agent: "child 1", conversation: "c1" };
const other = { bot: "/other-home/bots/a", name: "A", agent: "the main agent", conversation: "root" };

describe("screen leases", () => {
  it("lets one conversation use a screen until it gives it up, and tells the others who has it", () => {
    const leases = new ScreenLeases(leaseFile());
    const first = leases.take("x11:local:99", main);
    expect(first.ok).toBe(true);
    const busy = leases.take("x11:local:99", child);
    expect(busy).toMatchObject({ ok: false, lease: { bot: "/bots/a", agent: "the main agent", running: 1 } });
    expect(leases.take("x11:local:99", other).ok).toBe(false);
    if (first.ok) first.done();
    // Its lease lasts across its calls, and other screens are free.
    expect(leases.take("x11:local:99", main).ok).toBe(true);
    expect(leases.take("x11:local:98", other).ok).toBe(true);
    leases.release("/bots/a", "root");
    expect(leases.take("x11:local:99", child).ok).toBe(true);
    leases.close();
  });

  it("frees a lease when its holder has not used the screen for the idle time", () => {
    const leases = new ScreenLeases(leaseFile(), { idleMs: 60_000 });
    const taken = leases.take("macos", main);
    if (taken.ok) taken.done();
    expect(leases.take("macos", child, Date.now() + 30_000).ok).toBe(false);
    expect(leases.take("macos", child, Date.now() + 61_000).ok).toBe(true);
    leases.close();
  });

  it("frees a lease when the process that holds it is gone, also in the middle of a command", () => {
    const file = leaseFile();
    const module = new URL("../src/agent/screen.ts", import.meta.url).href;
    // Another Pots process takes the screen and dies without giving it up.
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { ScreenLeases } from ${JSON.stringify(module)}; new ScreenLeases(${JSON.stringify(file)}).take("macos", ${JSON.stringify(other)}); process.exit(0);`,
    ]);
    const leases = new ScreenLeases(file);
    expect(leases.take("macos", main).ok).toBe(true);
    leases.close();
  });
});

describe("the screen tool in a codemode script", { timeout: 60_000 }, () => {
  // An agent of its own, with a lease file of its own: a real gateway would share the machine's lease file, and on macOS
  // and Windows its one screen, with any Pots that runs on this computer.
  const SCREEN = "test-screen";
  /** The script calls the screen tool. Its command says it started (the file appears only with its text in it), then runs
   * until the test removes the hold file. */
  const SCRIPT = `try {
  const result = await tools.screen({ command: 'echo "$POTS_TEST_SCREEN" > starting && mv starting started; while [ -e hold ]; do sleep 0.1; done; echo on the screen' });
  return "ran: " + result.output;
} catch (error) {
  return "refused: " + error.message;
}`;
  let model: FakeModel | undefined;
  let agent: Agent | undefined;
  let leases: ScreenLeases | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await agent?.close();
    await close?.();
    leases?.close();
    await model?.close();
    agent = leases = close = model = undefined;
  });

  async function setUp(): Promise<{ workspace: string; bot: string; results: () => string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "pots-screen-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    // A wake runs the script; its result ends the run.
    model = await startFakeModel((request: FakeRequest) => (request.messages.at(-1)?.role === "user" ? { call: { name: "codemode", arguments: { code: SCRIPT } } } : { text: "done" }));
    const pi = join(dir, "pi");
    mkdirSync(pi);
    const models = { providers: { fake: { baseUrl: model.url, api: "openai-completions", apiKey: "fake", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "coworker", contextWindow: 128_000 }] } } };
    writeFileSync(join(pi, "models.json"), JSON.stringify(models));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = pi;
    const database = await openDatabase(join(dir, "bot.sqlite"));
    close = () => database.close();
    leases = new ScreenLeases(join(dir, "screens.sqlite"));
    try {
      agent = await Agent.open({
        database,
        models: await openModels(),
        model: "fake/coworker",
        thinking: "off",
        compaction: () => ({}),
        workspace,
        shellEnv: process.env,
        screen: { current: () => ({ key: SCREEN, label: "the test screen", env: { POTS_TEST_SCREEN: "yes" } }), bot: dir, name: () => "Test", leases },
        sections: [{ name: "identity", render: () => "You are a test bot." }],
        children: {
          max: () => 1,
          sections: [{ name: "child", render: () => "You are a child." }],
          place: () => undefined,
          ended: async () => "0",
        },
        codemode: createCodemode(() => []),
        actions: { send: async () => ({ message: "test:#general/1" }), react: async () => {}, call: async () => null },
        log: () => {},
      });
      await agent.resume();
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
    const results = () => model!.requests.flatMap((request) => (request.messages.at(-1)?.role === "tool" ? [request.messages.at(-1)!.content] : []));
    return { workspace, bot: dir, results };
  }

  it("takes the lease for the script's conversation, and frees it when the run ends", async () => {
    const { workspace, bot, results } = await setUp();
    writeFileSync(join(workspace, "hold"), "");
    await agent!.submit({ id: "w1", text: "use the screen", steer: false });
    await waitFor(() => existsSync(join(workspace, "started")), { what: "the screen command" });
    // The command has the screen's environment, and the main agent holds the screen while it runs.
    expect(readFileSync(join(workspace, "started"), "utf8").trim()).toBe("yes");
    expect(leases!.holder(SCREEN)).toMatchObject({ bot, agent: "the main agent", running: 1 });
    rmSync(join(workspace, "hold"));
    await waitFor(() => results().length === 1, { what: "the script's result" });
    expect(results()[0]).toContain("ran: on the screen");
    await waitFor(() => leases!.holder(SCREEN) === undefined, { what: "the lease to free" });
  });

  it("does not run the command while another agent holds the screen", async () => {
    const { workspace, results } = await setUp();
    const other = leases!.take(SCREEN, { bot: "/other-home/bots/b", name: "B", agent: "the main agent", conversation: "root" });
    expect(other.ok).toBe(true);
    await agent!.submit({ id: "w1", text: "use the screen", steer: false });
    await waitFor(() => results().length === 1, { what: "the script's result" });
    expect(results()[0]).toMatch(/refused: .*the test screen is in use by the main agent of B/);
    expect(existsSync(join(workspace, "started"))).toBe(false);
    expect(leases!.holder(SCREEN)).toMatchObject({ bot: "/other-home/bots/b" });
  });
});
