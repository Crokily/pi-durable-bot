import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// pots init in a real terminal. Some bugs show only there, such as raw mode switched off under a prompt, so these
// tests type keys into a pseudo-terminal from Python's pty module (Linux and macOS) and read the screen.

const POTS = fileURLToPath(new URL("../src/cli/pots.ts", import.meta.url));
const python = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

// Runs a command in a pseudo-terminal. Each step waits until the screen shows a text, then types keys a moment later,
// like a person. Prints the screen.
const DRIVER = `
import json, os, pty, select, sys, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
screen = b""
def read_until(text, seconds=20):
    global screen
    end = time.time() + seconds
    while text.encode() not in screen and time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try: screen += os.read(fd, 65536)
            except OSError: break
for wait, keys in steps:
    read_until(wait)
    time.sleep(0.3)
    os.write(fd, keys.encode())
read_until("never", 2)
os.kill(pid, 9)
sys.stdout.write(screen.decode(errors="replace"))
`;

/** pots init in a pseudo-terminal with a fresh home; the screen it showed, without colours. */
function initInTerminal(steps: [wait: string, keys: string][]): string {
  const home = mkdtempSync(join(tmpdir(), "pots-init-"));
  try {
    const result = spawnSync("python3", ["-c", DRIVER, JSON.stringify(steps), process.execPath, POTS, "init", "--no-service", "--no-chat"], {
      env: { ...process.env, POTS_HOME: join(home, "pots"), PI_CODING_AGENT_DIR: join(home, "pi"), BROWSER: "true", DISPLAY: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    return result.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const DOWN = "\x1b[B";

describe.skipIf(!python)("pots init in a terminal", { timeout: 90_000 }, () => {
  it("moves through pi's own login prompt with the arrow keys", () => {
    const screen = initInTerminal([
      ["Continue?", "y"],
      ["What is its name?", "\r"],
      ["How should your bot get its AI?", "\r"],
      ["Which subscription?", "\r"],
      ["login method", DOWN],
      ["login method", "\r"],
      ["Paste the code", "abc"],
    ]);
    expect(screen).not.toContain("^[[B");
    expect(screen).toMatch(/✔ Select Anthropic login method: …\s+Copy code login/);
    expect(screen).toContain("Paste the code Anthropic shows after you sign in: › abc");
  });
});
