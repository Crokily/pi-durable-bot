import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { CHANNEL, ME, TestGateway, waitFor } from "./support/gateway.ts";

// The pots command line from outside: what each command prints and does, against a real gateway with one bot. Only
// the output, the exit status, the test platform and the bot's log are checked.

let model: FakeModel;
let gateway: TestGateway;

beforeAll(async () => {
  model = await startFakeModel();
  gateway = new TestGateway({ model, terminal: true });
  await gateway.start();
}, 60_000);

afterAll(async () => {
  await gateway?.dispose();
  await model?.close();
});

/** A command that works: its output. */
const pots = async (...args: string[]) => {
  const result = await gateway.run(args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
};

/** A command that fails: the message it gives. */
const fails = async (...args: string[]) => {
  const result = await gateway.run(args);
  expect(result.status).toBe(1);
  return result.stderr.trim();
};

describe("pots", { timeout: 120_000 }, () => {
  it("says its version", async () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect((await pots("--version")).trim()).toBe(`pots v${version}`);
  });

  it("shows the gateway and its bot", async () => {
    const lines = (await pots("status")).trim().split("\n");
    expect(lines[0]).toBe(`home: ${gateway.home}`);
    expect(lines[1]).toMatch(/^gateway: running \(process \d+\)$/);
    expect(lines[2]).toMatch(/^service: /);
    expect(lines.slice(3)).toEqual(["coworker: Coworker, fake/coworker, idle, channels test, terminal"]);
    expect(await pots("bot", "list")).toBe("coworker\tCoworker\tfake/coworker\tidle\n");
  });

  it("sends a message once per send ID, also from standard input", async () => {
    const sent = JSON.parse(await pots("send", `${CHANNEL}:#general`, "hello from the command line")) as { message: string; place: string };
    expect(sent).toEqual({ message: expect.stringMatching(/^test:#general\/m-/), place: `${CHANNEL}:#general` });
    const record = gateway.sent().find((item) => item.text === "hello from the command line")!;
    expect(record.send_id).toMatch(/^cli:/);
    expect(sent.message).toBe(`${CHANNEL}:#general/${record.id}`);

    const first = JSON.parse(await pots("send", `${CHANNEL}:#general`, "once", "--id", "cli-test-1")) as { message: string };
    const again = JSON.parse(await pots("send", `${CHANNEL}:#general`, "once", "--id", "cli-test-1")) as { message: string; repeated?: boolean };
    expect(again).toEqual({ ...first, place: `${CHANNEL}:#general`, repeated: true });
    expect(gateway.sent().filter((item) => item.send_id === "cli-test-1")).toHaveLength(1);

    const piped = await gateway.run(["send", `${CHANNEL}:#general`, "-"], { input: "line one\nline two\n" });
    expect(piped.status).toBe(0);
    expect(gateway.sent().at(-1)!.text).toBe("line one\nline two\n");
  });

  it("reacts and calls the platform", async () => {
    const id = gateway.say("general", "alice", "something to react to");
    expect(await pots("react", `${CHANNEL}:#general/${id}`, ":eyes:")).toBe("ok\n");
    const records = JSON.parse(await pots("call", CHANNEL, "records")) as { type: string; message?: string; emoji?: string; person: string }[];
    expect(records.find((record) => record.type === "reaction_added" && record.message === id)).toMatchObject({ emoji: "eyes", person: ME });

    const edited = JSON.parse(await pots("call", CHANNEL, "edit", JSON.stringify({ message: `${CHANNEL}:#general/${id}`, text: "changed" }))) as { type: string; text: string };
    expect(edited).toMatchObject({ type: "edit", text: "changed", message: id });
    expect(await fails("call", CHANNEL, "edit", "{not json")).toBe("ERROR\n  params must be JSON");
    expect(await fails("call", CHANNEL, "nope", "{}")).toBe('ERROR\n  nope: "message" must be a message address');
    expect(await fails("call", "slack", "chat.postMessage", "{}")).toBe('ERROR\n  unknown channel "slack"; channels: test, terminal');
  });

  it("sets, lists and cancels timed wakes", async () => {
    const before = Date.now();
    const timer = JSON.parse(await pots("wake", "--in", "30m", "--note", "check the build")) as Record<string, unknown>;
    expect(timer).toMatchObject({ note: "check the build", set_by: "agent" });
    expect(Number(timer.due_at)).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(Number(timer.due_at)).toBeLessThan(Date.now() + 30 * 60_000);

    const at = JSON.parse(await pots("wake", "--at", "2099-01-02 03:04", "--note", "far away")) as Record<string, unknown>;
    expect(at.due_at).toBe(new Date(2099, 0, 2, 3, 4).getTime());

    const list = JSON.parse(await pots("wake", "--list")) as { id: number; note: string; set_by: string }[];
    expect(list.map((item) => [item.id, item.note, item.set_by])).toEqual([
      [timer.id, "check the build", "agent"],
      [at.id, "far away", "agent"],
    ]);
    expect(await pots("wake", "--cancel", String(timer.id))).toBe("cancelled\n");
    expect(await pots("wake", "--cancel", String(at.id))).toBe("cancelled\n");
    // With no wake of its own left, the bot has its fallback check-in again.
    expect((JSON.parse(await pots("wake", "--list")) as { set_by: string }[]).map((item) => item.set_by)).toEqual(["fallback"]);
    expect(await fails("wake", "--cancel", "999999")).toBe("ERROR\n  no pending wake 999999");
    expect(await fails("wake", "--in", "3q")).toBe('ERROR\n  bad duration "3q"; use for example 90s, 30m, 2h or 1d');
    expect(await fails("wake", "--at", "someday")).toBe('ERROR\n  bad time "someday"; use for example "2026-10-28 09:00" (local time) or Unix ms');
  });

  it("shows the context and turns the page", async () => {
    const context = JSON.parse(await pots("context")) as { used: number; window: number; compactAt: number; text: string };
    expect(context.window).toBe(128_000);
    expect(context.compactAt).toBeLessThan(context.window);
    expect(context.text).toMatch(/^Context: about \d+k tokens used, window 128k; pi compacts automatically at about \d+k\.$/);
    expect(JSON.parse(await pots("turn-page", "--note", "a fresh start"))).toEqual({ notesChars: 0 });
  });

  it("talks to the bot in its terminal channel", async () => {
    const answer = await pots("chat", "--message", "are you there?", "--timeout", "60");
    expect(answer).toBe("Coworker: ack: [wake] DM\n");
    await waitFor(() => gateway.query("SELECT 1 FROM gw_events WHERE channel = 'terminal' AND text = 'are you there?'").length === 1, { what: "the message in the log" });
  });

  it("asks for secrets in pots chat, where the bot does not see them", async () => {
    const params = { text: "Your two Slack tokens, please", file: "slack.env", keys: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"] };
    const asked = JSON.parse(await pots("call", "terminal", "ask-secret", JSON.stringify(params))) as { message: string; asked: unknown };
    expect(asked.asked).toEqual({ file: "slack.env", keys: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"] });
    expect(await fails("call", "terminal", "ask-secret", JSON.stringify({ ...params, file: "../bot.json" }))).toBe(
      'ERROR\n  ask-secret: "file" must be a file name in the secrets folder, such as "slack.env"',
    );

    const file = join(gateway.home, "secrets", "slack.env");
    const chat = await gateway.run(["chat"], { input: "xapp-hidden-1\nxoxb-hidden-2\n" });
    expect(chat.stdout).toContain("Coworker: Your two Slack tokens, please");
    expect(chat.stdout).toContain(`wrote SLACK_APP_TOKEN, SLACK_BOT_TOKEN to ${file}`);
    expect(chat.stdout).not.toContain("hidden");
    expect(readFileSync(file, "utf8")).toBe("SLACK_APP_TOKEN=xapp-hidden-1\nSLACK_BOT_TOKEN=xoxb-hidden-2\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    // The bot gets a message that names the keys; the values reach neither the bot's log nor the model.
    await waitFor(() => gateway.query("SELECT 1 FROM gw_events WHERE channel = 'terminal' AND text LIKE '(pots chat: wrote %'").length === 1, { what: "the answer in the log" });
    expect(gateway.query("SELECT 1 FROM gw_events WHERE text LIKE '%hidden%' OR raw LIKE '%hidden%'")).toEqual([]);
    expect(JSON.stringify(model.requests)).not.toContain("hidden");
  });

  it("says what is wrong in one line", async () => {
    expect(await fails("send", "test:#general", "hi", "--bot", "nope")).toBe(`ERROR\n  there is no bot "nope" in ${join(gateway.home, "bots")}`);
    expect(await fails("send", "nope:#x", "hi")).toBe('ERROR\n  no channel for address "nope:#x". Copy addresses from a wake message or the log.');
    expect(await fails("send", "test:#general", "  ")).toBe("ERROR\n  text is empty");
    expect(await fails("turn-page")).toBe("ERROR\n  Missing required flag: --note");
  });
});

describe("pots without a running gateway", { timeout: 120_000 }, () => {
  it("creates bots, lists them and says when one is not running", async () => {
    await gateway.stop();
    const dir = (await pots("bot", "new", "Second Bot", "--model", "fake/coworker", "--about", "helps with releases")).trim();
    expect(dir).toBe(join(gateway.home, "bots", "second-bot"));
    expect(JSON.parse(readFileSync(join(dir, "bot.json"), "utf8"))).toEqual({
      name: "Second Bot",
      model: "fake/coworker",
      thinking: "medium",
      judge: "main",
      channels: [{ id: "terminal", type: "terminal" }],
    });
    expect(readFileSync(join(dir, "responsibilities.md"), "utf8")).toBe("helps with releases\n");
    expect((await pots("bot", "new", "Second Bot", "--model", "fake/coworker")).trim()).toBe(join(gateway.home, "bots", "second-bot-2"));
    expect(await fails("bot", "new", "X", "--id", "Bad ID")).toBe('ERROR\n  bad bot ID "Bad ID": use lowercase letters, digits, "_" and "-"');
    expect(await pots("bot", "list")).toBe(
      ["coworker\tCoworker\tfake/coworker\tnot running", "second-bot\tSecond Bot\tfake/coworker\tnot running", "second-bot-2\tSecond Bot\tfake/coworker\tnot running", ""].join("\n"),
    );
    expect((await pots("status")).trim().split("\n").slice(1)).toEqual(
      expect.arrayContaining(["gateway: not running", "coworker: not running", "second-bot: not running", "second-bot-2: not running"]),
    );
    expect(await fails("send", "test:#general", "hi")).toBe("ERROR\n  say which bot with --bot <id> (bots: coworker, second-bot, second-bot-2)");
    expect(await fails("send", "test:#general", "hi", "--bot", "coworker")).toMatch(/^ERROR\n {2}the bot is not running \(.*\); start it with pots service install or pots start$/);
    expect(await pots("send", "test:#general", "hi", "--bot", "coworker", "--help")).toContain("Send a message.");
  });

  it("init checks that pi can use the model before it makes a bot", async () => {
    const init = async (model: string) => {
      const result = await gateway.run(["init", "--yes", "--name", "Third", "--model", model, "--no-service", "--no-chat"], { env: { PI_CODING_AGENT_DIR: join(gateway.home, "pi") } });
      return { status: result.status, error: result.stderr.trim() };
    };
    expect(await init("nope/x")).toEqual({
      status: 1,
      error: 'ERROR\n  nope/x cannot be used: pi has no login or key for "nope" on this computer. Run pots init without --model to sign in, or set it up with the pi command line.',
    });
    expect(await init("fake/nope")).toEqual({ status: 1, error: 'ERROR\n  fake/nope cannot be used: "fake" has no model "nope". It has: coworker' });
    expect(await init("coworker")).toEqual({ status: 1, error: 'ERROR\n  --model must be "provider/modelId", for example anthropic/claude-opus-5-5' });
    expect(existsSync(join(gateway.home, "bots", "third"))).toBe(false);
    // Listed, but it does not answer: a server that is not there.
    const dead = join(gateway.home, "pi-dead");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "models.json"), JSON.stringify({ providers: { dead: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "x", models: [{ id: "m", contextWindow: 32_768 }] } } }));
    const silent = await gateway.run(["init", "--yes", "--name", "Third", "--model", "dead/m", "--no-service", "--no-chat"], { env: { PI_CODING_AGENT_DIR: dead } });
    expect(silent.status).toBe(1);
    expect(silent.stderr.trim()).toMatch(/^ERROR\n {2}dead\/m cannot be used with this login: .+/);
    expect(existsSync(join(gateway.home, "bots", "third"))).toBe(false);
    expect(await init("fake/coworker")).toEqual({ status: 0, error: "" });
    expect(JSON.parse(readFileSync(join(gateway.home, "bots", "third", "bot.json"), "utf8")).model).toBe("fake/coworker");
  });
});
