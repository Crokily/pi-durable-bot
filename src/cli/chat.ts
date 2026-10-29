import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { type SecretRequest, secretRequest, terminalDir, terminalPerson } from "../channels/terminal/index.ts";
import { platformFile } from "../channels/test/index.ts";
import { writeSecrets } from "../core/env-file.ts";
import { SECRETS_DIR } from "../core/home.ts";
import { botDir, control, resolveBot, userError } from "./control.ts";

// pots chat: talk to a bot in this terminal. What you type goes into its terminal channel; what it sends there shows up
// here. The channel is a file, so messages wait while the bot is not running. When the bot asks for secrets, such as a
// chat app's tokens, they are typed here without being shown and go straight to the secrets folder.

interface Line {
  id: string;
  type: string;
  at: number;
  place: string;
  person: string;
  text?: string;
  emoji?: string;
  /** A bot message that asks for secrets. */
  secret?: SecretRequest;
  /** The id of the request for secrets that this message answers. */
  answers?: string;
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

function say(terminal: Terminal, text: string, answers?: string): void {
  mkdirSync(dirname(terminal.file), { recursive: true });
  const line: Line = { id: `m-${randomUUID()}`, type: "message", at: Date.now(), place: terminal.place, person: terminal.person, text, ...(answers ? { answers } : {}) };
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

/** The requests for secrets in these lines that no line answers yet. */
function unanswered(lines: Line[]): Line[] {
  const answered = new Set(lines.map((line) => line.answers));
  return lines.filter((line) => line.person === "bot" && line.secret && !answered.has(line.id));
}

/** Write what the person typed for a request to its file in the secrets folder, and tell the bot which keys came. */
function answerSecret(terminal: Terminal, request: Line, values: Record<string, string>): string {
  const { file, keys } = secretRequest({ ...request.secret });
  const path = join(SECRETS_DIR, file);
  const given = keys.filter((key) => values[key]);
  const skipped = keys.filter((key) => !values[key]);
  if (given.length > 0) writeSecrets(path, Object.fromEntries(given.map((key) => [key, values[key]!])));
  const text = [given.length > 0 ? `wrote ${given.join(", ")} to ${path}` : "", skipped.length > 0 ? `skipped ${skipped.join(", ")}` : ""].filter(Boolean).join("; ");
  say(terminal, `(pots chat: ${text})`, request.id);
  return text;
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
      // One readline at a time: the chat's, or a fresh one for each request for secrets, with its echo muted and no
      // history. A secret never shares the chat's half-typed text, its history or its deleted text (Ctrl+U, then Ctrl+Y).
      const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
      Object.defineProperty(muted, "columns", { get: () => process.stdout.columns });
      let replacing = false;
      const onClose = () => {
        if (!replacing) resume(Effect.void);
      };
      const chatLine = (typed = "") => {
        const next = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
        next.on("line", onChat).on("close", onClose);
        next.prompt();
        if (typed) next.write(typed);
        return next;
      };
      const secretLine = () =>
        createInterface({ input: process.stdin, output: muted, terminal: process.stdin.isTTY === true, historySize: 0 })
          .on("line", onSecret)
          .on("close", onClose);
      const replace = (make: () => Interface) => {
        replacing = true;
        rl.close();
        replacing = false;
        rl = make();
      };
      let offset = start.offset;
      let busy: boolean | undefined;
      let errorShown = since;
      const pending = unanswered(start.lines);
      let asking: { request: Line; keys: string[]; values: Record<string, string>; typed: string } | undefined;
      const showPrompt = () => {
        if (asking) process.stdout.write(`${asking.keys[0]}: `);
        else rl.prompt(true);
      };
      const print = (text: string) => {
        process.stdout.write("\r\x1b[2K");
        console.log(text);
        showPrompt();
      };
      const askNext = () => {
        const request = pending.shift();
        if (!request?.secret) return;
        asking = { request, keys: [...request.secret.keys], values: {}, typed: asking?.typed ?? rl.line };
        replace(secretLine);
        print(dim(`${terminal.name} asks for ${request.secret.keys.join(", ")}. What you type is not shown; it goes only to ${join(SECRETS_DIR, request.secret.file)}, and ${terminal.name} does not see it. An empty line skips one.`));
      };
      function onChat(input: string) {
        if (input.trim()) say(terminal, input);
        rl.prompt();
      }
      function onSecret(input: string) {
        if (!asking) return;
        process.stdout.write("\n");
        const key = asking.keys.shift()!;
        if (input.trim()) asking.values[key] = input.trim();
        if (asking.keys.length > 0) return showPrompt();
        const done = asking;
        try {
          console.log(dim(answerSecret(terminal, done.request, done.values)));
        } catch (error) {
          console.log(`Could not save it: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (pending.length > 0) return askNext();
        asking = undefined;
        replace(() => chatLine(done.typed));
      }
      let rl = chatLine();
      askNext();
      const watch = setInterval(() => {
        const next = readFrom(terminal, offset);
        offset = next.offset;
        for (const line of next.lines) {
          const text = line.person === "bot" ? render(terminal, line) : undefined;
          if (text) print(text);
        }
        pending.push(...unanswered(next.lines));
        if (!asking) askNext();
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
