import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakeLine, wakes } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// Children from outside: a real gateway whose fake main agent starts a child with the task tool, or a routine starts
// one. A child's end that wakes the main agent, or a child that goes on after a stop, would show only as a confused
// bot, so these are checked here; so is the one wake of a child that fails.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");

/**
 * The main agent starts a child for "please research" and stops it for "stop the research"; a wake from a child it
 * passes on in the place, and for "what did <child> say" it reads the child's result. The child answers its brief at
 * once, or for "wait long" runs a long command first, and for "wait for go" one that ends once the file go is in the
 * workspace. For "please note", the child adds a line to the bot's memory index first, and for "please research and
 * tell", it wakes the main agent with pots wake first. "on <model>" starts the child on that model, and "please tell
 * <child> more" sends it a message. For "please probe" the child runs a command that hangs after one line of output,
 * from bash or from a script; the main agent sends it "wrap up" for "wrap up the probe", and interrupts it for
 * "interrupt the probe". For "please fail", the child runs a command, then its model fails for good; for "please retry",
 * its model fails once with an error that is retried, then answers. For a child's failure, the main agent passes on its
 * first line in the place.
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (isChild(request)) {
    const brief = request.messages[0]?.content ?? "";
    const ran = request.messages.some((message) => message.role === "tool");
    if (brief.includes("fail after a nap")) return ran ? { fail: { status: 401, message: "the login expired" } } : { call: { name: "bash", arguments: { command: "sleep 4" } } };
    if (brief.includes("fail after a cut")) return ran ? { call: { name: "bash", arguments: { command: "echo never-ran" } }, finish: "content_filter" } : { call: { name: "bash", arguments: { command: "echo step one" } } };
    if (brief.includes("fail after a step")) return last?.role === "user" ? { call: { name: "bash", arguments: { command: "echo step one" } } } : { fail: { status: 401, message: "the login expired" } };
    if (brief.includes("flaky") && flaky++ === 0) return { fail: { status: 503, message: "overloaded" } };
    if (last?.role === "tool" && last.content.includes('"id"')) return { text: "told the main agent" };
    if (last?.role !== "user") return { text: "done waiting" };
    if (last.content.includes("and tell")) return { call: { name: "bash", arguments: { command: `pots wake --note "the answer is 42, Alice should know"` } } };
    if (last.content.includes("wrap up")) return { text: "wrapped up" };
    if (last.content.includes("answer at length")) return { text: `${Array.from({ length: 2_100 }, (_, line) => `line ${line + 1}`).join("\n")}\nTHE END` };
    if (last.content.includes("hang in bash")) return { call: { name: "bash", arguments: { command: HANG } } };
    if (last.content.includes("hang in a script")) return { call: { name: "codemode", arguments: { code: `return await tools.bash({ command: ${JSON.stringify(HANG)} });` } } };
    if (last.content.includes("wait long")) return { call: { name: "bash", arguments: { command: "sleep 60" } } };
    if (last.content.includes("wait for go")) return { call: { name: "bash", arguments: { command: "until [ -e go ]; do sleep 0.2; done" } } };
    if (last.content.includes("nap first")) return { call: { name: "bash", arguments: { command: "sleep 8" } } };
    if (last.content.includes("save a memory")) {
      const index = /Contents of (\S+\/MEMORY\.md) \(the memory of/.exec(request.system)![1]!;
      // In quotes: bash takes the backslashes of a Windows path away.
      return { call: { name: "bash", arguments: { command: `echo '- [Bob](bob.md) — likes coffee' >> '${index}'` } } };
    }
    return { text: "the answer is 42" };
  }
  if (last?.role !== "user") return { text: "done" };
  if (last.content.startsWith("[wake] your child")) return { call: { name: "send", arguments: { to: "test:#general", text: `report: ${wakeLine(last.content)}` } } };
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(last.content)?.[0];
  if (last.content.startsWith("[wake] wake from your child")) {
    const note = /^Note: (.*)/m.exec(last.content)?.[1] ?? "?";
    return { call: { name: "send", arguments: { to: "test:#general", text: `report: ${note}` } } };
  }
  const said = /what did (c\d+) say/.exec(last.content);
  if (said) return { call: { name: "task", arguments: { action: "result", child: said[1] } } };
  if (last.content.includes("stop the research")) return { call: { name: "task", arguments: { action: "stop", child: "c1" } } };
  if (last.content.includes("wrap up the probe")) return { call: { name: "task", arguments: { action: "send", child: "c1", message: "wrap up" } } };
  if (last.content.includes("interrupt the probe")) return { call: { name: "task", arguments: { action: "interrupt", child: "c1" } } };
  if (last.content.includes("please probe")) {
    const brief = last.content.includes("by script") ? "hang in a script" : "hang in bash";
    return { call: { name: "task", arguments: { action: "start", title: "probe", brief } } };
  }
  const tell = /please tell (c\d+) more/.exec(last.content);
  if (tell) return { call: { name: "task", arguments: { action: "send", child: tell[1], message: "more" } } };
  const on = /please \w+ on ([\w-]+\/[\w-]+)/.exec(last.content)?.[1];
  if (last.content.includes("please wait")) {
    const choice = on ? { model: on, thinking: "low" } : {};
    return { call: { name: "task", arguments: { action: "start", title: "waiter", brief: `wait for go, then answer (${on ?? "no model"})`, ...choice } } };
  }
  if (last.content.includes("please write at length")) return { call: { name: "task", arguments: { action: "start", title: "long", brief: "answer at length" } } };
  if (last.content.includes("please hold")) return { call: { name: "bash", arguments: { command: "sleep 10" } } };
  if (last.content.includes("please fail slowly")) return { call: { name: "task", arguments: { action: "start", title: "doomed", brief: "fail after a nap" } } };
  if (last.content.includes("please fail cut off")) return { call: { name: "task", arguments: { action: "start", title: "doomed", brief: "fail after a cut" } } };
  if (last.content.includes("please fail")) return { call: { name: "task", arguments: { action: "start", title: "doomed", brief: "fail after a step" } } };
  if (last.content.includes("please retry")) return { call: { name: "task", arguments: { action: "start", title: "flaky", brief: "flaky, then answer" } } };
  if (last.content.includes("please nap")) return { call: { name: "task", arguments: { action: "start", title: "nap", brief: "nap first, then answer" } } };
  if (last.content.includes("please note")) return { call: { name: "task", arguments: { action: "start", title: "note", brief: "save a memory", thinking: "max" } } };
  if (last.content.includes("please research")) {
    const brief = last.content.includes("slowly") ? "wait long, then find the answer" : last.content.includes("and tell") ? "find the answer and tell" : "find the answer";
    return { call: { name: "task", arguments: { action: "start", title: "research", brief, ...(on ? { model: on } : {}) } } };
  }
  return { text: "nothing to do" };
}

/** How many requests the flaky child made. */
let flaky = 0;

