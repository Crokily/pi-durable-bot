import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeModel, startFakeModel, wakes } from "./support/fake-model.ts";
import { TestGateway, waitFor } from "./support/gateway.ts";

// The page server from outside: a real gateway with one bot, its pots page commands, and HTTP requests to the page server
// on 127.0.0.1 as the public address would forward them. settings.json gives a publicUrl, so no Quick Tunnel starts.

const PUBLIC = "https://pages.example.test";
/** What the secrets folder holds; no page link may ever serve it. */
const OUTSIDE = "SLACK_BOT_TOKEN=xoxb-outside-secret";

let model: FakeModel;
let gateway: TestGateway;

beforeAll(async () => {
  model = await startFakeModel();
  gateway = new TestGateway({ model });
  writeFileSync(join(gateway.home, "settings.json"), JSON.stringify({ publicUrl: `${PUBLIC}/` }));
  mkdirSync(join(gateway.home, "secrets"), { recursive: true });
  writeFileSync(join(gateway.home, "secrets", "slack.env"), `${OUTSIDE}\n`);
  writePage("demo", { "index.html": "<!doctype html><h1>Deploy plan</h1>", "style.css": "h1 { color: teal }", "sub/index.html": "<p>sub</p>" });
  await gateway.start();
}, 60_000);

afterAll(async () => {
  await gateway?.dispose();
  await model?.close();
});

function writePage(name: string, files: Record<string, string>, dir = gateway.botDir): void {
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, "pages", name, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}

