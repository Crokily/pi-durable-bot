import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// pots in a real terminal. Some bugs show only there, such as raw mode switched off under a prompt, so these tests
// type keys into a pseudo-terminal from Python's pty module (Linux and macOS) and read the screen.

const POTS = fileURLToPath(new URL("../src/cli/pots.ts", import.meta.url));
const python = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

// Runs a command in a pseudo-terminal. Each step waits until the screen shows a text, then, a moment later like a
// person, types keys or appends a line to a file. Prints the screen.
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
for wait, action in steps:
    read_until(wait)
    time.sleep(0.3)
    if isinstance(action, dict):
        with open(action["file"], "a") as f: f.write(action["line"] + "\\n")
    else:
        os.write(fd, action.encode())
read_until("never", 2)
os.kill(pid, 9)
sys.stdout.write(screen.decode(errors="replace"))
`;

type Step = [wait: string, action: string | { file: string; line: string }];

let home: string;

afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = () => ({ ...process.env, POTS_HOME: join(home, "pots"), PI_CODING_AGENT_DIR: join(home, "pi"), BROWSER: "true", DISPLAY: "" });

/** A pots command in a pseudo-terminal; the screen it showed, without colours. */
function inTerminal(args: string[], steps: Step[]): string {
  const result = spawnSync("python3", ["-c", DRIVER, JSON.stringify(steps), process.execPath, POTS, ...args], { env: env(), encoding: "utf8", timeout: 60_000 });
  return result.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const DOWN = "\x1b[B";

describe.skipIf(!python)("pots in a terminal", { timeout: 90_000 }, () => {
  it("init moves through pi's own login prompt with the arrow keys", () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const screen = inTerminal(
      ["init", "--no-service", "--no-chat"],
      [
        ["Continue?", "y"],
        ["What is its name?", "\r"],
        ["How should your bot get its AI?", "\r"],
        ["Which subscription?", "\r"],
        ["login method", DOWN],
        ["login method", "\r"],
        ["Paste the code", "abc"],
      ],
    );
    expect(screen).not.toContain("^[[B");
    expect(screen).toMatch(/✔ Select Anthropic login method: …\s+Copy code login/);
    expect(screen).toContain("Paste the code Anthropic shows after you sign in: › abc");
  });

  it("chat takes a secret apart from what the person was typing, and forgets it", () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    execFileSync(process.execPath, [POTS, "bot", "new", "Tester", "--model", "fake/x"], { env: env() });
    const platform = join(home, "pots", "bots", "tester", "terminal", "platform.jsonl");
    mkdirSync(dirname(platform), { recursive: true });
    const person = userInfo().username.toLowerCase().replace(/[^\w-]+/g, "-") || "you";
    const request = { id: "m-ask", type: "message", at: Date.now(), place: `dm-${person}`, person: "bot", text: "Your Slack token, please", secret: { file: "slack.env", keys: ["SLACK_BOT_TOKEN"] } };
    const screen = inTerminal(
      ["chat"],
      [
        ["Ctrl+C to leave", "half a sen"],
        ["half a sen", { file: platform, line: JSON.stringify(request) }],
        ["SLACK_BOT_TOKEN: ", "xoxb-wrong"],
        ["SLACK_BOT_TOKEN: ", "\x15xoxb-right\r"],
        ["wrote SLACK_BOT_TOKEN", "tence\x19\r"],
      ],
    );
    expect(readFileSync(join(home, "pots", "secrets", "slack.env"), "utf8")).toBe("SLACK_BOT_TOKEN=xoxb-right\n");
    expect(screen).not.toContain("xoxb");
    const said = readFileSync(platform, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { person: string; text: string })
      .filter((line) => line.person !== "bot")
      .map((line) => line.text);
    expect(said).toEqual(["(pots chat: wrote SLACK_BOT_TOKEN to " + join(home, "pots", "secrets", "slack.env") + ")", "half a sentence"]);
  });
});
