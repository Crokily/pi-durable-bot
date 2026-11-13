import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// On Linux with a systemd user manager, each command of a bot (bash, screen, routines' --run) runs in a systemd scope of
// its own, in one slice per Pots home. A scope is a cgroup: when memory runs out, systemd-oomd and the kernel pick the
// command that uses it, not the gateway with every bot in it; and a gateway restart leaves alone what a command left
// running, such as a browser or a server. The command stays the gateway's child, in its own process group, with the
// same pipes, so output, timeouts and interrupts work as before. Where there is no user manager (macOS, Windows, a
// system service, most containers), commands run as before.
//
// What Pots does with the scopes, and nothing more: when a bot stops, the scopes of the commands it was still waiting on
// stop with it, also at its next start after a crash; when Pots' own service is stopped on purpose (systemctl stop, pots
// service uninstall), not restarted, the slice stops; after a start each bot is told what its commands left running.
// Everything else is the bot's to decide.

const execFileAsync = promisify(execFile);
/** How long a systemctl call may take; the user manager answers in milliseconds. */
const SYSTEMCTL_TIMEOUT_MS = 5_000;
/** How much of a left process's command line a wake shows. */
const COMMAND_CHARS = 120;

/** What this process found once: the programs, and the slice of this Pots home. */
export interface ScopeSupport {
  readonly systemdRun: string;
  readonly bash: string;
  /** The first 8 hex digits of the SHA-256 of POTS_HOME, so two Pots homes of one user never share scopes. */
  readonly key: string;
  /** app-pots-<key>.slice: every scope of this Pots home, under the user manager's app.slice. */
  readonly slice: string;
  /** The gateway's own service in the user manager, such as pots.service, when the gateway runs as one. */
  readonly service?: string;
}

/** A scope of a bot's command that runs now. */
interface Scope {
  readonly unit: string;
  /** The process that runs the command: Pots waits on the command while it runs. */
  readonly pid: number;
  readonly started: number;
  readonly cgroup: string;
}

/** A scope that a command left running when it returned, as a wake shows it. */
export interface LeftScope {
  readonly unit: string;
  readonly started: number;
  readonly processes: number;
  /** The command line of its oldest process, cut. */
  readonly first?: string;
}

let detected: Promise<ScopeSupport | undefined> | undefined;

/** Found once per process, at the first call: undefined where commands run as before. */
export function scopeSupport(home: string): Promise<ScopeSupport | undefined> {
  return (detected ??= detect(home));
}

/** The support found, when something asked for it. */
export function foundScopeSupport(): Promise<ScopeSupport | undefined> | undefined {
  return detected;
}

