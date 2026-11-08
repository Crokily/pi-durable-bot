// The package as a person gets it, from end to end. CI runs it on Linux, macOS and Windows (.github/workflows/ci.yml):
// pack the package, install it globally from the tarball without our lockfile, make a bot with pots init and the fake
// model of the tests (test/support/fake-model.ts, so no API key), run the gateway as a background service, send the bot
// one message over its terminal channel and wait for its answer, and remove the service. The gateway must stop
// cleanly: its output ends with "shutdown" and "bot stopped".
//
//   node scripts/install-test.ts               the service, as pots init installs it
//   node scripts/install-test.ts --system      Linux: a system service (needs sudo)
//   node scripts/install-test.ts --foreground  pots start in a child process instead of the service
//
// The service's gateway reads pi's models.json from ~/.pi/agent and keeps its bots in ~/.pots, as a person's does, so
// the script writes there, and runs only where the CI variable is set. --foreground uses folders of its own and touches
// nothing else on the computer: use it to try the script on your own.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askGatewayToStop } from "../src/cli/service.ts";
import { startFakeModel } from "../test/support/fake-model.ts";

const mode = process.argv[2] === "--system" ? "system" : process.argv[2] === "--foreground" ? "foreground" : "service";
const windows = process.platform === "win32";
const repo = fileURLToPath(new URL("..", import.meta.url));

function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

if (mode !== "foreground" && !process.env.CI) fail("this installs a service and writes ~/.pi/agent/models.json, so it runs only where CI is set; use --foreground");
if (mode === "system" && process.platform !== "linux") fail("--system is for Linux");

const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "pots-install-"));
const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
delete env.POTS_HOME;
delete env.PI_CODING_AGENT_DIR;
if (mode === "foreground") {
  env.POTS_HOME = join(work, "home");
  env.PI_CODING_AGENT_DIR = join(work, "pi");
}
const potsHome = env.POTS_HOME ?? join(homedir(), ".pots");
const piDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const prefix = join(work, "global");
const pots = windows ? join(prefix, "pots.cmd") : join(prefix, "bin", "pots");
/** pots start, with --foreground. */
let gateway: ChildProcess | undefined;
let gatewayOutput = "";

