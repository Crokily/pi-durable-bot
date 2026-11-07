import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dreamDue, forkRefusal, type MemoryFolders, withAgeNote } from "../src/agent/memory.ts";
import { cutIndex, listMemoryFiles } from "../src/bot/memory.ts";
import { agentRequests, coworker, type FakeModel, type FakeReply, type FakeRequest, isDream, isMemoryPass, lastUser, startFakeModel, wakes } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// The memory from outside, and the parts of it that code must hold. Their failures would be silent: a fork whose request
// does not start as the main agent's did costs the full price, a fork that runs a command it should not, sends, or
// stays in the database changes what people and the bot see, a pass that runs twice or not at all after a restart
// only shows as a memory that is wrong, and a dream that never runs only as a memory that grows.

const DAY = 86_400_000;
let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled|could not|no answer/i.test(String(line.message)))).toEqual([]);
});

async function setUp(memory?: (request: FakeRequest) => FakeReply | Promise<FakeReply>, script = coworker, settings?: Record<string, unknown>): Promise<void> {
  model = await startFakeModel(script, memory ? { memory } : {});
  gateway = new TestGateway({ model, ...(settings ? { settings } : {}) });
  await gateway.start();
}

/** The memory fork's turn: how many tool results came back since its message. */
const turn = (request: FakeRequest) => request.messages.length - request.messages.findLastIndex((message) => message.role === "user") - 1 >>> 1;
const passes = () => gateway.output.filter((line) => line.message === "memory pass");
const own = () => join(gateway.botDir, "memory");
const forks = () => gateway.query<{ id: number }>("SELECT id FROM pi_conversations WHERE id != 1");
const state = (key: string) => gateway.query<{ value: string }>("SELECT value FROM bot_state WHERE key = ?", key)[0]?.value;
const write = (path: string, content: string): FakeReply => ({ call: { name: "write", arguments: { path, content } } });

