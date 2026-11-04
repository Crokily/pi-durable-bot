import { execFile } from "node:child_process";
import { arch, hostname, release, userInfo } from "node:os";
import { promisify } from "node:util";

/** The computer the bot runs on, as plain facts for its prompt. */
export interface Machine {
  /** For example "macOS 15.4 (arm64)", "Linux 6.8.12 (arm64)", "Windows 10.0.26100 (x64)". */
  os: string;
  hostname: string;
  user: string;
  /** How the bash tool runs: plain bash, or Git Bash on Windows. */
  shell: string;
}

/**
 * Asks the system in the background, so the gateway starts while the commands run. Only facts that stay the same from
 * one start to the next: they are in the prompt's start, which the provider caches. Whether sudo needs a password is
 * not one of them (on macOS it depends on when sudo last asked), so the agent checks that itself.
 */
export async function describeMachine(): Promise<Machine> {
  const platform = process.platform;
  const macOS = platform === "darwin" ? await run("sw_vers", ["-productVersion"]) : undefined;
  const os =
    platform === "darwin"
      ? `macOS ${macOS ?? release()}`
      : platform === "win32"
        ? `Windows ${release()}`
        : `${platform === "linux" ? "Linux" : platform} ${release()}`;
  return {
    os: `${os} (${arch()})`,
    hostname: hostname(),
    user: userInfo().username,
    shell: platform === "win32" ? "Git Bash (Windows paths also work, for example C:/Users)" : "bash",
  };
}

const execFileAsync = promisify(execFile);

/** The command's output, or undefined when it fails. */
async function run(command: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync(command, args, { encoding: "utf8", timeout: 5_000 })).stdout.trim();
  } catch {
    return undefined;
  }
}
