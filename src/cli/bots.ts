import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { BOT_ID, DEFAULT_JUDGE, DEFAULT_MODEL } from "../bot/definition.ts";
import { BOTS_DIR } from "../core/home.ts";
import { botDir, control, listBots, userError } from "./control.ts";

// Bot folders: create one, list them. The running gateway starts a new folder within a few seconds.

export interface NewBot {
  id: string;
  name: string;
  model: string;
  judge?: string;
  /** The one-sentence definition from pots init. The bot turns it into its AGENTS.md and responsibilities. */
  about?: string;
  /** What the bot is told when it starts for the first time. */
  firstWake?: string;
}

/** A free bot ID from a name: "Pots" → "pots", a second "Pots" → "pots-2". */
export function idFor(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "") || "bot";
  let id = base;
  for (let n = 2; existsSync(join(BOTS_DIR, id)); n++) id = `${base}-${n}`;
  return id;
}

export const createBot = (bot: NewBot) =>
  Effect.suspend(() => {
    if (!BOT_ID.test(bot.id)) return Effect.fail(userError(`bad bot ID ${JSON.stringify(bot.id)}: use lowercase letters, digits, "_" and "-"`));
    const dir = botDir(bot.id);
    if (existsSync(join(dir, "bot.json"))) return Effect.fail(userError(`${dir} already has a bot.json`));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "responsibilities.md"), bot.about ? `${bot.about}\n` : "");
    writeFileSync(join(dir, "notes.md"), "");
    if (bot.firstWake) writeFileSync(join(dir, "first-wake.md"), bot.firstWake);
    // bot.json last: the gateway starts a folder once it has one. Every bot can talk in its terminal from the start.
    const definition = { name: bot.name, model: bot.model, thinking: "medium", judge: bot.judge ?? DEFAULT_JUDGE, channels: [{ id: "terminal", type: "terminal" }] };
    writeFileSync(join(dir, "bot.json"), `${JSON.stringify(definition, null, 2)}\n`);
    return Effect.succeed(dir);
  });

const create = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(Argument.withDescription("What people call it.")),
    id: Flag.String("id").pipe(Flag.optional, Flag.withDescription("The folder name. Default: from the name.")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_MODEL), Flag.withDescription('Any pi model as "provider/modelId".')),
    judge: Flag.String("judge").pipe(Flag.withDefault(DEFAULT_JUDGE), Flag.withDescription('"main", "off", or a classifier "provider/modelId".')),
    about: Flag.String("about").pipe(Flag.optional, Flag.withDescription("One sentence: what this bot is for.")),
  },
  (input) =>
    Effect.gen(function* () {
      const dir = yield* createBot({
        id: Option.getOrElse(input.id, () => idFor(input.name)),
        name: input.name,
        model: input.model,
        judge: input.judge,
        ...(Option.isSome(input.about) ? { about: input.about.value } : {}),
      });
      yield* Console.log(dir);
    }),
).pipe(Command.withDescription("Create another bot. It starts within a few seconds when the gateway runs."));

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    for (const id of listBots()) {
      const definition = JSON.parse(readFileSync(join(botDir(id), "bot.json"), "utf8")) as { name?: string; model?: string };
      const status = yield* control(id, "GET", "/status").pipe(
        Effect.map((result) => ((result as { busy?: boolean }).busy ? "working" : "idle")),
        Effect.orElseSucceed(() => "not running"),
      );
      yield* Console.log(`${id}\t${definition.name ?? ""}\t${definition.model ?? ""}\t${status}`);
    }
  }),
).pipe(Command.withDescription("List the bots on this machine."));

export const botCommand = Command.make("bot").pipe(Command.withDescription("Create and list bots."), Command.withSubcommands([create, list]));
