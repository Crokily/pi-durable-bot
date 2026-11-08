import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where Pots keeps everything on this machine. The same layout on macOS, Linux and Windows.

/** ~/.pots, or $POTS_HOME. */
export const POTS_HOME = process.env.POTS_HOME ?? join(homedir(), ".pots");
/** One folder per bot. */
export const BOTS_DIR = join(POTS_HOME, "bots");
/** The memory all bots share, for facts about the user: one markdown file per memory, and MEMORY.md, their index. */
export const MEMORY_DIR = join(POTS_HOME, "memory");
/** Channel tokens and other secrets. Readable only by the owner. */
export const SECRETS_DIR = join(POTS_HOME, "secrets");
/** The `pots` command for the bots' own shells, scripts and scheduled jobs. */
export const BIN_DIR = join(POTS_HOME, "bin");
/** The gateway's output when it runs as a service on macOS or Windows. */
export const LOGS_DIR = join(POTS_HOME, "logs");
/** The process ID of the running gateway. There is at most one per POTS_HOME. */
export const PID_FILE = join(POTS_HOME, "gateway.pid");

/** The process ID in the pid file, when that process is still running. */
export function runningGateway(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return processRunning(pid) ? pid : undefined;
}

export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Windows has no SIGTERM. There the gateway takes `POST /stop` on this named pipe and stops as it does on SIGTERM
 * elsewhere; pots service asks it so before it ends the gateway's processes.
 */
export const gatewayPipe = (pid: number) => `\\\\.\\pipe\\pots-gateway-${pid}`;
