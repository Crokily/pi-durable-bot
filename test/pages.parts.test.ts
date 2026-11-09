import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/agent/agent.ts";
import { CLOUDFLARED_VERSION, downloadCloudflared, ensureCloudflared, untar } from "../src/pages/cloudflared.ts";
import { fileTestHooks, inside, openFile, pageFolder, pathSegments } from "../src/pages/files.ts";
import { PageHost, QUICK_TUNNEL_NOTE } from "../src/pages/host.ts";
import { readSettings } from "../src/pages/settings.ts";
import { BotPages, PAGE_DAYS, SECRET_LINK_MS, secretWakeRetry } from "../src/pages/store.ts";
import { QuickTunnel } from "../src/pages/tunnel.ts";
import { waitFor } from "./support/gateway.ts";

// The page server's parts on their own: the pages and links of a bot on a clock the test moves, the Quick Tunnel with a
// fake cloudflared, the download of cloudflared from a server of the test's own, and the host's port.

const DAY = 86_400_000;
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pots-pages-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("page paths", () => {
  it("refuses what could leave the folder or name another file", () => {
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("index.html")).toEqual(["index.html"]);
    expect(pathSegments("img/a%20b.png")).toEqual(["img", "a b.png"]);
    expect(pathSegments("sub/")).toEqual(["sub"]);
    expect(pathSegments("%252e%252e/x")).toEqual(["%2e%2e", "x"]);
    for (const bad of ["..", "../x", "a/../b", "%2e%2e/x", "%2E%2e/x", ".", "./x", "a%2fb", "a%2Fb", "a%5cb", "a\\b", "a//b", "%00", "a%00b", "%e0%a4%a"]) {
      expect({ bad, segments: pathSegments(bad) }).toEqual({ bad, segments: undefined });
    }
    if (process.platform === "win32") for (const bad of ["c:", "a:b", "CON", "nul.txt", "COM1.html", "x.", "x "]) expect(pathSegments(bad)).toBeUndefined();
  });
});

/** Make a link, or say why it cannot be made here: Windows without the right to make symbolic links. */
function linkOrSkip(make: () => void): boolean {
  try {
    make();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

const dirLink = process.platform === "win32" ? "junction" : "dir";

describe("opening a page file", () => {
  afterEach(() => {
    delete fileTestHooks.beforeOpen;
  });

  it("refuses a file, or a folder above it, swapped for a link between the check and the open", async () => {
    // The native realpath, as the server's: on Windows the other one keeps short names such as RUNNER~1.
    const root = realpathSync.native(temp());
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "outside-secret");
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "a.txt"), "outside-secret");
    writeFileSync(join(root, "a.txt"), "inside");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "inside");

    const plain = await openFile(root, ["a.txt"], false, true);
    expect(plain?.kind).toBe("file");
    if (plain?.kind === "file") {
      expect((await plain.handle.readFile()).toString()).toBe("inside");
      await plain.handle.close();
    }

    let swapped = false;
    fileTestHooks.beforeOpen = (path) => {
      rmSync(path);
      swapped = linkOrSkip(() => symlinkSync(join(outside, "secret.txt"), path, "file"));
    };
    expect(await openFile(root, ["a.txt"], false, true)).toBeUndefined();
    if (!swapped) writeFileSync(join(root, "a.txt"), "inside");

    fileTestHooks.beforeOpen = () => {
      renameSync(join(root, "sub"), join(root, "sub-before"));
      symlinkSync(join(outside, "sub"), join(root, "sub"), dirLink);
    };
    expect(await openFile(root, ["sub", "a.txt"], false, true)).toBeUndefined();
  });

  it("compares paths by their exact case, and a folder only with its separator", () => {
    const pages = join(sep === "/" ? "/home/bot" : "C:\\bot", "pages");
    expect(inside(join(pages, "Report"), join(pages, "report", "x.html"))).toBe(false);
    expect(inside(join(pages, "report"), join(pages, "report", "x.html"))).toBe(true);
    expect(inside(join(pages, "rep"), join(pages, "report", "x.html"))).toBe(false);
    expect(inside(join(pages, "report"), join(pages, "report"))).toBe(false);
    expect(inside(join(pages, "report"), join(pages, "report"), true)).toBe(true);
  });

  const probe = temp();
  writeFileSync(join(probe, "case-probe"), "");
  const caseSensitive = !existsSync(join(probe, "CASE-PROBE"));

  it.skipIf(!caseSensitive)("refuses a link in pages/Report to pages/report on a case-sensitive file system", async () => {
    const bot = temp();
    mkdirSync(join(bot, "pages", "report"), { recursive: true });
    mkdirSync(join(bot, "pages", "Report"), { recursive: true });
    writeFileSync(join(bot, "pages", "report", "x.html"), "the other page");
    if (!linkOrSkip(() => symlinkSync(join(bot, "pages", "report", "x.html"), join(bot, "pages", "Report", "x.html"), "file"))) return;
    const folder = await pageFolder(bot, "Report");
    expect(folder).toBe(join(realpathSync.native(bot), "pages", "Report"));
    expect(await openFile(folder!, ["x.html"], false, true)).toBeUndefined();
    expect(await pageFolder(bot, "REPORT")).toBeUndefined();
  });
});

