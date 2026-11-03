import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, isFirstLook, isMemoryPass, startFakeModel } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// The memory pass from outside. Its failures would be silent: a pass whose request does not start as the main
// agent's did misses the provider's cache and costs the full price, a pass that reaches the chat or the main
// conversation changes what people and the bot see, a forgotten fact that comes back, or an entry saved twice after a
// crash, only shows as a memory that is wrong.

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled|could not/i.test(String(line.message)))).toEqual([]);
});

/** The first look says yes; the pass answers with these changes. */
const remembering =
  (...changes: Record<string, unknown>[]) =>
  (request: FakeRequest): FakeReply =>
    isFirstLook(request) ? { text: JSON.stringify({ write_likely: true }) } : { text: JSON.stringify({ changes }) };

async function setUp(memory: (request: FakeRequest) => FakeReply): Promise<void> {
  model = await startFakeModel(undefined, { memory });
  gateway = new TestGateway({ model });
  await gateway.start();
}

const passes = () => gateway.output.filter((line) => line.message === "memory pass");
const memory = () => gateway.pots("memory", "list");

describe("memory", { timeout: 90_000 }, () => {
  it("continues the main conversation with its session, saves the answer, and shows it on the next page", async () => {
    await setUp(remembering({ add: "Alice likes tea." }, { add: "The user's time zone is Australia/Sydney.", shared: true }));
    gateway.say("general", "alice", `@${ME} I like tea`);
    await waitFor(() => passes().length === 1, { what: "the memory pass" });
    expect(memory()).toBe("- s1: The user's time zone is Australia/Sydney.\n- m1: Alice likes tea.\n");

    // The pass's request starts as the main agent's last one did, with the same session, so the cache serves it.
    const main = agentRequests(model).at(-1)!;
    const pass = model.requests.find(isMemoryPass)!;
    expect(pass.system).toBe(main.system);
    expect(pass.tools).toEqual(main.tools);
    expect(pass.messages.slice(0, main.messages.length)).toEqual(main.messages);
    expect(pass.session).toBeDefined();
    expect(pass.session).toBe(main.session);

    // Nothing of it reached the chat or the main conversation, and the section stays as the page began.
    gateway.say("general", "alice", `@${ME} anything else?`);
    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    expect(gateway.sent().map((record) => record.text)).toEqual(["ack: [wake] someone mentioned you", "ack: [wake] someone mentioned you"]);
    const later = agentRequests(model).at(-1)!;
    expect(later.messages.some((message) => message.content.includes("[memory pass]"))).toBe(false);
    expect(later.system).toContain("Your memory is empty.");

    expect((await gateway.run(["turn-page", "--note", "a new page"])).status).toBe(0);
    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => gateway.sent().length === 3, { what: "the reply on the new page" });
    expect(agentRequests(model).at(-1)!.system).toContain("- s1: The user's time zone is Australia/Sydney.\n- m1: Alice likes tea.");
  });

  it("does not save a forgotten fact again", async () => {
    await setUp(remembering({ add: "alice likes  TEA." }));
    expect(gateway.pots("memory", "add", "Alice likes tea.")).toBe("Saved m1.\n");
    expect(gateway.pots("memory", "forget", "m1")).toBe("Forgot m1. It is not saved again.\n");
    gateway.say("general", "alice", `@${ME} I like tea`);
    await waitFor(() => passes().length === 1, { what: "the memory pass" });
    expect(memory()).toBe("Your memory is empty.\n");
    // The pass was told what was forgotten.
    expect(model.requests.find(isMemoryPass)!.messages.at(-1)!.content).toContain("do not save them again:\n- Alice likes tea.");
  });

  it("saves once when the gateway dies right after the pass saved", async () => {
    await setUp(remembering({ add: "Bob wants short replies." }));
    gateway.crashAfterNextMemoryPass();
    gateway.say("general", "bob", `@${ME} keep it short`);
    await gateway.exited();
    expect(gateway.output.some((line) => line.message === "crash test: dying after the memory pass saved")).toBe(true);

    await gateway.start();
    await waitFor(() => passes().length === 2, { what: "the pass to run again" });
    expect(passes()[1]!.result).toBe("applied before");
    await pause(1_000);
    expect(memory()).toBe("- m1: Bob wants short replies.\n");
    // The fork answered once: the pass that ran again found its answer.
    expect(model.requests.filter(isMemoryPass)).toHaveLength(1);
  });
});
