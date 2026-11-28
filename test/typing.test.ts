import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { platformFile } from "../src/channels/test/index.ts";
import { type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakeLine, wakes } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// The typing people see while the bot works, from outside: a real gateway on the test channel, which writes each show
// and stop of its sign to working.jsonl, shown again every second.

const isJudge = (request: FakeRequest) => request.system.startsWith("You judge events");
const isChild = (request: FakeRequest) => request.system.includes("You are a child agent of");

/**
 * The judge: "pricing" is related and needs an answer (0.9), "maybe" is related and may need one (0.6), the rest not.
 * The main agent answers a wake in its place, except: "stay quiet" (no send); "wait for go" (it waits until the file go
 * is in its workspace, then answers); "send first" (it answers, then waits for go); "research and tell" (a child that
 * wakes it with pots wake, whose note it passes on); "research slowly" (the same, but the child waits for go first);
 * "answer natively" (it posts with call, not send, then waits for go).
 */
function script(request: FakeRequest): FakeReply {
  if (isJudge(request)) {
    const state = JSON.parse(request.messages.at(-1)?.content ?? "{}") as { state?: { new_events?: { text?: string }[] } };
    const texts = (state.state?.new_events ?? []).map((event) => event.text ?? "");
    const score = texts.some((text) => /pricing/i.test(text)) ? 0.9 : texts.some((text) => /maybe/i.test(text)) ? 0.6 : 0.1;
    return { text: JSON.stringify({ related: score > 0.5 ? 0.9 : 0.1, respond: score }) };
  }
  const last = request.messages.at(-1);
  if (isChild(request)) {
    const slow = request.messages.some((message) => message.role === "user" && message.content.includes("wait for go first"));
    const wait = slow ? "until [ -e go ]; do sleep 0.2; done; " : "";
    if (last?.role === "user") return { call: { name: "bash", arguments: { command: `${wait}pots wake --note "the answer is 42"` } } };
    return { text: "told the main agent" };
  }
  const wake = request.messages.findLast((message) => message.role === "user" && message.content.startsWith("[wake]"))?.content ?? "";
  const place = /\b[a-z0-9][a-z0-9-]*:#[\w-]+/.exec(wake)?.[0] ?? "test:#general";
  const went = request.messages.some((message) => message.role === "tool" && message.content.includes("went"));
  const sent = request.messages.filter((message) => message.toolCalls?.includes("send")).length;
  const waitForGo = { call: { name: "bash", arguments: { command: "until [ -e go ]; do sleep 0.2; done; echo went" } } };
  // Also as new events in a place it works on (a steer), which go into the run as they are.
  if (last?.role === "user" && last.content.includes("stay quiet")) return { text: "nothing to say" };
  if (wake.includes("wait for go")) {
    if (!went) return last?.role === "tool" && !last.content.includes("went") ? { text: "waiting" } : waitForGo;
    return sent === 0 ? { call: { name: "send", arguments: { to: place, text: "done" } } } : { text: "done" };
  }
  if (wake.includes("answer natively")) {
    const posted = request.messages.some((message) => message.toolCalls?.includes("call"));
    if (!posted) return { call: { name: "call", arguments: { channel: "test", method: "post", params: { to: place, text: "a photo" } } } };
    return went ? { text: "done" } : waitForGo;
  }
  if (wake.includes("send first")) {
    if (sent === 0) return { call: { name: "send", arguments: { to: place, text: "on it" } } };
    return went ? { text: "done" } : waitForGo;
  }
  if (last?.role !== "user") return { text: "done" };
  if (wake.startsWith("[wake] wake from your child")) {
    return { call: { name: "send", arguments: { to: "test:#general", text: `report: ${/^Note: (.*)/m.exec(wake)?.[1] ?? "?"}` } } };
  }
  if (wake.includes("stay quiet")) return { text: "nothing to say" };
  if (wake.includes("research slowly")) return { call: { name: "task", arguments: { action: "start", title: "research", brief: "wait for go first, then find it and tell" } } };
  if (wake.includes("research and tell")) return { call: { name: "task", arguments: { action: "start", title: "research", brief: "find it and tell" } } };
  return { call: { name: "send", arguments: { to: place, text: `ack: ${wakeLine(wake)}` } } };
}

let model: FakeModel;
let gateway: TestGateway;

async function setUp(options: { judge?: string; modelDelayMs?: number } = {}): Promise<void> {
  model = await startFakeModel(script, { delayMs: options.modelDelayMs ?? 0 });
  gateway = new TestGateway({ model, judge: options.judge ?? "off", settings: { judgeThreshold: 0.5 } });
  await gateway.start();
}

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

interface Sign {
  readonly type: "show" | "stop";
  readonly to: string;
  readonly at: number;
}

