import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakeLine } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// Children that start children, from outside: a real gateway whose fake main agent starts a lead child, and the lead
// starts children of its own with the task tool, from a script or step by step, and waits for them.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");
/** Whether a person put the file go in the workspace. */
const go = () => existsSync(join(gateway.botDir, "workspace", "go"));
const putGo = () => writeFileSync(join(gateway.botDir, "workspace", "go"), "");
const go2 = () => existsSync(join(gateway.botDir, "workspace", "go2"));
const putGo2 = () => writeFileSync(join(gateway.botDir, "workspace", "go2"), "");
const bash = (command: string): FakeReply => ({ call: { name: "bash", arguments: { command } } });
const task = (args: Record<string, unknown>): FakeReply => ({ call: { name: "task", arguments: args } });

/** What a lead does for each brief, step by step; then it answers with the result of its last step. */
const LEADS: Record<string, FakeReply[]> = {
  "fan out": [
    {
      call: {
        name: "codemode",
        arguments: {
          code:
            'const started = [await tools.task({ action: "start", title: "one", brief: "answer one" }), await tools.task({ action: "start", title: "two", brief: "wait for go" })];\n' +
            'return await tools.task({ action: "wait", children: started.map((each) => /Started (c\\d+)/.exec(JSON.stringify(each))[1]) });',
        },
      },
    },
  ],
  cap: [task({ action: "start", title: "one", brief: "wait for go" }), task({ action: "start", title: "two", brief: "answer one" })],
  any: [task({ action: "start", title: "one", brief: "answer one" }), task({ action: "start", title: "two", brief: "wait for go" }), task({ action: "wait", children: ["c2", "c3"], any: true })],
  "time limit": [task({ action: "start", title: "one", brief: "wait for go" }), task({ action: "wait", children: ["c2"], seconds: 2 })],
  "wait for two": [task({ action: "start", title: "one", brief: "wait for go" }), task({ action: "start", title: "two", brief: "wait for go" }), task({ action: "wait", children: ["c2", "c3"] })],
  again: [task({ action: "start", title: "one", brief: "answer one" }), task({ action: "start", title: "two", brief: "wait for go" }), task({ action: "wait", children: ["c2", "c3"] })],
  long: [
    task({ action: "start", title: "one", brief: "answer long" }),
    task({ action: "start", title: "two", brief: "answer long" }),
    task({ action: "start", title: "three", brief: "answer long" }),
    task({ action: "wait", children: ["c2", "c3", "c4"] }),
  ],
  "start one": [task({ action: "start", title: "one", brief: "wait for go" })],
  "start two": [task({ action: "start", title: "one", brief: "wait for go" }), task({ action: "start", title: "two", brief: "wait for go" })],
  "fail after a wait": [task({ action: "start", title: "doomed", brief: "fail after a nap" }), task({ action: "wait", children: ["c2"], seconds: 1 }), bash("until [ -e go ]; do sleep 0.2; done")],
  "wait for all": [task({ action: "start", title: "one", brief: "wait for go" }), task({ action: "wait", children: ["c2"] })],
  "fail below": [task({ action: "start", title: "doomed", brief: "fail after a step" }), bash("until [ -e go ]; do sleep 0.2; done")],
  "fail later": [task({ action: "start", title: "doomed", brief: "fail after a nap" })],
  "parallel waits": [
    {
      call: {
        name: "codemode",
        arguments: {
          code:
            'const ids = [];\nfor (const title of ["one", "two", "three", "four"]) ids.push(/Started (c\\d+)/.exec(JSON.stringify(await tools.task({ action: "start", title, brief: "answer huge" })))[1]);\n' +
            'return await Promise.all(ids.map((id) => tools.task({ action: "wait", children: [id] })));',
        },
      },
    },
  ],
};

