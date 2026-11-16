import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthInteraction, envApiKeyAuth, fauxAssistantMessage, fauxProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/agent/agent.ts";
import { PageHost, QUICK_TUNNEL_LOGIN_NOTE } from "../src/pages/host.ts";
import { LOGIN_MINUTES, LOGIN_UNOPENED_MS, type LoginState, loginTimes, shapeOptions } from "../src/pages/login.ts";
import { BotPages } from "../src/pages/store.ts";
import { waitFor } from "./support/gateway.ts";

// The login page from outside, in this process: a real page server and a bot's links in a SQLite file, pi's own
// ModelRuntime with its auth.json in a temporary folder, and fake providers whose logins use pi's AuthInteraction as the
// real ones do: a device code that pi polls, a code pasted back, and API keys. The test is the person's browser: HTTP
// to the page server, with the Origin of the public address and the cookie Start set.

const PUBLIC = "https://pages.example.test";
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pots-login-test-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The fake providers' side: what the provider's site would do when the person signs in there. */
class FakeSite {
  approved = false;
  polls = 0;
  /** The code a copy-code login shows, with the state the page must send back. */
  readonly code = "good-code#state-1";
}

function chat(id: string, name: string, auth: Provider["auth"]): Provider {
  const faux = fauxProvider({ provider: id, models: [{ id: `${id}-large` }, { id: `${id}-small` }] });
  faux.appendResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("OK")));
  return { ...faux.provider, id, name, auth };
}

const credential = (access: string): OAuthCredential => ({ type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 3_600_000 });

