import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Reader } from "../src/pages/rfb.ts";
import { type FakeModel, startFakeModel, wakes } from "./support/fake-model.ts";
import { pause, TestGateway, waitFor } from "./support/gateway.ts";
import { FakeVnc } from "./support/vnc.ts";

// The desktop page from outside: a real gateway with one bot whose bot.json names a VNC server of the test's own, its
// pots page desktop command, and what a person's browser does: HTTP to the page server on 127.0.0.1, as the public
// address would forward it, and the page's WebSocket, which speaks VNC to Pots. settings.json gives a publicUrl, so no
// Quick Tunnel starts.

const PUBLIC = "https://pages.example.test";
const PASSWORD = "pots-vnc";

let model: FakeModel;
let gateway: TestGateway;
let desktop: FakeVnc;

beforeAll(async () => {
  model = await startFakeModel();
  desktop = await FakeVnc.start({ password: PASSWORD, resizable: true, name: "the bot's desktop" });
  gateway = new TestGateway({ model });
  writeFileSync(join(gateway.home, "settings.json"), JSON.stringify({ publicUrl: PUBLIC }));
  mkdirSync(join(gateway.home, "secrets"), { recursive: true });
  writeFileSync(join(gateway.home, "secrets", "vnc.env"), `VNC_PASSWORD=${PASSWORD}\n`);
  setVnc({ port: desktop.port, passwordFile: "vnc.env" });
  await gateway.start();
}, 60_000);

afterAll(async () => {
  await gateway?.dispose();
  await desktop?.close();
  await model?.close();
});

