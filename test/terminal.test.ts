import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/cli/ai.ts";

// pots in a real terminal. Some bugs show only there, such as raw mode switched off under a prompt, so these tests
// type keys into a pseudo-terminal from Python's pty module (Linux and macOS) and read the screen.

const POTS = fileURLToPath(new URL("../src/cli/pots.ts", import.meta.url));
const FAKE_MODEL = new URL("./support/fake-model.ts", import.meta.url).href;
const MODELS = new URL("../src/agent/models.ts", import.meta.url).href;
const python = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

// Runs a command in a pseudo-terminal. Each step waits until the screen shows a text, then, a moment later like a
// person, types keys, appends a line to a file or opens a URL; a step with no action only waits, until the command
// ends when its text is never shown. Prints the screen, and <<exited>> if the command ended.
const DRIVER = `
import json, os, pty, select, sys, time, urllib.request
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
    if action is None: continue
    time.sleep(0.3)
    if isinstance(action, dict) and "get" in action:
        try: urllib.request.urlopen(action["get"], timeout=5)
        except Exception: pass
    elif isinstance(action, dict):
        with open(action["file"], "a") as f: f.write(action["line"] + "\\n")
    else:
        os.write(fd, action.encode())
read_until("never", 2)
# The terminal closes a moment before the command can be reaped.
end = time.time() + 2
while not os.waitpid(pid, os.WNOHANG)[0]:
    if time.time() > end:
        os.kill(pid, 9)
        break
    time.sleep(0.05)
else:
    screen += b"\\n<<exited>>"
sys.stdout.write(screen.decode(errors="replace"))
`;

type Step = [wait: string, action: string | { file: string; line: string } | { get: string } | null];

let home: string;

afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = () => ({ ...process.env, POTS_HOME: join(home, "pots"), PI_CODING_AGENT_DIR: join(home, "pi"), BROWSER: "true", DISPLAY: "" });

/** A pots command in a pseudo-terminal; the screen it showed, without colours. */
function inTerminal(args: string[], steps: Step[]): string {
  const result = spawnSync("python3", ["-c", DRIVER, JSON.stringify(steps), process.execPath, POTS, ...args], { env: env(), encoding: "utf8", timeout: 60_000 });
  return result.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";

/** Starts the fake model in a process of its own: the terminal holds this one until the command ends. Its URL. */
async function fakeModel(): Promise<{ url: string; stop(): void }> {
  const server = spawn(process.execPath, ["--input-type=module", "-e", `const { startFakeModel } = await import(${JSON.stringify(FAKE_MODEL)}); console.log((await startFakeModel()).url);`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve) => server.stdout.once("data", (data) => resolve(String(data).trim())));
  return { url, stop: () => server.kill() };
}

/** pi's TypeSafe provider, pointed at the fake model's judge. */
function typesafeAt(url: string): void {
  mkdirSync(join(home, "pi"), { recursive: true });
  writeFileSync(join(home, "pi", "models.json"), JSON.stringify({ providers: { typesafe: { baseUrl: url } } }));
}

/** How many times to press the down arrow at "Which provider?" to reach a provider; the list is pi's. */
function downTo(provider: string): string {
  const script = `const { openModels } = await import(${JSON.stringify(MODELS)}); const models = await openModels(); console.log(JSON.stringify(models.getProviders().filter((item) => item.auth.apiKey?.login).map((item) => item.id)));`;
  const ids = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: env(), encoding: "utf8" })) as string[];
  expect(ids).toContain(provider);
  return DOWN.repeat(ids.indexOf(provider));
}