describe("memory", { timeout: 90_000 }, () => {
  it("forks the main conversation after a run, keeps to its tools, and the next wake says what it changed", async () => {
    const outside = join(tmpdir(), `pots-memory-${process.pid}-${Date.now()}.txt`);
    await setUp((request) => {
      // The wake before the pass's message: only the first run holds something to save.
      if (!request.messages.filter((message) => message.role === "user").at(-2)?.content.includes("I like tea")) return { text: "Nothing to save." };
      switch (turn(request)) {
        case 0:
          return { call: { name: "bash", arguments: { command: `echo hi > ${outside}` } } };
        case 1:
          return { call: { name: "send", arguments: { to: "test:#general", text: "from the pass" } } };
        case 2:
          return write(join(own(), "alice-tea.md"), "---\nname: alice-tea\ndescription: Alice likes tea\nmetadata:\n  type: user\n---\n\nAlice likes tea.\n");
        case 3:
          return write(join(own(), "MEMORY.md"), "- [Alice likes tea](alice-tea.md) — what she drinks\n");
        default:
          return { text: "Saved." };
      }
    });
    gateway.say("general", "alice", `@${ME} I like tea`);
    await waitFor(() => passes().length === 1, { what: "the memory pass" });

    // Its request starts as the main agent's last one did, with the same provider session, so the cache serves it.
    const main = agentRequests(model).at(-1)!;
    const pass = model.requests.filter(isMemoryPass);
    expect(pass).toHaveLength(5);
    expect(pass[0]!.system).toBe(main.system);
    expect(pass[0]!.tools).toEqual(main.tools);
    expect(pass[0]!.messages.slice(0, main.messages.length)).toEqual(main.messages);
    expect(pass[0]!.session).toBeDefined();
    expect(pass[0]!.session).toBe(main.session);
    expect(lastUser(pass[0]!)).toMatch(/^You are now acting as the memory extraction subagent\. Analyze the most recent ~4 messages above/);
    expect(lastUser(pass[0]!)).not.toContain("## Existing memory files");
    // Code refused the command that writes outside the memory and the send; the files it wrote are there.
    const last = pass[4]!.messages;
    const results = last.slice(last.findLastIndex((message) => message.role === "user")).filter((message) => message.role === "tool").map((message) => message.content);
    expect(results[0]).toMatch(/Only read-only shell commands \(ls, find, grep, cat, stat, wc, head, tail and sqlite3 -readonly -safe, also joined by pipes\)/);
    expect(results[1]).toMatch(/only read, read-only bash, and write\/edit of \.md files within .* are allowed in this context/);
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(join(own(), "MEMORY.md"), "utf8")).toBe("- [Alice likes tea](alice-tea.md) — what she drinks\n");
    expect(gateway.sent().map((record) => record.text)).toEqual(["ack: [wake] someone mentioned you"]);
    // Nothing of the fork stays.
    expect(forks()).toEqual([]);

    // The next wake says, once, what the pass changed; the main conversation never holds the pass's message, and its
    // memory section shows the new index only on the next page.
    gateway.say("general", "alice", `@${ME} anything else?`);
    await waitFor(() => passes().length === 2, { what: "the second pass" });
    const next = wakes(model).at(-1)!;
    expect(next).toMatch(/\n\nBackground memory extraction updated your memory: saved 1 memory\nFiles changed: \S+[\\/]alice-tea\.md, \S+[\\/]MEMORY\.md\nYour loaded copy of \S+[\\/]memory[\\/]MEMORY\.md is now stale relative to disk — read it again if you need current contents\.\nThis is ambient context — do not narrate it to people unless they ask or it is directly relevant to their request\.$/);
    const later = agentRequests(model).at(-1)!;
    expect(later.messages.some((message) => message.content.includes("memory extraction subagent"))).toBe(false);
    expect(later.system).toContain("Your MEMORY.md is currently empty.");
    // The second pass looks only at the second run, and lists the memory files.
    expect(lastUser(model.requests.filter(isMemoryPass).at(-1)!)).toMatch(/most recent ~4 messages[\s\S]*## Existing memory files\n\n- \[user\] alice-tea\.md \(\S+\): Alice likes tea\n\nCheck this list/);

    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => passes().length === 3, { what: "the third pass" });
    expect(wakes(model).at(-1)!).not.toContain("Background memory extraction");
    expect((await gateway.run(["turn-page", "--note", "a new page"])).status).toBe(0);
    gateway.say("general", "alice", `@${ME} new page`);
    await waitFor(() => gateway.sent().length === 4, { what: "the reply on the new page" });
    expect(agentRequests(model).at(-1)!.system).toContain(`(your auto-memory, as it was when this page began):\n\n- [Alice likes tea](alice-tea.md) — what she drinks`);
  });

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

  it("ends a pass after 5 turns", async () => {
    await setUp(() => ({ call: { name: "read", arguments: { path: join(own(), "MEMORY.md") } } }));
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => passes().length === 1, { what: "the memory pass" });
    await pause(1_000);
    expect(model.requests.filter(isMemoryPass)).toHaveLength(5);
    expect(forks()).toEqual([]);
  });

  it("is skipped when the main agent wrote memory itself, not when its write failed or it only read, and a memory file read 2 days after it changed says how old it is", async () => {
    const script = (request: FakeRequest): FakeReply => {
      const last = request.messages.at(-1)!;
      const memory = /You have a persistent file-based memory at `(\S+)\/`/.exec(request.system)![1]!;
      if (last.role === "user" && last.content.includes("try to note")) {
        return { call: { name: "edit", arguments: { path: join(memory, "old.md"), edits: [{ oldText: "not there", newText: "x" }] } } };
      }
      if (last.role === "user" && last.content.includes("remember")) return { call: { name: "read", arguments: { path: join(memory, "old.md") } } };
      if (last.role === "tool" && request.messages.at(-2)?.toolCalls?.[0] === "read") return write(join(memory, "bob.md"), "Bob wants short replies.\n");
      // A command that only reads, which the fork's checker cannot read (a glob): no write.
      if (last.role === "tool" && request.messages.at(-2)?.toolCalls?.[0] === "edit") return { call: { name: "bash", arguments: { command: `cat ${memory}/*.md` } } };
      return coworker(request);
    };
    await setUp(undefined, script);
    writeFileSync(join(own(), "old.md"), "An old memory.\n");
    utimesSync(join(own(), "old.md"), new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
    // An edit whose text does not match saved nothing, and cat reads: the pass runs.
    gateway.say("general", "bob", `@${ME} try to note this`);
    await waitFor(() => passes().length === 1, { what: "the pass after the failed edit" });
    gateway.say("general", "bob", `@${ME} remember that I want short replies`);
    await waitFor(() => gateway.output.some((line) => line.message === "memory pass skipped: the main agent wrote memory itself"), { what: "the skipped pass" });
    expect(model.requests.filter(isMemoryPass)).toHaveLength(1);
    expect(readFileSync(join(own(), "bob.md"), "utf8")).toBe("Bob wants short replies.\n");
    const read = agentRequests(model).find((request) => request.messages.at(-1)?.role === "tool" && request.messages.at(-2)?.toolCalls?.[0] === "read")!;
    expect(read.messages.at(-1)!.content).toMatch(/^<system-reminder>This memory is 3 days old\. Memories are point-in-time observations, not live state — claims about people, places, files or plans may be outdated\.[^<]*<\/system-reminder>\nAn old memory\.\n?$/);
    expect(state("memory_changes")).toBe("1");

    // The cursor moved on: the next pass looks only at the next run.
    gateway.say("general", "bob", `@${ME} thanks`);
    await waitFor(() => passes().length === 2, { what: "the next pass" });
    expect(passes()[1]!.messages).toBe(4);
  });

  it("refuses a fork's change to a memory file that another writer changed, made or deleted since the pass began, also after the fork read it", async () => {
    let waiting = false;
    const drink = () => join(own(), "drink.md");
    const old = () => join(own(), "old.md");
    const script = (request: FakeRequest): FakeReply => {
      const last = request.messages.at(-1)!;
      if (last.role === "user" && last.content.includes("I drink coffee now")) return write(drink(), "Coffee.\n");
      // In quotes: bash takes the backslashes of a Windows path away.
      if (last.role === "tool" && request.messages.at(-2)?.toolCalls?.[0] === "write") return { call: { name: "bash", arguments: { command: `rm '${old()}'` } } };
      return coworker(request);
    };
    await setUp(async (request) => {
      if (!request.messages.filter((message) => message.role === "user").at(-2)?.content.includes("I drink tea")) return { text: "Nothing to save." };
      switch (turn(request)) {
        case 0:
          // A slow pass: the main agent makes one file and deletes another meanwhile.
          waiting = true;
          await waitFor(() => existsSync(drink()) && !existsSync(old()), { what: "the main agent's changes" });
          return write(drink(), "Tea.\n");
        case 1:
          return write(old(), "Old, again.\n");
        case 2:
          return { call: { name: "read", arguments: { path: drink() } } };
        case 3:
          return write(drink(), "Coffee, tea before.\n");
        default:
          return { text: "Saved." };
      }
    }, script);
    writeFileSync(old(), "Old.\n");
    gateway.say("general", "alice", `@${ME} I drink tea`);
    await waitFor(() => waiting, { what: "the pass" });
    gateway.say("general", "alice", `@${ME} I drink coffee now`);
    await waitFor(() => passes().length === 1, { what: "the slow pass" });
    const last = model.requests.filter(isMemoryPass).at(-1)!.messages;
    const results = last.slice(last.findLastIndex((message) => message.role === "user")).filter((message) => message.role === "tool").map((message) => message.content);
    const refused = (path: string) => `Tool call blocked: ${path} changed after this memory pass began, so this pass may not change it: another writer has a newer copy.`;
    expect(results[0]).toContain(refused(drink()));
    expect(results[1]).toContain(refused(old()));
    expect(results[3]).toContain(refused(drink()));
    expect(readFileSync(drink(), "utf8")).toBe("Coffee.\n");
    expect(existsSync(old())).toBe(false);
  });

  it("tells the next wake what a fork changed also when its model failed after, and keeps the cursor", async () => {
    await setUp((request) => {
      if (!request.messages.filter((message) => message.role === "user").at(-2)?.content.includes("I like tea")) return { text: "Nothing to save." };
      return turn(request) === 0 ? write(join(own(), "tea.md"), "Tea.\n") : { fail: { status: 401, message: "the login expired" } };
    });
    gateway.say("general", "alice", `@${ME} I like tea`);
    await waitFor(() => gateway.output.some((line) => line.message === "memory pass got no answer"), { what: "the failed pass" });
    expect(state("memory_cursor")).toBeUndefined();
    expect(state("memory_changes")).toBe("1");
    expect(forks()).toEqual([]);
    gateway.say("general", "alice", `@${ME} anything else?`);
    await waitFor(() => passes().length === 1, { what: "the next pass" });
    expect(wakes(model).at(-1)!).toMatch(/Background memory extraction updated your memory: saved 1 memory\nFiles changed: \S+[\\/]tea\.md\n/);
    // The same messages again, with the new ones.
    expect(passes()[0]!.messages).toBe(8);
    gateway.output.splice(gateway.output.findIndex((line) => line.message === "memory pass got no answer"), 1);
  });

  it("catches up after a restart, and deletes a fork the stop left", async () => {
    let hold = true;
    await setUp(async () => {
      if (hold) await pause(20_000);
      return { text: "Nothing to save." };
    });
    gateway.crashBeforeNextMemoryPass();
    gateway.say("general", "alice", `@${ME} hello`);
    await gateway.exited();
    expect(gateway.output.some((line) => line.message === "crash test: dying before the memory pass")).toBe(true);
    expect(model.requests.filter(isMemoryPass)).toHaveLength(0);

    // The run ended, but its pass did not: the next start makes it. This one dies while the fork waits for the model.
    await gateway.start();
    await waitFor(() => model.requests.some(isMemoryPass), { what: "the pass after the restart" });
    await gateway.kill();
    expect(forks()).toHaveLength(1);

    hold = false;
    await gateway.start();
    await waitFor(() => passes().length === 1, { what: "the pass after the second restart" });
    expect(gateway.output.find((line) => line.message === "deleted memory forks a stop left")?.forks).toBe(1);
    expect(model.requests.filter(isMemoryPass)).toHaveLength(2);
    expect(forks()).toEqual([]);
    expect(passes()[0]!.messages).toBe(4);
  });

  it("dreams after 5 memory changes, once a day, and the next wake says what it changed", async () => {
    let n = 0;
    await setUp((request) => {
      if (isDream(request)) return turn(request) === 0 ? write(join(own(), "merged.md"), "Merged.\n") : { text: "Merged the notes." };
      return turn(request) === 0 ? write(join(own(), `note-${++n}.md`), "A note.\n") : { text: "Saved." };
    });
    for (let i = 1; i <= 5; i++) {
      gateway.say("general", "alice", `@${ME} note ${i}`);
      await waitFor(() => passes().length === i, { what: `pass ${i}` });
    }
    await waitFor(() => gateway.output.some((line) => line.message === "memory dream"), { what: "the dream" });
    const dream = model.requests.find(isDream)!;
    expect(lastUser(dream)).toMatch(/^# Dream: Memory Consolidation\n[\s\S]*\*\*Tool constraints for this run:\*\*[\s\S]*Memory changes since the last consolidation \(none before\): 5$/);
    // A fork of the main conversation, as the passes are.
    expect(dream.system).toBe(agentRequests(model).at(-1)!.system);
    expect(state("memory_changes")).toBe("0");
    expect(Number(state("memory_dream_at"))).toBeGreaterThan(Date.now() - 60_000);
    expect(forks()).toEqual([]);

    gateway.say("general", "alice", `@${ME} note 6`);
    await waitFor(() => passes().length === 6, { what: "pass 6" });
    expect(wakes(model).at(-1)!).toMatch(/Background memory consolidation updated your memory: consolidated 1 memory file\nFiles changed: \S+[\\/]merged\.md\n/);
    await pause(1_000);
    expect(model.requests.filter(isDream)).toHaveLength(2);
    expect(state("memory_changes")).toBe("1");
  });

  it("is off with settings.autoMemory false: no memory section and no pass, at once when it is set while running", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => passes().length === 1, { what: "the pass" });
    expect(agentRequests(model).at(-1)!.system).toContain("# Memory");
    const file = join(gateway.botDir, "bot.json");
    const definition = JSON.parse(readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
    writeFileSync(file, JSON.stringify({ ...definition, settings: { ...definition.settings, autoMemory: false } }));
    await waitFor(() => gateway.output.some((line) => line.message === "definition applied"), { what: "the new definition" });
    gateway.say("general", "alice", `@${ME} hello again`);
    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    await pause(1_500);
    expect(model.requests.filter(isMemoryPass)).toHaveLength(1);
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

  it("lets a fork read anything, write only .md files in the memory folders, and run only read-only commands and rm of them", async () => {
    make();
    const cwd = join(dir, "bot", "workspace");
    symlinkSync(join(dir, "outside"), join(folders.own, "link"));
    symlinkSync(join(dir, "outside", "missing.txt"), join(folders.own, "dangling.md"));
    const outside = join(dir, "outside");
    const refused = async (name: string, args: Record<string, unknown>) => (await forkRefusal(name, args, folders, cwd)) !== undefined;
    // The paths in single quotes, as bash needs them on Windows: there they hold backslashes, and ~ in a short name.
    const sh = { own: `'${folders.own}'`, shared: `'${folders.shared}'`, outside: `'${outside}'`, db: `'${join(dir, "bot.sqlite")}'` };
    for (const command of [
      "ls -la",
      `cat ${sh.own}/MEMORY.md | grep tea | wc -l`,
      `find ${sh.own} -name '*.md'`,
      `grep -rn "tea" ${sh.shared} 2>/dev/null | head -5`,
      `sqlite3 -readonly -safe ${sh.db} "SELECT text FROM gw_messages LIMIT 5"`,
      `rm -f ${sh.own}/old.md ${sh.shared}/x.md`,
      `rm -- ${sh.own}/new.md`,
      `find ${sh.own} -maxdepth 2 -type f -name '*.md' -mtime -2 -print`,
      `find ${sh.own} ! -name MEMORY.md -o -newer ${sh.own}/MEMORY.md`,
      `grep -c 'a$' ${sh.own}/MEMORY.md 2>&1`,
      `sqlite3 -readonly -safe -json -header ${sh.db} "SELECT 1"`,
    ]) {
      expect(await refused("bash", { command }), command).toBe(false);
    }
    for (const command of [
      `echo hi > ${sh.own}/a.md`,
      `cat a >> ${sh.own}/MEMORY.md`,
      "touch x",
      "node -e 'require(\"fs\").writeFileSync(\"x\", \"\")'",
      `ls; rm ${sh.own}/a.md`,
      "ls && touch x",
      "ls $(touch x)",
      "ls `touch x`",
      'ls "$(touch x)"',
      "FOO=1 ls",
      `find ${sh.own} -delete`,
      `find . -exec rm {} \\;`,
      `sqlite3 ${sh.db} "DELETE FROM gw_messages"`,
      `sqlite3 -readonly ${sh.db} "SELECT writefile('x', 'y')"`,
      `rm -rf ${sh.own}`,
      `rm ${sh.own}/*.md`,
      `rm ${sh.own}/notes.txt`,
      `rm ${sh.outside}/a.md`,
      `rm ${sh.own}/../a.md`,
      `rm ${sh.own}/link/a.md`,
      "rm memory/a.md",
      `/bin/rm ${sh.own}/a.md`,
      `ls | rm ${sh.own}/a.md`,
      "ls\ntouch x",
      // What a review found: a word before a redirect, braces, $'...', sqlite3's .nonce.
      `find ${sh.outside} -delete>/dev/null`,
      `rm -f ${sh.own}/a.md ${sh.outside}/b.md>/dev/null`,
      `rm -f ${sh.own}/{keep,../outside}.md`,
      `find ${sh.outside} $'-delete'`,
      `sqlite3 -readonly -safe -nonce secret :memory: '.nonce secret' '.shell touch /tmp/escaped'`,
      // What bash would expand or interpret, and options that are not on the lists.
      `find ${sh.outside} $"-delete"`,
      `find ${sh.outside} \\-delete`,
      `ls ${sh.own}/*.md`,
      "cat ~/.ssh/id_rsa",
      'grep -r "a$HOME" .',
      "ls >/dev/null",
      "ls 2> /dev/null",
      `find ${sh.outside} -fprint x`,
      `find ${sh.outside} -printf x`,
      `sqlite3 -safe -readonly ${sh.db} "SELECT 1"`,
      `sqlite3 -readonly -safe -cmd '.shell x' ${sh.db}`,
      `sqlite3 -readonly -safe ${sh.db} " .shell touch x"`,
      `sqlite3 -readonly -safe ${sh.db} -cmd x`,
      `cat x.sql | sqlite3 -readonly -safe ${sh.db}`,
      `rm ${sh.own}/dangling.md`,
    ]) {
      expect(await refused("bash", { command }), command).toBe(true);
    }
    expect(await refused("read", { path: "/etc/hosts" })).toBe(false);
    expect(await refused("write", { path: join(folders.own, "a.md"), content: "" })).toBe(false);
    expect(await refused("edit", { path: join(folders.shared, "sub", "b.md"), edits: [] })).toBe(false);
    expect(await refused("write", { path: "../memory/c.md", content: "" })).toBe(false);
    expect(await refused("write", { path: join(folders.own, "a.txt"), content: "" })).toBe(true);
    expect(await refused("write", { path: join(folders.own, "link", "a.md"), content: "" })).toBe(true);
    expect(await refused("write", { path: join(dir, "outside", "a.md"), content: "" })).toBe(true);
    // A link below the memory folder, also one that leads nowhere yet: write would follow it.
    expect(await refused("write", { path: join(folders.own, "dangling.md"), content: "" })).toBe(true);
    for (const name of ["screen", "send", "react", "call", "task"]) expect(await refused(name, {}), name).toBe(true);
  });

  it("dreams when 24 hours passed since the last dream and 5 memory changes came since then", () => {
    const now = Date.now();
    expect(dreamDue({ changes: 4 }, now)).toBe(false);
    expect(dreamDue({ changes: 5 }, now)).toBe(true);
    expect(dreamDue({ changes: 9, dreamAt: now - 23 * 3_600_000 }, now)).toBe(false);
    expect(dreamDue({ changes: 5, dreamAt: now - 24 * 3_600_000 }, now)).toBe(true);
  });

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

  it("loads MEMORY.md up to 200 lines and 25,000 characters, and lists the memory files of both folders, newest first", async () => {
    make();
    const lines = Array.from({ length: 250 }, (_, i) => `- [m${i + 1}](m${i + 1}.md) — hook`).join("\n");
    expect(cutIndex(lines)).toBe(
      `${lines.split("\n").slice(0, 200).join("\n")}\n\n> WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded: 50 of 250 lines were cut off, starting at line 201 ("- [m201](m201.md) — hook"). Keep index entries to one line under ~200 chars; move detail into topic files.`,
    );
    expect(cutIndex("x".repeat(30_000))).toMatch(/^x{25000}\n\n> WARNING: MEMORY\.md is 29\.3KB \(limit: 24\.4KB\) — index entries are too long\. Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off\./);

    writeFileSync(join(folders.own, "MEMORY.md"), "- index");
    writeFileSync(join(folders.own, "alice.md"), '---\nname: alice\ndescription: "Alice: likes tea"\nmetadata:\n  type: user\n---\n\nAlice likes tea.\n');
    writeFileSync(join(folders.shared, "tz.md"), "---\nname: tz\ndescription: The user's time zone\ntype: reference\n---\n");
    writeFileSync(join(folders.shared, "plain.md"), "No frontmatter.\n");
    utimesSync(join(folders.own, "alice.md"), new Date(2026, 0, 2), new Date(2026, 0, 2));
    utimesSync(join(folders.shared, "tz.md"), new Date(2026, 0, 3), new Date(2026, 0, 3));
    utimesSync(join(folders.shared, "plain.md"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(await listMemoryFiles(folders)).toBe(
      [
        `- [reference] ${join(folders.shared, "tz.md")} (${new Date(2026, 0, 3).toISOString()}): The user's time zone`,
        `- [user] alice.md (${new Date(2026, 0, 2).toISOString()}): Alice: likes tea`,
        `- ${join(folders.shared, "plain.md")} (${new Date(2026, 0, 1).toISOString()})`,
      ].join("\n"),
    );
  });
});