const port = () => (JSON.parse(readFileSync(join(gateway.home, "settings.json"), "utf8")) as { pagePort: number }).pagePort;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** An HTTP request with the path exactly as given: no client fixes "..", "%2e" or backslashes first. */
function http(method: string, path: string, options: { body?: string; type?: string; to?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: options.to ?? port(), method, path, headers: options.body === undefined ? {} : { "content-type": options.type ?? "application/json" } },
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

const pathOf = (url: string) => new URL(url).pathname;

async function potsJson<T>(...args: string[]): Promise<T> {
  const result = await gateway.run(args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as T;
}

/** Every value of every table of the bot's database, as one text. */
function everything(): string {
  const db = new DatabaseSync(join(gateway.botDir, "bot.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all())).join("\n");
  } finally {
    db.close();
  }
}

interface Link {
  link: string;
  url: string;
  via: string;
  note?: string;
}

describe("pages", { timeout: 120_000 }, () => {
  let demo: Link;

  it("makes a link to a page, kept before it is given out, and serves the page's files at it", async () => {
    demo = await potsJson<Link>("page", "link", "demo", "--for", "test:@alice");
    expect(demo).toEqual({ link: "L1", url: expect.stringMatching(/^https:\/\/pages\.example\.test\/p\/[A-Za-z0-9_-]{24}\/$/), via: "public-url" });
    expect(gateway.query("SELECT id, page, made_for FROM bot_page_links")).toEqual([{ id: 1, page: "demo", made_for: "test:@alice" }]);

    const page = await http("GET", pathOf(demo.url));
    expect(page.status).toBe(200);
    expect(page.body).toBe("<!doctype html><h1>Deploy plan</h1>");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    // The bot's pages get no CSP: they may load what they like.
    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect((await http("GET", `${pathOf(demo.url)}style.css`)).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await http("GET", `${pathOf(demo.url)}sub/`)).body).toBe("<p>sub</p>");
    // Relative links need the closing "/": a folder without it is sent back with it.
    const bare = await http("GET", pathOf(demo.url).slice(0, -1));
    expect([bare.status, bare.headers.location]).toEqual([301, `${pathOf(demo.url).split("/")[2]}/`]);
    expect((await http("GET", `${pathOf(demo.url)}sub`)).headers.location).toBe("sub/");
    // No listing, and an unknown token or file is not found, with the same headers.
    const missing = await http("GET", "/p/AAAAAAAAAAAAAAAAAAAAAAAA/");
    expect([missing.status, missing.headers["referrer-policy"], missing.headers["x-content-type-options"]]).toEqual([404, "no-referrer", "nosniff"]);
    expect((await http("GET", "/")).status).toBe(404);
    expect((await http("GET", "/p/")).status).toBe(404);
    expect((await http("GET", `${pathOf(demo.url)}nope.html`)).status).toBe(404);
    expect(gateway.query<{ opened_at: number | null }>("SELECT opened_at FROM bot_pages WHERE name = 'demo'")[0]!.opened_at).toBeGreaterThan(0);
  });

  it("serves only files inside the link's own page folder", async () => {
    const pageDir = join(gateway.botDir, "pages", "demo");
    const secrets = join(gateway.home, "secrets");
    const made: string[] = [];
    const tryLink = (make: () => void, path: string) => {
      try {
        make();
        made.push(path);
      } catch (error) {
        // Windows without the right to make symbolic links.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    };
    tryLink(() => symlinkSync(join(secrets, "slack.env"), join(pageDir, "link.txt"), "file"), "link.txt");
    tryLink(() => symlinkSync(secrets, join(pageDir, "linked"), "dir"), "linked/slack.env");
    tryLink(() => linkSync(join(secrets, "slack.env"), join(pageDir, "hard.txt")), "hard.txt");
    if (process.platform === "win32") tryLink(() => symlinkSync(secrets, join(pageDir, "junction"), "junction"), "junction/slack.env");
    const escapes = [
      "../../../secrets/slack.env",
      "../../../../secrets/slack.env",
      "%2e%2e/%2e%2e/%2e%2e/secrets/slack.env",
      "%2E%2E/%2E%2E/%2E%2E/%2E%2E/secrets/slack.env",
      "..%2f..%2f..%2fsecrets%2fslack.env",
      "sub%2f..%2f..%2f..%2f..%2fsecrets%2fslack.env",
      "..%5c..%5c..%5csecrets%5cslack.env",
      "..\\..\\..\\secrets\\slack.env",
      "sub\\..\\..\\..\\..\\secrets\\slack.env",
      "./../../../secrets/slack.env",
      "sub/../../../../secrets/slack.env",
      "%252e%252e/%252e%252e/%252e%252e/secrets/slack.env",
      "..%00/x",
      ...made,
    ];
    for (const escape of escapes) {
      const answer = await http("GET", `${pathOf(demo.url)}${escape}`);
      expect({ escape, status: answer.status }).toEqual({ escape, status: 404 });
      expect(answer.body).not.toContain("outside-secret");
    }
    // The links of at least the symbolic link and the hard link were made, also on Windows CI.
    expect(made.length).toBeGreaterThanOrEqual(process.platform === "win32" ? 1 : 3);

    // A page folder that is itself a link is no page; one replaced by a link after its link was made serves nothing.
    tryLink(() => symlinkSync(secrets, join(gateway.botDir, "pages", "evil"), process.platform === "win32" ? "junction" : "dir"), "evil");
    if (existsSync(join(gateway.botDir, "pages", "evil"))) {
      const refused = await gateway.run(["page", "link", "evil"]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("there is no page folder pages/evil/ (or it is a symbolic link)");
    }
    writePage("swap", { "index.html": "swap" });
    const swap = await potsJson<Link>("page", "link", "swap");
    rmSync(join(gateway.botDir, "pages", "swap"), { recursive: true });
    tryLink(() => symlinkSync(secrets, join(gateway.botDir, "pages", "swap"), process.platform === "win32" ? "junction" : "dir"), "swap");
    for (const path of ["slack.env", ""]) {
      const answer = await http("GET", `${pathOf(swap.url)}${path}`);
      expect(answer.status).toBe(404);
      expect(answer.body).not.toContain("outside-secret");
    }
  });

  it("gives a page's version, which changes when a file of the page changes", async () => {
    const info = async () => JSON.parse((await http("GET", `${pathOf(demo.url)}__pots/info`)).body) as { page: string; version: string };
    const first = await info();
    expect(first).toEqual({ page: "demo", version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect((await info()).version).toBe(first.version);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(gateway.botDir, "pages", "demo", "style.css"), "h1 { color: navy }");
    const second = await info();
    expect(second.version).not.toBe(first.version);
    writePage("demo", { "sub/new.txt": "new" });
    expect((await info()).version).not.toBe(second.version);
  });

  it("sends the page's version with each HTML file, never from a kept copy, and keeps other files cacheable", async () => {
    const version = async () => (JSON.parse((await http("GET", `${pathOf(demo.url)}__pots/info`)).body) as { version: string }).version;
    const page = await http("GET", pathOf(demo.url));
    expect(page.headers["server-timing"]).toBe(`pots-version;desc="${await version()}"`);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers.etag).toBeUndefined();
    const css = await http("GET", `${pathOf(demo.url)}style.css`);
    expect(css.headers["server-timing"]).toBeUndefined();
    expect(css.headers.etag).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(gateway.botDir, "pages", "demo", "style.css"), "h1 { color: teal }");
    const again = await http("GET", pathOf(demo.url));
    expect(again.headers["server-timing"]).toBe(`pots-version;desc="${await version()}"`);
    expect(again.headers["server-timing"]).not.toBe(page.headers["server-timing"]);
  });

  it("wakes the bot once per submission, also for a retry and for posts at the same time", async () => {
    const submit = (body: unknown) => http("POST", `${pathOf(demo.url)}__pots/submit`, { body: typeof body === "string" ? body : JSON.stringify(body) });
    const version = (JSON.parse((await http("GET", `${pathOf(demo.url)}__pots/info`)).body) as { version: string }).version;
    const answer = { submission: "sub-1", version, answers: { step3: "change", comment: "try it on staging first" } };
    const first = await submit(answer);
    expect([first.status, JSON.parse(first.body)]).toEqual([200, { ok: true }]);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    // The response was lost and the page sends it again.
    expect((await submit(answer)).status).toBe(200);
    const together = await Promise.all(Array.from({ length: 5 }, () => submit({ ...answer, submission: "sub-2" })));
    expect(together.map((item) => item.status)).toEqual([200, 200, 200, 200, 200]);
    expect(gateway.query("SELECT request_id, source FROM bot_timers WHERE request_id LIKE 'page:%' ORDER BY id")).toEqual([
      { request_id: "page:L1:sub-1", source: "pages" },
      { request_id: "page:L1:sub-2", source: "pages" },
    ]);
    const note = `page answer: someone used link L1 (made for test:@alice) on page demo (version ${version}): {"step3":"change","comment":"try it on staging first"}`;
    await waitFor(() => wakes(model).filter((wake) => wake.includes(note)).length === 2, { what: "the two page answers' wakes" });
    expect(wakes(model).find((wake) => wake.includes(note))).toContain(`\nNote: ${note}\n`);

    for (const [body, error] of [
      ["{not json", "the body is not JSON"],
      [{ version, answers: {} }, '"submission" must be an ID of 1 to 128 characters, the same on a retry'],
      [{ submission: "x", answers: {} }, '"version" must be the version from __pots/info that the person saw'],
      [{ submission: "x", version, answers: [1] }, '"answers" must be a JSON object'],
      [{ submission: "x", version, answers: { text: "x".repeat(70_000) } }, "the body is over 64 KB"],
    ] as const) {
      const refused = await submit(body);
      expect([refused.status, JSON.parse(refused.body)]).toEqual([400, { ok: false, error }]);
    }
    expect((await http("GET", `${pathOf(demo.url)}__pots/submit`)).status).toBe(405);
    expect((await http("POST", "/p/AAAAAAAAAAAAAAAAAAAAAAAA/__pots/submit", { body: JSON.stringify(answer) })).status).toBe(404);
  });

  it("lists the pages with their links, and takes a link back", async () => {
    const extra = await potsJson<Link>("page", "link", "demo");
    const list = await potsJson<{ via: string; address: string; pages: { page: string; kept: boolean; lastOpened: string | null; deleteAfter: string | null; links: { link: string; url: string; for: string | null }[] }[] }>(
      "page",
      "list",
    );
    expect(list.via).toBe("public-url");
    expect(list.address).toBe(PUBLIC);
    const page = list.pages.find((item) => item.page === "demo")!;
    expect(page.kept).toBe(false);
    expect(page.lastOpened).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(new Date(page.deleteAfter!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(page.links).toEqual([
      { link: "L1", url: demo.url, for: "test:@alice", created: expect.any(String) },
      { link: extra.link, url: extra.url, for: null, created: expect.any(String) },
    ]);

    expect((await gateway.run(["page", "unlink", extra.url])).stdout).toBe(`Unlinked ${extra.link}.\n`);
    expect((await http("GET", pathOf(extra.url))).status).toBe(404);
    expect((await http("POST", `${pathOf(extra.url)}__pots/submit`, { body: JSON.stringify({ submission: "a", version: "", answers: {} }) })).status).toBe(404);
    const again = await gateway.run(["page", "unlink", extra.link]);
    expect([again.status, again.stderr.trim()]).toEqual([1, `ERROR\n  there is no link "${extra.link}" of this bot (pots page list shows them)`]);
    const bad = await gateway.run(["page", "link", "../secrets"]);
    expect(bad.stderr).toContain('bad page name "../secrets"');
  });

  it("shows the page server in pots status", async () => {
    const lines = (await gateway.run(["status"])).stdout.split("\n");
    expect(lines[3]).toBe(`pages: port ${port()}, ${PUBLIC} (public-url)`);
  });

  let secret: { link: string; url: string; expires: string; via: string };
  let values: { API_KEY: string; API_SECRET: string };

  it("serves the password page in a sandbox of its own, and a GET does not use the link up", async () => {
    secret = await potsJson("page", "secret", "--file", "pagetest.env", "--keys", "API_KEY,API_SECRET", "--text", "Paste the two keys\nfrom the dashboard", "--for", "test:@bob");
    expect(secret).toEqual({ link: "S1", url: expect.stringMatching(/^https:\/\/pages\.example\.test\/s\/[A-Za-z0-9_-]{24}$/), expires: expect.any(String), via: "public-url" });
    expect(Math.abs(new Date(secret.expires).getTime() - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    for (let i = 0; i < 2; i++) {
      const page = await http("GET", pathOf(secret.url));
      expect(page.status).toBe(200);
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toBe("sandbox allow-forms; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      expect(csp).not.toMatch(/allow-same-origin|allow-scripts/);
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      expect(page.body.match(/type="password"/g)).toHaveLength(2);
      expect(page.body).toContain('name="API_KEY"');
      expect(page.body).toContain("Paste the two keys\nfrom the dashboard");
      expect(page.body).not.toContain("<script");
      // Not a Quick Tunnel here: no word about Cloudflare.
      expect(page.body).not.toContain("Cloudflare");
    }
    const form = (fields: Record<string, string>) => http("POST", pathOf(secret.url), { body: new URLSearchParams(fields).toString(), type: "application/x-www-form-urlencoded" });
    const half = await form({ API_KEY: "only-one" });
    expect(half.status).toBe(400);
    expect(half.body).toContain("Fill in every value.");
    expect(half.headers["content-security-policy"]).toContain("sandbox allow-forms");

    values = { API_KEY: `key-${Date.now()}-a7`, API_SECRET: `secret-${Date.now()}-b9` };
    const saved = await form(values);
    expect(saved.status).toBe(200);
    expect(saved.body).toContain("API_KEY, API_SECRET were written to pagetest.env.");
    expect(saved.headers["content-security-policy"]).toContain("sandbox allow-forms");
    const used = await form(values);
    expect(used.status).toBe(409);
    expect(used.body).toContain("This link was already used");
    expect((await http("GET", pathOf(secret.url))).status).toBe(410);
  });

  it("writes the values only to the file, owner-only, and tells the bot which keys came", async () => {
    const file = join(gateway.home, "secrets", "pagetest.env");
    // With the comment line of the submission that wrote them, which readers skip.
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^API_KEY=${values.API_KEY}\nAPI_SECRET=${values.API_SECRET}\n# pots-secret-claim: [0-9a-f]{24}\n$`));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const note = "secret page: someone used link S1 (made for test:@bob) and wrote API_KEY, API_SECRET to pagetest.env in the secrets folder";
    await waitFor(() => wakes(model).some((wake) => wake.includes(note)), { what: "the password page's wake" });
    expect(gateway.query("SELECT request_id, note FROM bot_timers WHERE request_id = 'secret:S1'")).toEqual([{ request_id: "secret:S1", note }]);
    expect(gateway.query("SELECT state FROM bot_secret_links WHERE id = 1")).toEqual([{ state: "used" }]);
    for (const value of Object.values(values)) {
      expect(everything()).not.toContain(value);
      expect(JSON.stringify(model.requests)).not.toContain(value);
      expect(JSON.stringify(gateway.output)).not.toContain(value);
    }
  });

  it("finishes a password page's submission that a crash cut off, after the restart", async () => {
    for (const [index, crash] of [
      [2, "crash-after-secret-write"],
      [3, "crash-after-secret-used"],
    ] as const) {
      const link = await potsJson<{ link: string; url: string }>("page", "secret", "--file", `crash${index}.env`, "--keys", "TOKEN");
      expect(link.link).toBe(`S${index}`);
      writeFileSync(join(gateway.botDir, crash), "");
      const value = `crash-value-${index}-${Date.now()}`;
      await http("POST", pathOf(link.url), { body: `TOKEN=${value}`, type: "application/x-www-form-urlencoded" }).catch(() => undefined);
      await gateway.exited();
      expect(gateway.running).toBe(false);
      await gateway.start();
      const note = `secret page: someone used link S${index} (made for anyone) and wrote TOKEN to crash${index}.env in the secrets folder`;
      await waitFor(() => wakes(model).some((wake) => wake.includes(note)), { what: `the wake after ${crash}` });
      expect(readFileSync(join(gateway.home, "secrets", `crash${index}.env`), "utf8")).toMatch(new RegExp(`^TOKEN=${value}\n# pots-secret-claim: [0-9a-f]{24}\n$`));
      expect(gateway.query("SELECT state FROM bot_secret_links WHERE id = ?", index)).toEqual([{ state: "used" }]);
      expect(gateway.query("SELECT count(*) AS n FROM bot_timers WHERE request_id = ?", `secret:S${index}`)).toEqual([{ n: 1 }]);
      expect((await http("POST", pathOf(link.url), { body: "TOKEN=again", type: "application/x-www-form-urlencoded" })).status).toBe(409);
      expect(everything()).not.toContain(value);
    }
    expect(wakes(model).filter((wake) => wake.includes("secret page: someone used link S2 "))).toHaveLength(1);
    expect(wakes(model).filter((wake) => wake.includes("secret page: someone used link S3 "))).toHaveLength(1);

    // Dying after the claim, before the write, over a file that already has the key, written a moment ago: the old file
    // is not taken for the claim's write, so the link is open again after the restart, and no wake says it was used.
    writeFileSync(join(gateway.home, "secrets", "crash4.env"), "TOKEN=written-a-moment-ago\n");
    const link = await potsJson<{ link: string; url: string }>("page", "secret", "--file", "crash4.env", "--keys", "TOKEN");
    writeFileSync(join(gateway.botDir, "crash-before-secret-write"), "");
    await http("POST", pathOf(link.url), { body: "TOKEN=lost-in-the-crash", type: "application/x-www-form-urlencoded" }).catch(() => undefined);
    await gateway.exited();
    await gateway.start();
    expect(gateway.query("SELECT state FROM bot_secret_links WHERE id = 4")).toEqual([{ state: "open" }]);
    expect(readFileSync(join(gateway.home, "secrets", "crash4.env"), "utf8")).toBe("TOKEN=written-a-moment-ago\n");
    expect((await http("POST", pathOf(link.url), { body: "TOKEN=sent-again", type: "application/x-www-form-urlencoded" })).status).toBe(200);
    expect(readFileSync(join(gateway.home, "secrets", "crash4.env"), "utf8")).toMatch(/^TOKEN=sent-again\n# pots-secret-claim: [0-9a-f]{24}\n$/);
    const note = "secret page: someone used link S4 (made for anyone) and wrote TOKEN to crash4.env in the secrets folder";
    await waitFor(() => wakes(model).some((wake) => wake.includes(note)), { what: "the wake of the second submission" });
    expect(wakes(model).filter((wake) => wake.includes(note))).toHaveLength(1);
    expect(everything()).not.toContain("lost-in-the-crash");
  });

  it("keeps links and the port across a restart", async () => {
    const before = port();
    await gateway.stop();
    await gateway.start();
    expect(port()).toBe(before);
    const page = await http("GET", pathOf(demo.url));
    expect([page.status, page.body]).toEqual([200, "<!doctype html><h1>Deploy plan</h1>"]);
    const version = (JSON.parse((await http("GET", `${pathOf(demo.url)}__pots/info`)).body) as { version: string }).version;
    expect((await http("POST", `${pathOf(demo.url)}__pots/submit`, { body: JSON.stringify({ submission: "after-restart", version, answers: { ok: true } }) })).status).toBe(200);
    await waitFor(() => wakes(model).some((wake) => wake.includes(`on page demo (version ${version}): {"ok":true}`)), { what: "the answer after the restart" });
  });
});

describe("a page port that is taken", { timeout: 60_000 }, () => {
  let other: TestGateway;
  let blocker: Server;
  let taken: number;

  beforeAll(async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    taken = (blocker.address() as { port: number }).port;
    other = new TestGateway({ model });
    writeFileSync(join(other.home, "settings.json"), JSON.stringify({ publicUrl: PUBLIC, pagePort: taken }));
    writePage("demo", { "index.html": "x" }, other.botDir);
    await other.start();
  }, 60_000);

  afterAll(async () => {
    await other?.dispose();
    await new Promise((resolve) => blocker?.close(resolve));
  });

  it("is reported, not replaced, and the bot runs without pages", async () => {
    const message = `port ${taken} (pagePort in ${join(other.home, "settings.json")}) is taken by another program, so pages are not served; free it, or set another pagePort there and restart Pots (a Funnel or proxy that points at the old port must change too)`;
    expect(other.output.find((line) => line.message === "page server not running")).toMatchObject({ problem: message });
    expect((await other.run(["status"])).stdout.split("\n")[3]).toBe(`pages: not served: ${message}`);
    const link = await other.run(["page", "link", "demo"]);
    expect([link.status, link.stderr.trim()]).toEqual([1, `ERROR\n  the page server is not running: ${message}`]);
    expect((JSON.parse(readFileSync(join(other.home, "settings.json"), "utf8")) as { pagePort: number }).pagePort).toBe(taken);
  });
});