/**
 * The main agent starts a lead for "please lead <brief>", stops a child for "stop <child>", lists its children for
 * "please list", reads a child's result for "what did <child> say", and passes on a child's failure in the place. A
 * grandchild answers "one" at once, "two" once go is there, or runs a command and then its model fails for good.
 */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  const brief = request.messages[0]?.content ?? "";
  const step = request.messages.filter((message) => message.role === "tool").length;
  if (isChild(request) && brief.startsWith("[brief from child")) {
    if (request.messages.some((message) => message.content === "[message from the main agent]\nhold on")) return go2() ? { text: "held" } : bash("until [ -e go2 ]; do sleep 0.2; done");
    if (last?.role === "user" && last.content.startsWith("[message from")) return { text: last.content.split("\n")[1] ?? "" };
    if (brief.includes("answer one")) return { text: "one" };
    if (brief.includes("answer huge")) {
      const id = /you are child (c\d+)/.exec(brief)?.[1];
      return { text: Array.from({ length: 2_100 }, (_, index) => `${id} line ${index + 1}`).join("\n") };
    }
    if (brief.includes("answer long")) return { text: Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join("\n") };
    if (brief.includes("wait for go")) return go() ? { text: "two" } : bash("until [ -e go ]; do sleep 0.2; done");
    const fail: FakeReply = { fail: { status: 401, message: "the login expired" } };
    if (brief.includes("fail after a step")) return step === 0 ? bash("echo step one") : fail;
    if (brief.includes("fail after a nap")) return step === 0 ? bash("sleep 3") : fail;
    return { text: "?" };
  }
  if (isChild(request) && brief.split("\n")[1] === "answer, then handle a failure") {
    // Answers, then stops the child whose failure it hears of, and works on until go is there.
    if (last?.role === "user" && last.content.startsWith("[your child")) return task({ action: "stop", child: "c2" });
    if (last?.role === "tool" && last.content.startsWith("Stopped c2")) return bash("until [ -e go ]; do sleep 0.2; done");
    if (step === 0) return task({ action: "start", title: "doomed", brief: "fail after a nap" });
    return { text: step === 1 ? "first answer" : "handled" };
  }
  if (isChild(request)) {
    if (last?.role === "user" && last.content.startsWith("[your child")) return { text: `heard: ${wakeLine(last.content)}` };
    const plan = LEADS[brief.split("\n")[1] ?? ""] ?? [];
    return plan[step] ?? { text: `lead got: ${last?.content}` };
  }
  if (last?.role !== "user") return { text: "done" };
  if (last.content.startsWith("[wake] your child")) return { call: { name: "send", arguments: { to: "test:#general", text: `report: ${wakeLine(last.content)}` } } };
  const lead = /please lead (.+)/.exec(last.content)?.[1];
  if (lead) return task({ action: "start", title: "lead", brief: lead });
  const stop = /stop (c\d+)/.exec(last.content)?.[1];
  if (stop) return task({ action: "stop", child: stop });
  const said = /what did (c\d+) say/.exec(last.content)?.[1];
  if (said) return task({ action: "result", child: said });
  const awaited = /wait for (c\d+)/.exec(last.content)?.[1];
  if (awaited) return task({ action: "wait", children: [awaited] });
  const tell = /tell (c\d+): (.+)/.exec(last.content);
  if (tell) return task({ action: "send", child: tell[1], message: tell[2] });
  if (last.content.includes("please list")) return task({ action: "list" });
  return { text: "nothing to do" };
}

async function setUp(settings: Record<string, unknown> = {}): Promise<void> {
  model = await startFakeModel(script);
  gateway = new TestGateway({ model, settings });
  await gateway.start();
}

/** The results of the main agent's tool calls, oldest first, as its last request has them. */
const mainResults = () =>
  (
    agentRequests(model)
      .filter((request) => !isChild(request))
      .at(-1)?.messages ?? []
  ).flatMap((message) => (message.role === "tool" ? [message.content] : []));
