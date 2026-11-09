import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The page kit (kit/pots.js) in Node, without a browser: its plain functions, run as a browser runs the file, in a
// context of its own with no document. What needs a page (reading a form, the status line, reloading) is left to a
// browser.

const source = readFileSync(new URL("../kit/pots.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../kit/pots.css", import.meta.url), "utf8");

/** The kit is plain JavaScript, with no types. */
type Kit = any;

function loadKit(): Kit {
  const context: Record<string, unknown> = {};
  runInNewContext(source, context);
  return context.PotsKit;
}

const kit = loadKit();

interface Call {
  url: string;
  body: { submission: string; version: string; answers: unknown };
}

/** A fake Pots: each try takes the next of the given results, a status or "throw" (no connection). */
function fakeIo(results: (number | "throw")[], version: () => Promise<string> = async () => "v3") {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const states: string[] = [];
  let ids = 0;
  const io = {
    fetch: async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const result = results.shift() ?? 200;
      if (result === "throw") throw new TypeError("Failed to fetch");
      return { ok: result >= 200 && result < 300, status: result, text: async () => (result === 400 ? "bad body" : "") };
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    randomId: () => `id-${++ids}`,
    version,
    onStatus: (state: string) => states.push(state),
  };
  return { io, calls, sleeps, states };
}

const answers = { target: { question: "Where?", answer: { value: "test", label: "Test" } } };