function setVnc(vnc: Record<string, unknown>): void {
  const file = join(gateway.botDir, "bot.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), vnc }, null, 2));
}

const port = () => (JSON.parse(readFileSync(join(gateway.home, "settings.json"), "utf8")) as { pagePort: number }).pagePort;
const pathOf = (url: string) => new URL(url).pathname;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: port(), method, path, headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** A request from the desktop page itself: its Origin is the public address, with the cookie its browser has. */
const fromPage = (method: string, path: string, cookie?: string, body?: unknown) =>
  http(method, path, { headers: { origin: PUBLIC, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function potsJson<T>(...args: string[]): Promise<T> {
  const result = await gateway.run(args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as T;
}

/** The cookie a Start answer sets, as the browser sends it back. */
function cookieOf(answer: Answer): string {
  const header = answer.headers["set-cookie"];
  const line = Array.isArray(header) ? header[0]! : header!;
  return line.split(";")[0]!;
}

interface Browser {
  ws: WebSocket;
  read(n: number): Promise<Buffer>;
  send(bytes: number[] | Buffer): void;
  closed: Promise<number>;
}

/** The desktop page's WebSocket. Resolves with the HTTP status when Pots refuses it. */
function openSocket(path: string, cookie?: string, origin = PUBLIC): Promise<Browser | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port()}${path}ws`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
    const reader = new Reader();
    ws.on("message", (data: Buffer) => reader.push(data));
    const closed = new Promise<number>((done) => ws.on("close", (code) => (reader.fail(new Error(`closed ${code}`)), done(code))));
    ws.on("unexpected-response", (_request, response) => resolve(response.statusCode!));
    ws.on("open", () => resolve({ ws, read: (n) => reader.read(n), send: (bytes) => ws.send(Buffer.from(bytes)), closed }));
    ws.on("error", (error) => reject(error));
  });
}

/** noVNC's side of the handshake that Pots offers: RFB 3.8, no password. Then ClientInit and the ServerInit. */
async function handshake(browser: Browser, shared: boolean): Promise<{ width: number; height: number; name: string }> {
  expect((await browser.read(12)).toString("latin1")).toBe("RFB 003.008\n");
  browser.send(Buffer.from("RFB 003.008\n", "latin1"));
  expect([...(await browser.read(2))]).toEqual([1, 1]);
  browser.send([1]);
  expect([...(await browser.read(4))]).toEqual([0, 0, 0, 0]);
  browser.send([shared ? 1 : 0]);
  const head = await browser.read(24);
  const name = (await browser.read(head.readUInt32BE(20))).toString("utf8");
  return { width: head.readUInt16BE(0), height: head.readUInt16BE(2), name };
}

function keyEvent(keysym: number, down: boolean): Buffer {
  const message = Buffer.alloc(8);
  message[0] = 4;
  message[1] = down ? 1 : 0;
  message.writeUInt32BE(keysym, 4);
  return message;
}

function setDesktopSize(width: number, height: number): Buffer {
  const message = Buffer.alloc(24);
  message[0] = 251;
  message.writeUInt16BE(width, 2);
  message.writeUInt16BE(height, 4);
  message[6] = 1;
  message.writeUInt32BE(0x6b8b4567, 8);
  message.writeUInt16BE(width, 16);
  message.writeUInt16BE(height, 18);
  return message;
}

interface Link {
  link: string;
  url: string;
  expires: string;
  via: string;
  note?: string;
}

describe("desktop pages", { timeout: 120_000 }, () => {
  let first: Link;
  let cookie: string;
  let browser: Browser;

  it("are made once the VNC server of bot.json answers, and show nothing before Start", async () => {
    first = await potsJson<Link>("page", "desktop", "--text", "Solve the CAPTCHA, then press Done", "--for", "test:@alice", "--input", "code");
    expect(first).toEqual({ link: "D1", url: expect.stringMatching(/^https:\/\/pages\.example\.test\/d\/[A-Za-z0-9_-]{24}\/$/), expires: expect.any(String), via: "public-url" });
    expect(Math.abs(new Date(first.expires).getTime() - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    // Pots checked the desktop, as a viewer that shares it with the others.
    expect(desktop.connections.at(-1)).toMatchObject({ signedIn: true, shared: true });

    const page = await http("GET", pathOf(first.url), { headers: { "accept-language": "en-US" } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'; script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain('<div class="ask">Solve the CAPTCHA, then press Done</div>');
    expect(page.body).toContain('<script type="module" src="../../__pots/kit/desktop/desktop.js"></script>');
    expect(page.body).not.toContain("Cloudflare");
    // The page's files are in the kit.
    for (const file of ["desktop.js", "desktop.css", "novnc.js", "novnc/LICENSE.MPL-2.0"]) expect((await http("GET", `/__pots/kit/desktop/${file}`)).status).toBe(200);
    expect(JSON.parse((await http("GET", `${pathOf(first.url)}state`)).body)).toMatchObject({ state: "open", mine: false, resizable: true, size: null });
    expect(await openSocket(pathOf(first.url))).toBe(410);
    expect((await http("POST", pathOf(first.url))).status).toBe(405);
    const missing = await http("GET", "/d/AAAAAAAAAAAAAAAAAAAAAAAA/");
    expect([missing.status, missing.body.includes("This link does not work")]).toEqual([404, true]);
  });

  it("bind to the first browser that presses Start", async () => {
    const path = pathOf(first.url);
    expect((await http("POST", `${path}start`)).status).toBe(403);
    expect((await http("POST", `${path}start`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const started = await http("POST", `${path}start`, { headers: { origin: PUBLIC, "x-forwarded-proto": "https" } });
    expect(started.status).toBe(200);
    expect(String(started.headers["set-cookie"])).toMatch(/^pots_desktop=[A-Za-z0-9_-]{43}; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/);
    cookie = cookieOf(started);
    expect(JSON.parse(started.body)).toMatchObject({ ok: true, resizable: true, size: { width: 1280, height: 800 } });
    expect(JSON.parse((await http("GET", `${path}state`, { headers: { cookie } })).body)).toMatchObject({ state: "started", mine: true, size: { width: 1280, height: 800 } });
    expect(JSON.parse((await http("GET", `${path}state`)).body)).toMatchObject({ state: "started", mine: false, size: null });
    const elsewhere = await fromPage("POST", `${path}start`);
    expect([elsewhere.status, JSON.parse(elsewhere.body).code]).toEqual([409, "elsewhere"]);
    expect((await fromPage("POST", `${path}start`, cookie)).status).toBe(200);
  });

  it("carry the browser's connection to the VNC server, signed in by Pots and shared", async () => {
    const path = pathOf(first.url);
    expect(await openSocket(path)).toBe(403);
    expect(await openSocket(path, cookie, "https://evil.example")).toBe(403);
    browser = (await openSocket(path, cookie)) as Browser;
    // The browser asks for the desktop alone; Pots keeps it shared with its other viewers.
    expect(await handshake(browser, false)).toEqual({ width: 1280, height: 800, name: "the bot's desktop" });
    const connection = desktop.connections.at(-1)!;
    expect(connection).toMatchObject({ signedIn: true, shared: true });
    browser.send(keyEvent(0x61, true));
    browser.send(keyEvent(0x61, false));
    await waitFor(() => connection.keys.length === 2, { what: "the keys at the VNC server" });
    expect(connection.keys).toEqual([
      { keysym: 0x61, down: true },
      { keysym: 0x61, down: false },
    ]);
    // The page takes the phone's shape.
    browser.send(setDesktopSize(500, 1082));
    await waitFor(() => desktop.width === 500, { what: "the desktop to take the phone's shape" });
    // The same browser opens it again, in another tab: that one takes over.
    const again = (await openSocket(path, cookie)) as Browser;
    expect(await browser.closed).toBe(4001);
    browser = again;
    expect(await handshake(browser, true)).toMatchObject({ width: 500, height: 1082 });
  });

  it("wake the bot once when the person hands the desktop back, with their note, and set its size back", async () => {
    const path = pathOf(first.url);
    expect((await fromPage("POST", `${path}end`, "pots_desktop=someone-else", { how: "done", note: "" })).status).toBe(403);
    expect((await fromPage("POST", `${path}end`, cookie, { how: "maybe" })).status).toBe(400);
    const ended = await fromPage("POST", `${path}end`, cookie, { how: "done", note: "The code went to my email." });
    expect([ended.status, JSON.parse(ended.body)]).toEqual([200, { ok: true, restored: true }]);
    expect([desktop.width, desktop.height]).toEqual([1280, 800]);
    expect(await browser.closed).toBe(4000);
    const note =
      'desktop page: someone handed your desktop back on link D1 (made for test:@alice) and pressed Done: the step is done, they say. Their note: "The code went to my email.". The screen is yours again. Its size is back to 1280×800, as at Start.';
    await waitFor(() => wakes(model).some((wake) => wake.includes(note)), { what: "the hand-back's wake" });
    expect(gateway.query("SELECT request_id, source FROM bot_timers WHERE request_id LIKE 'desktop:%'")).toEqual([{ request_id: "desktop:D1", source: "pages" }]);
    expect(wakes(model).find((wake) => wake.includes(note))).toContain("[wake] one of your page links was used or ended");
    expect((await fromPage("POST", `${path}end`, cookie, { how: "done" })).status).toBe(410);
    expect((await fromPage("POST", `${path}start`, cookie)).status).toBe(410);
    const page = await http("GET", path, { headers: { "accept-language": "zh-CN" } });
    expect([page.status, page.body.includes("已交还给 Coworker")]).toEqual([410, true]);
    expect(await openSocket(path, cookie)).toBe(410);
  });

  it("are taken back by pots page unlink, which ends a started one without a wake", async () => {
    const link = await potsJson<Link>("page", "desktop", "--text", "Approve the sign-in");
    const started = await fromPage("POST", `${pathOf(link.url)}start`);
    const open = (await openSocket(pathOf(link.url), cookieOf(started))) as Browser;
    await handshake(open, true);
    open.send(setDesktopSize(700, 400));
    await waitFor(() => desktop.width === 700, { what: "the resize" });
    expect((await gateway.run(["page", "unlink", link.url])).stdout).toBe(`Unlinked ${link.link}.\n`);
    expect(await open.closed).toBe(4000);
    expect(desktop.width).toBe(1280);
    expect((await http("GET", pathOf(link.url))).status).toBe(410);
    await pause(500);
    expect(wakes(model).filter((wake) => wake.includes(`link ${link.link} `))).toEqual([]);
  });

  it("are listed, and a started one goes on after a restart, with the desktop's size set back at the stop", async () => {
    const link = await potsJson<Link>("page", "desktop", "--text", "Keep going after a restart", "--minutes", "30");
    const started = await fromPage("POST", `${pathOf(link.url)}start`);
    const own = cookieOf(started);
    let open = (await openSocket(pathOf(link.url), own)) as Browser;
    await handshake(open, true);
    open.send(setDesktopSize(640, 480));
    await waitFor(() => desktop.width === 640, { what: "the resize" });
    const list = await potsJson<{ desktopLinks: { link: string; url: string; state: string; connected: boolean; for: string | null }[] }>("page", "list");
    expect(list.desktopLinks.map((item) => [item.link, item.state])).toEqual([
      ["D1", "done"],
      [link.link, "started"],
    ]);
    expect(list.desktopLinks[1]).toMatchObject({ url: link.url, connected: true, for: null });

    await gateway.stop();
    expect(await open.closed).toBe(1012);
    expect(desktop.width).toBe(1280);
    await gateway.start();
    expect(JSON.parse((await http("GET", `${pathOf(link.url)}state`, { headers: { cookie: own } })).body)).toMatchObject({ state: "started", mine: true });
    open = (await openSocket(pathOf(link.url), own)) as Browser;
    expect(await handshake(open, true)).toMatchObject({ width: 1280, height: 800 });
    await fromPage("POST", `${pathOf(link.url)}end`, own, { how: "cannot", note: "" });
    expect(await open.closed).toBe(4000);
  });

  it("tell the bot when the VNC server stops answering, and are not made while it does not answer", async () => {
    const other = await FakeVnc.start({ password: PASSWORD });
    setVnc({ port: other.port, passwordFile: "vnc.env" });
    // bot.json's change applies within seconds.
    let made: { status: number | null; stdout: string } = { status: 1, stdout: "" };
    for (let tries = 0; tries < 40; tries++) {
      made = await gateway.run(["page", "desktop", "--text", "On the other desktop"]);
      if (made.status === 0 && other.connections.length > 0) break;
      if (made.status === 0) await gateway.run(["page", "unlink", (JSON.parse(made.stdout) as Link).link]);
      await pause(250);
    }
    const link = JSON.parse(made.stdout) as Link;
    const started = await fromPage("POST", `${pathOf(link.url)}start`);
    expect(started.status).toBe(200);
    const port = other.port;
    await other.close();
    const lost = (await openSocket(pathOf(link.url), cookieOf(started))) as Browser;
    expect(await lost.closed).toBe(4002);
    const note = `desktop page: the person on link ${link.link} (made for anyone) lost your desktop: Pots could not reach it: no VNC server listens at 127.0.0.1:${port}`;
    await waitFor(() => wakes(model).some((wake) => wake.includes(note)), { what: "the wake about the lost desktop" });
    const again = (await openSocket(pathOf(link.url), cookieOf(started))) as Browser;
    expect(await again.closed).toBe(4002);
    await pause(300);
    expect(wakes(model).filter((wake) => wake.includes(note))).toHaveLength(1);
    const refused = await gateway.run(["page", "desktop", "--text", "x"]);
    expect([refused.status, refused.stderr]).toEqual([1, expect.stringContaining(`no VNC server listens at 127.0.0.1:${port} (the port of "vnc" in bot.json)`)]);
    setVnc({ port: desktop.port, passwordFile: "vnc.env" });
  });
});
