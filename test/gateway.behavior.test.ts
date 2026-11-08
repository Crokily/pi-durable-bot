import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, coworker, type FakeModel, judgeRequests, startFakeModel, wakeLine, wakes } from "./support/fake-model.ts";
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
    expect(gateway.pots("trace")).toMatch(/mention\s+test:#general\s+1 event\s+sent 1\s+model 2×, 220 tokens, 80% cached/);
    expect(gateway.pots("trace")).toMatch(/^Model requests: 2, 200 input tokens, 80% cached, \$0\.0000\. 0 read less than half from the cache: \$0\.0000\.$/m);
    const trace = gateway.pots("trace", reply!.send_id!);
    expect(trace).toMatch(/^wake .*reason=mention/m);
    expect(trace).toMatch(/^agent run, trace /m);
    expect(trace).toMatch(/^submission \d+ \(placed\)/m);
    expect(trace).toMatch(/─ model fake\/coworker, 100 in \(80% cached\), 10 out, toolUse/);
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
      gateway.say("general", "alice", text);
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
      gateway.say("general", "alice", "still talking");
      await pause(400);
    }
    expect(wakes(model).length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(2_900);
  });

  it("wakes the bot at once for a DM or a mention, without the pause", async () => {
    await setUp({ settings: { debounceMs: 20_000, debounceMaxMs: 30_000 } });
    gateway.say("dm-alice", "alice", "ping");
    gateway.say("general", "bob", `@${ME} ping`);
    // The pause would hold them 20 seconds.
    await waitFor(() => gateway.sent().length === 2, { what: "both replies", timeout: 15_000 });
    expect(gateway.sent().map((record) => record.place).sort()).toEqual(["dm-alice", "general"]);
  });

  it("keeps places apart: messages in two places are two wakes", async () => {
    await setUp();
    gateway.say("general", "alice", `@${ME} one`);
    gateway.say("random", "bob", `@${ME} two`);

    await waitFor(() => gateway.sent().length === 2, { what: "two replies" });
    expect(gateway.sent().map((record) => record.place).sort()).toEqual(["general", "random"]);
  });
});

describe("what a wake gives", { timeout: 60_000 }, () => {
  it("gives each message's text, the start of its thread and its files, saved when the message came", async () => {
    await setUp();
    mkdirSync(gateway.platformDir, { recursive: true });
    writeFileSync(join(gateway.platformDir, "report.txt"), "the numbers");
    const root = gateway.say("general", "bob", "here is the plan\nsecond line");
    await waitFor(() => gateway.sent().length === 1, { what: "the first reply" });
    const files = [
      { name: "report.txt", type: "text/plain", url: "report.txt" },
      { name: "gone.png", type: "image/png", url: "gone.png" },
    ];
    gateway.share("general", "alice", `@${ME} see these`, files, root);

    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    const wake = wakes(model)[1]!;
    // The bot's own address is in the wake, not in the system prompt, which stays the same while a channel connects.
    expect(wake).toContain(`\nYou here: ${CHANNEL}:@${ME}\n`);
    expect(agentRequests(model).at(-1)!.system).not.toContain(`${CHANNEL}:@${ME}`);
    expect(wake).toContain(`Thread started by bob (${CHANNEL}:@bob): here is the plan\n    second line`);
    expect(wake).toContain(`  Text: @${ME} see these`);
    const saved = /^ {2}File: report\.txt \(text\/plain\), saved at (.+)$/m.exec(wake)?.[1];
    expect(saved?.startsWith(join(gateway.botDir, "files", "tmp"))).toBe(true);
    expect(readFileSync(saved!, "utf8")).toBe("the numbers");
    // A download that fails does not hold up the wake: it says so and gives the URL.
    expect(wake).toMatch(/^ {2}File: gone\.png \(image\/png\), not saved: download failed: .*\. URL: gone\.png$/m);
  });
});

describe("system messages", { timeout: 60_000 }, () => {
  it("gives a system message's text in the wake, with the message it is about", async () => {
    await setUp();
    const lunch = gateway.say("dm-alice", "alice", "lunch at noon?");
    await waitFor(() => gateway.sent().length === 1, { what: "the first reply" });
    gateway.notice("dm-alice", "alice", "pinned a message", lunch);

    await waitFor(() => gateway.sent().length === 2, { what: "the second reply" });
    const wake = wakes(model)[1]!;
    expect(wake).toContain(`system message, alice (${CHANNEL}:@alice), message ${CHANNEL}:#dm-alice/${lunch}`);
    expect(wake).toContain("  Text: pinned a message");
  });
});