/** The main agent's next task result that starts with start, after the first `after` results. */
async function mainResult(start: string, after = 0): Promise<string> {
  const next = () => mainResults().slice(after).find((each) => each.startsWith(start));
  await waitFor(() => next() !== undefined, { what: `the result "${start}"` });
  return next()!;
}
/** The lead's answer: its last request's answer is what it got from its last step. */
const leadAnswer = () => new RegExp(`^c1 "lead": ended`, "m").test(gateway.pots("children"));
/** The lead's requests, oldest first: c1's, or another lead's. */
const leadRequests = (id = "c1") => model.requests.filter((request) => isChild(request) && request.messages[0]?.content.startsWith(`[brief from the main agent; you are child ${id}]`));
/** Whether the gateway printed this line. */
const printed = (message: string) => gateway.output.some((line) => line.message === message);
/** A hold of the gateway's, while its file is in the bot's folder; for child-keep, of only the child `only`. */
const hold = (name: "child-start" | "after-child-stop" | "child-keep", only = "") => writeFileSync(join(gateway.botDir, `hold-${name}`), only);
const release = (name: "child-start" | "after-child-stop" | "child-keep") => rmSync(join(gateway.botDir, `hold-${name}`), { force: true });
const reports = () => gateway.sent().filter((record) => record.text?.startsWith("report:"));
const failureWakes = () => gateway.query<{ text: string }>("SELECT text FROM bot_wakes WHERE reason = 'child'");
const forgetFailures = () => gateway.output.splice(0, gateway.output.length, ...gateway.output.filter((line) => !/failed/i.test(String(line.message))));
const said = async (id: string) => {
  const after = mainResults().length;
  gateway.say("general", "alice", `@${ME} what did ${id} say`);
  return mainResult(`${id} "`, after);
};

