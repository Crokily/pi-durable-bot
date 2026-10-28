import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, judgeRequests, startFakeModel, wakeLine, wakes } from "./support/fake-model.ts";
import { CHANNEL, ME, pause, TestGateway, waitFor } from "./support/gateway.ts";

// The gateway seen from outside, with a real `pots start` process: people write on the test platform, the bot is
// woken through a fake model, and what it sends appears on the platform. Only external behavior is checked, so these
// tests hold whatever the gateway looks like inside.

let model: FakeModel;
let gateway: TestGateway;

async function setUp(options: { judge?: string; settings?: Record<string, unknown>; modelDelayMs?: number } = {}): Promise<void> {
  model = await startFakeModel(undefined, { delayMs: options.modelDelayMs ?? 0 });
  gateway = new TestGateway({ model, ...options });
  await gateway.start();
}

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  // Nothing went wrong on the way: no failed step and no unhandled error in the gateway's output.
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

const event = (id: string) => gateway.query<{ kind: string; wake: string | null; place: string; mentions_me: number }>(
  "SELECT e.kind, e.wake, e.place, e.mentions_me FROM gw_events e JOIN gw_messages m ON m.address = e.message WHERE m.address = ?",
  `${CHANNEL}:#${id}`,
)[0];

describe("receive, log, wake, send", { timeout: 60_000 }, () => {
  it("logs a mention, wakes the bot once, and sends its reply once", async () => {
    await setUp();
    const id = gateway.say("general", "alice", `@${ME} can you check the build?`);

    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    const [reply] = gateway.sent();
    expect(reply!.place).toBe("general");
    expect(reply!.text).toBe("ack: [wake] someone mentioned you");
    expect(reply!.send_id).toMatch(/^tool:/);

    expect(event(`general/${id}`)).toMatchObject({ kind: "message", wake: "mention", mentions_me: 1 });
    // The sent message comes back through the inbox and is logged as the bot's own.
    await waitFor(() => gateway.query("SELECT 1 FROM gw_messages WHERE send_id = ? AND from_me = 1", reply!.send_id!).length === 1, {
      what: "the reply in the log",
    });
    expect(gateway.query<{ state: string }>("SELECT state FROM gw_outbox WHERE send_id = ?", reply!.send_id!)).toEqual([{ state: "sent" }]);

    // The bot's own message does not wake it again.
    await pause(1_000);
    expect(wakes(model)).toHaveLength(1);
    expect(gateway.sent()).toHaveLength(1);

    // pots trace shows the whole wake: the event, the decision, the agent's run with its model requests, and the send
    // under the send tool's call.
    await gateway.stop();
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+sent 1\s+model 2×, 220 tokens/);
    const trace = gateway.pots("trace", reply!.send_id!);
    expect(trace).toMatch(/^wake .*reason=mention/m);
    expect(trace).toMatch(/^agent run, trace /m);
    expect(trace).toMatch(/^submission \d+ \(placed\)/m);
    expect(trace).toMatch(/─ model fake\/coworker, 100 in, 10 out, toolUse/);
    expect(trace).toMatch(/─ tool send call → done[^\n]*\n[│ ]*└─ send send=tool:\d+ .*result=sent/);
    expect(trace).toContain(`event=${id}`);
  });

  it("wakes the bot for a one-to-one DM without a mention", async () => {
    await setUp();
    const id = gateway.say("dm-alice", "alice", "are you there?");

    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(gateway.sent()[0]).toMatchObject({ place: "dm-alice", text: "ack: [wake] DM" });
    expect(event(`dm-alice/${id}`)?.wake).toBe("dm");
  });

  it("groups messages that come close together into one wake", async () => {
    await setUp({ settings: { debounceMs: 600, debounceMaxMs: 5_000 } });
    for (const text of ["first", "second", "third"]) {
      gateway.say("general", "alice", `@${ME} ${text}`);
      await pause(150);
    }

    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await pause(1_000);
    expect(wakes(model)).toHaveLength(1);
    expect(wakes(model)[0]).toContain("New events (3)");
    expect(gateway.sent()).toHaveLength(1);
  });

  it("does not wait longer than the longest wait when people keep talking", async () => {
    await setUp({ settings: { debounceMs: 800, debounceMaxMs: 1_500 } });
    const start = Date.now();
    // A message every 400 ms never leaves an 800 ms pause, so only the 1.5 s limit can end the wait.
    while (Date.now() - start < 3_000 && wakes(model).length === 0) {
      gateway.say("general", "alice", `@${ME} still talking`);
      await pause(400);
    }
    expect(wakes(model).length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(2_900);
  });

  it("keeps places apart: messages in two places are two wakes", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} one`);
    gateway.say("random", "bob", `@${ME} two`);

    await waitFor(() => gateway.sent().length === 2, { what: "two replies" });
    expect(gateway.sent().map((record) => record.place).sort()).toEqual(["general", "random"]);
  });
});

describe("the judge", { timeout: 60_000 }, () => {
  it("wakes the bot only for messages the judge finds relevant", async () => {
    await setUp({ judge: "main" });
    const lunch = gateway.say("random", "bob", "anyone up for lunch?");
    const pricing = gateway.say("general", "alice", "the pricing page shows the old prices");

    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(gateway.sent()[0]!.place).toBe("general");
    expect(wakeLine(gateway.sent()[0]!.text!)).toContain("The judge found that it is about what you are responsible for");
    await waitFor(() => event(`random/${lunch}`)?.wake === "judge_no", { what: "the judge's no" });
    expect(event(`general/${pricing}`)?.wake).toBe("relevant");
    await pause(1_000);
    expect(gateway.sent()).toHaveLength(1);
  });

  it("with no judge, every message wakes the bot", async () => {
    await setUp({ judge: "off" });
    const id = gateway.say("random", "bob", "anyone up for lunch?");

    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(gateway.sent()[0]!.text).toBe("ack: [wake] no mention. You have no judge set, so every message comes to you");
    expect(event(`random/${id}`)?.wake).toBe("heard");
  });
});

describe("crashes and restarts", { timeout: 90_000 }, () => {
  it("sends a message once when the gateway dies after the platform took it", async () => {
    await setUp();
    gateway.crashAfterNextSend();
    gateway.say("general", "alice", `@${ME} please answer`);

    // The gateway kills itself right after the platform accepted the reply, before the outbox recorded it.
    await gateway.exited();
    expect(gateway.sent()).toHaveLength(1);
    const sendId = gateway.sent()[0]!.send_id!;
    expect(gateway.query<{ state: string }>("SELECT state FROM gw_outbox WHERE send_id = ?", sendId)).toEqual([{ state: "sending" }]);

    await gateway.start();
    await waitFor(() => gateway.query<{ state: string }>("SELECT state FROM gw_outbox WHERE send_id = ?", sendId)[0]?.state === "sent", {
      what: "the send to be recovered",
    });
    // The agent's run went on with the found message as the tool's answer.
    await waitFor(() => agentRequests(model).at(-1)?.messages.at(-1)?.content.includes("not sent again") === true, { what: "the tool answer" });
    await pause(1_000);
    expect(gateway.sent()).toHaveLength(1);
  });

  it("wakes the bot once when the gateway dies right after the bot took the wake", async () => {
    // A slow model keeps the agent's run going after the restart, so a wake decided anew would steer it.
    await setUp({ modelDelayMs: 2_000 });
    gateway.crashAfterNextWake();
    const id = gateway.say("general", "alice", `@${ME} please answer`);
    await gateway.exited();
    expect(event(`general/${id}`)?.wake).toBe("mention");

    await gateway.start();
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await pause(3_000);
    expect(gateway.sent()).toHaveLength(1);
    expect(gateway.query<{ id: string }>("SELECT id FROM bot_wakes").map((row) => row.id)).toEqual([`mention:test:#general:1`]);
    expect(gateway.query("SELECT * FROM gw_pending_wakes")).toEqual([]);

    // The wake delivered again after the restart leads to the agent's run, which went on in its first trace.
    await gateway.stop();
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+sent 1\s+model \d+×/);
    const trace = gateway.pots("trace", "mention:test:#general:1");
    expect(trace).toMatch(/^agent run, trace /m);
    expect(trace).toMatch(/─ model fake\/coworker, 100 in, 10 out, toolUse/);
    expect(trace).toMatch(/└─ send send=tool:\d+ .*result=sent/);
  });

  it("finishes the agent's work after a stop that came while the agent and the judge were waiting for the model", async () => {
    await setUp({ judge: "main", modelDelayMs: 2_000 });
    gateway.say("general", "alice", `@${ME} please answer`);
    await waitFor(() => agentRequests(model).length === 1, { what: "the agent's model request" });
    gateway.say("random", "bob", "the pricing page shows the old prices");
    await waitFor(() => judgeRequests(model).length === 1, { what: "the judge's model request" });

    // SIGTERM while both wait for the model. The work in progress must not be lost or done twice.
    await gateway.stop();
    await gateway.start();
    await waitFor(() => gateway.sent().length === 2, { timeout: 30_000, what: "both replies" });
    await pause(3_000);
    expect(gateway.sent().map((record) => record.place).sort()).toEqual(["general", "random"]);
  });

  it("keeps an event that was stored but not decided when the gateway is killed", async () => {
    await setUp({ settings: { debounceMs: 3_000, debounceMaxMs: 5_000 } });
    const id = gateway.say("general", "alice", `@${ME} are you there?`);
    // Stored in the log, still waiting for the pause to end.
    await waitFor(() => event(`general/${id}`) !== undefined, { what: "the event in the log" });
    expect(event(`general/${id}`)?.wake).toBeNull();
    await gateway.kill();
    expect(wakes(model)).toHaveLength(0);

    await gateway.start();
    await waitFor(() => gateway.sent().length === 1, { what: "the reply after the restart" });
    expect(event(`general/${id}`)?.wake).toBe("mention");
    await pause(1_000);
    expect(wakes(model)).toHaveLength(1);
  });

  it("fills in what people said while the gateway was stopped", async () => {
    await setUp();
    await gateway.stop();
    const id = gateway.say("general", "alice", `@${ME} did you see this?`);

    await gateway.start();
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    expect(event(`general/${id}`)?.wake).toBe("mention");
  });

  it("logs each event once when the platform delivers it again after a restart", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} hello`);
    await waitFor(() => gateway.sent().length === 1, { what: "the reply" });
    await gateway.stop();

    // The test channel reads its whole platform file again on every start; the inbox drops what it has.
    await gateway.start();
    await pause(1_500);
    expect(gateway.query<{ n: number }>("SELECT count(*) AS n FROM gw_events WHERE kind = 'message'")[0]!.n).toBe(2);
    expect(wakes(model)).toHaveLength(1);
    expect(gateway.sent()).toHaveLength(1);
  });
});