async function detect(home: string): Promise<ScopeSupport | undefined> {
  if (process.platform !== "linux") return undefined;
  const systemdRun = onPath("systemd-run");
  // The shell pi-durable's bash tool takes: /bin/bash, else bash on PATH.
  const bash = existsSync("/bin/bash") ? "/bin/bash" : onPath("bash");
  if (!systemdRun || !bash) return undefined;
  const key = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8);
  const slice = `app-pots-${key}.slice`;
  // The same options as every command's, so an older systemd that lacks one leaves commands as they were.
  try {
    await execFileAsync(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--slice=${slice}`, "--description=Pots: checks that commands can run in scopes", "--", bash, "-c", "true"], {
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
  const service = ownService();
  return { systemdRun, bash, key, slice, ...(service ? { service } : {}) };
}

function onPath(program: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, program))) return join(dir, program);
  }
  return undefined;
}

/** The service of the user manager that this process is in, from its cgroup: .../user@1000.service/app.slice/pots.service. */
function ownService(): string | undefined {
  try {
    const path = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => fields[0] === "0" || fields[1] === "name=systemd")
      ?.slice(2)
      .join(":");
    const match = path ? /\/user@\d+\.service\/(?:.*\/)?([^/]+\.service)$/.exec(path) : null;
    return match?.[1];
  } catch {
    return undefined;
  }
}

function systemctl(args: readonly string[]): Promise<string> {
  return execFileAsync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS }).then((result) => result.stdout);
}

/** A shell word that bash passes on unchanged. */
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The commands of one bot. */
export class CommandScopes {
  readonly support: ScopeSupport;
  /**
   * Every scope of the bot is <prefix>-<process ID>-<token>.scope. The token is the start time in milliseconds in base
   * 36 and two base-36 digits that differ for each command of the process.
   */
  readonly prefix: string;
  readonly #unit: RegExp;
  readonly #script: string;
  #count = 0;
  /** Set once the bot stops: a command that ends interrupted from then on is one that Pots still waited on. */
  #closing = false;
  readonly #interrupted = new Set<string>();

  constructor(support: ScopeSupport, bot: string) {
    this.support = support;
    this.prefix = `pots-${support.key}-${bot}`;
    // Exactly two parts after the prefix, so a scope of bot "a-1" (pots-<key>-a-1-<pid>-<token>) is not one of bot "a".
    this.#unit = new RegExp(`^${this.prefix}-(\\d+)-([0-9a-z]{3,})\\.scope$`);
    const { systemdRun, bash, slice } = support;
    // The command's process, in its scope, tells the shell below that it started, then runs the command with the real
    // standard error. Until then standard error is /dev/null, so systemd-run's own messages do not mix with the output.
    const inner = `kill -USR1 "$PPID"; exec ${quote(bash)} -c "$1" 2>&3 3>&-`;
    // $1 is the command, $2 its token. The subshell's process becomes systemd-run, which moves it into the new scope
    // and becomes the command: its process ID is in the scope's name. When systemd-run cannot start the scope, the command
    // runs here, without a scope, as it did before scopes; one that started is never run twice.
    // The shell stays in the gateway's cgroup while the command runs. It outlives the SIGTERM that systemd sends there
    // when the gateway stops, so the command ends as Pots ends it, as an interrupted command, not by that signal; a
    // trap, unlike an ignored signal, is not passed on to the command.
    this.#script = [
      "exec 3>&2 2>/dev/null",
      "trap 's=1' USR1",
      "trap : TERM",
      `(exec ${quote(systemdRun)} --user --scope --quiet --collect --slice=${quote(slice)} --unit="${this.prefix}-$BASHPID-$2" --description=${quote(`Command of Pots bot ${bot}`)} -- ${quote(bash)} -c ${quote(inner)} pots "$1")`,
      "c=$?",
      `[ "$s" = 1 ] && exit "$c"`,
      `exec ${quote(bash)} -c "$1" 2>&3 3>&-`,
    ].join("\n");
  }

  /** An execution environment like pi-durable's, whose shell commands run in scopes. */
  env(options: ConstructorParameters<typeof NodeExecutionEnv>[0]): NodeExecutionEnv {
    return new ScopedExecutionEnv(options, this);
  }

  /** A new command's token. */
  token(): string {
    return `${Date.now().toString(36)}${(this.#count++ % 1296).toString(36).padStart(2, "0")}`;
  }

  /** How a shell command runs: in bash, which starts the scope and the command in it. */
  argv(command: string, token: string): string[] {
    return [this.support.bash, "-c", this.#script, "pots", command, token];
  }

  /** The command with this token ended because it was interrupted: by a timeout, an interrupt or the bot's stop. */
  interrupted(token: string): void {
    if (this.#closing) this.#interrupted.add(token);
  }

  /** The bot stops: the commands it interrupts from now on are those it was waiting on. */
  close(): void {
    this.#closing = true;
  }

  /**
   * Stop the scopes of the commands that the bot's stop interrupted, with all that runs in them. Their process groups have
   * ended already; this also ends what they started outside them. Returns how many there were.
   */
  async stopInterrupted(): Promise<number> {
    const tokens = [...this.#interrupted];
    this.#interrupted.clear();
    if (tokens.length > 0) await systemctl(["stop", "--no-block", "--", ...tokens.map((token) => `${this.prefix}-*-${token}.scope`)]).catch(() => {});
    return tokens.length;
  }

  /** The bot's scopes that run now. Empty when systemd does not answer. */
  async #list(): Promise<Scope[]> {
    let out: string;
    try {
      out = await systemctl(["show", "--property=Id,ActiveState,ControlGroup", "--", `${this.prefix}-*.scope`]);
    } catch {
      return [];
    }
    const scopes: Scope[] = [];
    for (const block of out.split(/\n\s*\n/)) {
      const fields = Object.fromEntries(block.split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]] : [])));
      const match = this.#unit.exec(fields.Id ?? "");
      if (!match || fields.ActiveState !== "active" || !fields.ControlGroup) continue;
      scopes.push({ unit: fields.Id!, pid: Number(match[1]), started: parseInt(match[2]!.slice(0, -2), 36), cgroup: fields.ControlGroup });
    }
    return scopes;
  }

  /**
   * At the bot's start: stop the scopes of the commands that the last gateway still waited on when it ended, as when it
   * crashed, and return those and what commands left running. A command's own process runs as long as Pots waits on the
   * command; a stop that went as it should leaves none.
   */
  async recover(): Promise<{ stopped: string[]; left: LeftScope[] }> {
    const scopes = await this.#list();
    const stopped = scopes.filter((scope) => commandRuns(scope));
    // SIGTERM, and SIGKILL for what is left after the scope's stop timeout. One that ended meanwhile is not loaded any
    // more: systemctl says so and stops the others.
    if (stopped.length > 0) await systemctl(["stop", "--no-block", "--", ...stopped.map((scope) => scope.unit)]).catch(() => {});
    const left = await Promise.all(scopes.filter((scope) => !stopped.includes(scope)).map((scope) => describe(scope)));
    // Not one whose processes ended meanwhile.
    return { stopped: stopped.map((scope) => scope.unit), left: left.filter((scope) => scope.processes > 0) };
  }
}

