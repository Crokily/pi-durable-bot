import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import { gatewayPipe, LOGS_DIR, PID_FILE, POTS_HOME, processRunning, runningGateway } from "../core/home.ts";
import { userError } from "./control.ts";

// The gateway as a background service of the user who runs it, so it starts at login and the bots can use the desktop
// and its browser. macOS: a LaunchAgent. Linux: a systemd user unit with lingering, or a system unit with --system for
// servers. Windows: a Task Scheduler task at logon that starts the gateway without a window.

export interface ServiceManager {
  /** "launchd", "systemd --user", "systemd" or "Task Scheduler". */
  readonly kind: string;
  readonly installed: () => boolean;
  /** Write the service and (re)start it. */
  readonly install: (options: { system: boolean }) => Effect.Effect<void, ReturnType<typeof userError>>;
  readonly uninstall: () => Effect.Effect<void, ReturnType<typeof userError>>;
  readonly restart: () => Effect.Effect<void, ReturnType<typeof userError>>;
  /** Show the gateway's output: the last lines, then new ones with follow. */
  readonly logs: (options: { lines: number; follow: boolean }) => Effect.Effect<void, ReturnType<typeof userError>>;
}

export class Service extends Context.Service<Service, ServiceManager>()("pots/Service") {}

/** What the service runs: this node, this package's `pots start`, and the PATH of the person who installs it. */
const gateway = {
  node: process.execPath,
  entry: fileURLToPath(new URL(`./pots${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url)),
  path: [dirname(process.execPath), ...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")]
    .filter((item, index, all) => item && all.indexOf(item) === index)
    .join(process.platform === "win32" ? ";" : ":"),
  /** Only when it is not the default, so the service keeps finding the same bots. */
  home: process.env.POTS_HOME,
};
const LOG_FILE = join(LOGS_DIR, "gateway.log");

const run = (command: string, args: readonly string[], options: { input?: string; quiet?: boolean } = {}) =>
  Effect.try({
    try: () =>
      execFileSync(command, args, {
        encoding: "utf8",
        input: options.input,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", options.quiet ? "ignore" : "pipe"],
      }).trim(),
    catch: (error) => {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      return userError(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    },
  });

/** Show a file's last lines, then follow it, the way `tail -f` does. */
const tailFile = (file: string, { lines, follow }: { lines: number; follow: boolean }) =>
  Effect.gen(function* () {
    if (!existsSync(file)) return yield* Effect.fail(userError(`no log yet at ${file}`));
    const text = readFileSync(file, "utf8");
    process.stdout.write(`${text.split("\n").slice(-lines - 1).join("\n")}`);
    if (!follow) return;
    let offset = Buffer.byteLength(text);
    yield* Effect.callback<never>(() => {
      const timer = setInterval(() => {
        const buffer = readFileSync(file);
        if (buffer.length < offset) offset = 0;
        if (buffer.length > offset) process.stdout.write(buffer.subarray(offset).toString("utf8"));
        offset = buffer.length;
      }, 500);
      return Effect.sync(() => clearInterval(timer));
    });
  });

/** Wait for an external command that shows output, such as `journalctl -f`. */
const passthrough = (command: string, args: readonly string[]) =>
  Effect.callback<void, ReturnType<typeof userError>>((resume) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", () => resume(Effect.void));
    child.on("error", (error) => resume(Effect.fail(userError(`${command}: ${error.message}`))));
    return Effect.sync(() => child.kill());
  });

// ---- macOS ----

const LABEL = "io.github.crokily.pots";
const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const launchd: ServiceManager = {
  kind: "launchd",
  installed: () => existsSync(plistPath),
  install: () =>
    Effect.gen(function* () {
      const domain = `gui/${userInfo().uid}`;
      mkdirSync(LOGS_DIR, { recursive: true });
      mkdirSync(dirname(plistPath), { recursive: true });
      const env = { PATH: gateway.path, ...(gateway.home ? { POTS_HOME: gateway.home } : {}) };
      writeFileSync(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(gateway.node)}</string><string>${xml(gateway.entry)}</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
  <key>WorkingDirectory</key><string>${xml(POTS_HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`,
      );
      yield* run("launchctl", ["bootout", `${domain}/${LABEL}`], { quiet: true }).pipe(Effect.ignore);
      yield* run("launchctl", ["bootstrap", domain, plistPath]);
    }),
  uninstall: () =>
    Effect.gen(function* () {
      yield* run("launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`], { quiet: true }).pipe(Effect.ignore);
      rmSync(plistPath, { force: true });
    }),
  restart: () => run("launchctl", ["kickstart", "-k", `gui/${userInfo().uid}/${LABEL}`]).pipe(Effect.asVoid),
  logs: (options) => tailFile(LOG_FILE, options),
};

