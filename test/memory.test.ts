import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, isFirstLook, isMemoryPass, startFakeModel } from "./support/fake-model.ts";
import { ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// The memory pass from outside. Its failures would be silent: a pass whose request does not start as the main
// agent's did misses the provider's cache and costs the full price, a pass that reaches the chat or the main
// conversation changes what people and the bot see, and an entry saved twice after a crash, or one that is not deleted
// when it is forgotten, only shows as a memory that is wrong.

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

    // The next pass, after the first one saved, still starts as the main agent's last request did: a fork keeps the
    // sections it took from the main conversation, also in the first process after an install or upgrade.
    await waitFor(() => passes().length === 2, { what: "the second memory pass" });
    const second = model.requests.filter(isMemoryPass)[1]!;
    const before = agentRequests(model).filter((request) => model.requests.indexOf(request) < model.requests.indexOf(second)).at(-1)!;
    expect(second.system).toBe(before.system);
    expect(second.messages.slice(0, before.messages.length)).toEqual(before.messages);

    expect((await gateway.run(["turn-page", "--note", "a new page"])).status).toBe(0);
    gateway.say("general", "alice", `@${ME} and now?`);
    await waitFor(() => gateway.sent().length === 3, { what: "the reply on the new page" });
    expect(agentRequests(model).at(-1)!.system).toContain("- s1: The user's time zone is Australia/Sydney.\n- m1: Alice likes tea.");
  });

  it("forgets by deleting the entry, from pots memory or from a pass", async () => {
    await setUp(remembering({ forget: "m2" }, { add: "Alice likes tea." }));
    expect(gateway.pots("memory", "add", "Alice likes tea.")).toBe("Saved m1.\n");
    expect(gateway.pots("memory", "add", "Bob likes coffee.")).toBe("Saved m2.\n");
    expect(gateway.pots("memory", "forget", "m1")).toBe("Forgot m1.\n");
    gateway.say("general", "alice", `@${ME} I like tea`);
    await waitFor(() => passes().length === 1, { what: "the memory pass" });
    // Nothing keeps a forgotten text out: said again, it is saved again, with a new ID.
    expect(passes()[0]!.result).toBe("forgot m2, added m3");
    expect(memory()).toBe("- m3: Alice likes tea.\n");
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