/** What the platform showed of the bot's typing, in order. */
function signs(): Sign[] {
  const file = join(gateway.platformDir, "working.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Sign);
}

/** The signs, with shows again at the same address as one: "show <to>" and "stop <to>". */
function steps(): string[] {
  const out: string[] = [];
  for (const sign of signs()) {
    const step = `${sign.type} ${sign.to}`;
    if (out.at(-1) !== step) out.push(step);
  }
  return out;
}

/** A person clicks a button of the bot's on a message. */
function click(place: string, person: string, message: string): void {
  appendFileSync(platformFile(gateway.platformDir), `${JSON.stringify({ id: `e-${randomUUID()}`, at: Date.now(), type: "interaction", place, person, message, text: "clicked Approve" })}\n`);
}

const go = () => writeFileSync(join(gateway.botDir, "workspace", "go"), "");
const stopped = () => steps().at(-1)?.startsWith("stop") === true;

describe("typing while the bot works", { timeout: 60_000 }, () => {
  it("shows on the message that mentions the bot while it works, and stops when it sends there", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} please wait for go`);
    await waitFor(() => signs().length >= 3, { what: "the sign, shown again" });
    expect(gateway.sent()).toEqual([]);
    go();
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the reply and the stop" });
    expect(steps()).toEqual([`show test:#general/${id}`, `stop test:#general/${id}`]);
    // The typing stops before the message goes out: no show reaches the platform after it.
    const reply = gateway.sent()[0]!;
    expect(signs().filter((sign) => sign.type === "show").at(-1)!.at).toBeLessThanOrEqual(reply.at);
    await pause(1_500);
    expect(steps()).toHaveLength(2);
  });

  it("shows for a DM and for a click on the bot's button, in a thread on its first message", async () => {
    await setUp();
    const dm = gateway.say("dm-alice", "alice", "hi there");
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the DM's reply" });
    expect(steps()).toEqual([`show test:#dm-alice/${dm}`, `stop test:#dm-alice/${dm}`]);

    const root = gateway.say("general", "bob", "the release plan");
    const reply = gateway.say("general", "bob", `@${ME} thoughts?`, root);
    await waitFor(() => gateway.sent().length === 2 && stopped(), { what: "the thread's reply" });
    expect(steps().slice(2)).toEqual([`show test:#general/${root}`, `stop test:#general/${root}`]);
    expect(reply).toBeDefined();

    click("ops", "carol", "m-42");
    await waitFor(() => gateway.sent().length === 3 && stopped(), { what: "the click's reply" });
    expect(steps().slice(4)).toEqual(["show test:#ops/m-42", "stop test:#ops/m-42"]);
  });

  it("stops when the run ends without a send", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} please stay quiet`);
    await waitFor(() => stopped(), { what: "the stop" });
    expect(steps()).toEqual([`show test:#general/${id}`, `stop test:#general/${id}`]);
    expect(gateway.sent()).toEqual([]);
  });

  it("shows when the judge finds an answer very likely, not when it is only likely, and never without a place", async () => {
    await setUp({ judge: "main" });
    gateway.say("random", "bob", "maybe we should look at this");
    await waitFor(() => gateway.sent().length === 1, { what: "the reply to the likely one" });
    expect(gateway.sent()[0]!.place).toBe("random");
    const pricing = gateway.say("general", "alice", "the pricing page shows the old prices");
    await waitFor(() => gateway.sent().length === 2 && stopped(), { what: "the reply to the very likely one" });
    expect(steps()).toEqual([`show test:#general/${pricing}`, `stop test:#general/${pricing}`]);

    // A wake with no place: a pots wake from a command.
    gateway.pots("wake", "--note", "check the build");
    await waitFor(() => wakes(model).some((text) => text.includes("check the build")), { what: "the timed wake" });
    await pause(2_000);
    expect(steps()).toHaveLength(2);
  });

  it("shows nothing for a message that comes to the bot only because it has no judge", async () => {
    await setUp();
    gateway.say("random", "bob", "anyone up for lunch?");
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await pause(1_500);
    expect(signs()).toEqual([]);
  });

  it("shows again where a child that works there wakes the bot", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} please research and tell`);
    await waitFor(() => gateway.sent().some((record) => record.text === "report: the answer is 42") && stopped() && steps().length >= 4, { what: "the report" });
    // The first run started the child and ended; the child's wake showed it again on the same message.
    expect(steps()).toEqual([`show test:#general/${id}`, `stop test:#general/${id}`, `show test:#general/${id}`, `stop test:#general/${id}`]);
  });

  it("moves to a new mention in the place while the bot works, but not to a message without one", async () => {
    await setUp();
    const first = gateway.say("general", "alice", `@${ME} please wait for go`);
    await waitFor(() => signs().length >= 1, { what: "the sign" });
    gateway.say("general", "bob", "unrelated chatter");
    await waitFor(() => wakes(model).length >= 1 && gateway.query("SELECT 1 FROM bot_wakes WHERE reason = 'steer'").length === 1, { what: "the steer" });
    await pause(1_500);
    expect(steps()).toEqual([`show test:#general/${first}`]);
    const second = gateway.say("general", "bob", `@${ME} one more thing`);
    await waitFor(() => steps().length === 3, { what: "the sign on the new mention" });
    expect(steps()).toEqual([`show test:#general/${first}`, `stop test:#general/${first}`, `show test:#general/${second}`]);
    go();
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the reply" });
    expect(steps().at(-1)).toBe(`stop test:#general/${second}`);
  });

  it("stops when the bot answers with a platform call instead of send, while its run goes on", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} please answer natively`);
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the post and the stop" });
    expect(steps()).toEqual([`show test:#general/${id}`, `stop test:#general/${id}`]);
    await pause(2_000);
    expect(steps()).toHaveLength(2);
    expect(gateway.output.some((line) => line.message === "agent idle")).toBe(false);
    go();
  });

  it("goes on when an old message of the bot's comes into the log late, as a replay does", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} please wait for go`);
    await waitFor(() => signs().length >= 1, { what: "the sign" });
    // A message of the bot's from before the mention, which the platform gives only now.
    appendFileSync(
      platformFile(gateway.platformDir),
      `${JSON.stringify({ id: `m-${randomUUID()}`, at: Date.now() - 60_000, type: "message", place: "general", person: ME, text: "an old answer" })}\n`,
    );
    await waitFor(() => gateway.query("SELECT 1 FROM gw_messages WHERE text = 'an old answer'").length === 1, { what: "the old message in the log" });
    const before = signs().length;
    await pause(2_500);
    expect(steps()).toEqual([`show test:#general/${id}`]);
    expect(signs().length).toBeGreaterThan(before);
    go();
    await waitFor(() => gateway.sent().length === 2 && stopped(), { what: "the reply" });
  });

  it("shows a child's wake on the message the child was started for, not on a newer one in the place", async () => {
    await setUp();
    const first = gateway.say("general", "alice", `@${ME} please research slowly`);
    await waitFor(() => stopped() && steps().length === 2, { what: "the first run's end" });
    const second = gateway.say("general", "bob", `@${ME} please stay quiet`);
    await waitFor(() => stopped() && steps().length === 4, { what: "the second run's end" });
    go();
    await waitFor(() => gateway.sent().some((record) => record.text === "report: the answer is 42") && stopped() && steps().length === 6, { what: "the report" });
    expect(steps()).toEqual([
      `show test:#general/${first}`,
      `stop test:#general/${first}`,
      `show test:#general/${second}`,
      `stop test:#general/${second}`,
      `show test:#general/${first}`,
      `stop test:#general/${first}`,
    ]);
  });

  it("does not hold up the reply when the platform refuses, and says so once", async () => {
    await setUp({ modelDelayMs: 1_500 });
    writeFileSync(join(gateway.platformDir, "refuse-working"), "");
    gateway.say("general", "alice", `@${ME} please answer`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(signs()).toEqual([]);
    expect(gateway.output.filter((line) => line.message === "could not show that the bot works; stopped there")).toHaveLength(1);
  });
});