function providers(site: FakeSite): Provider[] {
  const refresh = { refresh: async (current: OAuthCredential) => current, toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }) };
  return [
    // As OpenAI Codex: a browser way and a device code; pi polls until the person entered the code.
    chat("fake-device", "Fake Device", {
      oauth: {
        name: "Fake Device (subscription)",
        isSubscription: true,
        loginLabel: "Sign in with Fake Device",
        ...refresh,
        async login(interaction: AuthInteraction) {
          const way = await interaction.prompt({
            type: "select",
            message: "Select Fake login method:",
            options: [
              { id: "browser", label: "Browser login (default)" },
              { id: "device_code", label: "Device code login (headless)" },
            ],
          });
          if (way !== "device_code") throw new Error(`the test chose ${way}`);
          interaction.notify({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://fake.example/device", expiresInSeconds: 900 });
          for (;;) {
            interaction.signal?.throwIfAborted();
            site.polls += 1;
            if (site.approved) break;
            interaction.notify({ type: "progress", message: `Waiting for the code (${site.polls})…` });
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          interaction.notify({ type: "progress", message: "Exchanging the code…" });
          return credential("device-token");
        },
      },
    }),
    // As Anthropic's copy code: a sign-in URL, then the code the provider shows is pasted back.
    chat("fake-paste", "Fake Paste", {
      oauth: {
        name: "Fake Paste (subscription)",
        isSubscription: true,
        ...refresh,
        async login(interaction: AuthInteraction) {
          interaction.notify({ type: "auth_url", url: "https://fake.example/authorize?challenge=c1&state=state-1", instructions: "Sign in, then paste the code." });
          // A URL that is not http(s) never reaches the page.
          interaction.notify({ type: "info", message: "Help", links: [{ url: "javascript:alert(1)", label: "bad" }, { url: "https://fake.example/help", label: "Help page" }] });
          const input = await interaction.prompt({ type: "manual_code", message: "Paste the code:", placeholder: "code#state" });
          if (input !== site.code) throw new Error(`Token exchange failed: {"error":"invalid_grant","echo":"${input}"}`);
          return credential("paste-token");
        },
      },
    }),
    // A plain API key, and one with a choice of which some ways work only on the computer itself, as Amazon Bedrock.
    chat("fake-key", "Fake Key", { apiKey: envApiKeyAuth("Fake Key API key", ["FAKE_KEY_FOR_TEST"]) }),
    chat("fake-aws", "Fake AWS", {
      apiKey: {
        name: "Fake AWS credentials",
        async login(interaction) {
          const way = await interaction.prompt({
            type: "select",
            message: "Select authentication method:",
            options: [
              { id: "bearer-token", label: "Bearer token" },
              { id: "aws-profile", label: "AWS profile" },
              { id: "credential-chain", label: "Existing AWS credential chain" },
            ],
          });
          return { type: "api_key", key: `${way}:${await interaction.prompt({ type: "secret", message: "Enter bearer token" })}` };
        },
        resolve: async ({ credential: stored }) => (stored?.key ? { auth: { apiKey: stored.key } } : undefined),
      },
    }),
  ];
}

interface Fixture {
  dir: string;
  sql: Database;
  pages: BotPages;
  host: PageHost;
  models: ModelRuntime;
  site: FakeSite;
  woke: { note: string; requestId: string }[];
  state: { now: number; failWakes: number };
}

async function open(dir: string, site: FakeSite, settings: Record<string, unknown> = { publicUrl: PUBLIC }, state = { now: Date.now(), failWakes: 0 }, woke: Fixture["woke"] = []): Promise<Fixture> {
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  const models = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
  for (const provider of providers(site)) models.registerNativeProvider(provider);
  const sql = await openDatabase(join(dir, "bot.sqlite"));
  const seen = new Set(woke.map((wake) => wake.requestId));
  const pages = await BotPages.open({
    id: "bot",
    dir,
    sql,
    secretsDir: join(dir, "secrets"),
    name: () => "Coworker",
    // As the timers do: one wake per request ID.
    wake: async (note, requestId) => {
      if (state.failWakes > 0) {
        state.failWakes -= 1;
        throw new Error("the bot's database is busy");
      }
      if (seen.has(requestId)) return;
      seen.add(requestId);
      woke.push({ note, requestId });
    },
    print: () => {},
    clock: () => state.now,
    login: {
      models: () => models,
      defaultModel: async (provider) => (provider === "fake-device" ? "fake-device-small" : undefined),
      tryModel: async (_models, model) => (model === "fake-key/fake-key-large" ? "401 bad key" : undefined),
    },
  });
  // Never a real tunnel: without a publicUrl, the address cannot come.
  const cloudflared = async (): Promise<readonly string[]> => {
    throw new Error("no cloudflared in this test");
  };
  const host = new PageHost({ home: dir, settingsFile, binDir: join(dir, "bin"), print: () => {}, cloudflared });
  await host.start();
  host.register(pages);
  await pages.resume();
  return { dir, sql, pages, host, models, site, woke, state };
}

async function close(f: Fixture): Promise<void> {
  f.pages.login.stop();
  await f.pages.stopCleanup();
  await f.host.stop();
  await f.sql.close();
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, any>;
}

function http(f: Fixture, method: string, path: string, options: { body?: unknown; cookie?: string; origin?: string | null; lang?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.origin !== null) headers.origin = options.origin ?? PUBLIC;
    if (options.cookie) headers.cookie = options.cookie;
    if (options.lang) headers["accept-language"] = options.lang;
    const req = request({ host: "127.0.0.1", port: f.host.port, method, path, headers }, (res) => {
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

const pathOf = (url: string) => new URL(url).pathname;
const cookieOf = (answer: Answer) => {
  const header = answer.headers["set-cookie"];
  return (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
};

/** A browser that opened the link and pressed Start. */
async function started(f: Fixture, input: { provider?: string; text?: string; person?: string } = {}): Promise<{ path: string; cookie: string; link: string }> {
  const made = await f.host.login(f.pages, input);
  const path = pathOf(made.url);
  const start = await http(f, "POST", `${path}start`, { body: {} });
  expect(start.status).toBe(200);
  return { path, cookie: cookieOf(start), link: made.link };
}

const stateOf = async (f: Fixture, path: string, cookie: string, after?: number) => (await http(f, "GET", `${path}state${after === undefined ? "" : `?after=${after}`}`, { cookie })).json as LoginState;

/** Wait until the page's state matches, as the page does: it asks for news and gets each change. */
async function until(f: Fixture, path: string, cookie: string, check: (state: LoginState) => boolean, what: string): Promise<LoginState> {
  let state = await stateOf(f, path, cookie);
  const deadline = Date.now() + 10_000;
  while (!check(state)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state)}`);
    state = await stateOf(f, path, cookie, state.version);
  }
  return state;
}

describe("the ways a page offers", () => {
  it("puts the way that works from another device first, marked, and leaves out the ways for the computer itself", () => {
    expect(
      shapeOptions([
        { id: "browser", label: "Browser login (default)" },
        { id: "copy_code", label: "Copy code login (headless)" },
      ]).options,
    ).toEqual([
      { id: "copy_code", label: "Copy code login (headless)", recommended: true },
      { id: "browser", label: "Browser login" },
    ]);
    // pi writes the IDs in more than one way.
    expect(shapeOptions([{ id: "browser", label: "Sign in with browser (recommended)" }, { id: "device-code", label: "Device code" }]).options[0]).toEqual({ id: "device-code", label: "Device code", recommended: true });
    // No match: pi's options as they are, unmarked.
    expect(shapeOptions([{ id: "one", label: "One (default)" }, { id: "two", label: "Two" }])).toEqual({ options: [{ id: "one", label: "One (default)" }, { id: "two", label: "Two" }], hidden: [] });
    expect(
      shapeOptions([
        { id: "api-key", label: "Google Cloud API key" },
        { id: "adc", label: "Application Default Credentials" },
        { id: "service-account", label: "Service account credentials file" },
      ]),
    ).toEqual({ options: [{ id: "api-key", label: "Google Cloud API key" }], hidden: ["Application Default Credentials", "Service account credentials file"] });
  });
});

describe("login pages", { timeout: 60_000 }, () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await open(temp(), new FakeSite());
  });
  afterEach(async () => {
    await close(f);
  });

  it("make a link that shows nothing of the login before Start, and binds it to the first browser", async () => {
    await expect(f.host.login(f.pages, { provider: "nope" })).rejects.toThrow('bad --provider "nope": pi has no login or API key for it');
    const made = await f.host.login(f.pages, { provider: "fake-paste", text: "Sign in to Fake for me, please.", person: "test:@alice" });
    expect(made).toEqual({ link: "G1", url: expect.stringMatching(new RegExp(`^${PUBLIC}/g/[A-Za-z0-9_-]{24}/$`)), expires: new Date(f.state.now + LOGIN_UNOPENED_MS).toISOString(), via: "public-url" });
    const path = pathOf(made.url);
    // A page that is Pots' own: its script and style from this address only.
    const page = await http(f, "GET", path, { origin: null });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'; script-src 'self'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Coworker asks you to sign in to Fake Paste");
    expect(page.body).toContain("Sign in to Fake for me, please.");
    expect(page.body).toContain('src="../../__pots/kit/login/login.js"');
    expect((await http(f, "GET", path, { origin: null, lang: "zh-CN,zh;q=0.9" })).body).toContain("Coworker 请你登录 Fake Paste");
    for (const file of ["login.js", "login.css"]) expect((await http(f, "GET", `/__pots/kit/login/${file}`)).status).toBe(200);
    // Before Start: no choices, no login.
    const before = await stateOf(f, path, "");
    expect(before).toMatchObject({ id: "G1", state: "open", mine: false, provider: "fake-paste" });
    expect(before.choices).toBeUndefined();
    // Only the page itself can press Start.
    expect((await http(f, "POST", `${path}start`, { body: {}, origin: "https://elsewhere.example" })).status).toBe(403);
    const start = await http(f, "POST", `${path}start`, { body: {} });
    expect(start.status).toBe(200);
    expect(start.headers["set-cookie"]).toEqual([expect.stringMatching(/^pots_login=[A-Za-z0-9_-]{43}; Max-Age=\d+; HttpOnly; SameSite=Strict$/)]);
    const cookie = cookieOf(start);
    const mine = await stateOf(f, path, cookie);
    expect(mine).toMatchObject({ state: "started", mine: true, expires: f.state.now + LOGIN_MINUTES * 60_000 });
    expect(mine.choices!.oauth.map((choice) => [choice.id, choice.name])).toEqual(expect.arrayContaining([["fake-device", "Sign in with Fake Device"], ["fake-paste", "Fake Paste (subscription)"]]));
    expect(mine.choices!.api_key.map((choice) => choice.id)).toEqual(expect.arrayContaining(["fake-key", "fake-aws"]));
    // Another browser cannot start it, see its login, or act on it.
    expect((await http(f, "POST", `${path}start`, { body: {}, cookie: "pots_login=someone-else" })).json).toMatchObject({ ok: false, code: "elsewhere" });
    expect(await stateOf(f, path, "pots_login=someone-else")).not.toHaveProperty("choices");
    expect((await http(f, "POST", `${path}login`, { body: { provider: "fake-key", way: "api_key" }, cookie: "pots_login=someone-else" })).status).toBe(403);
    // The same browser may press Start again, after a reload.
    expect((await http(f, "POST", `${path}start`, { body: {}, cookie })).status).toBe(200);
    expect((await f.host.list(f.pages)) as { loginLinks: unknown[] }).toMatchObject({ loginLinks: [{ link: "G1", for: "test:@alice", provider: "fake-paste", state: "started", signedIn: [] }] });
  });

  it("follows a device code while pi polls, and wakes the bot once with the provider and its models", async () => {
    const { path, cookie } = await started(f, { person: "test:@alice" });
    expect((await http(f, "POST", `${path}login`, { body: { provider: "fake-device", way: "oauth" }, cookie })).json).toEqual({ ok: true });
    // pi asks for the way: the device code comes first, marked; pi's "(default)" goes.
    const asked = await until(f, path, cookie, (state) => state.login?.question !== undefined, "pi's question");
    expect(asked.login).toMatchObject({ provider: "fake-device", name: "Sign in with Fake Device", way: "oauth", replaces: false });
    expect(asked.login!.question).toEqual({
      id: expect.any(String),
      type: "select",
      message: "Select Fake login method:",
      options: [
        { id: "device_code", label: "Device code login (headless)", recommended: true },
        { id: "browser", label: "Browser login" },
      ],
      hidden: [],
    });
    // A wrong answer, or one to a question that is gone, is refused.
    expect((await http(f, "POST", `${path}answer`, { body: { question: asked.login!.question!.id, value: "other" }, cookie })).status).toBe(400);
    expect((await http(f, "POST", `${path}answer`, { body: { question: "old", value: "device_code" }, cookie })).json).toMatchObject({ code: "gone" });
    expect((await http(f, "POST", `${path}answer`, { body: { question: asked.login!.question!.id, value: "device_code" }, cookie })).json).toEqual({ ok: true });
    // The code comes, and the page hears of each poll while it waits for news.
    const code = await until(f, path, cookie, (state) => state.login?.events.some((event) => event.type === "device_code") === true, "the device code");
    expect(code.login!.events).toContainEqual({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://fake.example/device", expiresAt: f.state.now + 900_000 });
    const polled = await until(f, path, cookie, (state) => state.login?.events.some((event) => event.type === "progress" && /\(3\)/.test(event.message)) === true, "pi's polls");
    // One line of progress at a time.
    expect(polled.login!.events.filter((event) => event.type === "progress")).toHaveLength(1);
    // The news comes at once when it changes, and waits while nothing does.
    const asking = Date.now();
    loginTimes.waitMs = 300;
    try {
      f.site.approved = true;
      const done = await until(f, path, cookie, (state) => state.login === undefined && (state.outcomes?.length ?? 0) > 0, "the outcome");
      expect(Date.now() - asking).toBeLessThan(5_000);
      expect(done.outcomes).toEqual([{ ok: true, provider: "fake-device", name: "Sign in with Fake Device", way: "oauth", replaced: false, model: "fake-device/fake-device-small", models: 2 }]);
    } finally {
      loginTimes.waitMs = 20_000;
    }
    await waitFor(() => f.woke.length === 1, { what: "the wake" });
    expect(f.woke[0]).toEqual({
      note: "login page: someone used link G1 (made for test:@alice) and signed in to Sign in with Fake Device (provider fake-device, subscription), for every bot and pi on this computer. Usable now: fake-device/fake-device-large, fake-device/fake-device-small. fake-device/fake-device-small answered when Pots tried it.",
      requestId: "login:G1:1",
    });
    expect(await f.models.listCredentials()).toContainEqual({ providerId: "fake-device", type: "oauth" });
    // Several logins per link: an API key next, which pi stores too. The tried model does not answer with this key.
    expect((await http(f, "POST", `${path}login`, { body: { provider: "fake-key", way: "api_key" }, cookie })).json).toEqual({ ok: true });
    const key = await until(f, path, cookie, (state) => state.login?.question?.type === "secret", "the key question");
    expect((await http(f, "POST", `${path}answer`, { body: { question: key.login!.question!.id, value: "   " }, cookie })).json).toMatchObject({ error: "It cannot be empty." });
    expect((await http(f, "POST", `${path}answer`, { body: { question: key.login!.question!.id, value: "sk-test\nmore" }, cookie })).status).toBe(400);
    expect((await http(f, "POST", `${path}answer`, { body: { question: key.login!.question!.id, value: "  sk-secret-123 " }, cookie })).json).toEqual({ ok: true });
    const second = await until(f, path, cookie, (state) => (state.outcomes?.length ?? 0) === 2, "the second outcome");
    expect(second.outcomes![1]).toEqual({ ok: true, provider: "fake-key", name: "Fake Key", way: "api_key", replaced: false, model: "fake-key/fake-key-large", modelProblem: "401 bad key", models: 2 });
    await waitFor(() => f.woke.length === 2, { what: "the second wake" });
    expect(f.woke[1]!.requestId).toBe("login:G1:2");
    expect(f.woke[1]!.note).toContain("signed in to Fake Key (provider fake-key, API key)");
    expect(f.woke[1]!.note).toContain("fake-key/fake-key-large did not answer when Pots tried it with this login.");
    expect(JSON.stringify(f.woke)).not.toContain("sk-secret");
    expect(JSON.stringify(await f.models.getAuth("fake-key"))).toContain("sk-secret-123");
    // Done ends the link; the bot heard of each login, so no more wake.
    expect((await http(f, "POST", `${path}done`, { body: {}, cookie })).json).toEqual({ ok: true });
    expect((await http(f, "GET", path, { origin: null })).status).toBe(410);
    expect((await http(f, "GET", path, { origin: null })).body).toContain("All set");
    expect(f.woke).toHaveLength(2);
    expect(((await f.host.list(f.pages)) as { loginLinks: unknown[] }).loginLinks).toMatchObject([{ link: "G1", state: "done", signedIn: ["fake-device (subscription)", "fake-key (API key)"] }]);
  });

  it("takes a pasted code, shows the person pi's error but tells the bot no more than that it failed, and says a login is replaced", async () => {
    const { path, cookie } = await started(f, { provider: "fake-paste" });
    expect((await http(f, "POST", `${path}login`, { body: { provider: "fake-paste", way: "oauth" }, cookie })).json).toEqual({ ok: true });
    const asked = await until(f, path, cookie, (state) => state.login?.question?.type === "manual_code", "the code question");
    expect(asked.login!.events).toEqual([
      { type: "auth_url", url: "https://fake.example/authorize?challenge=c1&state=state-1", instructions: "Sign in, then paste the code." },
      { type: "info", message: "Help", links: [{ url: "https://fake.example/help", label: "Help page" }] },
    ]);
    expect(asked.login!.question).toEqual({ id: expect.any(String), type: "manual_code", message: "Paste the code:", placeholder: "code#state" });
    await http(f, "POST", `${path}answer`, { body: { question: asked.login!.question!.id, value: "wrong#state-1" }, cookie });
    const failed = await until(f, path, cookie, (state) => (state.outcomes?.length ?? 0) === 1, "the failure");
    expect(failed.outcomes![0]).toMatchObject({ ok: false, cancelled: false, error: expect.stringContaining("invalid_grant") });
    // Again, now with the right code.
    await http(f, "POST", `${path}login`, { body: { provider: "fake-paste", way: "oauth" }, cookie });
    const again = await until(f, path, cookie, (state) => state.login?.question?.type === "manual_code", "the code question again");
    await http(f, "POST", `${path}answer`, { body: { question: again.login!.question!.id, value: f.site.code }, cookie });
    await until(f, path, cookie, (state) => state.outcomes?.[1]?.ok === true, "the login");
    await waitFor(() => f.woke.length === 1, { what: "the wake" });
    expect(f.woke[0]!.note).not.toMatch(/invalid_grant|wrong|good-code|challenge|authorize/);
    // The provider has a login now: a second link says it would be replaced, before and after.
    const next = await started(f);
    const choices = await stateOf(f, next.path, next.cookie);
    expect(choices.choices!.oauth.find((choice) => choice.id === "fake-paste")).toMatchObject({ replaces: true });
    expect(choices.choices!.oauth.find((choice) => choice.id === "fake-device")).toMatchObject({ replaces: false });
    await http(f, "POST", `${next.path}login`, { body: { provider: "fake-paste", way: "oauth" }, cookie: next.cookie });
    const replacing = await until(f, next.path, next.cookie, (state) => state.login?.question !== undefined, "the code question");
    expect(replacing.login!.replaces).toBe(true);
    await http(f, "POST", `${next.path}answer`, { body: { question: replacing.login!.question!.id, value: f.site.code }, cookie: next.cookie });
    await waitFor(() => f.woke.length === 2, { what: "the wake" });
    expect(f.woke[1]!.note).toContain("It replaced the fake-paste login that pi had before.");
    // The first link ends at its time: someone signed in on it, so no wake about its end.
    f.state.now += LOGIN_MINUTES * 60_000 + 1;
    await f.pages.login.checkExpiry();
    expect(f.woke).toHaveLength(2);
  });

  it("leaves out the ways for the computer itself, and lets the person cancel a sign-in", async () => {
    const { path, cookie } = await started(f);
    await http(f, "POST", `${path}login`, { body: { provider: "fake-aws", way: "api_key" }, cookie });
    const asked = await until(f, path, cookie, (state) => state.login?.question?.type === "select", "the question");
    expect(asked.login!.question).toMatchObject({ options: [{ id: "bearer-token", label: "Bearer token" }], hidden: ["AWS profile", "Existing AWS credential chain"] });
    // A sign-in runs: no second one.
    expect((await http(f, "POST", `${path}login`, { body: { provider: "fake-key", way: "api_key" }, cookie })).json).toMatchObject({ code: "busy" });
    expect((await http(f, "POST", `${path}cancel`, { body: {}, cookie })).json).toEqual({ ok: true });
    const cancelled = await until(f, path, cookie, (state) => state.login === undefined && (state.outcomes?.length ?? 0) === 1, "the cancel");
    expect(cancelled.outcomes![0]).toMatchObject({ ok: false, cancelled: true, error: "Cancelled." });
    // Nobody signed in when the link ends: the bot hears of it once.
    expect((await http(f, "POST", `${path}done`, { body: {}, cookie })).json).toEqual({ ok: true });
    await waitFor(() => f.woke.length === 1, { what: "the wake" });
    expect(f.woke[0]).toEqual({ note: "login page: someone pressed Done on link G1 (made for anyone) without signing in to anything.", requestId: "login:G1:end" });
  });

  it("ends at its time: unopened after an hour, and 15 minutes after Start, stopping the sign-in that runs", async () => {
    const unopened = await f.host.login(f.pages, {});
    const { path, cookie } = await started(f, { person: "test:@bob" });
    await http(f, "POST", `${path}login`, { body: { provider: "fake-device", way: "oauth" }, cookie });
    const asked = await until(f, path, cookie, (state) => state.login?.question !== undefined, "the question");
    await http(f, "POST", `${path}answer`, { body: { question: asked.login!.question!.id, value: "device_code" }, cookie });
    await until(f, path, cookie, (state) => state.login?.events.some((event) => event.type === "device_code") === true, "the device code");
    const polls = () => f.site.polls;
    f.state.now += LOGIN_MINUTES * 60_000 + 1;
    await f.pages.login.checkExpiry();
    expect((await stateOf(f, path, cookie)).state).toBe("expired");
    // pi stopped polling.
    const after = polls();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(polls()).toBeLessThanOrEqual(after + 1);
    expect((await http(f, "POST", `${path}answer`, { body: { question: "x", value: "y" }, cookie })).status).toBe(410);
    const page = await http(f, "GET", path, { origin: null });
    expect([page.status, page.body.includes("This link has ended")]).toEqual([410, true]);
    expect(f.woke).toEqual([{ note: expect.stringMatching(/^login page: link G2 \(made for test:@bob\) ended at .+, 15 minutes after Start, and nobody signed in\.$/), requestId: "login:G2:end" }]);
    f.state.now += LOGIN_UNOPENED_MS;
    await f.pages.login.checkExpiry();
    expect(f.woke[1]).toEqual({ note: expect.stringMatching(/^login page: link G1 \(made for anyone\) expired at .+: nobody pressed Start within an hour\.$/), requestId: "login:G1:end" });
    expect((await http(f, "GET", pathOf(unopened.url), { origin: null })).status).toBe(410);
  });

  it("is taken back with pots page unlink, which stops the sign-in and wakes nobody", async () => {
    const { path, cookie, link } = await started(f);
    await http(f, "POST", `${path}login`, { body: { provider: "fake-key", way: "api_key" }, cookie });
    await until(f, path, cookie, (state) => state.login?.question !== undefined, "the question");
    expect(await f.host.unlink(f.pages, `${PUBLIC}${path}`)).toBe(`Unlinked ${link}.`);
    expect((await stateOf(f, path, cookie)).state).toBe("revoked");
    expect((await http(f, "GET", path, { origin: null })).body).toContain("Coworker took this link back");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.woke).toEqual([]);
  });

  it("is taken back when the Quick Tunnel cannot give an address, and has its own note for one", async () => {
    await close(f);
    f = await open(f.dir, f.site, {});
    await expect(f.host.login(f.pages, {})).rejects.toThrow("no cloudflared in this test");
    expect(((await f.host.list(f.pages)) as { loginLinks: unknown[] }).loginLinks).toEqual([]);
    expect(QUICK_TUNNEL_LOGIN_NOTE).toContain("an API key typed on the page is seen as on the password page");
  });
});

describe("login pages after a restart", { timeout: 60_000 }, () => {
  it("end a link whose sign-in a restart lost, wake the bot once, and send a wake that failed again", async () => {
    const dir = temp();
    const site = new FakeSite();
    const woke: Fixture["woke"] = [];
    const state = { now: Date.now(), failWakes: 0 };
    let f = await open(dir, site, { publicUrl: PUBLIC }, state, woke);
    const running = await started(f, { person: "test:@alice" });
    const idle = await started(f);
    await http(f, "POST", `${running.path}login`, { body: { provider: "fake-device", way: "oauth" }, cookie: running.cookie });
    await until(f, running.path, running.cookie, (s) => s.login?.question !== undefined, "the question");
    // The first wake after the restart fails; it goes again.
    loginTimes.wakeRetryMs = 50;
    state.failWakes = 1;
    try {
      await close(f);
      f = await open(dir, site, { publicUrl: PUBLIC }, state, woke);
      await waitFor(() => woke.length === 1, { what: "the wake", timeout: 5_000 });
    } finally {
      loginTimes.wakeRetryMs = 10_000;
    }
    expect(woke).toEqual([
      {
        note: "login page: Pots restarted while someone was signing in to fake-device on link G1 (made for test:@alice), so that sign-in was lost and the link ended. A new link (pots page login) lets them try again.",
        requestId: "login:G1:end",
      },
    ]);
    expect((await http(f, "GET", running.path, { origin: null })).body).toContain("Pots restarted");
    // A link with no sign-in running goes on, for the browser that started it.
    expect(await stateOf(f, idle.path, idle.cookie)).toMatchObject({ state: "started", mine: true });
    await http(f, "POST", `${idle.path}login`, { body: { provider: "fake-key", way: "api_key" }, cookie: idle.cookie });
    const key = await until(f, idle.path, idle.cookie, (s) => s.login?.question !== undefined, "the question");
    await http(f, "POST", `${idle.path}answer`, { body: { question: key.login!.question!.id, value: "sk-1" }, cookie: idle.cookie });
    await waitFor(() => woke.length === 2, { what: "the login's wake" });
    expect(woke[1]!.requestId).toBe("login:G2:1");
    // Another restart sends nothing twice.
    await close(f);
    f = await open(dir, site, { publicUrl: PUBLIC }, state, woke);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(woke).toHaveLength(2);
    // Ended links are forgotten after 7 days.
    await http(f, "POST", `${idle.path}done`, { body: {}, cookie: idle.cookie });
    state.now += 8 * 86_400_000;
    await f.pages.cleanup();
    expect(((await f.host.list(f.pages)) as { loginLinks: unknown[] }).loginLinks).toEqual([]);
    await close(f);
  });
});
