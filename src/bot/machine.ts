import { execFileSync } from "node:child_process";
import { arch, hostname, release, userInfo } from "node:os";

/** The computer the bot runs on, as plain facts for its prompt. */
export interface Machine {
  /** For example "macOS 15.4 (arm64)", "Linux 6.8.12 (arm64)", "Windows 10.0.26100 (x64)". */
  os: string;
  hostname: string;
  user: string;
  /** How the bash tool runs: plain bash, or Git Bash on Windows. */
  shell: string;
  /** True when `sudo -n true` works: root commands need no password. */
  sudo: boolean;
}

export function describeMachine(): Machine {
  const platform = process.platform;
  const os =
    platform === "darwin"
      ? `macOS ${run("sw_vers", ["-productVersion"]) ?? release()}`
      : platform === "win32"
        ? `Windows ${release()}`
        : `${platform === "linux" ? "Linux" : platform} ${release()}`;
  return {
    os: `${os} (${arch()})`,
    hostname: hostname(),
    user: userInfo().username,
    shell: platform === "win32" ? "Git Bash (Windows paths also work, for example C:/Users)" : "bash",
    sudo: platform !== "win32" && run("sudo", ["-n", "true"]) !== undefined,
  };
}

function run(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  } catch {
    return undefined;
  }
}