describe("children that start children", { timeout: 90_000 }, () => {
  it("starts children from a script and waits for all of them; their results go to it, and the main agent sees the tree", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fan out`);
    await waitFor(() => /^c2 "one": ended/m.test(gateway.pots("children")) && /^c3 "two": working/m.test(gateway.pots("children")), { what: "the grandchildren" });
    // A child has the task tool; its children start with a brief from it, for its place.
    expect(leadRequests()[0]!.tools).toContain("task");
    const grandchild = model.requests.find((request) => request.messages[0]?.content.startsWith("[brief from child c1"))!;
    expect(grandchild.messages[0]!.content).toMatch(/^\[brief from child c1; you are child c[23]\]\n/);
    expect(gateway.pots("children")).toMatch(/^c2 "one": ended .* ago, waits for a message, started by c1, for test:#general/m);
    gateway.say("general", "alice", `@${ME} please list`);
    expect(await mainResult('c1 "lead"')).toMatch(/^c1 "lead": working, for .*\n {2}In codemode .*\n(?: {2}.*\n)*? {2}c2 "one": ended .*started by c1.*\n {2}c3 "two": working.*started by c1/);

    // The lead waits without a process of its own, and no end of a grandchild wakes the main agent.
    await pause(1_000);
    expect(leadRequests()).toHaveLength(1);
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    const answer = await said("c1");
    expect(answer).toMatch(/All of them ended: c2, c3\.\n\nc2 "one": ended [^\n]*\nIts final message:\none\n\nc3 "two": ended [^\n]*\nIts final message:\ntwo/);
    expect(gateway.query<{ reason: string }>("SELECT reason FROM bot_wakes").map((wake) => wake.reason)).not.toContain("child");
  });

  it("stops what a child started, and its children, when the main agent stops it", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fan out`);
    await waitFor(() => /^c3 "two": working/m.test(gateway.pots("children")), { what: "the grandchildren" });
    gateway.say("general", "alice", `@${ME} stop c1`);
    expect(await mainResult("Stopped c1")).toBe('Stopped c1 ("lead") and the children it started: c2, c3. Nothing comes back from them.');
    expect(gateway.pots("children")).toMatch(/^c1 "lead": stopped[^\n]*\nc2 "one": stopped[^\n]*started by c1[^\n]*\nc3 "two": stopped[^\n]*started by c1/);
    const before = model.requests.filter(isChild).length;
    putGo();
    await pause(2_000);
    expect(model.requests.filter(isChild).length).toBe(before);
  });

  it("shares one cap across children and their children", async () => {
    await setUp({ maxChildren: 2 });
    gateway.say("general", "alice", `@${ME} please lead cap`);
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: Not started: 2 children work now, as many as the cap \(settings\.maxChildren in bot\.json\)\. They are:\nc1 "lead": working[^\n]*\n(?: {2}.*\n)*c2 "one": working[^\n]*started by c1/);
    putGo();
  });

  it("waits for any one of them", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead any`);
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: One of them ended: c2; c3 still works\.\n\nc2 "one": ended [^\n]*\nIts final message:\none$/);

    putGo();
  });

  it("waits until the time is up", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead time limit`);
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: The time is up; c2 still works\.$/);
    putGo();
  });

  for (const how of ["stop", "kill"] as const) {
    it(`goes on waiting across a restart (${how})`, async () => {
      await setUp();
      gateway.say("general", "alice", `@${ME} please lead wait for all`);
      await waitFor(() => leadRequests().length === 2 && /^c2 "one": working/m.test(gateway.pots("children")), { what: "the wait" });
      await pause(500);
      await gateway[how]();
      putGo();
      await gateway.start();
      await waitFor(leadAnswer, { what: "the lead's end" });
      // The wait was not run again: the lead asked its model once more, with the wait's result.
      expect(leadRequests()).toHaveLength(3);
      expect(await said("c1")).toMatch(/lead got: All of them ended: c2\.\n\nc2 "one": ended [^\n]*\nIts final message:\ntwo$/);
    });
  }

  it("gives each waiter the end of a child that two wait for: its parent and the main agent", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead wait for all`);
    await waitFor(() => leadRequests().length === 2 && /^c2 "one": working/m.test(gateway.pots("children")), { what: "the lead's wait" });
    gateway.say("general", "alice", `@${ME} wait for c2`);
    await waitFor(() => model.requests.some((request) => !isChild(request) && String(request.messages.at(-1)?.content).includes("wait for c2")), { what: "the main agent's wait" });
    await pause(500);
    putGo();
    expect(await mainResult("All of them ended: c2.")).toMatch(/^All of them ended: c2\.\n\nc2 "one": ended [^\n]*\nIts final message:\ntwo$/);
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: All of them ended: c2\.\n\nc2 "one": ended [^\n]*\nIts final message:\ntwo$/);
  });

  it("stops a child that waits for two children, with them", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead wait for two`);
    await waitFor(() => leadRequests().length === 3 && /^c3 "two": working/m.test(gateway.pots("children")), { what: "the lead's wait" });
    await pause(500);
    gateway.say("general", "alice", `@${ME} stop c1`);
    expect(await mainResult("Stopped c1")).toBe('Stopped c1 ("lead") and the children it started: c2, c3. Nothing comes back from them.');
    expect(gateway.pots("children")).toMatch(/^c1 "lead": stopped[^\n]*\nc2 "one": stopped[^\n]*\nc3 "two": stopped/);
  });

  it("gives a wait the first end of each child, not the answer to a later message", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead again`);
    await waitFor(() => leadRequests().length === 3 && /^c2 "one": ended/m.test(gateway.pots("children")), { what: "the lead's wait" });
    await pause(500);
    gateway.say("general", "alice", `@${ME} tell c2: three`);
    await waitFor(() => model.requests.some((request) => isChild(request) && request.messages.at(-1)?.content === "[message from the main agent]\nthree"), { what: "c2's second answer" });
    await waitFor(() => /^c2 "one": ended/m.test(gateway.pots("children")), { what: "c2's second end" });
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: All of them ended: c2, c3\.\n\nc2 "one": ended [^\n]*\nIts final message:\none\n\nc3 "two": ended [^\n]*\nIts final message:\ntwo$/);
  });

  it("gives a batch too long for a tool's output whole, in one file", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead long`);
    await waitFor(leadAnswer, { what: "the lead's end" });
    const answer = await said("c1");
    const file = /lead got: All of them ended: c2, c3, c4\.\nTogether, their final messages are \d+ characters; all of it is in (\S+)\. Its start:\n/.exec(answer)?.[1];
    expect(file).toBeDefined();
    const saved = readFileSync(file!, "utf8");
    expect(saved.match(/^line 900$/gm)).toHaveLength(3);
    expect(saved).toMatch(/c4 "three": ended [^\n]*\nIts final message:\nline 1\n/);
  });

  it("shows each child of a batch as it ended, also one that works again since", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead again`);
    await waitFor(() => leadRequests().length === 3 && /^c2 "one": ended/m.test(gateway.pots("children")), { what: "the lead's wait" });
    await pause(500);
    gateway.say("general", "alice", `@${ME} tell c2: hold on`);
    await waitFor(() => /^c2 "one": working/m.test(gateway.pots("children")), { what: "c2's new work" });
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: All of them ended: c2, c3\.\n\nc2 "one": ended [^\n]*\nIts final message:\none\n\nc3 "two": ended [^\n]*\nIts final message:\ntwo$/);
    putGo2();
  });

  it("saves the long batches of waits at the same time each in its own file", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead parallel waits`);
    await waitFor(leadAnswer, { what: "the lead's end" });
    const files = [...(await said("c1")).matchAll(/all of it is in (\S+?\.md)\./g)].map((match) => match[1]!);
    expect(files).toHaveLength(4);
    // Each file has the answer of its own child only.
    expect(files.map((file) => [...new Set(readFileSync(file, "utf8").match(/^c\d+(?= line 2100$)/gm))])).toEqual([["c2"], ["c3"], ["c4"], ["c5"]]);
  });

  it("gives a stopped child's answer to its waits when the stop came after the answer, before its reporter kept it", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead wait for all`);
    await waitFor(() => leadRequests().length === 2 && /^c2 "one": working/m.test(gateway.pots("children")), { what: "the lead's wait" });
    hold("child-keep");
    putGo();
    await waitFor(() => printed("crash test: holding the child's end"), { what: "the held answer" });
    gateway.say("general", "alice", `@${ME} stop c2`);
    await mainResult("Stopped c2");
    release("child-keep");
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/lead got: All of them ended: c2\.\n\nc2 "one": stopped [^\n]*\nIt was stopped\. Its last final message:\ntwo$/);
  });

  for (const first of ["stop", "start"] as const) {
    it(`starts no child for a child that a stop marked, and stops one it started before (${first} first)`, async () => {
      await setUp();
      hold("child-start");
      gateway.say("general", "alice", `@${ME} please lead start one`);
      await waitFor(() => printed("crash test: holding the start of a child"), { what: "the held start" });
      if (first === "stop") {
        hold("after-child-stop");
        gateway.say("general", "alice", `@${ME} stop c1`);
        await waitFor(() => printed("crash test: holding after the stop mark"), { what: "the held stop" });
        release("child-start");
        await waitFor(() => leadRequests().length === 2, { what: "the start's result" });
        expect(leadRequests()[1]!.messages.at(-1)!.content).toBe("Not started: you were stopped.");
        release("after-child-stop");
        expect(await mainResult("Stopped c1")).toBe('Stopped c1 ("lead"). Nothing comes back from it.');
        expect(gateway.pots("children")).not.toMatch(/^c2/m);
      } else {
        release("child-start");
        await waitFor(() => /^c2 "one": working/m.test(gateway.pots("children")), { what: "the grandchild" });
        gateway.say("general", "alice", `@${ME} stop c1`);
        expect(await mainResult("Stopped c1")).toBe('Stopped c1 ("lead") and the children it started: c2. Nothing comes back from them.');
        expect(gateway.pots("children")).toMatch(/^c2 "one": stopped/m);
      }
    });
  }

  it("stops from a child's commands only the children it started", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead start two`);
    await waitFor(() => /^c3 "two": working/m.test(gateway.pots("children")), { what: "the first lead's children" });
    gateway.say("general", "alice", `@${ME} please lead start two`);
    await waitFor(() => /^c6 "two": working/m.test(gateway.pots("children")), { what: "the second lead's children" });
    const as = { env: { POTS_CHILD: "c4" } };
    expect((await gateway.run(["children", "--stop", "c2"], as)).stdout).toMatch(/No child c2 of yours/);
    expect((await gateway.run(["children", "--stop-all"], as)).stdout).toMatch(/^Stopped c5 \("one"\)\. .*\nStopped c6 \("two"\)\./);
    const children = gateway.pots("children");
    expect(children).toMatch(/^c2 "one": working/m);
    expect(children).toMatch(/^c3 "two": working/m);
    expect(children).toMatch(/^c5 "one": stopped/m);
    putGo();
  });

  it("tells the child that started it of a failure while that child works, and not the main agent", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fail below`);
    await waitFor(() => /^c2 "doomed": failed/m.test(gateway.pots("children")), { what: "the failure" });
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/heard: \[your child c2 "doomed" failed: model_error: .*the login expired/);
    expect(leadRequests().at(-1)!.messages.at(-1)!.content).toMatch(/\nLast, it called bash: echo step one$/);
    await pause(1_000);
    expect(failureWakes()).toHaveLength(0);
    expect(reports()).toHaveLength(0);
    forgetFailures();
  });

  it("tells the child that started it of a failure also after its wait for that child ran out of time", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fail after a wait`);
    await waitFor(() => /^c2 "doomed": failed/m.test(gateway.pots("children")), { what: "the failure" });
    expect(leadRequests()[2]!.messages.at(-1)!.content).toBe("The time is up; c2 still works.");
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/heard: \[your child c2 "doomed" failed: model_error: .*the login expired/);
    expect(failureWakes()).toHaveLength(0);
    forgetFailures();
  });

  it("withdraws a failure's message that waits for the child that started it, when the failed child is stopped", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fail below`);
    await waitFor(() => /^c1 "lead": working[^\n]*\n(?: {2}.*\n)*? {2}1 message from you waits/m.test(gateway.pots("children")), { what: "the queued failure" });
    gateway.say("general", "alice", `@${ME} stop c2`);
    await mainResult("Stopped c2");
    putGo();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(leadRequests().some((request) => request.messages.some((message) => message.content.includes("[your child c2")))).toBe(false);
    expect(failureWakes()).toHaveLength(0);
    forgetFailures();
  });

  it("keeps the answer of a child to a failure's message across a restart, after it stopped the failed child", async () => {
    await setUp();
    // The lead's first answer is held until the failure came as a new run: the lead still works.
    hold("child-keep", "c1");
    gateway.say("general", "alice", `@${ME} please lead answer, then handle a failure`);
    await waitFor(() => leadRequests().some((request) => request.messages.at(-1)?.content.startsWith("[your child c2")), { what: "the failure's message" });
    release("child-keep");
    await waitFor(() => leadRequests().some((request) => request.messages.at(-1)?.content.startsWith("Stopped c2")), { what: "the stop" });
    await pause(500);
    await gateway.stop();
    putGo();
    await gateway.start();
    await waitFor(leadAnswer, { what: "the lead's end" });
    expect(await said("c1")).toMatch(/Its last final message:\nhandled$/);
    forgetFailures();
  });

  it("wakes the main agent for a failure once the child that started it no longer works", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} please lead fail later`);
    await waitFor(() => reports().length === 1, { what: "the failure's report" });
    expect(reports()[0]!.text).toMatch(/^report: \[wake\] your child c2 failed: model_error: .*the login expired/);
    expect(failureWakes()).toHaveLength(1);
    expect(failureWakes()[0]!.text).toMatch(/^Child: c2 "doomed", for test:#general, started by your child c1, which no longer works, started /m);
    expect(leadRequests()).toHaveLength(2);
    forgetFailures();
  });
});
