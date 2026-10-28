import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { terminalDir, terminalPerson } from "../channels/terminal/index.ts";
import { platformFile } from "../channels/test/index.ts";
import { botDir, control, resolveBot, userError } from "./control.ts";

// pots chat: talk to a bot in this terminal. What you type goes into its terminal channel; what it sends there shows up
// here. The channel is a file, so messages wait while the bot is not running.

interface Line {
  id: string;
  type: string;
  at: number;
  place: string;
  person: string;
  text?: string;
  emoji?: string;
}

const dim = (text: string) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);

/** The terminal channel of a bot, or a failure that says how to add one. */
const terminalOf = (id: string) =>
  Effect.suspend(() => {
    const definition = JSON.parse(readFileSync(join(botDir(id), "bot.json"), "utf8")) as { name: string; channels: { id: string; type: string }[] };
    const channel = definition.channels.find((item) => item.type === "terminal");
    if (!channel) return Effect.fail(userError(`${id} has no terminal channel; add {"id": "terminal", "type": "terminal"} to "channels" in its bot.json`));
    const person = terminalPerson();
    return Effect.succeed({ name: definition.name, file: platformFile(terminalDir(botDir(id))), place: `dm-${person}`, person, address: `${channel.id}:@${person}` });
  });

type Terminal = Effect.Success<ReturnType<typeof terminalOf>>;

function say(terminal: Terminal, text: string): void {
  mkdirSync(dirname(terminal.file), { recursive: true });
  const line: Line = { id: `m-${randomUUID()}`, type: "message", at: Date.now(), place: terminal.place, person: terminal.person, text };
  appendFileSync(terminal.file, `${JSON.stringify(line)}\n`);
}

/** Read the lines of this DM that were added after `offset`; returns them and the new offset. */
function readFrom(terminal: Terminal, offset: number): { lines: Line[]; offset: number } {
  if (!existsSync(terminal.file) || statSync(terminal.file).size <= offset) return { lines: [], offset };
  const text = readFileSync(terminal.file).subarray(offset).toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], offset };
  const lines = text
    .slice(0, end)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Line)
    .filter((line) => line.place === terminal.place);
  return { lines, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
}

function render(terminal: Terminal, line: Line): string | undefined {
  const fromBot = line.person === "bot";
  const who = fromBot ? bold(terminal.name) : dim("you");
  if (line.type === "message") return `${who}: ${fromBot ? line.text : dim(line.text ?? "")}`;
  if (!fromBot) return undefined;
  if (line.type === "edit") return `${who} ${dim("(edited)")}: ${line.text}`;
  if (line.type === "reaction_added") return dim(`${terminal.name} reacted :${line.emoji}:`);
  if (line.type === "delete") return dim(`${terminal.name} deleted a message`);
  return undefined;
}

interface Status {
  busy: boolean;
  lastError?: { at: number; error: string };
}

/** The bot's status, or undefined when it is not running. */
const statusOf = (id: string) => Effect.runPromise(control(id, "GET", "/status").pipe(Effect.map((status) => status as Status | undefined), Effect.orElseSucceed(() => undefined)));

/** Talk until Ctrl+C or Ctrl+D. */
export const chatInteractive = (id: string) =>
  Effect.gen(function* () {
    const terminal = yield* terminalOf(id);
    const start = readFrom(terminal, 0);
    for (const line of start.lines.slice(-12)) {
      const text = render(terminal, line);
      if (text) console.log(text);
    }
    const since = Date.now();
    if ((yield* Effect.promise(() => statusOf(id))) === undefined) console.log(dim(`${terminal.name} is not running. Messages wait until it starts (pots service install, or pots start).`));
    console.log(dim(`Talking to ${terminal.name}. Ctrl+C to leave.`));
    yield* Effect.callback<void>((resume) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
      let offset = start.offset;
      let busy: boolean | undefined;
      let errorShown = since;
      const print = (text: string) => {
        process.stdout.write("\r\x1b[2K");
        console.log(text);
        rl.prompt(true);
      };
      const watch = setInterval(() => {
        const next = readFrom(terminal, offset);
        offset = next.offset;
        for (const line of next.lines) {
          const text = line.person === "bot" ? render(terminal, line) : undefined;
          if (text) print(text);
        }
      }, 300);
      const status = setInterval(() => {
        void statusOf(id).then((status) => {
          if (status?.busy && !busy) print(dim(`${terminal.name} is working…`));
          busy = status?.busy;
          if (status?.lastError && status.lastError.at > errorShown) {
            errorShown = status.lastError.at;
            print(`${terminal.name} could not work: ${status.lastError.error}`);
          }
        });
      }, 1_000);
      rl.on("line", (input) => {
        if (input.trim()) say(terminal, input);
        rl.prompt();
      });
      rl.on("close", () => resume(Effect.void));
      rl.prompt();
      return Effect.sync(() => {
        clearInterval(watch);
        clearInterval(status);
        rl.close();
      });
    });
  });

/** Send one message and print the bot's answers until it is done working, or until the timeout. For scripts and tests. */
const chatOnce = (id: string, text: string, timeoutMs: number) =>
  Effect.gen(function* () {
    const terminal = yield* terminalOf(id);
    let offset = readFrom(terminal, 0).offset;
    const since = Date.now();
    say(terminal, text);
    const deadline = Date.now() + timeoutMs;
    let answered = false;
    let quietSince = 0;
    while (Date.now() < deadline) {
      yield* Effect.sleep("500 millis");
      const next = readFrom(terminal, offset);
      offset = next.offset;
      for (const line of next.lines.filter((item) => item.person === "bot")) {
        const shown = render(terminal, line);
        if (shown) console.log(shown);
        if (line.type === "message") answered = true;
      }
      const status = yield* Effect.promise(() => statusOf(id));
      if (status === undefined) return yield* Effect.fail(userError(`${terminal.name} is not running; the message waits in its terminal channel`));
      if (status.lastError && status.lastError.at > since) return yield* Effect.fail(userError(`${terminal.name} could not work: ${status.lastError.error}`));
      quietSince = status.busy ? 0 : quietSince || Date.now();
      if (answered && quietSince && Date.now() - quietSince > 2_000) return;
    }
    return yield* Effect.fail(userError(answered ? `${terminal.name} is still working` : `no answer within ${timeoutMs / 1000} seconds`));
  });

export const chatCommand = Command.make(
  "chat",
  {
    bot: Flag.String("bot").pipe(Flag.optional, Flag.withDescription("Which bot. Default: the only bot.")),
    message: Flag.String("message").pipe(Flag.withAlias("m"), Flag.optional, Flag.withDescription("Send this, print the answer and leave.")),
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(600), Flag.withDescription("With --message: seconds to wait for the answer.")),
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      if (Option.isSome(input.message)) return yield* chatOnce(id, input.message.value, input.timeout * 1000);
      yield* chatInteractive(id);
    }),
).pipe(Command.withDescription("Talk to a bot in this terminal."));