// ---- Linux ----

const userUnit = join(homedir(), ".config/systemd/user/pots.service");
const systemUnit = "/etc/systemd/system/pots.service";

function unitText(system: boolean): string {
  const quote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `# Written by pots service install.
[Unit]
Description=Pots gateway (pi-durable-bot)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
${system ? `User=${userInfo().username}\n` : ""}WorkingDirectory=${POTS_HOME}
ExecStart=${quote(gateway.node)} ${quote(gateway.entry)} start
Environment=${quote(`PATH=${gateway.path}`)}
${gateway.home ? `Environment=${quote(`POTS_HOME=${gateway.home}`)}\n` : ""}Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=${system ? "multi-user.target" : "default.target"}
`;
}

/** The user a system unit runs the gateway as: its User=, or root without one. Undefined when it cannot be read. */
function unitUser(file: string): string | undefined {
  try {
    return /^User=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? "root";
  } catch {
    return undefined;
  }
}

const isMe = (user: string) => user === userInfo().username || user === String(userInfo().uid);

/**
 * systemd: a user unit, or a system unit with --system. One Pots per Linux user: a system unit that runs as another
 * user is that user's, so it counts as not there, and this user gets a user unit of their own. Paths and commands can be
 * given for tests.
 */
export function systemdManager(files = { user: userUnit, system: systemUnit }, exec: typeof run = run): ServiceManager {
  const ownSystem = () => {
    const user = unitUser(files.system);
    return user !== undefined && isMe(user);
  };
  const otherUser = () => {
    const user = unitUser(files.system);
    return user !== undefined && !isMe(user) ? user : undefined;
  };
  const manager: ServiceManager = {
    get kind() {
      return ownSystem() ? "systemd" : "systemd --user";
    },
    installed: () => existsSync(files.user) || ownSystem(),
    install: ({ system }) =>
      Effect.gen(function* () {
        mkdirSync(POTS_HOME, { recursive: true });
        if (system) {
          const other = otherUser();
          if (other) return yield* Effect.fail(userError(`a system service of user ${other} is installed (${files.system}); use a user service: pots service install`));
          if (existsSync(files.user)) yield* manager.uninstall();
          yield* exec("sudo", ["tee", files.system], { input: unitText(true) });
          yield* exec("sudo", ["systemctl", "daemon-reload"]);
          yield* exec("sudo", ["systemctl", "enable", "pots.service"]);
          yield* exec("sudo", ["systemctl", "restart", "pots.service"]);
          return;
        }
        if (ownSystem()) return yield* Effect.fail(userError(`a system service is installed (${files.system}); use pots service install --system, or uninstall it first`));
        mkdirSync(dirname(files.user), { recursive: true });
        writeFileSync(files.user, unitText(false));
        yield* exec("systemctl", ["--user", "daemon-reload"]);
        yield* exec("systemctl", ["--user", "enable", "pots.service"]);
        yield* exec("systemctl", ["--user", "restart", "pots.service"]);
        // Keep the user's services running without a login session, and start them at boot. Where polkit does not let a
        // user do that for themselves, sudo without a password often can, as on many cloud servers.
        const user = userInfo().username;
        yield* exec("loginctl", ["enable-linger", user]).pipe(
          Effect.catch(() => exec("sudo", ["-n", "loginctl", "enable-linger", user])),
          Effect.catch(() => Effect.logWarning(`could not enable lingering, so the bots stop when you log out. Run: sudo loginctl enable-linger ${user}`)),
        );
      }),
    uninstall: () =>
      Effect.gen(function* () {
        if (ownSystem()) {
          yield* exec("sudo", ["systemctl", "disable", "--now", "pots.service"]);
          yield* exec("sudo", ["rm", "-f", files.system]);
          yield* exec("sudo", ["systemctl", "daemon-reload"]);
        }
        if (existsSync(files.user)) {
          yield* exec("systemctl", ["--user", "disable", "--now", "pots.service"]);
          rmSync(files.user, { force: true });
          yield* exec("systemctl", ["--user", "daemon-reload"]);
        }
      }),
    restart: () =>
      (ownSystem() ? exec("sudo", ["systemctl", "restart", "pots.service"]) : exec("systemctl", ["--user", "restart", "pots.service"])).pipe(Effect.asVoid),
    logs: ({ lines, follow }) =>
      passthrough("journalctl", [...(ownSystem() ? [] : ["--user"]), "-u", "pots.service", "-n", String(lines), "-o", "cat", ...(follow ? ["-f"] : [])]),
  };
  return manager;
}

