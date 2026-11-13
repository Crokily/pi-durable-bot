import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/agent/agent.ts";
import { renderBusy, ScreenLeases } from "../src/agent/screen.ts";
import { readDefinition, type VncSetting } from "../src/bot/definition.ts";
import { BotDesktop, DESKTOP_UNOPENED_MS, desktopTimes } from "../src/pages/desktop.ts";
import { desktopHeaders, pickLang, renderDesktopEnded, renderDesktopPage } from "../src/pages/desktop-page.ts";
import { readDesktopLayout, readVncPassword, restoreDesktopLayout, type VncTarget } from "../src/pages/rfb.ts";
import { FakeVnc } from "./support/vnc.ts";
import { waitFor } from "./support/gateway.ts";

// The desktop page's parts on their own: Pots' side of the VNC protocol against a VNC server of the test's own, and a
// bot's desktop links on a clock the test moves, with a screen lease file of the test's own.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pots-desktop-"));
  dirs.push(dir);
  return dir;
};
const servers: FakeVnc[] = [];
const vnc = async (options: Parameters<typeof FakeVnc.start>[0] = {}) => {
  const server = await FakeVnc.start(options);
  servers.push(server);
  return server;
};
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const target = (server: FakeVnc, password?: string): VncTarget => ({ port: server.port, password: password === undefined ? undefined : Buffer.from(password), passwordFile: "vnc.env" });

describe("signing in to a VNC server", () => {
  it("reads a password from VNC_PASSWORD lines, or from a password file as vncpasswd writes it", () => {
    const dir = temp();
    writeFileSync(join(dir, "vnc.env"), "OTHER=1\nVNC_PASSWORD=longer-than-eight\n");
    expect(readVncPassword(join(dir, "vnc.env")).toString()).toBe("longer-t");
    // TigerVNC 1.16's vncpasswd -f for "testpw12" (16 bytes: the password, then the view-only one).
    writeFileSync(join(dir, "passwd"), Buffer.from("f977efe6a9b36c4ef977efe6a9b36c4e", "hex"));
    expect(readVncPassword(join(dir, "passwd")).toString()).toBe("testpw12");
    writeFileSync(join(dir, "bad"), "PASSWORD=x\n");
    expect(() => readVncPassword(join(dir, "bad"))).toThrow("neither KEY=value lines with VNC_PASSWORD nor a VNC password file");
    expect(() => readVncPassword(join(dir, "missing"))).toThrow("cannot read the VNC password file");
  });

  it("speaks RFB 3.3, 3.7, 3.8 and Apple's 3.889, with VncAuth or None", async () => {
    for (const version of ["003.003", "003.007", "003.008", "003.889"]) {
      const server = await vnc({ version, password: "secret", width: 1024, height: 768 });
      expect(await readDesktopLayout(target(server, "secret"))).toEqual({ width: 1024, height: 768 });
      expect(server.connections.at(-1)).toMatchObject({ signedIn: true, shared: true });
    }
    // None when the server offers it, also with VncAuth: no password is needed then.
    for (const version of ["003.007", "003.008"]) {
      const server = await vnc({ version, security: [2, 1] });
      expect(await readDesktopLayout(target(server))).toEqual({ width: 1280, height: 800 });
    }
  });

  it("says what is wrong, in words for the bot", async () => {
    const server = await vnc({ password: "secret" });
    await expect(readDesktopLayout(target(server, "wrong"))).rejects.toThrow(`the VNC server at 127.0.0.1:${server.port}: it refused the password in vnc.env: Authentication failed`);
    await expect(readDesktopLayout(target(server))).rejects.toThrow(`it asks for a password, and bot.json's "vnc" has no "passwordFile"`);
    const tls = await vnc({ security: [19, 30] });
    await expect(readDesktopLayout(target(tls))).rejects.toThrow("it offers only these ways to sign in: 19 (VeNCrypt), 30 (Apple Remote Desktop). Pots signs in with None (1) or VncAuth (2)");
    const closed = await vnc({ security: [] });
    await expect(readDesktopLayout(target(closed))).rejects.toThrow("it refused the connection: no way in");
    const port = server.port;
    await server.close();
    await expect(readDesktopLayout({ port, password: undefined })).rejects.toThrow(`no VNC server listens at 127.0.0.1:${port} (the port of "vnc" in bot.json)`);
  });

  it("reads the screen layout of a desktop that can change size, and sets it back", async () => {
    const server = await vnc({ password: "pw", resizable: true });
    const layout = await readDesktopLayout(target(server, "pw"));
    expect(layout).toEqual({ width: 1280, height: 800, screens: expect.any(String) });
    expect(await restoreDesktopLayout(target(server, "pw"), layout)).toBe("same");
    server.width = 500;
    server.height = 900;
    expect(await restoreDesktopLayout(target(server, "pw"), layout)).toBe("set");
    expect([server.width, server.height]).toEqual([1280, 800]);
    expect(server.connections.at(-1)!.resizes).toEqual([{ width: 1280, height: 800 }]);
    // A desktop that cannot change size says nothing about its layout; there is nothing to set back.
    const fixed = await vnc({ password: "pw" });
    const plain = await readDesktopLayout(target(fixed, "pw"));
    expect(plain).toEqual({ width: 1280, height: 800 });
    expect(await restoreDesktopLayout(target(fixed, "pw"), plain)).toBe("same");
  });
});