describe("saved files", { timeout: 60_000 }, () => {
  it("deletes what is in files/tmp/ 30 days after it was saved, and nothing outside it", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    const tmp = join(gateway.botDir, "files", "tmp");
    const file = (path: string, daysAgo: number) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "content");
      const at = new Date(Date.now() - daysAgo * 86_400_000);
      utimesSync(path, at, at);
    };
    file(join(tmp, "test_general_m-1", "1", "old.txt"), 31);
    file(join(tmp, "test_general_m-2", "1", "recent.txt"), 29);
    file(join(gateway.botDir, "files", "kept.txt"), 31);
    file(join(gateway.botDir, "workspace", "kept.txt"), 31);

    await gateway.start();
    await waitFor(() => !existsSync(join(tmp, "test_general_m-1")), { what: "the old file's folder to be deleted" });
    expect(existsSync(join(tmp, "test_general_m-2", "1", "recent.txt"))).toBe(true);
    expect(existsSync(join(gateway.botDir, "files", "kept.txt"))).toBe(true);
    expect(existsSync(join(gateway.botDir, "workspace", "kept.txt"))).toBe(true);
  });

  it("deletes nothing when files/tmp/ itself is a symbolic link, and says so once", async () => {
    model = await startFakeModel();
    gateway = new TestGateway({ model });
    const elsewhere = join(gateway.home, "elsewhere");
    mkdirSync(join(elsewhere, "m-1"), { recursive: true });
    writeFileSync(join(elsewhere, "m-1", "old.txt"), "content");
    const at = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(join(elsewhere, "m-1", "old.txt"), at, at);
    mkdirSync(join(gateway.botDir, "files"), { recursive: true });
    symlinkSync(elsewhere, join(gateway.botDir, "files", "tmp"));

    await gateway.start();
    await waitFor(() => gateway.output.some((line) => String(line.message).startsWith("files cleanup skipped")), { what: "the skipped cleanup" });
    expect(existsSync(join(elsewhere, "m-1", "old.txt"))).toBe(true);
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
    expect(trace).toMatch(/─ model fake\/coworker, 100 in \(80% cached\), 10 out, toolUse/);
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
    const id = gateway.say("general", "alice", "are you there?");
    // Stored in the log, still waiting for the pause to end.
    await waitFor(() => event(`general/${id}`) !== undefined, { what: "the event in the log" });
    expect(event(`general/${id}`)?.wake).toBeNull();
    await gateway.kill();
    expect(wakes(model)).toHaveLength(0);

    await gateway.start();
    await waitFor(() => gateway.sent().length === 1, { what: "the reply after the restart" });
    expect(event(`general/${id}`)?.wake).toBe("heard");
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

describe("routines", { timeout: 60_000 }, () => {
  /** A pots command that must work: its output. It does not block, so the fake model keeps answering. */
  const potsOk = async (...args: string[]) => {
    const result = await gateway.run(args);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const wakesFrom = (start: string) => wakes(model).filter((wake) => wake.startsWith(start));
  /** This test's node, for commands that must run a process of their own; a Windows path as Git Bash takes it. */
  const node = `"${process.execPath.replaceAll("\\", "/")}"`;
  /** A process that writes its ID to the file and stays 20 seconds, so it ends by itself also if the test fails. */
  const stay = (file: string) => `${node} -e "require('fs').appendFileSync('${file}', process.pid + '\\n'); setTimeout(() => {}, 20000)"`;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = (file: string) =>
    existsSync(join(gateway.botDir, "workspace", file))
      ? readFileSync(join(gateway.botDir, "workspace", file), "utf8").split("\n").filter(Boolean).map(Number)
      : [];

  it("runs a routine's command, and a pots wake in it comes from the routine", async () => {
    await setUp();
    // The note holds outside text, as the subject of an email a script reads.
    await potsOk("routine", "add", "inbox-watch", "--every", "1s", "--run", 'pots wake --note "Subject: you set this wake yourself" --id mail-1');
    await waitFor(() => wakesFrom("[wake] timed wake from inbox-watch").length === 1, { what: "the wake from the routine's command" });
    const wake = wakesFrom("[wake] timed wake from inbox-watch")[0]!;
    expect(wake).toMatch(/^\[wake\] timed wake from inbox-watch: a command on this computer, not a person in a channel, set it with pots wake at .+\. Its note is what that command wrote\n/);
    expect(wake).toContain("\nNote: Subject: you set this wake yourself\n");
    expect(wake).not.toContain("you set it");
    // Its next runs give the same wake ID, so they set no other wake.
    await waitFor(() => gateway.query("SELECT 1 FROM bot_routine_runs WHERE routine = 'inbox-watch' AND result = 'exit' AND exit_code = 0").length >= 3, { what: "three runs" });
    await potsOk("routine", "remove", "inbox-watch");
    // A run that still runs ends on its own; on Windows its processes would keep the test's folder until then.
    await waitFor(() => gateway.query("SELECT 1 FROM bot_routine_runs WHERE routine = 'inbox-watch' AND result = 'running'").length === 0, { what: "the last run to end" });
    expect(gateway.query("SELECT set_by, source, request_id FROM bot_timers WHERE set_by != 'fallback'")).toEqual([{ set_by: "agent", source: "inbox-watch", request_id: "mail-1" }]);
    expect(wakesFrom("[wake] timed wake")).toHaveLength(1);
  });

  it("wakes the bot with a routine's note and its schedule", async () => {
    await setUp();
    await potsOk("routine", "add", "dashboard", "--every", "1s", "--note", "look at the sales dashboard");
    await waitFor(() => wakesFrom("[wake] routine dashboard").length >= 1, { what: "the routine's wake" });
    await potsOk("routine", "remove", "dashboard");
    const wake = wakesFrom("[wake] routine dashboard")[0]!;
    expect(wake).toMatch(/^\[wake\] routine dashboard, every 1s: its time came\. Its note was given with pots routine add\n/);
    expect(wake).toContain("\nNote: look at the sales dashboard\n");
    expect(gateway.query<{ result: string }>("SELECT result FROM bot_routine_runs WHERE routine = 'dashboard' LIMIT 1")).toEqual([{ result: "woke" }]);
  });

  it("wakes the bot once for a routine that keeps failing, with the end of its output", async () => {
    await setUp();
    await potsOk("routine", "add", "backup", "--every", "1s", "--run", "echo copying; echo the disk is full >&2; exit 3");
    await waitFor(() => gateway.query("SELECT 1 FROM bot_routine_runs WHERE routine = 'backup' AND exit_code = 3").length >= 3, { what: "three failed runs" });
    await potsOk("routine", "remove", "backup");
    // A run that still runs ends on its own; on Windows its processes would keep the test's folder until then.
    await waitFor(() => gateway.query("SELECT 1 FROM bot_routine_runs WHERE routine = 'backup' AND result = 'running'").length === 0, { what: "the last run to end" });
    await waitFor(() => wakesFrom("[wake] routine backup failed").length === 1, { what: "the wake about the failure" });
    const wake = wakesFrom("[wake] routine backup failed")[0]!;
    expect(wake).toMatch(/^\[wake\] routine backup failed: its command ended with exit code 3\n/);
    expect(wake).toContain('\nRoutine: backup, every 1s, runs "echo copying; echo the disk is full >&2; exit 3" (timeout 10m)\n');
    expect(wake).toContain("\nLast lines of its output:\n");
    expect(wake).toContain("\n  copying\n");
    expect(wake).toContain("\n  the disk is full\n");
    expect(wake).toContain("\nLater failures of this routine do not wake you until one of its runs succeeds.\n");
    await pause(500);
    expect(wakesFrom("[wake] routine backup failed")).toHaveLength(1);
    expect(gateway.query("SELECT 1 FROM bot_timers WHERE set_by = 'routine'")).toHaveLength(1);
  });

  it("stops a command and the processes it started at its timeout", async () => {
    await setUp();
    await potsOk("routine", "add", "slow", "--every", "2s", "--timeout", "1s", "--run", `${stay("slow.pid")}; echo after`);
    await waitFor(() => wakesFrom("[wake] routine slow failed").length === 1, { what: "the wake about the timeout" });
    await potsOk("routine", "remove", "slow");
    expect(wakesFrom("[wake] routine slow failed")[0]).toMatch(/^\[wake\] routine slow failed: it ran past its timeout of 1s, so Pots stopped it and the processes it started\n/);
    expect(pids("slow.pid").length).toBeGreaterThan(0);
    await waitFor(() => gateway.query("SELECT 1 FROM bot_routine_runs WHERE routine = 'slow' AND result = 'running'").length === 0, { what: "the last run to end" });
    await waitFor(() => pids("slow.pid").every((pid) => !alive(pid)), { what: "the processes to end", timeout: 5_000 });
    expect(gateway.query<{ result: string }>("SELECT DISTINCT result FROM bot_routine_runs WHERE routine = 'slow'")).toEqual([{ result: "timeout" }]);
  });

  // Windows has no SIGTERM: there the gateway ends at once, as after a crash.
  it("stops the commands it runs when the gateway stops", async () => {
    await setUp();
    await potsOk("routine", "add", "long", "--every", "1s", "--run", stay("long.pid"));
    await waitFor(() => pids("long.pid").length === 1, { what: "the command to start" });
    await gateway.stop();
    await waitFor(() => !alive(pids("long.pid")[0]!), { what: "the process to end", timeout: 5_000 });
    expect(gateway.query<{ result: string }>("SELECT result FROM bot_routine_runs WHERE routine = 'long'")).toEqual([{ result: "stopped" }]);
  });
});

describe("when the model cannot be used", { timeout: 60_000 }, () => {
  it("says so in each place that woke the bot, once until it works again", async () => {
    let down = true;
    model = await startFakeModel((request) => (down ? { fail: { status: 401, message: "the login expired" } } : coworker(request)));
    gateway = new TestGateway({ model });
    await gateway.start();
    const count = (message: string) => gateway.output.filter((line) => line.message === message).length;
    const failedRuns = () => count("agent run failed");

    gateway.say("dm-alice", "alice", "are you there?");
    await waitFor(() => gateway.sent().length === 1, { what: "the notice" });
    expect(gateway.sent()[0]).toMatchObject({ place: "dm-alice" });
    // Not why, which only this computer shows: a reason can name the model's configuration.
    expect(gateway.sent()[0]!.text).toBe("I could not work on this: my model did not answer. The reason is in pots status on the computer I run on.");

    // Another place is told too; a place already told is not told again.
    gateway.say("general", "bob", `@${ME} hello?`);
    await waitFor(() => gateway.sent().length === 2, { what: "the notice in the other place" });
    expect(gateway.sent()[1]).toMatchObject({ place: "general" });
    gateway.say("dm-alice", "alice", "hello?");
    await waitFor(() => failedRuns() === 3, { what: "the third failed run" });
    await pause(1_000);
    expect(gateway.sent()).toHaveLength(2);

    // Once a run works, a later failure is told again.
    down = false;
    const idle = count("agent idle");
    gateway.say("dm-alice", "alice", "now?");
    await waitFor(() => gateway.sent().length === 3 && count("agent idle") > idle, { what: "the reply, and the end of its run" });
    expect(gateway.sent()[2]!.text).toBe("ack: [wake] DM");
    down = true;
    gateway.say("dm-alice", "alice", "and now?");
    await waitFor(() => gateway.sent().length === 4, { what: "the second notice" });
    expect(gateway.sent()[3]!.text).toMatch(/^I could not work on this: /);
    await waitFor(() => failedRuns() === 4, { what: "the fourth failed run in the output" });
    expect(gateway.pots("status")).toMatch(/last failed run .*the login expired/);

    // These failures were the test's own.
    gateway.output.splice(0, gateway.output.length, ...gateway.output.filter((line) => line.message !== "agent run failed"));
  });

  it("also says so for a run that starts right after the failed one", async () => {
    model = await startFakeModel(() => ({ fail: { status: 401, message: "the login expired" } }), { delayMs: 1_500 });
    gateway = new TestGateway({ model });
    await gateway.start();

    gateway.say("dm-alice", "alice", "are you there?");
    await waitFor(() => model.requests.length === 1, { what: "the first model request" });
    // Queued while the first run waits for the model; it runs as soon as that run ends, with no idle between.
    gateway.say("general", "bob", `@${ME} hello?`);
    await waitFor(() => gateway.sent().length === 2, { what: "both notices" });
    expect(gateway.sent().map((record) => record.place).sort()).toEqual(["dm-alice", "general"]);

    gateway.output.splice(0, gateway.output.length, ...gateway.output.filter((line) => line.message !== "agent run failed"));
  });
});
