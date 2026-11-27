import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, coworker, type FakeModel, type FakeRequest, isMemoryPass, startFakeModel } from "./support/fake-model.ts";
import { ME, TestGateway, waitFor } from "./support/gateway.ts";

// What the agent gets as a pi session would, seen from outside: AGENTS.md and skills found the way the pi CLI finds
// them, and images that read shrinks to fit the model.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const lastPrompt = () => agentRequests(model).at(-1)!.system;

function skill(dir: string, name: string, description: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
  return file;
}

/** A black grayscale PNG of this size. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

describe("pi's context files, skills and images", { timeout: 90_000 }, () => {
  it("finds AGENTS.md and skills as pi does, again before each request, and renames persona.md", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    writeFileSync(join(gateway.botDir, "persona.md"), "I keep it short.\n");
    writeFileSync(join(gateway.home, "pi", "AGENTS.md"), "Everyone here uses metric units.\n");
    const release = skill(join(gateway.home, "pi", "skills"), "release-notes", "Write release notes. Use when a version ships.");
    await gateway.start();
    const agents = join(gateway.botDir, "AGENTS.md");
    expect(readFileSync(agents, "utf8")).toBe("I keep it short.\n");
    expect(existsSync(join(gateway.botDir, "persona.md"))).toBe(false);

    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    const first = lastPrompt();
    expect(first).toContain("<project_context>");
    // pi's order: the global file, then from the root down to the working directory.
    expect(first.indexOf("Everyone here uses metric units.")).toBeLessThan(first.indexOf(`<project_instructions path="${agents}">\nI keep it short.`));
    expect(first).toContain(`<name>release-notes</name>\n    <description>Write release notes. Use when a version ships.</description>\n    <location>${release}</location>`);

    writeFileSync(agents, "I keep it short. I answer in French.\n");
    const deploy = skill(join(gateway.botDir, "workspace", ".agents", "skills"), "deploy", "Deploy the app. Use when asked to ship.");
    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    const second = lastPrompt();
    expect(second).toContain("I answer in French.");
    expect(second).toContain(`<location>${deploy}</location>`);
  });

  it("shrinks a screenshot larger than the model takes, as pi does", async () => {
    let image = "";
    const script = (request: FakeRequest) => {
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.content.startsWith("[wake]")) return { call: { name: "read", arguments: { path: image } } };
      return coworker(request);
    };
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    // A Retina screenshot; the model takes at most 2000x2000.
    image = join(gateway.home, "screen.png");
    writeFileSync(image, png(3024, 1964));
    await gateway.start();
    gateway.say("general", "alice", `@${ME} look at the screen`);
    await waitFor(() => agentRequests(model).some((request) => request.messages.some((message) => message.role === "tool")), { what: "the read result" });
    const after = agentRequests(model).find((request) => request.messages.some((message) => message.role === "tool"))!;
    expect(after.messages.filter((message) => message.role === "tool").map((message) => message.content).join("")).not.toMatch(/image processor|larger than/);
    expect(after.messages.reduce((sum, message) => sum + message.images, 0)).toBe(1);
  });
});

describe("pi's grep and find", { timeout: 90_000 }, () => {
  it("search file contents and names with ripgrep and fd, for the main agent", async () => {
    let folder = "";
    const script = (request: FakeRequest) => {
      const results = request.messages.filter((message) => message.role === "tool").length;
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.content.startsWith("[wake]")) return { call: { name: "grep", arguments: { pattern: "launch day", path: folder, ignoreCase: true } } };
      if (results === 1) return { call: { name: "find", arguments: { pattern: "*.md", path: folder } } };
      return coworker(request);
    };
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    folder = join(gateway.botDir, "workspace", "notes");
    mkdirSync(join(folder, "deep"), { recursive: true });
    writeFileSync(join(folder, "plan.md"), "Intro\nLaunch day is Friday.\n");
    writeFileSync(join(folder, "deep", "todo.md"), "Nothing here.\n");
    writeFileSync(join(folder, "deep", "data.txt"), "launch day again\n");
    await gateway.start();
    gateway.say("general", "alice", `@${ME} when do we launch?`);
    await waitFor(() => agentRequests(model).some((request) => request.messages.filter((message) => message.role === "tool").length === 2), { what: "the find result" });
    const [grep, find] = agentRequests(model)
      .find((request) => request.messages.filter((message) => message.role === "tool").length === 2)!
      .messages.filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(grep!.split("\n").sort()).toEqual(["deep/data.txt:1: launch day again", "plan.md:2: Launch day is Friday."]);
    expect(find!.split("\n").sort()).toEqual(["deep/todo.md", "plan.md"]);
  });
});

describe("pi's prompt cache warming", { timeout: 90_000 }, () => {
  /** A request without its answer cap, to compare a warm with the request it repeats. */
  const body = ({ maxTokens: _, ...rest }: FakeRequest) => rest;
  const warms = () => model.requests.filter((request) => request.maxTokens === 1);

  it("sends the main agent's last request again before its cache entry expires, not a memory pass's, until pi's setting turns it off", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model, promptCacheSeconds: 12, settings: { memoryExtraction: true } });
    await gateway.start();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    // pi warms at 90% of the entry's lifetime, keeping at least 10 seconds: here every 2 seconds.
    await waitFor(() => warms().length >= 2, { timeout: 20_000, what: "two warms" });
    const real = agentRequests(model).filter((request) => request.maxTokens !== 1);
    // With the long entry the main agent's request asked for: pi times the warms by its lifetime.
    expect(real.at(-1)!.cacheRetention).toBe("24h");
    for (const warm of warms()) expect(body(warm)).toEqual(body(real.at(-1)!));
    expect(model.requests.filter((request) => request.maxTokens !== 1 && isMemoryPass(request)).length).toBeGreaterThan(0);
    expect(gateway.sent()).toHaveLength(1);
    // A warm is a model request in pots trace, beside the request it repeats: under the same step of the run.
    const beside = () =>
      gateway.query<{ n: number }>("SELECT max(n) AS n FROM (SELECT count(*) AS n FROM gw_spans WHERE name = 'pi.ai.request' GROUP BY parent_id)")[0]!.n;
    await waitFor(() => beside() >= 3, { what: "the warms' spans" });

    // The pi CLI's switch: settings.json is read again within seconds, without a restart.
    writeFileSync(join(gateway.home, "pi", "settings.json"), JSON.stringify({ cacheWarming: "off" }));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const after = warms().length;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(warms()).toHaveLength(after);
  });

  it("stops warming after a request fails, as pi does, and does not send the failed request again", async () => {
    let down = false;
    model = await startFakeModel((request) => (down ? { fail: { status: 401, message: "the login expired" } } : coworker(request)));
    gateway = new TestGateway({ model, promptCacheSeconds: 12, settings: { memoryExtraction: true } });
    await gateway.start();
    const failedRuns = () => gateway.output.filter((line) => line.message === "agent run failed").length;
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await waitFor(() => warms().length >= 1, { timeout: 20_000, what: "a warm" });

    // A failure reports no usage: pi's last answer then has no prompt size, and its warming stops.
    down = true;
    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => failedRuns() === 1, { what: "the failed run" });
    const after = warms().length;
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(warms()).toHaveLength(after);

    // The failure was the test's own.
    gateway.output.splice(0, gateway.output.length, ...gateway.output.filter((line) => line.message !== "agent run failed"));
  });

  it("warms nothing when pi's setting is off", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model, promptCacheSeconds: 12, settings: { memoryExtraction: true } });
    writeFileSync(join(gateway.home, "pi", "settings.json"), JSON.stringify({ cacheWarming: "off" }));
    await gateway.start();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(warms()).toEqual([]);
  });
});