interface Fixture {
  dir: string;
  sql: Database;
  desktop: BotDesktop;
  leases: ScreenLeases;
  woke: { note: string; requestId: string }[];
  now: number;
  vnc: VncSetting | undefined;
  failWakes: number;
}

async function fixture(server: FakeVnc | undefined, options: { screen?: string; leases?: ScreenLeases; dir?: string } = {}): Promise<Fixture> {
  const dir = options.dir ?? temp();
  const secrets = join(dir, "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "vnc.env"), "VNC_PASSWORD=pw\n");
  const sql = await openDatabase(join(dir, "bot.sqlite"));
  const leases = options.leases ?? new ScreenLeases(join(temp(), "leases.sqlite"));
  const state = { now: Date.now(), vnc: server ? ({ port: server.port, passwordFile: "vnc.env" } as VncSetting | undefined) : undefined, failWakes: 0 };
  const woke: Fixture["woke"] = [];
  const seen = new Set<string>();
  const desktop = await BotDesktop.open({
    sql,
    dir,
    name: () => "Coworker",
    vnc: () => state.vnc,
    secretsDir: secrets,
    screen: () => ({ key: options.screen ?? "x11:local:91", label: "DISPLAY=:91", env: {} }),
    leases: () => leases,
    wake: async (note, requestId) => {
      if (state.failWakes > 0) {
        state.failWakes--;
        throw new Error("database is locked");
      }
      if (seen.has(requestId)) return;
      seen.add(requestId);
      woke.push({ note, requestId });
    },
    print: () => {},
    clock: () => state.now,
  });
  return Object.defineProperties({ dir, sql, desktop, leases, woke } as Omit<Fixture, "now" | "vnc" | "failWakes">, {
    now: { get: () => state.now, set: (value: number) => (state.now = value) },
    vnc: { get: () => state.vnc, set: (value: VncSetting | undefined) => (state.vnc = value) },
    failWakes: { get: () => state.failWakes, set: (value: number) => (state.failWakes = value) },
  }) as Fixture;
}

describe("desktop links", () => {
  let server: FakeVnc;
  let f: Fixture;
  beforeEach(async () => {
    server = await vnc({ password: "pw", resizable: true });
    f = await fixture(server);
  });
  afterEach(async () => {
    await f.desktop.stop();
    await f.sql.close();
    // Windows does not delete a database file that is still open.
    f.leases.close();
  });

  it("need a VNC server that answers before a link is made", async () => {
    f.vnc = undefined;
    await expect(f.desktop.create({ text: "Sign in" })).rejects.toThrow('bot.json has no "vnc"');
    f.vnc = { port: server.port };
    await expect(f.desktop.create({ text: "Sign in" })).rejects.toThrow('it asks for a password, and bot.json\'s "vnc" has no "passwordFile"');
    f.vnc = { port: server.port, passwordFile: "vnc.env" };
    await expect(f.desktop.create({ text: "  " })).rejects.toThrow("--text is required");
    await expect(f.desktop.create({ text: "x", input: "pin" })).rejects.toThrow('bad --input "pin": password, code or text');
    await expect(f.desktop.create({ text: "x", area: "1,2,3" })).rejects.toThrow('bad --area "1,2,3"');
    await expect(f.desktop.create({ text: "x", minutes: 61 })).rejects.toThrow("bad --minutes: a whole number from 1 to 60");
    const link = await f.desktop.create({ text: "Sign in", input: "password", area: "440,300,400,260", minutes: 5, person: "slack:@U1" });
    expect(link).toEqual({ id: "D1", token: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/), expiresAt: f.now + DESKTOP_UNOPENED_MS });
    expect(await f.desktop.view(link.token)).toMatchObject({ id: "D1", state: "open", input: "password", area: [440, 300, 400, 260], minutes: 5, resizable: true, size: { width: 1280, height: 800 }, mine: false });
  });

  it("bind to the first browser that presses Start, which holds the screen until the link ends", async () => {
    const link = await f.desktop.create({ text: "Sign in" });
    // Looking does not start it.
    expect((await f.desktop.view(link.token))?.state).toBe("open");
    expect(f.leases.holder("x11:local:91")).toBeUndefined();
    const first = await f.desktop.start(link.token, undefined);
    if (!first.ok) throw new Error(first.error);
    expect(first.view).toMatchObject({ state: "started", mine: true, expiresAt: f.now + 15 * 60_000 });
    expect(await f.desktop.start(link.token, "another browser")).toMatchObject({ ok: false, status: 409, code: "elsewhere" });
    expect(await f.desktop.start(link.token, first.secret)).toMatchObject({ ok: true, secret: first.secret });
    // The person comes first: an agent that held the screen loses it, and is told why when it tries.
    const lease = f.leases.holder("x11:local:91")!;
    expect(lease).toMatchObject({ bot: f.dir, conversation: "desktop:D1", agent: "a person, through desktop page link D1" });
    const busy = renderBusy({ key: "x11:local:91", label: "DISPLAY=:91", env: {} }, lease, f.leases.idleMs, f.dir);
    expect(busy).toContain("Not run: DISPLAY=:91 is in use by a person, through your desktop page link D1, since");
    expect(busy).toContain("pots page unlink D1 ends it now.");
    expect(f.leases.take("x11:local:91", { bot: f.dir, name: "Coworker", agent: "the main agent", conversation: "0" }).ok).toBe(false);
    // A second link cannot start while one is in use.
    const second = await f.desktop.create({ text: "Another step" });
    expect(await f.desktop.start(second.token, undefined)).toMatchObject({ ok: false, status: 409, code: "busy" });
    // Only the browser that started it hands it back.
    expect(await f.desktop.end(link.token, "another browser", "done", "")).toMatchObject({ ok: false, status: 403 });
    expect(await f.desktop.end(link.token, first.secret, "done", "  the code went\nto my email  ")).toEqual({ ok: true, restored: false });
    expect(await f.desktop.end(link.token, first.secret, "done", "")).toMatchObject({ ok: false, status: 410 });
    expect(f.leases.holder("x11:local:91")).toBeUndefined();
    expect(f.leases.take("x11:local:91", { bot: f.dir, name: "Coworker", agent: "the main agent", conversation: "0" }).ok).toBe(true);
    expect(f.woke).toEqual([
      {
        note: 'desktop page: someone handed your desktop back on link D1 (made for anyone) and pressed Done: the step is done, they say. Their note: "the code went\\nto my email". The screen is yours again.',
        requestId: "desktop:D1",
      },
    ]);
  });

  it("let only one of two links that are started at the same moment have the screen", async () => {
    const first = await f.desktop.create({ text: "One" });
    const second = await f.desktop.create({ text: "Two" });
    const results = await Promise.all([f.desktop.start(first.token, undefined), f.desktop.start(second.token, undefined)]);
    expect(results.map((result) => (result.ok ? "ok" : result.code)).sort()).toEqual(["busy", "ok"]);
    const winner = results[0]!.ok ? "D1" : "D2";
    expect(f.leases.holder("x11:local:91")).toMatchObject({ conversation: `desktop:${winner}` });
  });

  it("set the desktop's size back when they hand it back, or the link ends otherwise", async () => {
    const link = await f.desktop.create({ text: "Sign in", person: "test:@bob" });
    const started = await f.desktop.start(link.token, undefined);
    if (!started.ok) throw new Error(started.error);
    // The person's page took the phone's shape.
    server.width = 500;
    server.height = 1082;
    expect(await f.desktop.end(link.token, started.secret, "cannot", "")).toEqual({ ok: true, restored: true });
    expect([server.width, server.height]).toEqual([1280, 800]);
    expect(f.woke.at(-1)).toEqual({
      note: 'desktop page: someone handed your desktop back on link D1 (made for test:@bob) without doing the step: they pressed "I can\'t do it". They left no note. The screen is yours again. Its size is back to 1280×800, as at Start.',
      requestId: "desktop:D1",
    });

    // Taken back by the bot: the size goes back, and no wake.
    const other = await f.desktop.create({ text: "Again" });
    expect((await f.desktop.start(other.token, undefined)).ok).toBe(true);
    server.width = 600;
    expect(await f.desktop.revoke("D2")).toBe("D2");
    expect(server.width).toBe(1280);
    expect(await f.desktop.view(other.token)).toMatchObject({ state: "revoked" });
    expect(f.woke).toHaveLength(1);
    expect(await f.desktop.revoke("D2")).toBeUndefined();
    expect(await f.desktop.revoke("D9")).toBeUndefined();
  });

  it("end an hour after they were made unopened, and their minutes after Start, with a wake each", async () => {
    const unopened = await f.desktop.create({ text: "Nobody comes" });
    f.now += DESKTOP_UNOPENED_MS - 1;
    await f.desktop.checkExpiry();
    expect((await f.desktop.view(unopened.token))?.state).toBe("open");
    f.now += 1;
    expect((await f.desktop.view(unopened.token))?.state).toBe("expired");
    await f.desktop.checkExpiry();
    expect(await f.desktop.start(unopened.token, undefined)).toMatchObject({ ok: false, status: 410, code: "expired" });
    expect(f.woke).toEqual([{ note: expect.stringMatching(/^desktop page: link D1 \(made for anyone\) expired at .+: nobody pressed Start within an hour\.$/), requestId: "desktop:D1" }]);

    const started = await f.desktop.create({ text: "Comes, then leaves", minutes: 5 });
    const start = await f.desktop.start(started.token, undefined);
    if (!start.ok) throw new Error(start.error);
    server.height = 900;
    f.now += 5 * 60_000;
    await f.desktop.checkExpiry();
    expect(await f.desktop.end(started.token, start.secret, "done", "")).toMatchObject({ ok: false, status: 410 });
    expect(server.height).toBe(800);
    expect(f.leases.holder("x11:local:91")).toBeUndefined();
    expect(f.woke.at(-1)).toEqual({
      note: expect.stringMatching(/^desktop page: link D2 \(made for anyone\) ended at .+, 5 minutes after Start, and nobody pressed Done\. The screen is yours again\. Its size is back to 1280×800, as at Start\.$/),
      requestId: "desktop:D2",
    });
  });

  it("tell the bot once when Start cannot reach the desktop, and keep the link open", async () => {
    const link = await f.desktop.create({ text: "Sign in" });
    f.vnc = { port: server.port, passwordFile: "missing.env" };
    expect(await f.desktop.start(link.token, undefined)).toMatchObject({ ok: false, status: 503, code: "unreachable" });
    expect(await f.desktop.start(link.token, undefined)).toMatchObject({ ok: false, status: 503 });
    expect(f.woke).toEqual([{ note: expect.stringContaining("desktop page: someone pressed Start on link D1 (made for anyone), but Pots could not reach your desktop: cannot read the VNC password file"), requestId: "desktop:D1:unreachable" }]);
    f.vnc = { port: server.port, passwordFile: "vnc.env" };
    expect((await f.desktop.start(link.token, undefined)).ok).toBe(true);
  });

  it("set a wake that failed again later, without a restart", async () => {
    desktopTimes.wakeRetryMs = 5;
    try {
      const link = await f.desktop.create({ text: "Sign in" });
      const start = await f.desktop.start(link.token, undefined);
      if (!start.ok) throw new Error(start.error);
      f.failWakes = 2;
      expect(await f.desktop.end(link.token, start.secret, "done", "")).toEqual({ ok: true, restored: false });
      await waitFor(() => f.woke.length === 1, { what: "the wake, tried again" });
      expect(await f.sql.get("SELECT woken_at IS NOT NULL AS woken FROM bot_desktop_links")).toEqual({ woken: 1 });
    } finally {
      desktopTimes.wakeRetryMs = 10_000;
    }
  });
});