/** Whether the command's own process still runs in its scope; a process ID used again by another process is elsewhere. */
function commandRuns(scope: Scope): boolean {
  try {
    return readFileSync(`/proc/${scope.pid}/cgroup`, "utf8")
      .split("\n")
      .some((line) => line.endsWith(`/${scope.unit}`));
  } catch {
    return false;
  }
}

async function describe(scope: Scope): Promise<LeftScope> {
  // cgroup v2, or the systemd hierarchy of v1.
  const root = existsSync("/sys/fs/cgroup/cgroup.controllers") ? "/sys/fs/cgroup" : "/sys/fs/cgroup/systemd";
  const pids = await readFile(join(root, scope.cgroup, "cgroup.procs"), "utf8")
    .then((text) => text.split("\n").filter(Boolean).map(Number))
    .catch(() => [] as number[]);
  const started = await Promise.all(pids.map(async (pid) => ({ pid, at: await startTime(pid) })));
  const oldest = started.sort((a, b) => a.at - b.at)[0];
  const first = oldest ? await readFile(`/proc/${oldest.pid}/cmdline`, "utf8").catch(() => "") : "";
  const command = first.split("\0").filter(Boolean).join(" ");
  return {
    unit: scope.unit,
    started: scope.started,
    processes: pids.length,
    ...(command ? { first: command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS)}…` : command } : {}),
  };
}

/** When a process started, in clock ticks since boot: field 22 of /proc/<pid>/stat, the 20th after its name in parentheses. */
async function startTime(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[19]);
  return Number.isFinite(ticks) ? ticks : Number.POSITIVE_INFINITY;
}

class ScopedExecutionEnv extends NodeExecutionEnv {
  readonly #scopes: CommandScopes;

  constructor(options: ConstructorParameters<typeof NodeExecutionEnv>[0], scopes: CommandScopes) {
    super(options);
    this.#scopes = scopes;
  }

  override async exec(...[command, options, context]: Parameters<NodeExecutionEnv["exec"]>): ReturnType<NodeExecutionEnv["exec"]> {
    if (typeof command !== "string") return super.exec(command, options, context);
    const token = this.#scopes.token();
    const result = await super.exec(this.#scopes.argv(command, token), options, context);
    if (!result.ok && result.error.code === "aborted") this.#scopes.interrupted(token);
    return result;
  }
}

/**
 * Whether systemd is stopping the gateway's own service on purpose (systemctl stop, disable --now, a logout or a
 * shutdown), not restarting it: its job is a stop, and the gateway is the service's main process.
 */
export async function stoppingOnPurpose(support: ScopeSupport | undefined): Promise<boolean> {
  if (!support?.service) return false;
  try {
    const [main, jobs] = await Promise.all([
      systemctl(["show", "--property=MainPID", "--value", "--", support.service]),
      systemctl(["list-jobs", "--plain", "--no-legend", "--", support.service]),
    ]);
    if (Number(main.trim()) !== process.pid) return false;
    return jobs.split("\n").some((line) => {
      const [, unit, type] = line.trim().split(/\s+/);
      return unit === support.service && type === "stop";
    });
  } catch {
    return false;
  }
}

/** Stop every scope of this Pots home, of every bot. */
export async function stopAllScopes(support: ScopeSupport): Promise<void> {
  await systemctl(["stop", "--no-block", "--", support.slice]).catch(() => {});
}
