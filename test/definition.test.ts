import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { CHANNEL, ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// bot.json while the gateway runs, seen from outside: the gateway checks the bot folders every few seconds, applies a
// changed bot.json, keeps the running definition when the file is wrong and says why in bot.json.error, and starts and
// stops bots whose folders come and go.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const status = async () => (await gateway.run(["status"])).stdout.trim().split("\n").slice(3);

/** The system prompt of the agent's last model request. */
const lastPrompt = () => agentRequests(model).at(-1)!.system;

describe("bot.json while running", { timeout: 90_000 }, () => {
  it("applies a change, keeps the running definition while the file is wrong, and says why", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    await gateway.start();
    const file = join(gateway.botDir, "bot.json");
    const errorFile = join(gateway.botDir, "bot.json.error");
    const definition = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    const renamed = `${JSON.stringify({ ...definition, name: "Renamed" }, null, 2)}\n`;
    writeFileSync(file, renamed);
    await waitFor(() => gateway.output.some((line) => line.message === "definition applied"), { what: "the new definition" });
    expect(await status()).toEqual(["coworker: Renamed, fake/coworker, idle, channels test"]);
    gateway.say("general", "alice", `@${ME} who are you now?`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(lastPrompt()).toContain("You are Renamed.");

    writeFileSync(file, "{ not json");
    await waitFor(() => existsSync(errorFile), { what: "bot.json.error" });
    expect(readFileSync(errorFile, "utf8")).toMatch(new RegExp(`JSON|position|token`));
    expect(await status()).toEqual(["coworker: Renamed, fake/coworker, idle, channels test"]);
    gateway.say("general", "alice", `@${ME} still there?`);
    await waitFor(() => gateway.sent().length === 2, { what: "a reply with the running definition" });

    writeFileSync(file, `${JSON.stringify({ ...definition, name: "Renamed", model: "nope" }, null, 2)}\n`);
    await waitFor(() => readFileSync(errorFile, "utf8").includes('"model" must be "provider/modelId"'), { what: "the new error" });
    expect(readFileSync(errorFile, "utf8")).toBe(`${file}: "model" must be "provider/modelId"\n`);

    writeFileSync(file, renamed);
    await waitFor(() => !existsSync(errorFile), { what: "bot.json.error to go" });
    expect(gateway.output.filter((line) => line.message === "definition applied")).toHaveLength(1);
  });

  it("starts a bot whose folder appears and stops one whose folder goes", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    await gateway.start();
    const second = join(gateway.home, "bots", "second");
    const platform = join(gateway.home, "platform-second");
    mkdirSync(second, { recursive: true });
    writeFileSync(
      join(second, "bot.json"),
      JSON.stringify({ name: "Second", model: "fake/coworker", thinking: "off", judge: "off", channels: [{ id: CHANNEL, type: "test", dir: platform, me: ME }], settings: { debounceMs: 300 } }),
    );
    await waitFor(() => gateway.output.some((line) => line.bot === "second" && line.message === "bot started"), { what: "the second bot" });
    expect(await status()).toEqual(["coworker: Coworker, fake/coworker, idle, channels test", "second: Second, fake/coworker, idle, channels test"]);

    rmSync(second, { recursive: true, force: true });
    await waitFor(() => gateway.output.some((line) => line.bot === "second" && line.message === "bot stopped"), { what: "the second bot to stop" });
    expect(await status()).toEqual(["coworker: Coworker, fake/coworker, idle, channels test"]);
    // The first bot goes on as before.
    gateway.say("general", "alice", `@${ME} are you still here?`);
    await waitFor(() => gateway.sent().length === 1, { what: "the first bot's reply" });
    await pause(500);
  });
});