describe("desktop links after a stop or a crash", () => {
  it("go on where they were: a started link keeps the screen, one that ended meanwhile is finished once", async () => {
    const server = await vnc({ password: "pw", resizable: true });
    const leases = new ScreenLeases(join(temp(), "leases.sqlite"));
    const first = await fixture(server, { leases });
    const live = await first.desktop.create({ text: "Keeps going" });
    const ends = await first.desktop.create({ text: "Ends while Pots is down", minutes: 1 });
    const started = await first.desktop.start(live.token, undefined);
    if (!started.ok) throw new Error(started.error);
    // A crash: no stop, no wake, no size set back.
    await first.sql.run("UPDATE bot_desktop_links SET state = 'started', started_at = ?, layout = (SELECT layout FROM bot_desktop_links WHERE id = 1), expires_at = ? WHERE id = 2", first.now, first.now + 60_000);
    server.width = 500;
    leases.release(first.dir);
    await first.sql.close();

    const second = await fixture(server, { leases, dir: first.dir });
    second.now = first.now + 2 * 60_000;
    await second.desktop.holdScreens();
    expect(leases.holder("x11:local:91")).toMatchObject({ conversation: "desktop:D1" });
    await second.desktop.resume();
    expect((await second.desktop.view(live.token, started.secret))?.state).toBe("started");
    expect((await second.desktop.view(ends.token))?.state).toBe("expired");
    expect(second.woke.map((wake) => wake.requestId)).toEqual(["desktop:D2"]);
    expect(server.width).toBe(1280);
    // The browser that started it goes on.
    expect((await second.desktop.start(live.token, started.secret)).ok).toBe(true);
    await second.desktop.resume();
    expect(second.woke).toHaveLength(1);
    await second.desktop.stop();
    await second.sql.close();
    leases.close();
  });
});

