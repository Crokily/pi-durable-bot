import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import { LOGS_DIR, PID_FILE, POTS_HOME } from "../core/home.ts";
import { runningGateway } from "../main.ts";
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

const systemd: ServiceManager = {
  get kind() {
    return existsSync(systemUnit) ? "systemd" : "systemd --user";
  },
  installed: () => existsSync(userUnit) || existsSync(systemUnit),
  install: ({ system }) =>
    Effect.gen(function* () {
      mkdirSync(POTS_HOME, { recursive: true });
      if (system) {
        if (existsSync(userUnit)) yield* systemd.uninstall();
        yield* run("sudo", ["tee", systemUnit], { input: unitText(true) });
        yield* run("sudo", ["systemctl", "daemon-reload"]);
        yield* run("sudo", ["systemctl", "enable", "pots.service"]);
        yield* run("sudo", ["systemctl", "restart", "pots.service"]);
        return;
      }
      if (existsSync(systemUnit)) return yield* Effect.fail(userError(`a system service is installed (${systemUnit}); use pots service install --system, or uninstall it first`));
      mkdirSync(dirname(userUnit), { recursive: true });
      writeFileSync(userUnit, unitText(false));
      yield* run("systemctl", ["--user", "daemon-reload"]);
      yield* run("systemctl", ["--user", "enable", "pots.service"]);
      yield* run("systemctl", ["--user", "restart", "pots.service"]);
      // Keep the user's services running without a login session, and start them at boot.
      yield* run("loginctl", ["enable-linger", userInfo().username]).pipe(
        Effect.catch((error) => Effect.logWarning(`could not enable lingering, so the bots stop when you log out: ${error.message}`)),
      );
    }),
  uninstall: () =>
    Effect.gen(function* () {
      if (existsSync(systemUnit)) {
        yield* run("sudo", ["systemctl", "disable", "--now", "pots.service"]);
        yield* run("sudo", ["rm", "-f", systemUnit]);
        yield* run("sudo", ["systemctl", "daemon-reload"]);
      }
      if (existsSync(userUnit)) {
        yield* run("systemctl", ["--user", "disable", "--now", "pots.service"]);
        rmSync(userUnit, { force: true });
        yield* run("systemctl", ["--user", "daemon-reload"]);
      }
    }),
  restart: () =>
    (existsSync(systemUnit) ? run("sudo", ["systemctl", "restart", "pots.service"]) : run("systemctl", ["--user", "restart", "pots.service"])).pipe(
      Effect.asVoid,
    ),
  logs: ({ lines, follow }) =>
    passthrough("journalctl", [...(existsSync(systemUnit) ? [] : ["--user"]), "-u", "pots.service", "-n", String(lines), "-o", "cat", ...(follow ? ["-f"] : [])]),
};

// ---- Windows ----

const TASK = "Pots";
const launcher = join(POTS_HOME, "bin", "gateway.vbs");
/** A PowerShell string literal. */
const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
const powershell = (script: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** Stop the gateway the task started: the task first (so it does not restart it), then the gateway's processes. */
const stopWindowsGateway = Effect.gen(function* () {
  yield* powershell(`Stop-ScheduledTask -TaskName ${ps(TASK)} -ErrorAction SilentlyContinue`).pipe(Effect.ignore);
  const pid = runningGateway();
  if (pid !== undefined) yield* run("taskkill", ["/PID", String(pid), "/T", "/F"], { quiet: true }).pipe(Effect.ignore);
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
export const layer = Layer.succeed(Service, process.platform === "darwin" ? launchd : process.platform === "win32" ? windows : systemd);