/** A command that hangs after one line of output; the process that hangs writes its ID to hang.pid in the workspace. */
const HANG = "sleep 6131 & echo $! > hang.pid; echo probing 5901; wait";

async function setUp(options: { moreModels?: boolean; definition?: Record<string, unknown>; promptCacheSeconds?: number } = {}): Promise<void> {
  flaky = 0;
  model = await startFakeModel(script);
  // The fake models have pi's long prompt cache entry, and pi is told to use it everywhere: still only the main agent asks.
  gateway = new TestGateway({
    model,
    moreModels: options.moreModels ?? false,
    longPromptCache: true,
    env: { PI_CACHE_RETENTION: "long" },
    ...(options.promptCacheSeconds ? { promptCacheSeconds: options.promptCacheSeconds } : {}),
  });
  if (options.definition) {
    const file = join(gateway.botDir, "bot.json");
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...options.definition }, null, 2)}\n`);
  }
  await gateway.start();
}

const reports = () => gateway.sent().filter((record) => record.text?.startsWith("report:"));
/** The wakes for a child's failure, as the bot recorded them. */
const failureWakes = () => gateway.query<{ id: string; place: string | null; text: string }>("SELECT id, place, text FROM bot_wakes WHERE reason = 'child'");
/** Drop the output lines of the test's own failures, which afterEach would count. */
const forgetFailures = () => gateway.output.splice(0, gateway.output.length, ...gateway.output.filter((line) => !/failed/i.test(String(line.message))));
/** Whether a child ended and waits for a message, as pots children shows it. */
const ended = (id: string) => new RegExp(`^${id} "[^"]*": ended`, "m").test(gateway.pots("children"));
/** The child's final message as the task tool's result gives it to the main agent, after a person asks for it. */
async function resultOf(id: string): Promise<string> {
  gateway.say("general", "alice", `@${ME} what did ${id} say`);
  await waitFor(() => taskResult(`${id} "`) !== undefined && taskResult(`${id} "`)!.includes("final message"), { what: `${id}'s result` });
  return taskResult(`${id} "`)!;
}
/** The result of the main agent's last task call that starts with `start`. */
const taskResult = (start: string) =>
  agentRequests(model)
    .filter((request) => !isChild(request))
    .flatMap((request) => request.messages.filter((message) => message.role === "tool" && message.content.startsWith(start)))
    .at(-1)?.content;