describe("bot.json's vnc", () => {
  it("names a port on this computer and, if the server asks for one, the password file", () => {
    const dir = temp();
    const file = join(dir, "bot.json");
    const write = (vnc: unknown) => writeFileSync(file, JSON.stringify({ name: "Ada", channels: [], vnc }));
    write({ port: 5900, passwordFile: "vnc.env" });
    expect(readDefinition(file).definition.vnc).toEqual({ port: 5900, passwordFile: "vnc.env" });
    write({ port: 5901 });
    expect(readDefinition(file).definition.vnc).toEqual({ port: 5901 });
    for (const bad of [{ port: 0 }, { port: 5900.5 }, { port: "5900" }, { passwordFile: "vnc.env" }, { port: 5900, passwordFile: "" }, "5900"]) {
      write(bad);
      expect(() => readDefinition(file)).toThrow(`${file}: "vnc" must be {"port": <the port of the VNC server on this computer>, "passwordFile": "<a file in the secrets folder>"}`);
    }
    writeFileSync(file, JSON.stringify({ name: "Ada", channels: [] }));
    expect(readDefinition(file).definition.vnc).toBeUndefined();
  });
});

describe("the desktop page", () => {
  it("is in the person's language when Pots has it", () => {
    expect(pickLang("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(pickLang("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(pickLang("fr-FR,fr;q=0.9,zh;q=0.5")).toBe("zh");
    expect(pickLang("de")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
  });

  it("shows the bot's words only as text, and loads and talks only to its own address", () => {
    const view = {
      id: "D1",
      state: "open" as const,
      text: "</script><script>alert(1)</script> & <b>",
      input: null,
      area: null,
      minutes: 15,
      expiresAt: 0,
      startedAt: null,
      resizable: true,
      size: { width: 1280, height: 800 },
      mine: false,
      madeFor: null,
    };
    const html = renderDesktopPage(view, "Ada <x>", { lang: "en", quickTunnel: true, remote: "linux" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('<div class="ask">&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;</div>');
    expect(html).toContain('"text":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script> & \\u003cb>"');
    expect(html).toContain("Cloudflare can see the screen and what you type.");
    expect(html).not.toContain("style=");
    expect(renderDesktopPage(view, "Ada", { lang: "en", quickTunnel: false, remote: "linux" })).not.toContain("Cloudflare");
    expect(renderDesktopEnded("done", "Ada", "zh")).toContain("已交还给 Ada");
    const headers = desktopHeaders(["pages.example.test", "bad host/x", undefined]);
    expect(headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://pages.example.test ws://pages.example.test; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(headers["x-frame-options"]).toBe("DENY");
  });
});
