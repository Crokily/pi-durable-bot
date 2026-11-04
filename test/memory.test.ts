import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MemoryFolders, withAgeNote } from "../src/agent/memory.ts";
import { cutIndex } from "../src/bot/memory.ts";
import { agentRequests, type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { ME, TestGateway, waitFor } from "./support/gateway.ts";

// The memory from outside, and the parts of it that code must hold. Their failures would be silent: an index that
// changes in the middle of a page makes the provider's cache miss, one that is not cut costs every request, and an age
// note that is missing only shows as a bot that trusts an old memory.

const DAY = 86_400_000;
let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled|could not/i.test(String(line.message)))).toEqual([]);
});

describe("memory", { timeout: 90_000 }, () => {
  it("shows both MEMORY.md at the end of the prompt as they were when the page began", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    const own = join(gateway.botDir, "memory");
    const shared = join(gateway.home, "memory");
    for (const folder of [own, shared]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(own, "MEMORY.md"), "- [Alice likes tea](alice-tea.md) — what she drinks\n");
    await gateway.start();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    const first = agentRequests(model).at(-1)!.system;
    expect(first).toMatch(/\(your auto-memory, as it was when this page began\):\n\n- \[Alice likes tea\]\(alice-tea\.md\) — what she drinks\n\n/);
    expect(first).toMatch(/\(the auto-memory every bot of this computer shares, as it was when this page began\):\n\nThis MEMORY\.md is currently empty\.$/);

    writeFileSync(join(shared, "MEMORY.md"), "- [Time zone](tz.md) — Australia/Sydney\n");
    gateway.say("general", "alice", `@${ME} again`);
    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    expect(agentRequests(model).at(-1)!.system).toBe(first);
    expect((await gateway.run(["turn-page", "--note", "a new page"])).status).toBe(0);
    gateway.say("general", "alice", `@${ME} new page`);
    await waitFor(() => gateway.sent().length === 3, { what: "the reply on the new page" });
    expect(agentRequests(model).at(-1)!.system).toMatch(/shares, as it was when this page began\):\n\n- \[Time zone\]\(tz\.md\) — Australia\/Sydney$/);
  });

  it("has no memory section with settings.autoMemory false", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model, settings: { autoMemory: false } });
    await gateway.start();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(agentRequests(model).at(-1)!.system).not.toContain("# Memory");
  });
});

describe("memory parts", () => {
  let dir: string;
  let folders: MemoryFolders;
  const make = () => {
    dir = mkdtempSync(join(tmpdir(), "pots-memory-"));
    folders = { own: join(dir, "bot", "memory"), shared: join(dir, "shared") };
    for (const folder of [folders.own, folders.shared, join(dir, "outside")]) mkdirSync(folder, { recursive: true });
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("notes the age of a memory file read 2 days or more after it changed, and only of a memory file", async () => {
    make();
    const result = (text: string) => ({ output: [{ type: "text" as const, text }] });
    const file = (folder: string, name: string, days: number) => {
      const path = join(folder, name);
      writeFileSync(path, "x");
      utimesSync(path, new Date(Date.now() - days * DAY - 60_000), new Date(Date.now() - days * DAY - 60_000));
      return path;
    };
    const noted = async (path: string) => ((await withAgeNote(result("x"), path, folders, dir)).output![0] as { text: string }).text;
    expect(await noted(file(folders.own, "one.md", 1))).toBe("x");
    expect(await noted(file(folders.shared, "two.md", 2))).toMatch(/^<system-reminder>This memory is 2 days old\./);
    expect(await noted(file(join(dir, "outside"), "old.md", 9))).toBe("x");
    expect(((await withAgeNote(result("x"), join(folders.own, "two.md"), undefined, dir)).output![0] as { text: string }).text).toBe("x");
  });

  it("loads MEMORY.md up to 200 lines and 25,000 characters", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `- [m${i + 1}](m${i + 1}.md) — hook`).join("\n");
    expect(cutIndex(lines)).toBe(
      `${lines.split("\n").slice(0, 200).join("\n")}\n\n> WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded: 50 of 250 lines were cut off, starting at line 201 ("- [m201](m201.md) — hook"). Keep index entries to one line under ~200 chars; move detail into topic files.`,
    );
    expect(cutIndex("x".repeat(30_000))).toMatch(/^x{25000}\n\n> WARNING: MEMORY\.md is 29\.3KB \(limit: 24\.4KB\) — index entries are too long\. Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off\./);
  });
});