const auth = () => JSON.parse(readFileSync(join(home, "pi", "auth.json"), "utf8")) as Record<string, { type: string; key?: string }>;

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

  it("init signs in with ChatGPT using pi's device ID", () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const screen = inTerminal(
      ["init", "--no-service", "--no-chat"],
      [
        ["Continue?", "y"],
        ["What is its name?", "\r"],
        ["How should your bot get its AI?", "\r"],
        ["Which subscription?", DOWN.repeat(4)],
        ["Which subscription?", "\r"],
        ["paste the final redirect URL", ""],
      ],
    );
    expect(screen).not.toContain("requires a device ID");
    const deviceId = (JSON.parse(readFileSync(join(home, "pi", "settings.json"), "utf8")) as { deviceId: string }).deviceId;
    expect(screen).toContain(`ext_agent_host_id=urn%3Auuid%3A${deviceId}`);
    expect(screen).toContain("Complete login in your browser, or paste the final redirect URL here:");
  });

  it("init says why a browser sign-in failed, and asks again", () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const screen = inTerminal(
      ["init", "--no-service", "--no-chat"],
      [
        ["Continue?", "y"],
        ["What is its name?", "\r"],
        ["How should your bot get its AI?", "\r"],
        ["Which subscription?", DOWN.repeat(4)],
        ["Which subscription?", "\r"],
        ["paste the final redirect URL", { get: "http://127.0.0.1:1455/auth/callback?error=access_denied" }],
        // Ctrl+C at the question leaves.
        ["Login failed", "\x03"],
        ["<<the command ends>>", null],
      ],
    );
    expect(screen).toMatch(/Login failed: ChatGPT authorization failed: access_denied\s+\? How should your bot get its AI\?/);
    expect(screen).toContain("<<exited>>");
    expect(existsSync(join(home, "pots", "bots"))).toBe(false);
  });

  it("init adds a local server to pi's models.json and tries it", () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const screen = inTerminal(
      ["init", "--no-service", "--no-chat"],
      [
        ["Continue?", "y"],
        ["What is its name?", "\r"],
        ["How should your bot get its AI?", DOWN.repeat(2)],
        ["How should your bot get its AI?", "\r"],
        ["Which server?", DOWN.repeat(3)],
        ["Which server?", "\r"],
        ["base URL", "\x7f".repeat(40) + "http://127.0.0.1:9/v1\r"],
        ["API key", "\r"],
        ["Model ID", "m\r"],
        ["context window", "\r"],
        ["Try again", "n"],
        ["It stays in", "\x03"],
        ["<<the command ends>>", null],
      ],
    );
    const file = JSON.parse(readFileSync(join(home, "pi", "models.json"), "utf8")) as { providers: Record<string, { baseUrl: string; models: { id: string }[] }> };
    expect(file.providers.local).toMatchObject({ baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "m" }] });
    expect(screen).toContain("local/m does not answer:");
    // Back to the question, where the model pi now has is offered.
    expect(screen).toContain(`local/m does not answer. It stays in ${join(home, "pi", "models.json")}.`);
    expect(screen).toMatch(/It stays in [^\n]*\.\s+\? How should your bot get its AI\?/);
    expect(screen).toContain("A model you have already set up in pi (1)");
    expect(screen).toContain("<<exited>>");
    expect(existsSync(join(home, "pots", "bots"))).toBe(false);
  });

  it("init asks who decides on group messages that do not mention the bot, and leaves it to the bot by default", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const server = await fakeModel();
    try {
      const url = server.url;
      mkdirSync(join(home, "pi"), { recursive: true });
      const fake = { baseUrl: url, api: "openai-completions", apiKey: "fake", models: [{ id: "coworker", contextWindow: 128_000 }] };
      writeFileSync(join(home, "pi", "models.json"), JSON.stringify({ providers: { fake } }));
      const screen = inTerminal(
        ["init", "--no-service", "--no-chat"],
        [
          ["Continue?", "y"],
          ["What is its name?", "\r"],
          ["How should your bot get its AI?", "\r"],
          ["Which model should it think with?", "\r"],
          ["does not mention it?", "\r"],
          ["For example", "\r"],
          ["<<the command ends>>", null],
        ],
      );
      expect(screen).toContain("3  Group messages that do not mention Pots");
      expect(screen).toContain("Who decides whether Pots answers a group message that does not mention it?");
      expect(screen).toContain("Jev, a fast judge from TypeSafe");
      expect(screen).toContain("<<exited>>");
      expect(JSON.parse(readFileSync(join(home, "pots", "bots", "pots", "bot.json"), "utf8"))).toMatchObject({ model: "fake/coworker", judge: "off" });
    } finally {
      server.stop();
    }
  });

  it("login adds a model and a judge in one run, refuses an empty key, tries each, and lists them at Done", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const server = await fakeModel();
    try {
      typesafeAt(server.url);
      const typesafe = downTo("typesafe");
      const screen = inTerminal(
        ["login"],
        [
          // Nothing is set up yet, so the first choice is a subscription.
          ["How should your bot get its AI?", DOWN.repeat(2)],
          ["How should your bot get its AI?", "\r"],
          ["Which server?", DOWN.repeat(3)],
          ["Which server?", "\r"],
          ["base URL", "\x7f".repeat(40) + `${server.url}\r`],
          ["API key", "\r"],
          ["Model ID", "coworker\r"],
          ["context window", "\r"],
          // Back at the menu after the model.
          ["What next?", DOWN],
          ["What next?", "\r"],
          ["Which provider?", typesafe],
          ["Which provider?", "\r"],
          ["Enter TypeSafe API key", "\r"],
          ["cannot be empty", "good-key\r"],
          // Done is the last choice, one up from the first.
          ["Ready as a judge", UP],
          ["List what pi can use, and leave", "\r"],
          ["<<the command ends>>", null],
        ],
      );
      expect(screen).not.toContain("already set up in pi");
      expect(screen).toContain("Ready: local/coworker. A new bot can think with it: pots init --model local/coworker");
      expect(screen).toContain("It cannot be empty: paste it, or press Ctrl+C to go back");
      expect(screen).toContain("Trying typesafe/jev-latest…");
      expect(screen).toContain("Ready as a judge: typesafe/jev-latest. A new bot can use it: pots init --judge typesafe/jev-latest");
      expect(screen).toMatch(/Done\s+Models \(for --model\):\s+local\/coworker\s+Judges \(for --judge\):\s+typesafe\/jev-latest\s+<<exited>>/);
      expect(auth().typesafe).toEqual({ type: "api_key", key: "good-key" });
      const listed = spawnSync(process.execPath, [POTS, "login", "--list"], { env: env(), encoding: "utf8" });
      expect(listed.stdout).toBe("Models (for --model):\n  local/coworker\nJudges (for --judge):\n  typesafe/jev-latest\n");
    } finally {
      server.stop();
    }
  });

  it("login keeps the key pi has when the person leaves the key prompt empty and cancels", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const server = await fakeModel();
    try {
      typesafeAt(server.url);
      writeFileSync(join(home, "pi", "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "good-key" } }));
      const typesafe = downTo("typesafe");
      const screen = inTerminal(
        ["login"],
        [
          ["How should your bot get its AI?", DOWN],
          ["How should your bot get its AI?", "\r"],
          ["Which provider?", typesafe],
          ["Which provider?", "\r"],
          ["Enter TypeSafe API key", "\r"],
          ["cannot be empty", "\x03"],
          ["Cancelled.", UP],
          ["List what pi can use, and leave", "\r"],
          ["<<the command ends>>", null],
        ],
      );
      expect(screen).toMatch(/Cancelled\.\s+\? What next\?/);
      expect(screen).toMatch(/Judges \(for --judge\):\s+typesafe\/jev-latest\s+<<exited>>/);
      expect(auth().typesafe).toEqual({ type: "api_key", key: "good-key" });
    } finally {
      server.stop();
    }
  });

  it("login says why a judge cannot be used with its key, and goes back to the menu", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-terminal-"));
    const server = await fakeModel();
    try {
      typesafeAt(server.url);
      const typesafe = downTo("typesafe");
      const screen = inTerminal(
        ["login"],
        [
          ["How should your bot get its AI?", DOWN],
          ["How should your bot get its AI?", "\r"],
          ["Which provider?", typesafe],
          ["Which provider?", "\r"],
          ["Enter TypeSafe API key", "wrong-key\r"],
          ["cannot be used as the judge", UP],
          ["List what pi can use, and leave", "\r"],
          ["<<the command ends>>", null],
        ],
      );
      expect(screen).toMatch(/typesafe\/jev-latest cannot be used as the judge: System One API error \(401\): .*Please check your API key.*\s+\? What next\?/);
      expect(screen).toContain("<<exited>>");
    } finally {
      server.stop();
    }
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

// The tests above set BROWSER so that a sign-in opens no page. xdg-open reads it on Linux; on macOS pots reads it.
describe.runIf(process.platform === "darwin")("pots opens a page on macOS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("with the first command in $BROWSER that starts, and its arguments", async () => {
    home = mkdtempSync(join(tmpdir(), "pots-browser-"));
    const opened = join(home, "opened");
    const recorder = (name: string) => {
      writeFileSync(join(home, name), `#!/bin/sh\necho ${name} "$@" >> "${opened}"\n`, { mode: 0o755 });
      return join(home, name);
    };
    // A fake open, first on PATH, so that this test opens no page when pots does not read $BROWSER.
    recorder("open");
    vi.stubEnv("PATH", `${home}:${process.env.PATH}`);
    vi.stubEnv("BROWSER", `${join(home, "missing")}:${recorder("browser")} --new-window`);
    const url = "https://auth.example.com/authorize?a=1&b=2";
    openBrowser(url);
    await vi.waitFor(() => expect(readFileSync(opened, "utf8")).toBe(`browser --new-window ${url}\n`), { timeout: 3_000 });
  });
});
