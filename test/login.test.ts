import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeModel, startFakeModel, wakes } from "./support/fake-model.ts";
import { TestGateway, waitFor } from "./support/gateway.ts";

// The login page from outside: a real gateway with one bot, pi's models in the test's own folder with a provider that
// takes an API key and answers from the fake model, the bot's pots page login command, and what a person's browser
// does on the page: HTTP to the page server on 127.0.0.1, as the public address would forward it. Then pots login
// --link, which serves the page itself when no bot runs. No real provider is signed in to; device codes and pasted
// codes are in login.parts.test.ts, with fake providers in the test's process.

const PUBLIC = "https://pages.example.test";
const POTS = fileURLToPath(new URL("../src/cli/pots.ts", import.meta.url));

let model: FakeModel;
let gateway: TestGateway;

/** A provider of pi's models.json with no key yet: pi offers an API key login for it, as for any such provider. */
function addKeyedProvider(piDir: string, url: string): void {
  const file = join(piDir, "models.json");
  const models = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, unknown> };
  models.providers.keyed = {
    baseUrl: url,
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: "answer", contextWindow: 128_000 }],
  };
  writeFileSync(file, JSON.stringify(models, null, 2));
}

beforeAll(async () => {
  model = await startFakeModel();
  gateway = new TestGateway({ model });
  writeFileSync(join(gateway.home, "settings.json"), JSON.stringify({ publicUrl: PUBLIC }));
  addKeyedProvider(join(gateway.home, "pi"), model.url);
  await gateway.start();
}, 60_000);

afterAll(async () => {
  await gateway?.dispose();
  await model?.close();
});

const portOf = (home: string) => (JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { pagePort: number }).pagePort;
const pathOf = (url: string) => new URL(url).pathname;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, any>;
}

