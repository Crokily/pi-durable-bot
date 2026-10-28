import { readFileSync } from "node:fs";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { control, printResult, resolveBot, userError } from "./control.ts";

// The channel actions and the bot's own controls, for the agent's shell, its scripts and scheduled jobs, and people.

const bot = Flag.String("bot").pipe(Flag.optional, Flag.withDescription("Which bot. Default: $POTS_BOT, or the only bot."));

/** "-" reads standard input. */
const textOrStdin = (value: string) => (value === "-" ? readFileSync(0, "utf8") : value);

const send = Command.make(
  "send",
  {
    to: Argument.String("address").pipe(Argument.withDescription("A place, thread, message (reply in its thread) or person (DM).")),
    text: Argument.String("text").pipe(Argument.withDescription('The text, or "-" to read it from standard input.')),
    id: Flag.String("id").pipe(Flag.optional, Flag.withDescription("A send ID. A message with the same ID is sent only once.")),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const body = { to: input.to, text: textOrStdin(input.text), ...(Option.isSome(input.id) ? { id: input.id.value } : {}) };
      yield* printResult(yield* control(id, "POST", "/send", body));
    }),
).pipe(Command.withDescription("Send a message."));

const react = Command.make(
  "react",
  {
    message: Argument.String("message").pipe(Argument.withDescription("A message address.")),
    emoji: Argument.String("emoji"),
    remove: Flag.Boolean("remove").pipe(Flag.withDefault(false)),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      yield* printResult(yield* control(id, "POST", "/react", { message: input.message, emoji: input.emoji, remove: input.remove }));
    }),
).pipe(Command.withDescription("Add or remove a reaction."));

const call = Command.make(
  "call",
  {
    channel: Argument.String("channel").pipe(Argument.withDescription("A channel account ID from bot.json, for example slack.")),
    method: Argument.String("method").pipe(Argument.withDescription("A platform API method.")),
    params: Argument.String("params").pipe(Argument.withDescription('JSON params, or "-" to read them from standard input.'), Argument.optional),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const params = yield* Effect.try({
        try: () => (Option.isSome(input.params) ? JSON.parse(textOrStdin(input.params.value)) : {}),
        catch: () => userError("params must be JSON"),
      });
      yield* printResult(yield* control(id, "POST", "/call", { channel: input.channel, method: input.method, params }));
    }),
).pipe(Command.withDescription("Call a platform API method. The token stays in the gateway."));

const wake = Command.make(
  "wake",
  {
    in: Flag.String("in").pipe(Flag.optional, Flag.withDescription("After this long: 90s, 30m, 2h, 1d.")),
    at: Flag.String("at").pipe(Flag.optional, Flag.withDescription('At this local time, for example "2026-10-28 09:00", or Unix ms.')),
    note: Flag.String("note").pipe(Flag.withDefault(""), Flag.withDescription("What the wake is for.")),
    list: Flag.Boolean("list").pipe(Flag.withDefault(false), Flag.withDescription("List the pending wakes.")),
    cancel: Flag.Int("cancel").pipe(Flag.optional, Flag.withDescription("Cancel the pending wake with this ID.")),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      if (input.list) return yield* printResult(yield* control(id, "GET", "/wakes"));
      if (Option.isSome(input.cancel)) return yield* printResult(yield* control(id, "POST", "/wakes/cancel", { id: input.cancel.value }));
      const at = Option.isSome(input.in) ? Date.now() + (yield* duration(input.in.value)) : Option.isSome(input.at) ? yield* time(input.at.value) : Date.now();
      yield* printResult(yield* control(id, "POST", "/wake", { at, note: input.note }));
    }),
).pipe(Command.withDescription("Set a timed wake. With no time, the bot is woken now."));

const context = Command.make("context", { bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "GET", "/context"));
  }),
).pipe(Command.withDescription("How much of the context window the conversation uses."));

const turnPage = Command.make("turn-page", { note: Flag.String("note").pipe(Flag.withDescription("A message to yourself in the new context.")), bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "POST", "/turn-page", { note: input.note }));
  }),
).pipe(Command.withDescription("Start a fresh context. Write notes.md first."));

export const agentCommands = [send, react, call, wake, context, turnPage] as const;

function duration(text: string) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  if (!match) return Effect.fail(userError(`bad duration ${JSON.stringify(text)}; use for example 90s, 30m, 2h or 1d`));
  return Effect.succeed(Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"]);
}

function time(text: string) {
  const value = /^\d{12,}$/.test(text) ? Number(text) : Date.parse(text.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T"));
  if (!Number.isFinite(value)) return Effect.fail(userError(`bad time ${JSON.stringify(text)}; use for example "2026-10-28 09:00" (local time) or Unix ms`));
  return Effect.succeed(value);
}