describe("the page kit", () => {
  it("finds the page's own base in its path, also behind a path prefix", () => {
    expect(kit.pageBase("/p/AbC_-1/")).toBe("/p/AbC_-1/");
    expect(kit.pageBase("/p/AbC_-1/index.html")).toBe("/p/AbC_-1/");
    expect(kit.pageBase("/p/AbC_-1/docs/more.html")).toBe("/p/AbC_-1/");
    expect(kit.pageBase("/pots/p/AbC_-1/")).toBe("/pots/p/AbC_-1/");
    expect(kit.pageBase("/p/AbC_-1")).toBeNull();
    expect(kit.pageBase("/s/AbC_-1")).toBeNull();
  });

  it("makes submission IDs of 128 random bits", () => {
    let n = 0;
    const id = kit.newSubmissionId((bytes: Uint8Array) => bytes.forEach((_, i) => (bytes[i] = (n++ * 37) % 256)));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id.slice(0, 4)).toBe("0025");
  });

  it("counts UTF-8 bytes as Pots does", () => {
    for (const text of ["", "plain", "é", "部署计划", "✓ done", "👍🏽 ok", "\ud800 lone"]) expect(kit.utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("gives each kind of question its answer, with the question's text and a comment apart", () => {
    const radio = (key: string, value: string, label: string, checked = false) => ({ kind: "radio", key, value, label, checked });
    const box = (key: string, value: string, label: string, checked = false) => ({ kind: "checkbox", key, value, label, checked });
    const text = (key: string, value: string, comment = false) => ({ kind: "text", key, value, comment });
    const result = kit.answersFrom([
      { id: "target", text: "Where should I deploy first?", fields: [radio("target", "test", "Test", true), radio("target", "prod", "Production")] },
      { id: "none", text: "Not answered", fields: [radio("none", "a", "A"), radio("none", "b", "B")] },
      { id: "notify", text: "Who should I tell?", fields: [box("a", "support", "Support", true), box("b", "sales", "Sales"), box("c", "ops", "Ops", true)] },
      { id: "step-3", text: "3. Migrate the data", fields: [radio("s3", "approve", "Approve"), radio("s3", "reject", "Needs changes", true), text("s3c", "  Try it on test first.  ", true)] },
      { id: "step-4", text: "4. Clean up", fields: [radio("s4", "approve", "Approve", true), text("s4c", "   ", true)] },
      { id: "section", text: "The plan", fields: [text("c", "Looks good", true)] },
      { id: "notes", text: "Anything else?", fields: [text("notes", "line 1\nline 2")] },
      { id: "env", text: "Environment", fields: [{ kind: "select", key: "env", multiple: false, selected: [{ value: "eu", label: "Europe" }] }] },
      { id: "envs", text: "Environments", fields: [{ kind: "select", key: "envs", multiple: true, selected: [{ value: "eu", label: "Europe" }, { value: "us", label: "US" }] }] },
      { id: "empty-select", text: "Region", fields: [{ kind: "select", key: "r", multiple: false, selected: [] }] },
      { id: "contact", text: "Contact", fields: [text("name", "Ada"), text("email", "ada@example.com"), radio("via", "mail", "Mail", true)] },
      { id: "notes", text: "Same ID again", fields: [text("x", "second")] },
    ]);
    expect(result).toEqual({
      target: { question: "Where should I deploy first?", answer: { value: "test", label: "Test" } },
      none: { question: "Not answered", answer: null },
      notify: { question: "Who should I tell?", answer: [{ value: "support", label: "Support" }, { value: "ops", label: "Ops" }] },
      "step-3": { question: "3. Migrate the data", answer: { value: "reject", label: "Needs changes" }, comment: "Try it on test first." },
      "step-4": { question: "4. Clean up", answer: { value: "approve", label: "Approve" } },
      section: { question: "The plan", comment: "Looks good" },
      notes: { question: "Anything else?", answer: "line 1\nline 2" },
      env: { question: "Environment", answer: { value: "eu", label: "Europe" } },
      envs: { question: "Environments", answer: [{ value: "eu", label: "Europe" }, { value: "us", label: "US" }] },
      "empty-select": { question: "Region", answer: null },
      contact: { question: "Contact", answer: { name: "Ada", email: "ada@example.com", via: { value: "mail", label: "Mail" } } },
      "notes-2": { question: "Same ID again", answer: "second" },
    });
  });

  it("sends one submission ID on every try, with the version the page was loaded at, until Pots takes it", async () => {
    const { io, calls, sleeps, states } = fakeIo(["throw", 503, "throw", 429, 200]);
    const result = await kit.deliver("/p/tok/", answers, io);
    expect(result).toEqual({ ok: true, submission: "id-1" });
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.url).toBe("/p/tok/__pots/submit");
      expect(call.body).toEqual({ submission: "id-1", version: "v3", answers });
    }
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(states.filter((state) => state !== "sending")).toEqual(["retrying", "retrying", "retrying", "retrying", "done"]);
  });

  it("waits at most 30 seconds between tries, and keeps trying", async () => {
    const { io, sleeps } = fakeIo(Array(9).fill("throw"));
    expect((await kit.deliver("/p/tok/", answers, io)).ok).toBe(true);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000]);
  });

  it("stops at a refused body or a revoked link, without trying again", async () => {
    const bad = fakeIo([400]);
    expect(await kit.deliver("/p/tok/", answers, bad.io)).toEqual({ ok: false, status: 400, message: "bad body", bytes: undefined });
    expect(bad.calls).toHaveLength(1);
    expect(bad.sleeps).toEqual([]);
    const gone = fakeIo([404]);
    expect((await kit.deliver("/p/tok/", answers, gone.io)).status).toBe(404);
    expect(gone.calls).toHaveLength(1);
  });

  it("takes the version Pots sent with the HTML file, from the page's own load entry", () => {
    const load = (serverTiming: unknown) => [{ entryType: "navigation", serverTiming }];
    expect(kit.servedVersion(load([{ name: "cache", description: "hit" }, { name: "pots-version", description: "0a1b2c3d4e5f6a7b" }]))).toBe("0a1b2c3d4e5f6a7b");
    // A browser without Server-Timing, or a page that changed while Pots sent it: the kit asks __pots/info.
    expect(kit.servedVersion(load([]))).toBeNull();
    expect(kit.servedVersion(load(undefined))).toBeNull();
    expect(kit.servedVersion([])).toBeNull();
    expect(kit.servedVersion(undefined)).toBeNull();
  });

  it("reads the page's version once, when it loads, and never again later", async () => {
    /** A fake __pots/info: each read takes the next result, a version, a status or "throw" (no connection). */
    const info = (results: (string | number | "throw")[]) => {
      const sleeps: number[] = [];
      let reads = 0;
      const io = {
        fetch: async (url: string) => {
          expect(url).toBe("/p/tok/__pots/info");
          reads++;
          const result = results.shift() ?? "throw";
          if (result === "throw") throw new TypeError("Failed to fetch");
          if (typeof result === "number") return { ok: false, status: result, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ page: "plan", version: result }) };
        },
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      };
      return { io, sleeps, reads: () => reads };
    };
    const ok = info(["v7"]);
    expect(await kit.readVersion("/p/tok/", ok.io)).toBe("v7");

    // A failed first read is final: the page may change while the kit waits, so a second read could stamp the old
    // answers with the new version.
    const flaky = info(["throw", "v8"]);
    await expect(kit.readVersion("/p/tok/", flaky.io)).rejects.toEqual({ status: 0 });
    expect(flaky.reads()).toBe(1);
    expect(flaky.sleeps).toEqual([]);

    const busy = info([503, "v8"]);
    await expect(kit.readVersion("/p/tok/", busy.io)).rejects.toEqual({ status: 503 });
    expect(busy.reads()).toBe(1);

    const revoked = info([404]);
    await expect(kit.readVersion("/p/tok/", revoked.io)).rejects.toEqual({ status: 404 });
    expect(revoked.reads()).toBe(1);
  });

  it("never sends answers with a version read after the page loaded", async () => {
    // The page could not read its version when it loaded; the page has changed since, to v2. The kit keeps the failed
    // read, so nothing goes out, and the person is asked to reload; asking now would stamp the old answers with v2.
    const failedAtLoad = Promise.reject({ status: 0 });
    failedAtLoad.catch(() => {});
    let asked = 0;
    const stale = fakeIo([200], () => {
      asked++;
      return failedAtLoad;
    });
    const result = await kit.deliver("/p/tok/", answers, stale.io);
    expect(result).toEqual({ ok: false, status: 0, message: "no-version", bytes: undefined });
    expect(stale.calls).toEqual([]);
    expect(stale.sleeps).toEqual([]);
    expect(asked).toBe(1);

    const revoked = fakeIo([], async () => {
      throw { status: 404 };
    });
    expect(await kit.deliver("/p/tok/", answers, revoked.io)).toMatchObject({ ok: false, status: 404, message: "gone" });
    expect(revoked.calls).toEqual([]);
  });

  it("does not send answers over 64 KB", async () => {
    const { io, calls } = fakeIo([]);
    const big = { notes: { question: "Notes", answer: "部".repeat(22_000) } };
    const result = await kit.deliver("/p/tok/", big, io);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("too-large");
    expect(result.bytes).toBeGreaterThan(64 * 1024);
    expect(calls).toEqual([]);
  });

  it("keeps nothing in the browser and writes no HTML from text", () => {
    for (const word of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"])
      expect(source).not.toContain(word);
    expect(source).toContain("textContent");
  });

  it("styles light and dark, and loads nothing from elsewhere", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).not.toMatch(/@import|url\(/);
  });
});