function http(port: number, method: string, path: string, options: { body?: unknown; cookie?: string; page?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    // A request from the page itself has the public address as its Origin.
    if (options.page !== false) headers.origin = PUBLIC;
    if (options.cookie) headers.cookie = options.cookie;
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(body) as Record<string, unknown>;
        } catch {
          // HTML
        }
        resolve({ status: res.statusCode!, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

const cookieOf = (answer: Answer) => {
  const header = answer.headers["set-cookie"];
  return (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
};

/** Ask for news until the state matches, as the page does. */
async function until(port: number, path: string, cookie: string, check: (state: Record<string, any>) => boolean, what: string): Promise<Record<string, any>> {
  let state = (await http(port, "GET", `${path}state`, { cookie })).json;
  const deadline = Date.now() + 20_000;
  while (!check(state)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state)}`);
    state = (await http(port, "GET", `${path}state?after=${state.version as number}`, { cookie })).json;
  }
  return state;
}

/** Start the link, sign in to the keyed provider with this key, and return the page's state after. */
async function signInWithKey(port: number, path: string, key: string): Promise<{ cookie: string; state: Record<string, any> }> {
  const start = await http(port, "POST", `${path}start`, { body: {} });
  expect(start.status).toBe(200);
  const cookie = cookieOf(start);
  const choices = await until(port, path, cookie, (state) => state.choices !== undefined, "the choices");
  expect(choices.choices.api_key).toContainEqual({ id: "keyed", name: "keyed", replaces: false });
  expect((await http(port, "POST", `${path}login`, { body: { provider: "keyed", way: "api_key" }, cookie })).json).toEqual({ ok: true });
  const asked = await until(port, path, cookie, (state) => state.login?.question !== undefined, "the key question");
  expect(asked.login.question).toMatchObject({ type: "secret", message: "Enter API key" });
  expect((await http(port, "POST", `${path}answer`, { body: { question: asked.login.question.id, value: key }, cookie })).json).toEqual({ ok: true });
  return { cookie, state: await until(port, path, cookie, (state) => state.login === undefined && state.outcomes?.length > 0, "the outcome") };
}

describe("login pages in a gateway", { timeout: 120_000 }, () => {
  it("sign a provider in with an API key from a link the bot made, and wake the bot with its models", async () => {
    const refused = await gateway.run(["page", "login", "--provider", "nope"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('bad --provider "nope"');
    const made = await gateway.run(["page", "login", "--for", "test:@alice", "--text", "Add the key for keyed, please."]);
    expect(made.stderr).toBe("");
    const link = JSON.parse(made.stdout) as { link: string; url: string; via: string };
    expect(link).toEqual({ link: "G1", url: expect.stringMatching(/^https:\/\/pages\.example\.test\/g\/[A-Za-z0-9_-]{24}\/$/), expires: expect.any(String), via: "public-url" });
    const port = portOf(gateway.home);
    const path = pathOf(link.url);
    const page = await http(port, "GET", path, { page: false });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'; script-src 'self'");
    expect(page.body).toContain("Coworker asks you to sign in to a model");
    expect(page.body).toContain("Add the key for keyed, please.");
    for (const file of ["login.js", "login.css"]) expect((await http(port, "GET", `/__pots/kit/login/${file}`, { page: false })).status).toBe(200);

    const { state } = await signInWithKey(port, path, "sk-from-the-page");
    expect(state.outcomes).toEqual([{ ok: true, provider: "keyed", name: "keyed", way: "api_key", replaced: false, model: "keyed/answer", models: 1 }]);
    // pi stored the key where it keeps its logins, for every bot and the pi command line.
    expect(readFileSync(join(gateway.home, "pi", "auth.json"), "utf8")).toContain("sk-from-the-page");
    await waitFor(() => wakes(model).some((wake) => wake.includes("login page: someone used link G1")), { what: "the bot's wake", timeout: 20_000 });
    const wake = wakes(model).find((each) => each.includes("login page: someone used link G1"))!;
    expect(wake).toContain("login page: someone used link G1 (made for test:@alice) and signed in to keyed (provider keyed, API key), for every bot and pi on this computer. Usable now: keyed/answer. keyed/answer answered when Pots tried it.");
    expect(JSON.stringify(model.requests)).not.toContain("sk-from-the-page");
    // The bot knows the command.
    expect(model.requests.at(-1)!.system).toContain("pots page login [--provider <id>] [--text <text>] [--for <person address>]");
    const listed = await gateway.run(["login", "--list"], { env: { PI_CODING_AGENT_DIR: join(gateway.home, "pi") } });
    expect(listed.stdout).toContain("keyed/answer");
    const list = JSON.parse((await gateway.run(["page", "list"])).stdout) as { loginLinks: unknown[] };
    expect(list.loginLinks).toEqual([expect.objectContaining({ link: "G1", for: "test:@alice", state: "started", signedIn: ["keyed (API key)"] })]);
  });

  it("end a link whose sign-in a restart lost, and tell the bot", async () => {
    const made = JSON.parse((await gateway.run(["page", "login"])).stdout) as { link: string; url: string };
    expect(made.link).toBe("G2");
    const port = portOf(gateway.home);
    const path = pathOf(made.url);
    const start = await http(port, "POST", `${path}start`, { body: {} });
    const cookie = cookieOf(start);
    await http(port, "POST", `${path}login`, { body: { provider: "keyed", way: "api_key" }, cookie });
    // A login that exists is replaced, and the page knew it before.
    const asked = await until(port, path, cookie, (state) => state.login?.question !== undefined, "the key question");
    expect(asked.login).toMatchObject({ provider: "keyed", replaces: true });
    await gateway.stop();
    await gateway.start();
    await waitFor(() => wakes(model).some((wake) => wake.includes("login page: Pots restarted")), { what: "the bot's wake", timeout: 20_000 });
    expect(wakes(model).find((wake) => wake.includes("login page: Pots restarted"))).toContain(
      "login page: Pots restarted while someone was signing in to keyed on link G2 (made for anyone), so that sign-in was lost and the link ended. A new link (pots page login) lets them try again.",
    );
    const page = await http(port, "GET", path, { page: false });
    expect([page.status, page.body.includes("Pots restarted")]).toEqual([410, true]);
  });
});

/** A port that is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe("pots login --link", { timeout: 120_000 }, () => {
  let home: string;
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  it("serves the login page with no bot, prints the link, waits until Done, and prints what was signed in", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-test-link-"));
    const piDir = join(home, "pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: {} }));
    addKeyedProvider(piDir, model.url);
    const port = await freePort();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ publicUrl: PUBLIC, pagePort: port }));
    child = spawn(process.execPath, [POTS, "login", "--link", "--provider", "keyed"], {
      env: { ...process.env, POTS_HOME: home, PI_CODING_AGENT_DIR: piDir, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child!.once("exit", (code) => resolve(code)));
    await waitFor(() => /\/g\/[A-Za-z0-9_-]{24}\//.test(stdout), { what: "the link", timeout: 30_000 });
    const url = /https:\/\/\S+\/g\/[A-Za-z0-9_-]{24}\//.exec(stdout)![0];
    expect(url.startsWith(`${PUBLIC}/g/`)).toBe(true);
    const path = pathOf(url);
    const page = await http(port, "GET", path, { page: false });
    expect(page.body).toContain("Pots asks you to sign in to keyed");
    const { cookie, state } = await signInWithKey(port, path, "sk-link");
    expect(state.outcomes[0]).toMatchObject({ ok: true, provider: "keyed", model: "keyed/answer" });
    await waitFor(() => stdout.includes("signed in to keyed"), { what: "the login's line" });
    expect((await http(port, "POST", `${path}done`, { body: {}, cookie })).json).toEqual({ ok: true });
    expect(await exited).toBe(0);
    child = undefined;
    expect(stderr).toBe("");
    expect(stdout).toContain("someone used link G1 (made for anyone) and signed in to keyed (provider keyed, API key)");
    expect(stdout).toContain("Models (for --model):\n  keyed/answer");
    expect(stdout).not.toContain("sk-link");
    expect(readFileSync(join(piDir, "auth.json"), "utf8")).toContain("sk-link");
  });
});