interface Fixture {
  dir: string;
  secrets: string;
  sql: Database;
  pages: BotPages;
  woke: { note: string; requestId: string }[];
  now: number;
  /** How many of the next wakes fail. */
  failWakes: number;
}

async function fixture(): Promise<Fixture> {
  const dir = temp();
  const secrets = join(dir, "secrets");
  const sql = await openDatabase(join(dir, "bot.sqlite"));
  // From the wall clock: a written file's time is compared with it.
  const state = { now: Date.now(), failWakes: 0 };
  const woke: Fixture["woke"] = [];
  const seen = new Set<string>();
  const pages = await BotPages.open({
    id: "bot",
    dir,
    sql,
    secretsDir: secrets,
    name: () => "Coworker",
    // As the timers do: one wake per request ID.
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
  return Object.defineProperties({ dir, secrets, sql, pages, woke } as Omit<Fixture, "now" | "failWakes">, {
    now: { get: () => state.now, set: (value: number) => (state.now = value) },
    failWakes: { get: () => state.failWakes, set: (value: number) => (state.failWakes = value) },
  }) as Fixture;
}

const page = (f: Fixture, name: string, text = "<h1>hi</h1>") => {
  mkdirSync(join(f.dir, "pages", ...name.split("/")), { recursive: true });
  writeFileSync(join(f.dir, "pages", ...name.split("/"), "index.html"), text);
};

describe("password links", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(async () => {
    await f.pages.stopCleanup();
    await f.sql.close();
  });

  const form = (values: Record<string, string>) => new URLSearchParams(values);

  it("expire an hour after they were made, unsubmitted", async () => {
    const link = await f.pages.createSecretLink({ file: "a.env", keys: ["A"] });
    expect(link.expiresAt).toBe(f.now + SECRET_LINK_MS);
    f.now += SECRET_LINK_MS - 1;
    expect((await f.pages.secretLink(link.token))?.state).toBe("open");
    f.now += 1;
    expect((await f.pages.secretLink(link.token))?.state).toBe("expired");
    expect(await f.pages.submitSecret(link.token, form({ A: "x" }))).toBe("expired");
    expect(existsSync(join(f.secrets, "a.env"))).toBe(false);
    expect(f.woke).toEqual([]);
  });

  it("take one submission when two come at once", async () => {
    const link = await f.pages.createSecretLink({ file: "b.env", keys: ["A", "B"], person: "slack:@U1" });
    const results = await Promise.all([f.pages.submitSecret(link.token, form({ A: "one", B: "two" })), f.pages.submitSecret(link.token, form({ A: "three", B: "four" }))]);
    expect(results.sort()).toEqual(["saved", "used"]);
    expect(readFileSync(join(f.secrets, "b.env"), "utf8")).toMatch(/^A=(one|three)\nB=(two|four)\n# pots-secret-claim: [0-9a-f]{24}\n$/);
    expect(f.woke).toEqual([{ note: "secret page: someone used link S1 (made for slack:@U1) and wrote A, B to b.env in the secrets folder", requestId: "secret:S1" }]);
  });

  it("refuse a value with a line break, a missing value, a bad file or key, and keep the link open", async () => {
    const link = await f.pages.createSecretLink({ file: "c.env", keys: ["A"] });
    expect(await f.pages.submitSecret(link.token, form({ A: "a\nB=injected" }))).toEqual({ problem: "The value of A has a line break or another control character; paste it again." });
    expect(await f.pages.submitSecret(link.token, form({ A: "  " }))).toEqual({ problem: "Fill in every value." });
    expect((await f.pages.secretLink(link.token))?.state).toBe("open");
    await expect(f.pages.createSecretLink({ file: "../x.env", keys: ["A"] })).rejects.toThrow('bad --file "../x.env"');
    await expect(f.pages.createSecretLink({ file: "x.env", keys: ["1A"] })).rejects.toThrow('bad key "1A"');
    await expect(f.pages.createSecretLink({ file: "x.env", keys: [] })).rejects.toThrow("give 1 to 20 keys");
    expect(await f.pages.submitSecret("nope", form({ A: "x" }))).toBe("missing");
    expect(await f.pages.revoke("S1")).toBe("S1");
    expect(await f.pages.secretLink(link.token)).toBeUndefined();
    expect(await f.pages.submitSecret(link.token, form({ A: "x" }))).toBe("missing");
  });

  it("never take an older file with the keys for the claim's write after a crash", async () => {
    mkdirSync(f.secrets, { recursive: true });
    writeFileSync(join(f.secrets, "r.env"), "A=written-a-moment-ago\n");
    const link = await f.pages.createSecretLink({ file: "r.env", keys: ["A"] });
    f.pages.crashTests.beforeSecretWrite = () => {
      throw new Error("crash");
    };
    await expect(f.pages.submitSecret(link.token, form({ A: "lost" }))).rejects.toThrow("crash");
    expect(await f.sql.all("SELECT state FROM bot_secret_links")).toEqual([{ state: "writing" }]);
    f.pages.crashTests.beforeSecretWrite = () => {};
    await f.pages.resume();
    expect(await f.sql.all("SELECT state, claim FROM bot_secret_links")).toEqual([{ state: "open", claim: null }]);
    expect(f.woke).toEqual([]);
    expect(readFileSync(join(f.secrets, "r.env"), "utf8")).toBe("A=written-a-moment-ago\n");
    expect(await f.pages.submitSecret(link.token, form({ A: "new" }))).toBe("saved");
    const claim = (await f.sql.get<{ claim: string }>("SELECT claim FROM bot_secret_links"))!.claim;
    expect(readFileSync(join(f.secrets, "r.env"), "utf8")).toBe(`A=new\n# pots-secret-claim: ${claim}\n`);
    // The next password page to the same file puts its own line in place of this one.
    const next = await f.pages.createSecretLink({ file: "r.env", keys: ["B"] });
    expect(await f.pages.submitSecret(next.token, form({ B: "b" }))).toBe("saved");
    expect(readFileSync(join(f.secrets, "r.env"), "utf8")).toMatch(/^A=new\nB=b\n# pots-secret-claim: [0-9a-f]{24}\n$/);
  });

  it("finish a submission a crash cut off: a written file counts, an unwritten one opens the link again", async () => {
    const written = await f.pages.createSecretLink({ file: "w.env", keys: ["A"] });
    const unwritten = await f.pages.createSecretLink({ file: "u.env", keys: ["A"] });
    f.pages.crashTests.afterSecretWrite = () => {
      throw new Error("crash");
    };
    await expect(f.pages.submitSecret(written.token, form({ A: "kept" }))).rejects.toThrow("crash");
    // A claim whose write never happened.
    await f.sql.run("UPDATE bot_secret_links SET state = 'writing', claimed_at = ? WHERE id = 2", f.now);
    f.pages.crashTests.afterSecretWrite = () => {};
    expect(f.woke).toEqual([]);
    await f.pages.resume();
    expect(await f.sql.all("SELECT id, state FROM bot_secret_links ORDER BY id")).toEqual([
      { id: 1, state: "used" },
      { id: 2, state: "open" },
    ]);
    expect(f.woke.map((wake) => wake.requestId)).toEqual(["secret:S1"]);
    expect(await f.pages.submitSecret(unwritten.token, form({ A: "now" }))).toBe("saved");
    await f.pages.resume();
    expect(f.woke.map((wake) => wake.requestId)).toEqual(["secret:S1", "secret:S2"]);
  });

  it("say the values are saved when the bot's wake fails, and set the wake later, without a restart", async () => {
    secretWakeRetry.ms = 5;
    try {
      const link = await f.pages.createSecretLink({ file: "a.env", keys: ["A"] });
      // The first try and the first retry fail.
      f.failWakes = 2;
      expect(await f.pages.submitSecret(link.token, form({ A: "kept" }))).toBe("saved");
      expect(f.woke).toEqual([]);
      expect(readFileSync(join(f.secrets, "a.env"), "utf8")).toContain("A=kept");
      await waitFor(() => f.woke.length === 1);
      expect(f.woke.map((wake) => wake.requestId)).toEqual(["secret:S1"]);
      expect(await f.sql.get("SELECT state, woken_at IS NOT NULL AS woken FROM bot_secret_links")).toEqual({ state: "used", woken: 1 });
    } finally {
      secretWakeRetry.ms = 10_000;
    }
  });
});

describe("page cleanup", () => {
  let f: Fixture;
  beforeEach(async () => (f = await fixture()));
  afterEach(async () => f.sql.close());

  it("deletes a page nobody opened and nothing changed for 30 days, with its links; not keep/, not one opened", async () => {
    page(f, "old");
    page(f, "opened");
    page(f, "keep/report");
    const old = await f.pages.createLink("old");
    const opened = await f.pages.createLink("opened");
    await f.pages.createLink("keep/report");
    f.now += 20 * DAY;
    expect(await f.pages.openLink(opened.token)).toMatchObject({ page: "opened" });
    f.now += (PAGE_DAYS - 20) * DAY - 1;
    expect(await f.pages.cleanup()).toEqual([]);
    f.now += 2;
    expect(await f.pages.cleanup()).toEqual(["old"]);
    expect(existsSync(join(f.dir, "pages", "old"))).toBe(false);
    expect(await f.pages.openLink(old.token)).toBeUndefined();
    f.now += 30 * DAY;
    expect(await f.pages.cleanup()).toEqual(["opened"]);
    expect(existsSync(join(f.dir, "pages", "keep", "report", "index.html"))).toBe(true);
    expect((await f.pages.list()).pages.map((item) => item.page)).toEqual(["keep/report"]);
  });

  it("keeps a page opened or changed between its first look and the delete", async () => {
    page(f, "opened-meanwhile");
    page(f, "edited-meanwhile");
    page(f, "untouched");
    const link = await f.pages.createLink("opened-meanwhile");
    // The daily look sees the other two for the first time.
    expect(await f.pages.cleanup()).toEqual([]);
    f.now += (PAGE_DAYS + 1) * DAY;
    const deleted = await f.pages.cleanup({
      beforeDelete: async (name) => {
        if (name === "opened-meanwhile") await f.pages.openLink(link.token);
        if (name === "edited-meanwhile") writeFileSync(join(f.dir, "pages", name, "index.html"), "<h1>new text</h1>");
      },
    });
    expect(deleted).toEqual(["untouched"]);
    expect(readdirSync(join(f.dir, "pages")).sort()).toEqual(["edited-meanwhile", "opened-meanwhile"]);
    expect(await f.pages.openLink(link.token)).toMatchObject({ page: "opened-meanwhile" });
  });

  it("keeps an old page that gets a new link, also one made between its first look and the delete", async () => {
    page(f, "linked-before");
    page(f, "linked-meanwhile");
    page(f, "untouched");
    // The daily look sees them for the first time.
    expect(await f.pages.cleanup()).toEqual([]);
    f.now += (PAGE_DAYS + 1) * DAY;
    const before = await f.pages.createLink("linked-before");
    let meanwhile: { token: string } | undefined;
    const deleted = await f.pages.cleanup({
      beforeDelete: async (name) => {
        if (name === "linked-meanwhile") meanwhile = await f.pages.createLink(name);
      },
    });
    expect(deleted).toEqual(["untouched"]);
    expect(await f.pages.openLink(before.token)).toMatchObject({ page: "linked-before" });
    expect(await f.pages.openLink(meanwhile!.token)).toMatchObject({ page: "linked-meanwhile" });
  });

  it("makes and opens no link of a page while the cleanup removes it", async () => {
    page(f, "old");
    const before = await f.pages.createLink("old");
    f.now += (PAGE_DAYS + 1) * DAY;
    let making: Promise<string> | undefined;
    let opening: Promise<unknown> | undefined;
    const deleted = await f.pages.cleanup({
      beforeRemove: async (name) => {
        making = f.pages.createLink(name).then(
          (link) => `made ${link.id}`,
          (error: Error) => error.message,
        );
        opening = f.pages.openLink(before.token);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    expect(deleted).toEqual(["old"]);
    expect(await making).toBe("there is no page folder pages/old/ (or it is a symbolic link); write pages/old/index.html first");
    expect(await opening).toBeUndefined();
    expect(await f.sql.all("SELECT * FROM bot_page_links")).toEqual([]);
    expect(existsSync(join(f.dir, "pages", "old"))).toBe(false);
  });

  it("takes back the links of a page whose folder is gone, and of one that a new folder of the same name replaced", async () => {
    page(f, "gone");
    const first = await f.pages.createLink("gone");
    rmSync(join(f.dir, "pages", "gone"), { recursive: true });
    expect(await f.pages.openLink(first.token)).toBeUndefined();
    page(f, "gone", "<h1>new page</h1>");
    expect(await f.pages.openLink(first.token)).toBeUndefined();
    const second = await f.pages.createLink("gone");
    expect(await f.pages.openLink(second.token)).toMatchObject({ id: "L2", page: "gone" });
    // Deleted and made again with nobody opening it between: the old link is still dead.
    rmSync(join(f.dir, "pages", "gone"), { recursive: true });
    page(f, "gone", "<h1>third page</h1>");
    expect(await f.pages.openLink(second.token)).toBeUndefined();
    const third = await f.pages.createLink("gone");
    expect((await f.pages.list()).pages.find((item) => item.page === "gone")!.links.map((link) => link.link)).toEqual([third.id]);
  });

  it("counts a change to any file, also one whose time was set back, and deletes nothing a page links to", async () => {
    page(f, "site");
    mkdirSync(join(f.dir, "pages", "site", "img"));
    writeFileSync(join(f.dir, "pages", "site", "img", "a.svg"), "<svg/>");
    await f.pages.cleanup();
    f.now += (PAGE_DAYS - 1) * DAY;
    // The bot copies a file in with an old time, as cp -p does.
    writeFileSync(join(f.dir, "pages", "site", "img", "b.svg"), "<svg/>");
    utimesSync(join(f.dir, "pages", "site", "img", "b.svg"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await f.pages.cleanup();
    f.now += 2 * DAY;
    expect(await f.pages.cleanup()).toEqual([]);

    // A page folder that is a link is not a page: its target stays.
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep-me.txt"), "x");
    try {
      symlinkSync(outside, join(f.dir, "pages", "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    f.now += 60 * DAY;
    expect(await f.pages.cleanup()).toEqual(["site"]);
    expect(existsSync(join(outside, "keep-me.txt"))).toBe(true);
  });
});

/** A fake cloudflared: says an address and a connection as cloudflared does; it ends or changes address when the test says. */
const FAKE = `
const fs = require("fs");
const [dir] = process.argv.slice(2);
const runs = Number(fs.existsSync(dir + "/runs") ? fs.readFileSync(dir + "/runs", "utf8") : 0) + 1;
fs.writeFileSync(dir + "/runs", String(runs));
fs.writeFileSync(dir + "/args-" + runs + ".json", JSON.stringify(process.argv.slice(3)));
fs.writeFileSync(dir + "/pid-" + runs, String(process.pid));
const say = (text) => process.stderr.write("2026-11-09T06:36:01Z INF " + text + "\\n");
say("Requesting new quick Tunnel on trycloudflare.com...");
say("|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
say("|  https://run-" + runs + "-fake.trycloudflare.com                                       |");
if (!fs.existsSync(dir + "/silent-" + runs)) setTimeout(() => say("Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.192.7 location=syd01 protocol=quic"), 30);
if (fs.existsSync(dir + "/exit-" + runs)) setTimeout(() => process.exit(3), 200);
if (fs.existsSync(dir + "/change-" + runs)) setTimeout(() => say("|  https://changed-" + runs + "-fake.trycloudflare.com  |"), 200);
setInterval(() => {}, 1000);
`;

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Quick Tunnel", () => {
  let dir: string;
  let script: string;
  let tunnel: QuickTunnel | undefined;
  const messages: string[] = [];
  beforeEach(() => {
    dir = temp();
    script = join(dir, "fake-cloudflared.cjs");
    writeFileSync(script, FAKE);
    messages.length = 0;
  });
  afterEach(async () => tunnel?.stop());

  const make = (options: Partial<ConstructorParameters<typeof QuickTunnel>[0]> = {}) =>
    (tunnel = new QuickTunnel({
      target: "http://127.0.0.1:41234",
      home: dir,
      program: async () => [process.execPath, script, dir],
      print: (message) => messages.push(message),
      backoff: { firstMs: 20, maxMs: 100, resetAfterMs: 60_000 },
      startTimeoutMs: 5_000,
      ready: async () => {},
      ...options,
    }));

  it("reads the address once a connection works, with a config file of its own", async () => {
    const quick = make();
    expect(quick.status()).toEqual({ state: "off" });
    const [first, second] = await Promise.all([quick.ensure(), quick.ensure()]);
    expect([first, second]).toEqual(["https://run-1-fake.trycloudflare.com", "https://run-1-fake.trycloudflare.com"]);
    expect(quick.status()).toEqual({ state: "ready", address: first });
    expect(readFileSync(join(dir, "runs"), "utf8")).toBe("1");
    const args = JSON.parse(readFileSync(join(dir, "args-1.json"), "utf8")) as string[];
    expect(args).toEqual(["tunnel", "--no-autoupdate", "--config", join(dir, "cloudflared.yml"), "--url", "http://127.0.0.1:41234", "--metrics", "127.0.0.1:0"]);
    expect(readFileSync(join(dir, "cloudflared.yml"), "utf8")).toContain("no-autoupdate: true");
    await quick.stop();
    expect(running(Number(readFileSync(join(dir, "pid-1"), "utf8")))).toBe(false);
    expect(quick.status().state).toBe("off");
  });

  it("starts cloudflared again when it ends, and takes the new address; an address that changes counts too", async () => {
    writeFileSync(join(dir, "exit-1"), "");
    writeFileSync(join(dir, "change-2"), "");
    const quick = make();
    expect(await quick.ensure()).toBe("https://run-1-fake.trycloudflare.com");
    await waitFor(() => quick.address === "https://run-2-fake.trycloudflare.com", { what: "the second run's address", timeout: 5_000 });
    expect(messages).toContain("quick tunnel ended");
    await waitFor(() => quick.address === "https://changed-2-fake.trycloudflare.com", { what: "the changed address", timeout: 5_000 });
    expect(await quick.ensure()).toBe("https://changed-2-fake.trycloudflare.com");
  });

  it("says what cloudflared said when it gets no connection, and when there is no cloudflared", async () => {
    writeFileSync(join(dir, "silent-1"), "");
    await expect(make({ startTimeoutMs: 400 }).ensure()).rejects.toThrow(
      /^the Cloudflare Quick Tunnel had no address after 0 seconds; cloudflared said:\n(?:.*\n)*.*https:\/\/run-1-fake\.trycloudflare\.com/,
    );
    await tunnel!.stop();
    const missing = make({ program: async () => Promise.reject(new Error("could not download cloudflared")) });
    await expect(missing.ensure()).rejects.toThrow("could not download cloudflared");
    expect(missing.status()).toEqual({ state: "off", error: "could not download cloudflared" });
  });

  it.skipIf(process.platform === "win32")("stops a cloudflared that a crashed gateway left running", async () => {
    // A process whose command line names cloudflared and this home's config file, as the tunnel starts it.
    const left = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "cloudflared", "--config", join(dir, "cloudflared.yml")], { stdio: "ignore" });
    writeFileSync(join(dir, "cloudflared.pid"), `${left.pid}\n${join(dir, "cloudflared.yml")}\n`);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await make().ensure();
      await waitFor(() => !running(left.pid!), { what: "the left cloudflared to stop", timeout: 5_000 });
      // A process ID file that names another program does not stop it.
      await tunnel!.stop();
      writeFileSync(join(dir, "cloudflared.pid"), `${unrelated.pid}\n${join(dir, "cloudflared.yml")}\n`);
      await make().ensure();
      expect(running(unrelated.pid!)).toBe(true);
    } finally {
      left.kill("SIGKILL");
      unrelated.kill("SIGKILL");
    }
  });
});

describe("the page host", () => {
  let dir: string;
  let script: string;
  let hosts: PageHost[] = [];
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
    dir = temp();
    script = join(dir, "fake-cloudflared.cjs");
    writeFileSync(script, FAKE);
    hosts = [];
  });
  afterEach(async () => {
    for (const host of hosts) await host.stop();
    await f.sql.close();
  });

  const host = () => {
    const made = new PageHost({
      home: dir,
      settingsFile: join(dir, "settings.json"),
      binDir: join(dir, "bin"),
      print: () => {},
      cloudflared: async () => [process.execPath, script, dir],
      tunnel: { backoff: { firstMs: 20, maxMs: 100, resetAfterMs: 60_000 }, startTimeoutMs: 5_000, ready: async () => {} },
    });
    hosts.push(made);
    return made;
  };

  it("keeps the port it chose, and reports it taken instead of choosing another", async () => {
    const first = host();
    await first.start();
    const port = first.port!;
    expect(readSettings(join(dir, "settings.json"))).toEqual({ pagePort: port });
    const second = host();
    await second.start();
    expect(second.status()).toMatchObject({ listening: false, problem: expect.stringContaining(`port ${port} (pagePort in`) });
    expect(readSettings(join(dir, "settings.json"))).toEqual({ pagePort: port });
    await first.stop();
    const third = host();
    await third.start();
    expect(third.port).toBe(port);
  });

  it.skipIf(process.platform === "win32")("stops a tunnel a crashed gateway left, also when settings.json has a publicUrl", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ publicUrl: "https://coly.tail1234.ts.net" }));
    const left = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "cloudflared", "--config", join(dir, "cloudflared.yml")], { stdio: "ignore" });
    writeFileSync(join(dir, "cloudflared.pid"), `${left.pid}\n${join(dir, "cloudflared.yml")}\n`);
    try {
      await host().start();
      await waitFor(() => !running(left.pid!), { what: "the left tunnel to stop", timeout: 5_000 });
      expect(existsSync(join(dir, "cloudflared.pid"))).toBe(false);
    } finally {
      left.kill("SIGKILL");
    }
  });

  it("answers Not found for a deleted page's links and answers, and for a file swapped for a link", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ publicUrl: "https://coly.tail1234.ts.net" }));
    page(f, "gone");
    writeFileSync(join(f.dir, "pages", "gone", "a.txt"), "inside");
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "outside-secret");
    const pages = host();
    await pages.start();
    pages.register(f.pages);
    const link = await pages.link(f.pages, "gone");
    const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${pages.port}${new URL(link.url).pathname}${path}`, init);
    const submit = () => at("__pots/submit", { method: "POST", body: JSON.stringify({ submission: "s", version: "v", answers: {} }) });
    expect((await at("")).status).toBe(200);

    fileTestHooks.beforeOpen = (path) => {
      rmSync(path);
      if (!linkOrSkip(() => symlinkSync(join(outside, "secret.txt"), path, "file"))) writeFileSync(path, "inside");
    };
    try {
      const swapped = await at("a.txt");
      const body = await swapped.text();
      expect(body).not.toContain("outside-secret");
      if (body !== "inside") expect(swapped.status).toBe(404);
    } finally {
      delete fileTestHooks.beforeOpen;
    }

    rmSync(join(f.dir, "pages", "gone"), { recursive: true });
    expect((await at("")).status).toBe(404);
    expect((await submit()).status).toBe(404);
    page(f, "gone", "<h1>someone else's page</h1>");
    const old = await at("");
    expect([old.status, await old.text()]).toEqual([404, "Not found."]);
    expect((await submit()).status).toBe(404);
  });

  it("starts the Quick Tunnel at the first link, and none while settings.json has a publicUrl", async () => {
    page(f, "demo");
    const pages = host();
    await pages.start();
    pages.register(f.pages);
    expect(pages.status()).toMatchObject({ listening: true, via: "quick-tunnel" });
    expect(existsSync(join(dir, "runs"))).toBe(false);
    const link = await pages.link(f.pages, "demo", "slack:@U1");
    expect(link).toEqual({ link: "L1", url: expect.stringMatching(/^https:\/\/run-1-fake\.trycloudflare\.com\/p\/[A-Za-z0-9_-]{24}\/$/), via: "quick-tunnel", note: QUICK_TUNNEL_NOTE });
    expect(link.note).toBe(
      "This link goes through a Cloudflare Quick Tunnel: its address changes when Pots restarts, Cloudflare can see the page's content, and Cloudflare says Quick Tunnels are for testing and development.",
    );
    const secret = await pages.secret(f.pages, { file: "a.env", keys: ["A"] });
    expect(secret.note).toContain("Cloudflare can see what is typed on the page");
    expect(readFileSync(join(dir, "runs"), "utf8")).toBe("1");
    // The password page says so, when the address is a Quick Tunnel.
    const form = await fetch(`http://127.0.0.1:${pages.port}${new URL(secret.url).pathname}`);
    expect(await form.text()).toContain("Cloudflare can see what you type here");

    writeFileSync(join(dir, "settings.json"), JSON.stringify({ publicUrl: "https://coly.tail1234.ts.net", pagePort: pages.port }));
    const fixed = await pages.link(f.pages, "demo");
    expect(fixed).toEqual({ link: "L2", url: expect.stringMatching(/^https:\/\/coly\.tail1234\.ts\.net\/p\/[A-Za-z0-9_-]{24}\/$/), via: "public-url" });
    expect(running(Number(readFileSync(join(dir, "pid-1"), "utf8")))).toBe(false);
    expect(pages.status()).toEqual({ port: pages.port, listening: true, via: "public-url", address: "https://coly.tail1234.ts.net" });
    const list = (await pages.list(f.pages)) as { pages: { links: { url: string }[] }[] };
    expect(list.pages[0]!.links.map((item) => new URL(item.url).host)).toEqual(["coly.tail1234.ts.net", "coly.tail1234.ts.net"]);
  });
});