// ---- Windows ----

const TASK = "Pots";
const launcher = join(POTS_HOME, "bin", "gateway.vbs");
/** A PowerShell string literal. */
const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
const powershell = (script: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** As long as systemd (TimeoutStopSec) and launchd (ExitTimeOut) let the gateway stop before they kill it. */
const STOP_TIMEOUT_MS = 30_000;

/**
 * Ask the gateway with this process ID to stop, as SIGTERM does elsewhere (gatewayPipe). False when nothing listens, as
 * with a gateway older than this request; true when it answered, or took the request and ended before it could.
 */
export function askGatewayToStop(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false;
    const req = request({ socketPath: gatewayPipe(pid), method: "POST", path: "/stop" }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("socket", (socket) => socket.once("connect", () => (connected = true)));
    req.on("error", () => resolve(connected));
    req.setTimeout(10_000, () => req.destroy());
    req.end();
  });
}

/**
 * Stop the gateway the task started, as systemd and launchd do: ask it to stop, and end its processes only when it has
 * not ended within their time. Then stop the task, whose launcher starts the gateway again after an exit with an error.
 */
const stopWindowsGateway = Effect.gen(function* () {
  const pid = runningGateway();
  if (pid !== undefined && (yield* Effect.promise(() => askGatewayToStop(pid)))) {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (processRunning(pid) && Date.now() < deadline) yield* Effect.sleep("200 millis");
  }
  yield* powershell(`Stop-ScheduledTask -TaskName ${ps(TASK)} -ErrorAction SilentlyContinue`).pipe(Effect.ignore);
  const left = runningGateway();
  if (left !== undefined) yield* run("taskkill", ["/PID", String(left), "/T", "/F"], { quiet: true }).pipe(Effect.ignore);
  rmSync(PID_FILE, { force: true });
});

const windows: ServiceManager = {
  kind: "Task Scheduler",
  installed: () => existsSync(launcher),
  install: () =>
    Effect.gen(function* () {
      mkdirSync(dirname(launcher), { recursive: true });
      mkdirSync(LOGS_DIR, { recursive: true });
      // Starts the gateway without a window and starts it again if it stops with an error. A VBScript string doubles its quotes.
      const vbs = (text: string) => `"${text.replaceAll('"', '""')}"`;
      const command = `cmd /s /c ""${gateway.node}" "${gateway.entry}" start >> "${LOG_FILE}" 2>&1"`;
      writeFileSync(
        launcher,
        [
          "' Written by pots service install. Task Scheduler runs it at logon.",
          'Set shell = CreateObject("WScript.Shell")',
          `shell.Environment("Process")("PATH") = ${vbs(gateway.path)}`,
          ...(gateway.home ? [`shell.Environment("Process")("POTS_HOME") = ${vbs(gateway.home)}`] : []),
          "Do",
          `  code = shell.Run(${vbs(command)}, 0, True)`,
          "  If code = 0 Then Exit Do",
          "  WScript.Sleep 5000",
          "Loop",
          "",
        ].join("\r\n"),
      );
      yield* stopWindowsGateway;
      yield* powershell(
        [
          `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${ps(`"${launcher}"`)}`,
          "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
          "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
          `Register-ScheduledTask -TaskName ${ps(TASK)} -Action $action -Trigger $trigger -Settings $settings -Description 'Pots gateway (pi-durable-bot)' -Force | Out-Null`,
          `Start-ScheduledTask -TaskName ${ps(TASK)}`,
        ].join("; "),
      );
    }),
  uninstall: () =>
    Effect.gen(function* () {
      yield* stopWindowsGateway;
      yield* powershell(`Unregister-ScheduledTask -TaskName ${ps(TASK)} -Confirm:$false -ErrorAction SilentlyContinue`).pipe(Effect.ignore);
      rmSync(launcher, { force: true });
    }),
  restart: () =>
    Effect.gen(function* () {
      yield* stopWindowsGateway;
      yield* powershell(`Start-ScheduledTask -TaskName ${ps(TASK)}`);
    }),
  logs: (options) => tailFile(LOG_FILE, options),
};

/** The service manager of this platform. */
export const layer = Layer.succeed(Service, process.platform === "darwin" ? launchd : process.platform === "win32" ? windows : systemdManager());