describe("typing after a restart", { timeout: 90_000 }, () => {
  it("shows again where people still wait when the bot goes on with the run", async () => {
    await setUp({ modelDelayMs: 3_000 });
    const id = gateway.say("general", "alice", `@${ME} please answer`);
    await waitFor(() => signs().length >= 1, { what: "the sign" });
    await gateway.kill();
    rmSync(join(gateway.platformDir, "working.jsonl"));
    await gateway.start();
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the reply after the restart" });
    expect(steps()).toEqual([`show test:#general/${id}`, `stop test:#general/${id}`]);
  });

  it("shows again on the newest mention, also one the run had not taken in yet, and keeps no row of what is over", async () => {
    await setUp();
    const first = gateway.say("general", "alice", `@${ME} please wait for go`);
    await waitFor(() => signs().length >= 1, { what: "the sign" });
    const second = gateway.say("general", "bob", `@${ME} one more thing`);
    await waitFor(() => steps().length === 3, { what: "the sign on the new mention" });
    await gateway.kill();
    rmSync(join(gateway.platformDir, "working.jsonl"));
    await gateway.start();
    await waitFor(() => signs().length >= 1, { what: "the sign after the restart" });
    expect(steps()[0]).toBe(`show test:#general/${second}`);
    go();
    await waitFor(() => gateway.sent().length >= 1 && stopped() && gateway.output.some((line) => line.message === "agent idle"), { what: "the reply" });
    expect(steps().every((step) => step.endsWith(`/${second}`))).toBe(true);
    expect(first).toBeDefined();
    expect(gateway.query("SELECT submission FROM bot_working")).toEqual([]);
  });

  it("does not show again where the bot sent before the restart", async () => {
    await setUp({ modelDelayMs: 2_000 });
    gateway.say("general", "alice", `@${ME} please send first`);
    await waitFor(() => gateway.sent().length === 1 && stopped(), { what: "the first reply" });
    await gateway.kill();
    rmSync(join(gateway.platformDir, "working.jsonl"));
    await gateway.start();
    await waitFor(() => gateway.output.some((line) => line.message === "agent working"), { what: "the run to go on" });
    await pause(2_000);
    expect(signs()).toEqual([]);
    go();
  });
});
