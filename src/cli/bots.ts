import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Console, Effect, Option, Schedule } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { BOT_ID, DEFAULT_JUDGE, DEFAULT_MODEL } from "../bot/definition.ts";
import { terminalPerson } from "../channels/terminal/index.ts";
import { BOTS_DIR, runningGateway } from "../core/home.ts";
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

/** The name in a bot's bot.json, or its ID when the file has none or cannot be read. */
function nameOf(id: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(botDir(id), "bot.json"), "utf8")) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name : id;
  } catch {
    return id;
  }
}

/**
 * Who makes a new bot: another bot of this computer, when the command runs in its shell ($POTS_BOT), or else the
 * person at this computer, in a terminal or through an AI agent that works for them.
 */
export type Maker = { bot: string; name: string } | { person: string; command: "pots init" | "pots bot new" };

export function makerOf(command: "pots init" | "pots bot new"): Maker {
  const id = process.env.POTS_BOT;
  if (id && BOT_ID.test(id) && existsSync(join(botDir(id), "bot.json"))) return { bot: id, name: nameOf(id) };
  return { person: userInfo().username, command };
}

/** What a new bot is told at its first start: who made it and where they are, then what to set up. */
export function firstWake(bot: { id: string; about?: string }, maker: Maker, others: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const address = `terminal:@${terminalPerson()}`;
  const lines: string[] = [];
  let them: string;
  let subject: string;
  if ("bot" in maker) {
    them = "that person";
    subject = maker.name;
    lines.push(
      `This is your first start. ${maker.name}, the bot whose folder is ${botDir(maker.bot)}, created you with pots bot new, most likely because a person asked it to in a chat app. That person does not see your terminal channel (${address}). Until you join a chat app, ${maker.name} passes messages both ways: it writes to you there with pots chat, says who asked for you and where, and passes on what you send there when it next writes to you. When something you send cannot wait, such as a step only that person can do, also wake ${maker.name}: pots wake --bot ${maker.bot} --from ${bot.id} --note "<what to pass on>".`,
    );
  } else if (maker.command === "pots init") {
    them = maker.person;
    subject = "They";
    lines.push(`This is your first start. ${maker.person} just created you with pots init on this computer and is waiting in their terminal: ${address}. You talk there until you join other chat apps.`);
  } else {
    them = maker.person;
    subject = "They";
    lines.push(
      `This is your first start. ${maker.person} just created you with pots bot new on this computer, in a terminal or through an AI agent that works for them. They talk with you in your terminal channel (${address}) with pots chat --bot ${bot.id} until you join other chat apps; what you send there waits until they open it.`,
    );
  }
  lines.push(
    bot.about
      ? `${subject} described you in one sentence: "${bot.about}". Write your AGENTS.md and responsibilities.md from it, and refine them as you learn more.`
      : `${subject} did not say what you are for yet. Ask ${"bot" in maker ? `that person, through ${maker.name}` : "them"}, then write your AGENTS.md and responsibilities.md.`,
  );
  lines.push(
    `${"bot" in maker ? `Say hello in your terminal channel; ${maker.name} passes it on` : "Say hello there"}. Then check that you can see and use this computer's screen. If something that only ${them} can do stands in the way, such as a permission the system asks for, help them do it now, step by step. If there is no desktop, tell them, and work without one until you need a screen.`,
  );
  if (others.length > 0) {
    lines.push(
      [
        `Other bots already work on this computer: ${others.map((id) => `${nameOf(id)} (${id})`).join(", ")}, with their folders in ${BOTS_DIR}. Only one agent can use a screen at a time, also across bots, so bots that share a screen wait for each other: a screen per bot works best. A bot whose bot.json has no screen setting uses the gateway's screen, as you do now.`,
        platform === "darwin" || platform === "win32"
          ? `On ${platform === "darwin" ? "a Mac" : "Windows"} a second screen of your own is not practical: a user has one desktop there, so bots take turns on it. If another bot already uses it, tell ${them} so.`
          : `If another bot already uses the screen you would use, ask ${them} whether you should set up a screen of your own, and recommend it: a virtual desktop such as TigerVNC's Xvnc, with a window manager and a browser of your own (the desktop-page skill says how). Say what it costs: each screen with its own browser takes about 0.5–1 GB of memory, and when no virtual display server such as Xvnc is installed yet (check first), the packages need sudo and a one-time install.`,
      ].join(" "),
    );
  }
  lines.push(
    `Then find out which chat apps you should work in, for example Slack, and connect them yourself with this computer${others.length > 0 ? ", as an app of your own with a token file of your own: the other bots' are theirs" : ""}. Ask ${them} only for what you cannot do yourself, such as signing in or approving an install.`,
  );
  lines.push(
    `Also ask ${them} whether they want particular models for particular work. You do longer work in children and choose each child's model when you start it; without a choice, it has your model. Write what they say in your AGENTS.md.`,
  );
  return lines.join("\n");
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

/** Wait until the new bot answers on its control endpoint. */
export const waitForBot = (id: string) =>
  control(id, "GET", "/status").pipe(
    Effect.retry({ times: 90, schedule: Schedule.spaced("1 second") }),
    Effect.mapError(() => userError(`${id} did not start within 90 seconds; see pots service logs`)),
  );

const create = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(Argument.withDescription("What people call it.")),
    id: Flag.String("id").pipe(Flag.optional, Flag.withDescription("The folder name. Default: from the name.")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_MODEL), Flag.withDescription('Any pi model as "provider/modelId".')),
    judge: Flag.String("judge").pipe(Flag.withDefault(DEFAULT_JUDGE), Flag.withDescription('"off" (every message comes to the bot), a classifier "provider/modelId", or "main" (the bot\'s own model judges).')),
    about: Flag.String("about").pipe(Flag.optional, Flag.withDescription("One sentence: what this bot is for.")),
  },
  (input) =>
    Effect.gen(function* () {
      const id = Option.getOrElse(input.id, () => idFor(input.name));
      const about = Option.getOrUndefined(input.about);
      const others = listBots().filter((other) => other !== id);
      const dir = yield* createBot({
        id,
        name: input.name,
        model: input.model,
        judge: input.judge,
        ...(about ? { about } : {}),
        firstWake: firstWake({ id, ...(about ? { about } : {}) }, makerOf("pots bot new"), others),
      });
      // So that pots chat --bot <id> right after finds it running.
      if (runningGateway() !== undefined) yield* waitForBot(id);
      yield* Console.log(dir);
    }),
).pipe(
  Command.withDescription(
    "Create another bot. When the gateway runs, it waits until the gateway has started it. At its first start the bot says hello in its terminal channel and sets itself up, as after pots init.",
  ),
);

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