describe("pi's request identity", { timeout: 90_000 }, () => {
  it("names Pots, not pi, to OpenRouter", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model, settings: { memoryExtraction: true } });
    // pi's openrouter provider, pointed at the fake model.
    const modelsFile = join(gateway.home, "pi", "models.json");
    const models = JSON.parse(readFileSync(modelsFile, "utf8")) as { providers: Record<string, unknown> };
    models.providers.openrouter = { baseUrl: model.url, api: "openai-completions", apiKey: "fake", models: [{ id: "coworker", contextWindow: 128_000 }] };
    writeFileSync(modelsFile, JSON.stringify(models));
    const definitionFile = join(gateway.botDir, "bot.json");
    writeFileSync(definitionFile, JSON.stringify({ ...JSON.parse(readFileSync(definitionFile, "utf8")), model: "openrouter/coworker" }));
    await gateway.start();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    // The main agent's requests and the memory pass's.
    await waitFor(() => model.requests.some(isMemoryPass), { what: "the memory pass" });
    for (const request of model.requests) expect(request.app).toEqual({ title: "Pots", referer: "https://pots.sh" });
  });
});

describe("pi's network settings", { timeout: 90_000 }, () => {
  it("reaches the model through the proxy of pi's setting httpProxy", async () => {
    // A proxy that tunnels what it is asked to, and notes where to.
    const tunnels: string[] = [];
    const proxy = createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
      tunnels.push(req.url ?? "");
      const [host, port] = (req.url ?? "").split(":");
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      model = await startFakeModel();
      const none = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"].map((key) => [key, undefined]));
      gateway = new TestGateway({ model, env: none });
      writeFileSync(join(gateway.home, "pi", "settings.json"), JSON.stringify({ httpProxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` }));
      await gateway.start();
      gateway.say("general", "alice", `@${ME} hello`);
      await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
      expect(tunnels).toContain(new URL(model.url).host);
    } finally {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
