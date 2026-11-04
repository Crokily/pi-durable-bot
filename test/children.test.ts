import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakeLine } from "./support/fake-model.ts";
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
const lastUser = (request: FakeRequest) => request.messages.findLast((message) => message.role === "user")?.content ?? "";

/**
 * The main agent starts a child for "please research" and stops it for "stop the research"; a child's end it passes
 * on in the place. The child answers its brief at once, or for "wait long" runs a long command first and then says so
 * in the place. For "please note", the child saves a memory entry first.
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (isChild(request)) {
    if (last?.role !== "user") {
      const said = request.messages.some((message) => message.toolCalls?.includes("send"));
      if (request.messages[0]?.content.includes("wait long") && !said) return { call: { name: "send", arguments: { to: "test:#general", text: "child: waited" } } };
      return { text: "done waiting" };
    }
    if (last.content.includes("wait long")) return { call: { name: "bash", arguments: { command: "sleep 60" } } };
    if (last.content.includes("save a memory")) return { call: { name: "bash", arguments: { command: 'pots memory add "Bob likes coffee."' } } };
    return { text: "the answer is 42" };
  }
  if (last?.role !== "user") return { text: "done" };
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(last.content)?.[0];
  if (last.content.startsWith("[wake] your child")) {
    const final = /Its final message: (.*)/.exec(last.content)?.[1] ?? "?";
    return { call: { name: "send", arguments: { to: place, text: `report: ${final}` } } };
  }
  if (last.content.includes("stop the research")) return { call: { name: "task", arguments: { action: "stop", child: "c1" } } };
  if (last.content.includes("please note")) return { call: { name: "task", arguments: { action: "start", title: "note", brief: "save a memory", thinking: "max" } } };
  if (last.content.includes("please research")) {
    const brief = last.content.includes("slowly") ? "wait long, then find the answer" : "find the answer";
    return { call: { name: "task", arguments: { action: "start", title: "research", brief } } };
  }
  return { text: "nothing to do" };
}

async function setUp(): Promise<void> {
  model = await startFakeModel(script);
  gateway = new TestGateway({ model });
  await gateway.start();
}

const reports = () => gateway.sent().filter((record) => record.text?.startsWith("report:"));
/** How often the main conversation holds a child's report, as its newest request shows it. */
const reportsSeen = () => {
  const main = model.requests.filter((request) => !isChild(request) && request.tools.includes("task"));
  return main.at(-1)?.messages.filter((message) => message.role === "user" && message.content.startsWith("[wake] your child")).length ?? 0;
};

describe("children", { timeout: 90_000 }, () => {
  it("works in the background and reports its final message to the main agent", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please research`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(reports()[0]!.text).toBe("report: the answer is 42");
    // The child started from the brief alone, with the working tools but no task tool.
    const child = model.requests.find(isChild)!;
    expect(child.messages.map((message) => message.role)).toEqual(["user"]);
    expect(child.messages[0]!.content).toBe("[brief from the main agent]\nfind the answer");
    expect(child.tools).toEqual(["read", "write", "edit", "bash", "send", "react", "call", "screen"]);
    expect(gateway.pots("children")).toMatch(/^c1 "research": ended .* ago, waits for a message, for test:#general, thinking xhigh$/m);

    await gateway.stop();
    // The child's end is a wake of its own, and the child's model requests are in the trace with the others.
    expect(gateway.pots("trace")).toMatch(/child\s+test:#general\s+sent 1\s+model 2×/);
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+model 3×/);
    expect(gateway.pots("trace")).toMatch(/^Model requests: 5,/m);
    expect(gateway.pots("trace", "mention:test:#general:1")).toMatch(/^child run, trace [^\n]*\nsubmission \d+ \(placed\)[\s\S]*model fake\/coworker, 100 in \(80% cached\), 10 out, stop/m);
  });

  it("sees the memory as it was when it started, for its whole conversation, and keeps the thinking level it was given", async () => {
    await setUp();
    expect(gateway.pots("memory", "add", "Alice likes tea.")).toBe("Saved m1.\n");
    gateway.say("general", "alice", `@${ME} please note`);
    await waitFor(() => reports().length === 1, { what: "the report" });
    expect(gateway.pots("memory", "list")).toBe("- m1: Alice likes tea.\n- m2: Bob likes coffee.\n");
    // The entry the child saved itself does not change the start of its own requests.
    const [first, second] = model.requests.filter(isChild);
    expect(first!.system).toMatch(/# Memory\n[\s\S]*- m1: Alice likes tea\.$/);
    expect(second!.system).toBe(first!.system);
    expect(gateway.pots("children")).toMatch(/^c1 "note": .*, thinking max$/m);
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
    expect(gateway.sent().filter((record) => record.text?.startsWith("child:"))).toHaveLength(0);
    expect(reports()).toHaveLength(0);
    expect(gateway.query<{ id: string }>("SELECT id FROM bot_wakes WHERE reason = 'child'")).toHaveLength(0);
    expect(gateway.pots("children", "--stop", "c1")).toMatch(/c1 \("research"\) was stopped before/);
  });
});