/** Run a command to its end, and show its output. Without blocking: the fake model answers from this process. */
function run(command: string, args: readonly string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<{ code: number | null; out: string }> {
  if (!options.quiet) console.log(`\n$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    // npm and the pots command are .cmd files on Windows, which only a shell runs. No argument to them needs quoting.
    // Only a path is quoted: cmd starts a quoted batch name without its extension ("npm") with %~dp0 set to the
    // current folder, so npm.cmd looks for npm-cli.js in the wrong place.
    const shell = windows && !command.endsWith(".exe");
    const quoted = shell && /[\\/]/.test(command) ? `"${command}"` : command;
    const child = spawn(quoted, args, { env, cwd: options.cwd ?? work, shell });
    let out = "";
    const show = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (!options.quiet) process.stdout.write(chunk);
    };
    child.stdout.on("data", show);
    child.stderr.on("data", show);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Run a command that must succeed; its output. */
async function must(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<string> {
  const { code, out } = await run(command, args, options);
  if (code !== 0) await failWithLogs(`${basename(command)} ${args.join(" ")} exited with ${code}`);
  return out;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Pack and install, as a person gets it ----

await must("npm", ["pack", "--pack-destination", work], { cwd: repo });
const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
if (!tarball) fail(`npm pack wrote no tarball to ${work}`);
// Globally, without our lockfile: a dependency's own loose range can pull in a version we never tested.
await must("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(work, tarball)]);
await must(pots, ["--version"]);

// ---- A bot with the fake model ----

const model = await startFakeModel();
const models = join(piDir, "models.json");
if (existsSync(models)) fail(`${models} is there already; this needs a computer without pi's settings`);
mkdirSync(piDir, { recursive: true });
const fake = { baseUrl: model.url, api: "openai-completions", apiKey: "fake", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "coworker", contextWindow: 128_000 }] };
writeFileSync(models, JSON.stringify({ providers: { fake } }, null, 2));

const created = await must(pots, ["init", "--yes", "--name", "CI", "--model", "fake/coworker", "--judge", "off", "--no-service", "--no-chat"]);
const dir = /^Created (.+)$/m.exec(created)?.[1]?.trim();
if (!dir) fail("pots init did not say which folder it made");
const bot = basename(dir);

// ---- The gateway: the service, or pots start ----

if (mode === "foreground") {
  console.log(`\n$ ${pots} start (in the background)`);
  gateway = spawn(windows ? `"${pots}"` : pots, ["start"], { env, cwd: work, shell: windows });
  gateway.stdout!.on("data", (chunk: Buffer) => (gatewayOutput += chunk.toString("utf8")));
  gateway.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
} else {
  await must(pots, ["service", "install", ...(mode === "system" ? ["--system"] : [])]);
}

/** The gateway's output: from pots start, the log file of launchd and Task Scheduler, or the journal of systemd. */
async function gatewayLog(): Promise<string> {
  if (mode === "foreground") return gatewayOutput;
  if (process.platform !== "linux") {
    const file = join(potsHome, "logs", "gateway.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  // As root, --user-unit would look for root's own user units; match the runner's user unit by its fields instead.
  const unit = mode === "system" ? ["--unit", "pots.service"] : [`_SYSTEMD_USER_UNIT=pots.service`, `_UID=${process.getuid!()}`];
  return (await run("sudo", ["journalctl", "--no-pager", "-o", "cat", ...unit], { quiet: true })).out;
}

async function failWithLogs(message: string): Promise<never> {
  console.error("\n---- pots status ----");
  if (existsSync(pots)) console.error((await run(pots, ["status"], { quiet: true })).out);
  console.error("---- the gateway's output, last lines ----");
  console.error((await gatewayLog()).split("\n").slice(-60).join("\n"));
  if (windows) console.error((await run("powershell.exe", ["-NoProfile", "-Command", "Get-ScheduledTask -TaskName Pots | Get-ScheduledTaskInfo | Format-List"], { quiet: true })).out);
  fail(message);
}

/** Wait until pots status says the bot runs. */
async function waitForBot(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let status = "";
  while (Date.now() < deadline) {
    status = (await run(pots, ["status"], { quiet: true })).out;
    if (new RegExp(`^${bot}: CI, fake/coworker, (idle|working)`, "m").test(status)) {
      console.log(`\n$ ${pots} status\n${status}`);
      return;
    }
    if (gateway && gateway.exitCode !== null) break;
    await pause(1_000);
  }
  await failWithLogs(`the bot did not start within 2 minutes:\n${status}`);
}

await waitForBot();

// ---- One message and its answer, over the terminal channel ----

const answer = await must(pots, ["chat", "--bot", bot, "-m", "hello", "--timeout", "120"]);
if (!answer.includes("CI: ack: [wake] DM")) await failWithLogs("the bot's answer did not come back in pots chat");

// ---- Stop: remove the service, or stop pots start as the service would ----

if (gateway) {
  // On Windows the child is the shell that runs pots.cmd; the gateway's own process ID is in its pid file.
  if (windows) {
    const pid = Number(readFileSync(join(potsHome, "gateway.pid"), "utf8"));
    if (!(await askGatewayToStop(pid))) await failWithLogs("the gateway did not take the stop request");
  } else gateway.kill("SIGTERM");
  await new Promise((resolve) => gateway!.once("exit", resolve));
} else {
  await must(pots, ["service", "uninstall"]);
}

/** Whether the gateway's last run ended cleanly: after its last "started", a "shutdown" and the bot's "bot stopped". */
async function stoppedCleanly(): Promise<boolean> {
  const lines = (await gatewayLog()).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { message?: string; bot?: string }];
    } catch {
      return [];
    }
  });
  const last = lines.findLastIndex((line) => line.message === "started");
  const after = lines.slice(last + 1);
  return last >= 0 && after.some((line) => line.message === "shutdown") && after.some((line) => line.message === "bot stopped" && line.bot === bot);
}

const deadline = Date.now() + 15_000;
while (!(await stoppedCleanly())) {
  if (Date.now() > deadline) await failWithLogs("the gateway did not stop cleanly: its output has no shutdown after its last start");
  await pause(500);
}
const status = await must(pots, ["status"]);
if (!/^gateway: not running$/m.test(status) || !/^service: not installed$/m.test(status)) await failWithLogs("the gateway or the service is still there");

await model.close();
// So that the next run, such as the one with --system, finds the computer as this one did.
rmSync(models);
console.log(`\nOK: installed, ran as ${mode === "foreground" ? "pots start" : mode === "system" ? "a system service" : "a service"}, answered, and stopped cleanly.`);
