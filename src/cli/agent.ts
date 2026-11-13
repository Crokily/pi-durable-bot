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
    from: Flag.String("from").pipe(
      Flag.optional,
      Flag.withDescription("Where the wake comes from: a short name of the script or command that sets it. Default: $POTS_FROM."),
    ),
    id: Flag.String("id").pipe(Flag.optional, Flag.withDescription("A wake ID. A second wake with the same ID gives back the first and sets none.")),
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
      const from = Option.getOrUndefined(input.from) ?? process.env.POTS_FROM;
      const body = { at, note: input.note, ...(from ? { from } : {}), ...(Option.isSome(input.id) ? { id: input.id.value } : {}) };
      yield* printResult(yield* control(id, "POST", "/wake", body));
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

const children = Command.make(
  "children",
  {
    stop: Flag.String("stop").pipe(Flag.optional, Flag.withDescription("Stop the child with this ID, and what it runs.")),
    all: Flag.Boolean("stop-all").pipe(Flag.withDefault(false), Flag.withDescription("Stop every child.")),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      if (input.all) return yield* printResult(yield* control(id, "POST", "/children/stop", { all: true }));
      if (Option.isSome(input.stop)) return yield* printResult(yield* control(id, "POST", "/children/stop", { id: input.stop.value }));
      const result = (yield* control(id, "GET", "/children")) as { text: string };
      yield* printResult(result.text);
    }),
).pipe(Command.withDescription("List the children the bot's main agent started, with each one's thinking level, the model it chose for it, and what each one that works does now, or stop one or all. A stopped child reports nothing."));

const routineAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription('A short name: letters, digits, "-" and "_". A routine with this name is replaced.')),
    every: Flag.String("every").pipe(Flag.optional, Flag.withDescription("Repeat this often: 90s, 30m, 2h, 1d. The first time is one interval from now.")),
    cron: Flag.String("cron").pipe(Flag.optional, Flag.withDescription('A cron expression in this computer\'s time zone, for example "0 9 * * 1-5".')),
    note: Flag.String("note").pipe(Flag.optional, Flag.withDescription("Wake the bot with this note.")),
    run: Flag.String("run").pipe(
      Flag.optional,
      Flag.withDescription("Run this command in the bot's shell, with POTS_FROM set to the routine's name. It decides itself whether to wake the bot."),
    ),
    timeout: Flag.String("timeout").pipe(Flag.optional, Flag.withDescription("For --run: stop the command and what it started after this long. Default: 10m.")),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const body: Record<string, unknown> = { name: input.name };
      if (Option.isSome(input.every)) body.every = yield* duration(input.every.value);
      if (Option.isSome(input.cron)) body.cron = input.cron.value;
      if (Option.isSome(input.note)) body.note = input.note.value;
      if (Option.isSome(input.run)) body.run = input.run.value;
      if (Option.isSome(input.timeout)) body.timeout = yield* duration(input.timeout.value);
      yield* printResult(yield* control(id, "POST", "/routines/add", body));
    }),
).pipe(Command.withDescription("Add a routine: a note that wakes the bot, or a command that runs, at each time of its schedule."));

const routineList = Command.make("list", { bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    const result = (yield* control(id, "GET", "/routines")) as { text: string };
    yield* printResult(result.text);
  }),
).pipe(Command.withDescription("List the routines, with each one's next time and last run, and the fallback check-in."));

const routineRemove = Command.make("remove", { name: Argument.String("name"), bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "POST", "/routines/remove", { name: input.name }));
  }),
).pipe(Command.withDescription("Remove a routine. A command of it that runs now goes on until it ends."));

const routine = Command.make("routine").pipe(
  Command.withDescription("Repeating work: a note that wakes the bot, or a command that runs, on a schedule."),
  Command.withSubcommands([routineAdd, routineList, routineRemove]),
);

const formAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription('A short name: letters, digits, "-" and "_". A form with this name is replaced.')),
    form: Argument.String("form").pipe(
      Argument.withDescription('The form as JSON, or "-" to read it from standard input: a Slack view of type modal, or a Discord modal\'s data (title, components).'),
    ),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const form = yield* Effect.try({ try: () => JSON.parse(textOrStdin(input.form)) as unknown, catch: () => userError("the form must be JSON") });
      yield* printResult(yield* control(id, "POST", "/forms/add", { name: input.name, form }));
    }),
).pipe(Command.withDescription("Store a form. A button whose ID is form:<name> or form:<name>:<extra> opens it at once; the submission wakes the bot."));

const formList = Command.make("list", { bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    const result = (yield* control(id, "GET", "/forms")) as { text: string };
    yield* printResult(result.text);
  }),
).pipe(Command.withDescription("List the stored forms."));

const formRemove = Command.make("remove", { name: Argument.String("name"), bot }, (input) =>
  Effect.gen(function* () {
    const id = yield* resolveBot(input.bot);
    yield* printResult(yield* control(id, "POST", "/forms/remove", { name: input.name }));
  }),
).pipe(Command.withDescription("Remove a form. A button for it then acts as any other button."));

const form = Command.make("form").pipe(
  Command.withDescription("Forms (Slack and Discord) that a button opens at once, in the platform's own format."),
  Command.withSubcommands([formAdd, formList, formRemove]),
);

export const agentCommands = [send, react, call, wake, routine, form, context, turnPage, children] as const;

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