/** Whether the hanging process still runs: on Windows, Git Bash's process IDs are not Windows', so undefined there. */
const hangRuns = () => {
  if (process.platform === "win32") return undefined;
  const pid = Number(readFileSync(join(gateway.botDir, "workspace", "hang.pid"), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The main agent's requests. */
const mainRequests = () => agentRequests(model).filter((request) => !isChild(request));

describe("children", { timeout: 90_000 }, () => {
  it("works in the background; its end wakes no one, and the task tool gives its final message", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research`);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    // The child started from the brief alone, with its ID, the working tools and the task tool but no channel actions,
    // and its prompt does not tell it how to use them.
    const child = model.requests.find(isChild)!;
    expect(child.messages.map((message) => message.role)).toEqual(["user"]);
    expect(child.messages[0]!.content).toBe("[brief from the main agent; you are child c1]\nfind the answer");
    expect(child.tools).toEqual(["read", "write", "edit", "bash", "grep", "find", "task", "codemode", "screen"]);
    expect(child.system).not.toMatch(/pots send|pots react|pots call|ask-secret/);
    expect(gateway.pots("children")).toMatch(/^c1 "research": ended .* ago, waits for a message, for test:#general, thinking xhigh$/m);
    // The main agent's requests keep the provider's long prompt cache entry, as it is woken minutes to an hour apart; the
    // child's, which rarely pause, the short one, also with PI_CACHE_RETENTION=long.
    const main = agentRequests(model).filter((request) => !isChild(request));
    expect(main.length).toBeGreaterThan(0);
    expect(main.map((request) => request.cacheRetention)).toEqual(main.map(() => "24h"));
    expect(model.requests.filter(isChild).map((request) => request.cacheRetention)).toEqual(model.requests.filter(isChild).map(() => undefined));

    // The end did not wake the main agent: its only wake is the mention, and it made two requests for it.
    await pause(2_000);
    expect(gateway.query<{ reason: string }>("SELECT reason FROM bot_wakes").map((wake) => wake.reason)).toEqual(["mention"]);
    expect(mainRequests()).toHaveLength(2);
    expect(reports()).toHaveLength(0);
    expect(await resultOf("c1")).toMatch(/^c1 "research": ended \d+ s ago, waits for a message, for test:#general\nIts last final message:\nthe answer is 42$/);

    // On Windows a stop ends the process at once, as a kill does, before the gateway writes the spans of its last second:
    // there, wait until the last model request is written (with it, all that ended before it).
    if (process.platform === "win32") await waitFor(() => /^Model requests: 5,/m.test(gateway.pots("trace")), { what: "the spans" });
    await gateway.stop();
    // The child's model requests are in the trace with those of the wake that started it.
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+model 3×/);
    expect(gateway.pots("trace")).toMatch(/^Model requests: 5,/m);
    expect(gateway.pots("trace", "mention:test:#general:1")).toMatch(/^child run, trace [^\n]*\nsubmission \d+ \(placed\)[\s\S]*model fake\/coworker, 100 in \(80% cached\), 10 out, stop/m);
  });

  it("gives a result too long for a tool's output whole, in a file", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please write at length`);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    const result = await resultOf("c1");
    const file = /all of it is in (\S+)\. Its start:\nline 1\n/.exec(result)?.[1];
    expect(file).toBeDefined();
    const saved = readFileSync(file!, "utf8");
    expect(saved.split("\n")).toHaveLength(2_101);
    expect(saved.endsWith("line 2100\nTHE END")).toBe(true);
  });

  it("wakes the main agent itself when it judges that the main agent needs to know", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research and tell`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(reports()[0]!.text).toBe("report: the answer is 42, Alice should know");
    const wake = wakes(model).find((text) => text.startsWith("[wake] wake from your child"))!;
    expect(wakeLine(wake)).toMatch(/^\[wake\] wake from your child c1 "research", which works for test:#general: it set it with pots wake at .*\. Its note is what it wrote$/);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    expect(await resultOf("c1")).toMatch(/\nIts last final message:\ntold the main agent$/);
    // A script outside the child that names itself c1 is a script, not the child, and gets no place.
    gateway.pots("wake", "--note", "from a script", "--from", "c1");
    await waitFor(() => wakes(model).some((text) => text.includes("Note: from a script")), { what: "the script's wake" });
    expect(wakeLine(wakes(model).find((text) => text.includes("Note: from a script"))!)).toMatch(/^\[wake\] timed wake from c1: a command on this computer, not a person in a channel/);
    // One wake from the child, for its place, and none for its end.
    expect(gateway.query<{ reason: string; place: string | null }>("SELECT reason, place FROM bot_wakes").map((wake) => [wake.reason, wake.place])).toEqual([
      ["mention", "test:#general"],
      ["timer", "test:#general"],
      ["mention", "test:#general"],
      ["timer", null],
    ]);
    expect(gateway.query<{ child: string | null; source: string | null }>("SELECT child, source FROM bot_timers WHERE set_by = 'agent' ORDER BY id")).toEqual([
      { child: "c1", source: null },
      { child: null, source: "c1" },
    ]);
  });

  it("wakes the main agent once when a child fails, for its place, with why and what it did last", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please fail`);
    await waitFor(() => reports().length === 1, { what: "the failure's report" });
    expect(reports()[0]!.text).toMatch(/^report: \[wake\] your child c1 failed: model_error: .*the login expired/);
    const wake = failureWakes();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.place).toBe("test:#general");
    expect(wake[0]!.text).toMatch(/^Child: c1 "doomed", for test:#general, started .*, ran \d+ s$/m);
    expect(wake[0]!.text).toMatch(/^Last, it called bash: echo step one$/m);
    expect(gateway.pots("children")).toMatch(/^c1 "doomed": failed \(model_error: .*the login expired/m);
    await pause(2_000);
    expect(failureWakes()).toHaveLength(1);
    expect(reports()).toHaveLength(1);
    forgetFailures();
  });

  for (const when of ["before", "after"] as const) {
    it(`wakes the main agent once for a child's failure when the gateway dies ${when} the wake`, async () => {
      await setUp();
      gateway.crashAroundNextChildFailure(when);
      gateway.say("general", "alice", `@${ME} please fail`);
      await gateway.exited();
      expect(gateway.output.some((line) => line.message === `crash test: dying ${when} the child's failure wake`)).toBe(true);
      expect(reports()).toHaveLength(0);

      await gateway.start();
      await waitFor(() => reports().length === 1, { what: "the failure's report" });
      await pause(2_000);
      expect(reports()).toHaveLength(1);
      expect(failureWakes()).toHaveLength(1);
      expect(mainRequests().filter((request) => request.messages.at(-1)?.content.startsWith("[wake] your child"))).toHaveLength(1);
      forgetFailures();
    });
  }

  it("wakes the main agent once for a brief and a message that fail in one run, and again for a later failure", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please fail slowly`);
    await waitFor(() => /In bash for \d+ s: sleep 4/.test(gateway.pots("children")), { what: "the child's nap" });
    // Taken between the child's steps: it joins the run that fails.
    gateway.say("general", "alice", `@${ME} please tell c1 more`);
    await waitFor(() => taskResult("Sent to c1") !== undefined, { what: "the send" });
    await waitFor(() => reports().length === 1, { what: "the failure's report" });
    expect(model.requests.filter(isChild).at(-1)!.messages.at(-1)!.content).toBe("[message from the main agent]\nmore");
    await pause(2_000);
    expect(failureWakes()).toHaveLength(1);
    expect(reports()).toHaveLength(1);

    // A later message fails in a run of its own: a wake again.
    gateway.say("general", "alice", `@${ME} please tell c1 more`);
    await waitFor(() => reports().length === 2, { what: "the second failure's report" });
    await pause(2_000);
    expect(failureWakes()).toHaveLength(2);
    forgetFailures();
  });

  it("names in a failure's wake the last step that ran, not tool calls of an answer that was cut off", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please fail cut off`);
    await waitFor(() => failureWakes().length === 1, { what: "the failure wake", timeout: 30_000 });
    expect(failureWakes()[0]!.text).toMatch(/^Last, it called bash: echo step one$/m);
    expect(failureWakes()[0]!.text).not.toContain("never-ran");
    forgetFailures();
  });

  it("withdraws a failure wake that waits in the main agent's queue when the child is stopped", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please fail slowly`);
    await waitFor(() => /In bash for \d+ s: sleep 4/.test(gateway.pots("children")), { what: "the child's nap" });
    // The main agent is busy when the failure comes, so its wake waits in the queue.
    gateway.say("general", "alice", `@${ME} please hold`);
    await waitFor(() => failureWakes().length === 1, { what: "the failure wake" });
    const wake = () => gateway.query<{ status: string; reason: string | null }>(`SELECT status, json_extract(record, '$.reason') AS reason FROM pi_submissions WHERE request_id LIKE '"child-end:%'`);
    expect(wake()).toEqual([{ status: "queued", reason: null }]);
    expect(gateway.pots("children", "--stop", "c1")).toMatch(/Stopped c1/);
    await waitFor(() => wake()[0]?.status === "unanswered", { what: "the withdrawn wake" });
    expect(wake()).toEqual([{ status: "unanswered", reason: "aborted" }]);
    // The main agent ends its command and never sees the wake.
    await waitFor(() => mainRequests().some((request) => request.messages.at(-1)?.role === "tool" && request.messages.at(-3)!.content.includes("please hold")), { what: "the end of the main agent's command", timeout: 20_000 });
    await pause(1_000);
    expect(mainRequests().some((request) => request.messages.some((message) => message.content.startsWith("[wake] your child")))).toBe(false);
    expect(reports()).toHaveLength(0);
    forgetFailures();
  });

  it("does not wake the main agent for a model request that fails once and is retried", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please retry`);
    await waitFor(() => ended("c1"), { what: "the child's end", timeout: 30_000 });
    expect(flaky).toBe(2);
    await pause(1_000);
    expect(failureWakes()).toHaveLength(0);
    expect(await resultOf("c1")).toMatch(/\nIts last final message:\nthe answer is 42$/);
    forgetFailures();
  });

  it("wakes the main agent each time a routine's child fails", async () => {
    await setUp();
    gateway.pots("routine", "add", "doomed", "--every", "3s", "--child", "fail after a step");
    await waitFor(() => failureWakes().length === 2, { what: "two failure wakes", timeout: 30_000 });
    gateway.pots("routine", "remove", "doomed");
    const [first, second] = failureWakes();
    expect(first!.place).toBeNull();
    expect(first!.text).toMatch(/^\[wake\] your child c1 failed: model_error/);
    expect(first!.text).toMatch(/^Child: c1 "doomed", started by routine doomed, started /m);
    expect(second!.text).toMatch(/^\[wake\] your child c2 failed: model_error/);
    forgetFailures();
  });

  it("starts a child for a routine without waking the main agent, and skips the routine's time while that child works", async () => {
    await setUp();
    gateway.pots("routine", "add", "mail-watch", "--every", "3s", "--child", "wait for go, then answer (no model)");
    await waitFor(() => model.requests.some(isChild), { what: "the routine's child" });
    const first = model.requests.find(isChild)!;
    expect(first.messages[0]!.content).toBe("[brief from routine mail-watch; you are child c1]\nwait for go, then answer (no model)");
    expect(gateway.pots("children")).toMatch(/^c1 "mail-watch": working, for \d+ s, thinking xhigh$/m);
    expect(gateway.pots("routine", "list")).toMatch(/last: .*, started child c1\n/);
    // While c1 works, the routine's next times start no child.
    await pause(7_000);
    expect(gateway.pots("children")).not.toMatch(/^c2 /m);
    writeFileSync(join(gateway.botDir, "workspace", "go"), "");
    await waitFor(() => ended("c1"), { what: "the first child's end" });
    await waitFor(() => /^c2 "mail-watch"/m.test(gateway.pots("children")), { what: "the next child" });
    gateway.pots("routine", "remove", "mail-watch");
    await waitFor(() => ended("c2"), { what: "the next child's end" });
    // The main agent was never woken.
    expect(mainRequests()).toHaveLength(0);
    expect(gateway.query("SELECT id FROM bot_wakes")).toHaveLength(0);
  });

  it("sees the memory index as it was when it started, for its whole conversation, and keeps the thinking level it was given", async () => {
    await setUp();
    const index = join(gateway.botDir, "memory", "MEMORY.md");
    mkdirSync(join(gateway.botDir, "memory"), { recursive: true });
    writeFileSync(index, "- [Alice](alice.md) — likes tea\n");
    gateway.say("general", "alice", `@${ME} please note`);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    expect(readFileSync(index, "utf8")).toBe("- [Alice](alice.md) — likes tea\n- [Bob](bob.md) — likes coffee\n");
    // The line the child added itself does not change the start of its own requests; the child has what memory is for,
    // without the file format, and the main agent's facts about the index (alice.md is not there) are not in it.
    const [first, second] = model.requests.filter(isChild);
    expect(first!.system).toMatch(/# Memory\n\nMemory keeps facts and pointers that must outlast a page: [^\n]+ The message log keeps everything that was said\. [^\n]+\n\nContents of \S+[\\/]memory\/MEMORY\.md \(the memory of Coworker, as it was when you started\):\n\n- \[Alice\]\(alice\.md\) — likes tea\n\n/);
    expect(first!.system).not.toContain("A memory file:");
    expect(first!.system).not.toContain("links to files that do not exist");
    expect(second!.system).toBe(first!.system);
    expect(gateway.pots("children")).toMatch(/^c1 "note": .*, thinking max$/m);
  });

  it("keeps the model the main agent chose across a bot.json change and a restart; a child without one has the bot's model", async () => {
    // childModel and childThinking of an earlier version are still in bot.json: they are ignored, and the gateway says so.
    await setUp({ moreModels: true, definition: { childModel: "fake/helper", childThinking: "max" } });
    expect(gateway.output.some((line) => String(line.message).startsWith('"childModel" and "childThinking" in bot.json are no longer used, and ignored'))).toBe(true);
    const children = () => model.requests.filter(isChild);
    gateway.say("general", "alice", `@${ME} please wait on fake/helper`);
    await waitFor(() => children().length === 1, { what: "the first child" });
    gateway.say("general", "alice", `@${ME} please wait`);
    await waitFor(() => children().length === 2, { what: "the second child" });
    // Each line may be followed by lines on what the child does now.
    const list = gateway.pots("children");
    expect(list).toMatch(/^c1 "waiter": working, for [^,]*, for test:#general, model fake\/helper, thinking low$/m);
    expect(list).toMatch(/^c2 "waiter": working, for [^,]*, for test:#general, thinking xhigh$/m);

    // The bot's model changes while both children work: only the child without a model of its own takes it.
    const file = join(gateway.botDir, "bot.json");
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), model: "fake/other" }, null, 2)}\n`);
    await waitFor(() => gateway.output.some((line) => line.message === "definition applied"), { what: "the new definition" });
    writeFileSync(join(gateway.botDir, "workspace", "go"), "");
    await waitFor(() => ended("c1") && ended("c2"), { what: "both ends" });
    const of = (choice: string) => children().filter((request) => request.messages[0]!.content.endsWith(`(${choice})`)).map((request) => request.model);
    expect(of("fake/helper")).toEqual(["helper", "helper"]);
    expect(of("no model")).toEqual(["coworker", "other"]);

    // After a restart, each keeps the model it had, and the main agent still reads what each ended with.
    await gateway.stop();
    await gateway.start();
    expect(await resultOf("c1")).toMatch(/\nIts last final message:\ndone waiting$/);
    gateway.say("general", "alice", `@${ME} please tell c1 more`);
    await waitFor(() => children().length === 5, { what: "the first child's second answer" });
    await waitFor(() => ended("c1"), { what: "the first child's second end" });
    gateway.say("general", "alice", `@${ME} please tell c2 more`);
    await waitFor(() => children().length === 6, { what: "the second child's second answer" });
    await waitFor(() => ended("c2"), { what: "the second child's second end" });
    expect(of("fake/helper")).toEqual(["helper", "helper", "helper"]);
    expect(of("no model")).toEqual(["coworker", "other", "other"]);
    expect(reports()).toHaveLength(0);
  });

  it("starts no child on a model that is not signed in or unknown, and says why", async () => {
    await setUp({ moreModels: true });
    const results = () => agentRequests(model).flatMap((request) => (request.messages.at(-1)?.role === "tool" ? [request.messages.at(-1)!.content] : []));
    gateway.say("general", "alice", `@${ME} please research on locked/model`);
    await waitFor(() => results().length === 1, { what: "the first refusal" });
    gateway.say("general", "alice", `@${ME} please research on fake/nope`);
    await waitFor(() => results().length === 2, { what: "the second refusal" });
    const list = 'a codemode script lists the models you can use with models.getAvailableOfType("chat").';
    expect(results()).toEqual([
      `Not started: locked/model is not signed in on this computer: pi has no login or key for "locked". A person signs in with pots login in their terminal; ${list}`,
      `Not started: unknown model fake/nope; ${list}`,
    ]);
    expect(gateway.pots("children").trim()).toBe("No children.");
    expect(model.requests.some(isChild)).toBe(false);
  });

  it("does nothing more after a stop, from the task tool or pots children", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research slowly`);
    // The child runs its long command.
    await waitFor(() => model.requests.some(isChild), { what: "the child to start" });
    await pause(500);
    gateway.say("general", "alice", `@${ME} stop the research`);
    await waitFor(() => /^c1 "research": stopped/m.test(gateway.pots("children")), { what: "the stop" });
    await pause(2_000);
    // Only the first request of the child: its command was stopped, so it never answered.
    expect(model.requests.filter(isChild)).toHaveLength(1);

    // Another child, stopped by a person on this computer.
    gateway.say("general", "alice", `@${ME} please research slowly`);
    await waitFor(() => /^c2 "research": working/m.test(gateway.pots("children")), { what: "the second child" });
    expect(gateway.pots("children", "--stop", "c2")).toMatch(/Stopped c2/);
    await pause(2_000);
    expect(model.requests.filter(isChild)).toHaveLength(2);
    expect(wakeLine(gateway.pots("children"))).toMatch(/^c1 "research": stopped/);
    expect(failureWakes()).toHaveLength(0);
  });

  it("keeps a child's answer when a stop comes after the answer, before its reporter kept it", async () => {
    await setUp();
    gateway.holdChildKeep();
    gateway.say("general", "alice", `@${ME} please research`);
    await waitFor(() => gateway.output.some((line) => line.message === "crash test: holding the child's end"), { what: "the held answer" });
    gateway.say("general", "alice", `@${ME} stop the research`);
    await waitFor(() => /^c1 "research": stopped/m.test(gateway.pots("children")), { what: "the stop" });
    gateway.releaseChildKeep();
    expect(await resultOf("c1")).toMatch(/^c1 "research": stopped \d+ s ago, for test:#general\nIts last final message:\nthe answer is 42$/);
  });

  it("has its prompt cache warmed while it works, as pi warms its session, and no more once it is stopped", async () => {
    await setUp({ promptCacheSeconds: 12 });
    gateway.say("general", "alice", `@${ME} please research slowly`);
    // The child's request asked for its long command; the command runs, and the request is sent again every 2 seconds.
    const warms = () => model.requests.filter((request) => isChild(request) && request.maxTokens === 1);
    await waitFor(() => warms().length >= 2, { timeout: 20_000, what: "two warms of the child" });
    const { maxTokens: _, ...first } = model.requests.find((request) => isChild(request) && request.maxTokens !== 1)!;
    for (const { maxTokens: _cap, ...warm } of warms()) expect(warm).toEqual(first);
    gateway.say("general", "alice", `@${ME} stop the research`);
    await waitFor(() => /^c1 "research": stopped/m.test(gateway.pots("children")), { what: "the stop" });
    const stopped = warms().length;
    await pause(5_000);
    expect(warms()).toHaveLength(stopped);
  });

  it("shows what a child that hangs in a command does, and interrupt ends only the command: the child takes the message that waited", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please probe`);
    await waitFor(() => /Last output \d+ s ago: probing 5901/.test(gateway.pots("children")), { what: "the command's output" });
    expect(existsSync(join(gateway.botDir, "workspace", "hang.pid"))).toBe(true);
    expect(gateway.pots("children")).toMatch(
      /^c1 "probe": working, for \d+ s, for test:#general, thinking xhigh\n {2}In bash for \d+ s: sleep 6131 & echo \$! > hang\.pid; echo probing 5901; wait\n {2}Last output \d+ s ago: probing 5901$/m,
    );

    // A message to the child while it is in the command waits for the command to end, and the main agent learns that,
    // from the wake and from the answer to its send.
    gateway.say("general", "alice", `@${ME} wrap up the probe`);
    await waitFor(() => taskResult("Sent to c1") !== undefined, { what: "the send" });
    const wake = wakes(model).find((text) => text.includes("wrap up the probe"))!;
    expect(wake).toMatch(
      /^Your children working for this place \(1\):\n- c1 "probe": working, for \d+ s, for test:#general\n {2}In bash for \d+ s: sleep 6131 [^\n]*\n {2}Last output \d+ s ago: probing 5901$/m,
    );
    expect(taskResult("Sent to c1")).toMatch(
      /^Sent to c1; it takes the message when its current tool calls end\.\nc1 "probe": working, for \d+ s, for test:#general\n {2}In bash for \d+ s: sleep 6131 [^\n]*\n {2}Last output \d+ s ago: probing 5901$/,
    );
    await waitFor(() => gateway.pots("children").includes("1 message from you waits until its current tool calls end."), { what: "the waiting message" });
    await pause(1_000);
    expect(model.requests.filter(isChild)).toHaveLength(1);
    expect(hangRuns()).not.toBe(false);

    // The interrupt ends the command and the processes it started; the child goes on with the message.
    gateway.say("general", "alice", `@${ME} interrupt the probe`);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    expect(await resultOf("c1")).toMatch(/\nIts last final message:\nwrapped up$/);
    expect(taskResult("Interrupted c1")).toMatch(
      /^Interrupted c1: ended its bash, which ran \d+ s \(sleep 6131 & echo \$! > hang\.pid; echo probing 5901; wait\)\. It goes on: it sees that the call was aborted, and takes the message from you that waits\.$/,
    );
    const after = model.requests.filter(isChild)[1]!;
    expect(after.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(after.messages[2]!.content).toMatch(/probing 5901[\s\S]*aborted/);
    expect(after.messages[3]!.content).toBe("[message from the main agent]\nwrap up");
    expect(hangRuns()).not.toBe(true);
    expect(gateway.pots("children")).toMatch(/^c1 "probe": ended \d+ s ago, waits for a message, for test:#general, thinking xhigh$/m);
    expect(failureWakes()).toHaveLength(0);
  });

  it("interrupts a command that a child's script runs, and the child goes on", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please probe by script`);
    await waitFor(() => /Last output \d+ s ago: probing 5901/.test(gateway.pots("children")), { what: "the command's output" });
    expect(gateway.pots("children")).toMatch(
      /^c1 "probe": working, [^\n]*\n {2}In codemode for \d+ s: return await tools\.bash\(\{ command: "sleep 6131 [^\n]*\n {2}Its script is in bash for \d+ s: sleep 6131 & echo \$! > hang\.pid; echo probing 5901; wait\n {2}Last output \d+ s ago: probing 5901$/m,
    );
    gateway.say("general", "alice", `@${ME} interrupt the probe`);
    await waitFor(() => ended("c1"), { what: "the child's end" });
    expect(await resultOf("c1")).toMatch(/\nIts last final message:\ndone waiting$/);
    expect(taskResult("Interrupted c1")).toMatch(/^Interrupted c1: ended its codemode, which ran \d+ s \(return await tools\.bash[^\n]*\)\. It goes on: it sees that the call was aborted\.$/);
    expect(model.requests.filter(isChild).at(-1)!.messages.at(-1)!.content).toMatch(/aborted/);
    expect(hangRuns()).not.toBe(true);
  });

  it("does nothing more when the gateway dies between marking a child stopped and ending its work", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research slowly`);
    await waitFor(() => model.requests.some(isChild), { what: "the child to start" });
    await pause(500);
    gateway.crashAfterNextChildStop();
    gateway.say("general", "alice", `@${ME} stop the research`);
    await gateway.exited();
    expect(gateway.output.some((line) => line.message === "crash test: dying after marking the child stopped")).toBe(true);

    // After the restart the stop is finished: the child's command is not taken up again, and nothing comes from it.
    await gateway.start();
    await pause(3_000);
    expect(gateway.pots("children")).toMatch(/^c1 "research": stopped/m);
    expect(model.requests.filter(isChild)).toHaveLength(1);
    expect(gateway.pots("children", "--stop", "c1")).toMatch(/c1 \("research"\) was stopped before/);
  });
});
