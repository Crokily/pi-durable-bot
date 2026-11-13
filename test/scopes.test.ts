import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequests, type FakeModel, type FakeReply, type FakeRequest, startFakeModel, wakes } from "./support/fake-model.ts";
import { pause, TestGateway, waitFor } from "./support/gateway.ts";

// Each command of a bot in a systemd scope of its own (src/agent/scopes.ts), from outside: where the commands run, what
// a stop, a crash and a restart of the gateway end and leave, what the next wake says, and the gateway as a systemd
// service stopped on purpose and restarted. These need Linux with a systemd user manager, as a desktop or a server with
// lingering has; elsewhere commands run as before, and the last test checks that.

const POTS = fileURLToPath(new URL("../src/cli/pots.ts", import.meta.url));

/** Whether this computer can run a command in a scope of the user manager. */
function scopesWork(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
const SCOPES = scopesWork();

let model: FakeModel;
let gateway: TestGateway;

afterEach(async () => {
  await gateway?.dispose();
  await model?.close();
  expect(gateway.output.filter((line) => /failed|unhandled/i.test(String(line.message)))).toEqual([]);
});

/** This test's node, for commands that run a process of their own. */
const node = `"${process.execPath}"`;
/** A process that writes its ID to the file and stays a minute, so it ends by itself also if the test fails. */
const stay = (file: string) => `${node} -e "require('fs').appendFileSync('${file}', process.pid + '\\n'); setTimeout(() => {}, 60000)"`;
/** A command that leaves a process of its own session running, and returns. */
const LEAVE = `setsid ${stay("left.pid")} > /dev/null 2>&1 & echo left one`;
/** A command that Pots waits on, and that started a process outside its process group, which an interrupt does not end. */
const WAIT = `setsid ${stay("outside.pid")} > /dev/null 2>&1 & ${stay("waited.pid")}`;

/** The agent runs a command for "leave one running", "wait long" and "where are you", and answers what comes back with "done". */
function script(request: FakeRequest): FakeReply {
  const last = request.messages.at(-1);
  if (last?.role !== "user") return { text: "done" };
  if (last.content.includes("leave one running")) return { call: { name: "bash", arguments: { command: LEAVE } } };
  if (last.content.includes("wait long")) return { call: { name: "bash", arguments: { command: WAIT } } };
  if (last.content.includes("where are you")) return { call: { name: "bash", arguments: { command: "cat /proc/self/cgroup > where.txt" } } };
  return { text: "done" };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pids = (file: string) =>
  existsSync(join(gateway.botDir, "workspace", file)) ? readFileSync(join(gateway.botDir, "workspace", file), "utf8").split("\n").filter(Boolean).map(Number) : [];
const pid = (file: string) => pids(file)[0]!;
const key = () => gateway.slice.slice("app-pots-".length, -".slice".length);

async function setUp(env?: Record<string, string | undefined>): Promise<void> {
  model = await startFakeModel(script);
  gateway = new TestGateway({ model, ...(env ? { env } : {}) });
  await gateway.start();
}

/** Run the two commands: one leaves a process, the other runs until the gateway ends. */
async function leaveAndWait(): Promise<void> {
  gateway.say("dm-alice", "alice", "leave one running");
  await waitFor(() => pids("left.pid").length === 1, { what: "the process the command leaves" });
  await waitFor(() => wakes(model).length === 1 && agentRequests(model).at(-1)?.messages.at(-1)?.role === "tool", { what: "the command to return" });
  gateway.say("dm-alice", "alice", "wait long");
  await waitFor(() => pids("waited.pid").length === 1 && pids("outside.pid").length === 1, { what: "the command that runs on" });
}

describe.runIf(SCOPES)("commands in systemd scopes", { timeout: 60_000 }, () => {
  it("runs each command in a scope of its own, a routine's too, and tells the bot", async () => {
    await setUp();
    const scope = new RegExp(`/app-pots\\.slice/${gateway.slice.replaceAll(".", "\\.")}/pots-${key()}-coworker-\\d+-[0-9a-z]+\\.scope$`, "m");
    gateway.say("dm-alice", "alice", "where are you");
    await waitFor(() => existsSync(join(gateway.botDir, "workspace", "where.txt")), { what: "the command" });
    expect(readFileSync(join(gateway.botDir, "workspace", "where.txt"), "utf8")).toMatch(scope);
    const routine = await gateway.run(["routine", "add", "where", "--every", "1s", "--run", "cat /proc/self/cgroup > routine.txt"]);
    expect(routine.status).toBe(0);
    await waitFor(() => existsSync(join(gateway.botDir, "workspace", "routine.txt")), { what: "the routine's command" });
    expect(readFileSync(join(gateway.botDir, "workspace", "routine.txt"), "utf8")).toMatch(scope);
    expect((await gateway.run(["routine", "remove", "where"])).status).toBe(0);
    expect(agentRequests(model)[0]!.system).toContain(
      `- Each command you run with bash or screen, and each command of your routines, runs in a systemd scope of its own, pots-${key()}-coworker-<process ID>-<id>.scope, in ${gateway.slice}.`,
    );
  });

  it("after a crash, stops the commands it waited on, and the next wake tells what commands left running", async () => {
    await setUp();
    await leaveAndWait();
    await gateway.kill();
    // The commands are not in the gateway's cgroup, so they outlive it.
    expect([pid("left.pid"), pid("waited.pid"), pid("outside.pid")].every(alive)).toBe(true);
    await gateway.start();
    await waitFor(() => !alive(pid("waited.pid")) && !alive(pid("outside.pid")), { what: "the command Pots waited on to stop, with what it started" });
    await pause(500);
    expect(alive(pid("left.pid"))).toBe(true);
    const before = wakes(model).length;
    gateway.say("dm-alice", "alice", "hello again");
    await waitFor(() => wakes(model).length > before, { what: "the next wake" });
    const wake = wakes(model).at(-1)!;
    expect(wake).toMatch(
      new RegExp(
        `\\n\\nWhen Pots started at .+, commands you ran before it stopped had left these running, each in its systemd scope:\\n- pots-${key()}-coworker-\\d+-[0-9a-z]+\\.scope: started .+, 1 process; the oldest: .*node.* -e .*left\\.pid.*\\nThey run until they end or you stop them \\(systemctl --user stop <scope>\\)\\.`,
      ),
    );
    // Once.
    gateway.say("dm-alice", "alice", "and again");
    await waitFor(() => wakes(model).length > before + 1, { what: "the wake after" });
    expect(wakes(model).at(-1)).not.toContain("left these running");
  });

  it("a stop ends the commands it waits on with what they started, and keeps what commands left running", async () => {
    await setUp();
    await leaveAndWait();
    await gateway.stop();
    await waitFor(() => !alive(pid("waited.pid")) && !alive(pid("outside.pid")), { what: "the command Pots waited on to stop, with what it started" });
    await pause(500);
    expect(alive(pid("left.pid"))).toBe(true);
    await gateway.start();
    const before = wakes(model).length;
    gateway.say("dm-alice", "alice", "hello again");
    await waitFor(() => wakes(model).length > before, { what: "the next wake" });
    expect(wakes(model).at(-1)).toContain("commands you ran before it stopped had left these running");
  });

  it("as a systemd service: a restart keeps what commands left running, a stop on purpose ends it", async () => {
    model = await startFakeModel(script);
    gateway = new TestGateway({ model });
    const unit = `pots-test-${randomUUID().slice(0, 8)}.service`;
    const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 60_000 });
    // The environment the tests give a gateway, without the desktop's variables that the user manager has.
    const env = Object.entries({ ...process.env, POTS_HOME: gateway.home, PI_CODING_AGENT_DIR: join(gateway.home, "pi"), NO_COLOR: "1" }).flatMap(([name, value]) =>
      value === undefined || /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|_)$/.test(name) || /\n/.test(value) ? [] : [`--setenv=${name}=${value}`],
    );
    execFileSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, "-p", "UnsetEnvironment=DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS", ...env, process.execPath, POTS, "start"], { timeout: 10_000 });
    try {
      const potsOk = async (...args: string[]) => {
        const result = await gateway.run(args);
        if (result.status !== 0) throw new Error(result.stderr);
      };
      // The first works once the bot runs.
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          await potsOk("routine", "add", "leave", "--every", "1s", "--run", `[ -e left ] || { : > left; ${LEAVE}; }`);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await pause(200);
        }
      }
      await potsOk("routine", "add", "wait", "--every", "1s", "--run", `[ -e waited ] || { : > waited; ${WAIT}; }`);
      await waitFor(() => pids("left.pid").length === 1 && pids("waited.pid").length === 1 && pids("outside.pid").length === 1, { what: "the commands" });

      systemctl("restart", unit);
      await waitFor(() => !alive(pid("waited.pid")) && !alive(pid("outside.pid")), { what: "the command Pots waited on to stop, with what it started" });
      await pause(500);
      expect(alive(pid("left.pid"))).toBe(true);

      // The restarted gateway runs: its routines' runs go on.
      const runs = () => gateway.query<{ n: number }>("SELECT count(*) AS n FROM bot_routine_runs WHERE routine = 'leave'")[0]!.n;
      const after = runs();
      await waitFor(() => runs() > after, { what: "a run of the restarted gateway" });

      systemctl("stop", unit);
      await waitFor(() => !alive(pid("left.pid")), { what: "what the command left to stop with the service" });
    } finally {
      try {
        execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 60_000 });
      } catch {
        // stopped and collected
      }
    }
  });
});

describe.runIf(process.platform === "linux")("commands without a systemd user manager", { timeout: 60_000 }, () => {
  it("run as they did before scopes", async () => {
    // Without XDG_RUNTIME_DIR and the session bus, systemd-run --user finds no user manager.
    await setUp({ XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined });
    gateway.say("dm-alice", "alice", "where are you");
    await waitFor(() => existsSync(join(gateway.botDir, "workspace", "where.txt")), { what: "the command" });
    expect(readFileSync(join(gateway.botDir, "workspace", "where.txt"), "utf8")).not.toContain("app-pots");
    expect(agentRequests(model)[0]!.system).not.toContain("systemd scope");
    await gateway.stop();
    await gateway.start();
    const before = wakes(model).length;
    gateway.say("dm-alice", "alice", "hello again");
    await waitFor(() => wakes(model).length > before, { what: "the next wake" });
    expect(wakes(model).at(-1)).not.toContain("left these running");
  });
});