/** A small tar.gz with one file, as the macOS release is made. */
function tgz(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("the cloudflared download", () => {
  let server: Server;
  let base: string;
  const served = new Map<string, Buffer>();
  let requests: string[] = [];
  let cut = false;

  beforeEach(async () => {
    requests = [];
    cut = false;
    server = createServer((req, res) => {
      requests.push(req.url!);
      const body = served.get(req.url!.split("/").pop()!);
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { "content-length": body.length });
      if (cut) {
        res.write(body.subarray(0, 10));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      setTimeout(() => res.end(body), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const program = Buffer.from("#!/bin/sh\necho cloudflared version test\n");
  served.set("cf-raw", program);
  const archive = tgz("cloudflared", program);
  served.set("cf.tgz", archive);

  it("puts a program in place only once its SHA-256 matches, executable", async () => {
    const bin = temp();
    const path = await downloadCloudflared(bin, { releases: base, platform: "linux", arch: "x64", assets: { "linux-x64": { name: "cf-raw", sha256: sha(program) } } });
    expect(path).toBe(join(bin, "cloudflared"));
    expect(readFileSync(path)).toEqual(program);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(requests).toEqual([`/${CLOUDFLARED_VERSION}/cf-raw`]);
    expect(readdirSync(bin)).toEqual(["cloudflared"]);
  });

  it("opens the macOS .tgz after checking it, and checks the program in it too", async () => {
    // An empty archive: two blocks of zeros.
    expect(untar(Buffer.alloc(1024), "cloudflared")).toBeUndefined();
    const bin = temp();
    const path = await downloadCloudflared(bin, {
      releases: base,
      platform: "darwin",
      arch: "arm64",
      assets: { "darwin-arm64": { name: "cf.tgz", sha256: sha(program), archiveSha256: sha(archive) } },
    });
    expect(readFileSync(path)).toEqual(program);
    const other = temp();
    await expect(
      downloadCloudflared(other, { releases: base, platform: "darwin", arch: "arm64", assets: { "darwin-arm64": { name: "cf.tgz", sha256: "0".repeat(64), archiveSha256: sha(archive) } } }),
    ).rejects.toThrow("cloudflared in cf.tgz does not match its SHA-256");
    expect(readdirSync(other)).toEqual([]);
  });

  it("leaves nothing when the SHA-256 does not match or the download is cut off; .exe on Windows", async () => {
    const bin = temp();
    await expect(downloadCloudflared(bin, { releases: base, platform: "linux", arch: "x64", assets: { "linux-x64": { name: "cf-raw", sha256: "0".repeat(64) } } })).rejects.toThrow(
      `could not download cloudflared ${CLOUDFLARED_VERSION} from ${base}/${CLOUDFLARED_VERSION}/cf-raw: cf-raw does not match its SHA-256`,
    );
    expect(readdirSync(bin)).toEqual([]);
    cut = true;
    await expect(downloadCloudflared(bin, { releases: base, platform: "linux", arch: "x64", assets: { "linux-x64": { name: "cf-raw", sha256: sha(program) } } })).rejects.toThrow(
      "could not download cloudflared",
    );
    expect(readdirSync(bin)).toEqual([]);
    cut = false;
    // What a download cut off by a crash left is cleared by the next one.
    writeFileSync(join(bin, "cloudflared.0a1b2c3d4e5f.download"), "half");
    const windows = await downloadCloudflared(bin, { releases: base, platform: "win32", arch: "x64", assets: { "win32-x64": { name: "cf-raw", sha256: sha(program) } } });
    expect(windows).toBe(join(bin, "cloudflared.exe"));
    expect(readdirSync(bin)).toEqual(["cloudflared.exe"]);
    await expect(downloadCloudflared(bin, { platform: "aix" as NodeJS.Platform, arch: "ppc64" })).rejects.toThrow("there is no cloudflared release for aix-ppc64");
  });

  it("downloads once when asked twice at the same time, and not at all when there is one", async () => {
    const bin = temp();
    const options = { releases: base, platform: "linux" as const, arch: "x64", path: "", assets: { "linux-x64": { name: "cf-raw", sha256: sha(program) } } };
    const [a, b] = await Promise.all([ensureCloudflared(bin, options), ensureCloudflared(bin, options)]);
    expect(a).toBe(b);
    expect(requests).toHaveLength(1);
    expect(await ensureCloudflared(bin, options)).toBe(a);
    expect(requests).toHaveLength(1);
  });
});

// The real release from GitHub, and a real Quick Tunnel through Cloudflare. Run with: POTS_TEST_NETWORK=1 npx vitest run test/pages.parts.test.ts
describe.skipIf(!process.env.POTS_TEST_NETWORK)("the real cloudflared", { timeout: 300_000 }, () => {
  it("downloads the pinned release, checks it, runs it, and serves a page through a Quick Tunnel", async () => {
    const bin = temp();
    const path = await downloadCloudflared(bin);
    expect(execFileSync(path, ["--version"], { encoding: "utf8" })).toContain(`cloudflared version ${CLOUDFLARED_VERSION}`);
    const origin = createServer((_req, res) => res.end("hello through the tunnel"));
    const elsewhere = createServer((_req, res) => res.end("the person's own service"));
    for (const server of [origin, elsewhere]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const home = temp();
    // A ~/.cloudflared/config.yml of the person's own, whose ingress would take a Quick Tunnel elsewhere, must not count.
    const person = temp();
    mkdirSync(join(person, ".cloudflared"));
    writeFileSync(join(person, ".cloudflared", "config.yml"), `ingress:\n  - service: http://127.0.0.1:${(elsewhere.address() as { port: number }).port}\n`);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = person;
    process.env.USERPROFILE = person;
    const tunnel = new QuickTunnel({
      target: `http://127.0.0.1:${(origin.address() as { port: number }).port}`,
      home,
      program: async () => [path],
      print: () => {},
    });
    try {
      const address = await tunnel.ensure();
      expect(address).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
      // The tunnel gave the address once public DNS had its name, so the first try works, or one of the next few.
      let body = "";
      for (let i = 0; i < 10 && body !== "hello through the tunnel"; i++) {
        body = await fetch(address)
          .then((response) => response.text())
          .catch(() => "");
        if (body !== "hello through the tunnel") await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      expect(body).toBe("hello through the tunnel");
    } finally {
      await tunnel.stop();
      origin.close();
      elsewhere.close();
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
