import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakeLine, wakes } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// Children from outside: a real gateway whose fake main agent starts a child with the task tool. A report that comes
// twice, or one that comes after a stop, would show only as a confused bot, so these are checked here.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");

/**
 * The main agent starts a child for "please research" and stops it for "stop the research"; a child's end it passes
 * on in the place. The child answers its brief at once, or for "wait long" runs a long command first. For "please
 * note", the child adds a line to the bot's memory index first. For "please probe" the child runs a command that hangs
 * after one line of output, from bash or from a script; the main agent sends it "wrap up" for "wrap up the probe", and
 * interrupts it for "interrupt the probe".
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (isChild(request)) {
    if (last?.role !== "user") return { text: "done waiting" };
    if (last.content.includes("wrap up")) return { text: "wrapped up" };
    if (last.content.includes("hang in bash")) return { call: { name: "bash", arguments: { command: HANG } } };
    if (last.content.includes("hang in a script")) return { call: { name: "codemode", arguments: { code: `return await tools.bash({ command: ${JSON.stringify(HANG)} });` } } };
    if (last.content.includes("wait long")) return { call: { name: "bash", arguments: { command: "sleep 60" } } };
    if (last.content.includes("nap first")) return { call: { name: "bash", arguments: { command: "sleep 8" } } };
    if (last.content.includes("save a memory")) {
      const index = /Contents of (\S+\/MEMORY\.md) \(the auto-memory of/.exec(request.system)![1]!;
      // In quotes: bash takes the backslashes of a Windows path away.
      return { call: { name: "bash", arguments: { command: `echo '- [Bob](bob.md) — likes coffee' >> '${index}'` } } };
    }
    return { text: "the answer is 42" };
  }
  if (last?.role !== "user") return { text: "done" };
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(last.content)?.[0];
  if (last.content.startsWith("[wake] your child")) {
    const final = /Its final message: (.*)/.exec(last.content)?.[1] ?? "?";
    return { call: { name: "send", arguments: { to: place, text: `report: ${final}` } } };
  }
  if (last.content.includes("stop the research")) return { call: { name: "task", arguments: { action: "stop", child: "c1" } } };
  if (last.content.includes("wrap up the probe")) return { call: { name: "task", arguments: { action: "send", child: "c1", message: "wrap up" } } };
  if (last.content.includes("interrupt the probe")) return { call: { name: "task", arguments: { action: "interrupt", child: "c1" } } };
  if (last.content.includes("please probe")) {
    const brief = last.content.includes("by script") ? "hang in a script" : "hang in bash";
    return { call: { name: "task", arguments: { action: "start", title: "probe", brief } } };
  }
  if (last.content.includes("please nap")) return { call: { name: "task", arguments: { action: "start", title: "nap", brief: "nap first, then answer" } } };
  if (last.content.includes("please note")) return { call: { name: "task", arguments: { action: "start", title: "note", brief: "save a memory", thinking: "max" } } };
  if (last.content.includes("please research")) {
    const brief = last.content.includes("slowly") ? "wait long, then find the answer" : "find the answer";
    return { call: { name: "task", arguments: { action: "start", title: "research", brief } } };
  }
  return { text: "nothing to do" };
}

/** A command that hangs after one line of output; the process that hangs writes its ID to hang.pid in the workspace. */
const HANG = "sleep 6131 & echo $! > hang.pid; echo probing 5901; wait";

async function setUp(childModel?: string): Promise<void> {
  model = await startFakeModel(script);
  gateway = new TestGateway({ model, ...(childModel ? { childModel } : {}) });
  await gateway.start();
}

const reports = () => gateway.sent().filter((record) => record.text?.startsWith("report:"));
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
/** How often the main conversation holds a child's report, as its newest request shows it. */
const reportsSeen = () => {
  const main = agentRequests(model).filter((request) => !isChild(request));
  return main.at(-1)?.messages.filter((message) => message.role === "user" && message.content.startsWith("[wake] your child")).length ?? 0;
};

describe("children", { timeout: 90_000 }, () => {
  it("works in the background and reports its final message to the main agent", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(reports()[0]!.text).toBe("report: the answer is 42");
    // The child started from the brief alone, with the working tools but no channel actions and no task tool, and its
    // prompt does not tell it how to use them.
    const child = model.requests.find(isChild)!;
    expect(child.messages.map((message) => message.role)).toEqual(["user"]);
    expect(child.messages[0]!.content).toBe("[brief from the main agent]\nfind the answer");
    expect(child.tools).toEqual(["read", "write", "edit", "bash", "screen", "codemode"]);
    expect(child.system).not.toMatch(/pots send|pots react|pots call|ask-secret/);
    expect(gateway.pots("children")).toMatch(/^c1 "research": ended .* ago, waits for a message, for test:#general, thinking xhigh$/m);

    // On Windows a stop ends the process at once, as a kill does, before the gateway writes the spans of its last second:
    // there, wait until the last model request is written (with it, all that ended before it).
    if (process.platform === "win32") await waitFor(() => /^Model requests: 5,/m.test(gateway.pots("trace")), { what: "the spans" });
    await gateway.stop();
    // The child's end is a wake of its own, and the child's model requests are in the trace with the others.
    expect(gateway.pots("trace")).toMatch(/child\s+test:#general\s+sent 1\s+model 2×/);
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+model 3×/);
    expect(gateway.pots("trace")).toMatch(/^Model requests: 5,/m);
    expect(gateway.pots("trace", "mention:test:#general:1")).toMatch(/^child run, trace [^\n]*\nsubmission \d+ \(placed\)[\s\S]*model fake\/coworker, 100 in \(80% cached\), 10 out, stop/m);
  });

  it("sees the memory index as it was when it started, for its whole conversation, and keeps the thinking level it was given", async () => {
    await setUp();
    const index = join(gateway.botDir, "memory", "MEMORY.md");
    mkdirSync(join(gateway.botDir, "memory"), { recursive: true });
    writeFileSync(index, "- [Alice](alice.md) — likes tea\n");
    gateway.say("general", "alice", `@${ME} please note`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(readFileSync(index, "utf8")).toBe("- [Alice](alice.md) — likes tea\n- [Bob](bob.md) — likes coffee\n");
    // The line the child added itself does not change the start of its own requests; the child has no memory instructions.
    const [first, second] = model.requests.filter(isChild);
    expect(first!.system).toMatch(/# Memory\n\nContents of \S+[\\/]memory\/MEMORY\.md \(the auto-memory of Coworker, as it was when you started\):\n\n- \[Alice\]\(alice\.md\) — likes tea\n\n/);
    expect(first!.system).not.toContain("Each memory is one file holding one fact");
    expect(second!.system).toBe(first!.system);
    expect(gateway.pots("children")).toMatch(/^c1 "note": .*, thinking max$/m);
  });

  it("takes the bot's model once bot.json no longer names a childModel, also a child that works", async () => {
    await setUp("fake/helper");
    gateway.say("general", "alice", `@${ME} please nap`);
    await waitFor(() => model.requests.some(isChild), { what: "the child to start" });
    const file = join(gateway.botDir, "bot.json");
    const { childModel: _, ...definition } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
    await waitFor(() => gateway.output.some((line) => line.message === "definition applied"), { what: "the new definition" });
    await waitFor(() => reports().length === 1, { what: "the report" });
    // The child's first request before the change, its last one after.
    expect(model.requests.filter(isChild).map((request) => request.model)).toEqual(["helper", "coworker"]);
  });

  for (const when of ["before", "after"] as const) {
    it(`reports once when the gateway dies ${when} the report reaches the main agent`, async () => {
      await setUp();
      gateway.crashAroundNextChildReport(when);
      gateway.say("general", "alice", `@${ME} please research`);
      await gateway.exited();
      expect(gateway.output.some((line) => line.message === `crash test: dying ${when} the child's report`)).toBe(true);
      expect(reports()).toHaveLength(0);

      await gateway.start();
      await waitFor(() => reports().length === 1, { what: "the report" });
      await pause(2_000);
      expect(reports()).toHaveLength(1);
      expect(reportsSeen()).toBe(1);
      expect(gateway.query<{ id: string }>("SELECT id FROM bot_wakes WHERE reason = 'child'")).toHaveLength(1);
    });
  }

  it("reports nothing after a stop, from the task tool or pots children", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research slowly`);
    // The child runs its long command.
    await waitFor(() => model.requests.some(isChild), { what: "the child to start" });
    await pause(500);
    gateway.say("general", "alice", `@${ME} stop the research`);
    await waitFor(() => /^c1 "research": stopped/m.test(gateway.pots("children")), { what: "the stop" });
    await pause(2_000);
    expect(reports()).toHaveLength(0);
    expect(reportsSeen()).toBe(0);
    // Only the first request of the child: its command was stopped, so it never answered.
    expect(model.requests.filter(isChild)).toHaveLength(1);

    // Another child, stopped by a person on this computer.
    gateway.say("general", "alice", `@${ME} please research slowly`);
    await waitFor(() => /^c2 "research": working/m.test(gateway.pots("children")), { what: "the second child" });
    expect(gateway.pots("children", "--stop", "c2")).toMatch(/Stopped c2/);
    await pause(2_000);
    expect(reports()).toHaveLength(0);
    expect(gateway.query<{ id: string }>("SELECT id FROM bot_wakes WHERE reason = 'child'")).toHaveLength(0);
    expect(wakeLine(gateway.pots("children"))).toMatch(/^c1 "research": stopped/);
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
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(reports()[0]!.text).toBe("report: wrapped up");
    expect(taskResult("Interrupted c1")).toMatch(
      /^Interrupted c1: ended its bash, which ran \d+ s \(sleep 6131 & echo \$! > hang\.pid; echo probing 5901; wait\)\. It goes on: it sees that the call was aborted, and takes the message from you that waits\.$/,
    );
    const after = model.requests.filter(isChild)[1]!;
    expect(after.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(after.messages[2]!.content).toMatch(/probing 5901[\s\S]*aborted/);
    expect(after.messages[3]!.content).toBe("[message from the main agent]\nwrap up");
    expect(hangRuns()).not.toBe(true);
    expect(gateway.pots("children")).toMatch(/^c1 "probe": ended \d+ s ago, waits for a message, for test:#general, thinking xhigh$/m);
  });

  it("interrupts a command that a child's script runs, and the child goes on", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please probe by script`);
    await waitFor(() => /Last output \d+ s ago: probing 5901/.test(gateway.pots("children")), { what: "the command's output" });
    expect(gateway.pots("children")).toMatch(
      /^c1 "probe": working, [^\n]*\n {2}In codemode for \d+ s: return await tools\.bash\(\{ command: "sleep 6131 [^\n]*\n {2}Its script is in bash for \d+ s: sleep 6131 & echo \$! > hang\.pid; echo probing 5901; wait\n {2}Last output \d+ s ago: probing 5901$/m,
    );
    gateway.say("general", "alice", `@${ME} interrupt the probe`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(reports()[0]!.text).toBe("report: done waiting");
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
    expect(reports()).toHaveLength(0);
    expect(gateway.query<{ id: string }>("SELECT id FROM bot_wakes WHERE reason = 'child'")).toHaveLength(0);
    expect(gateway.pots("children", "--stop", "c1")).toMatch(/c1 \("research"\) was stopped before/);
  });
});
