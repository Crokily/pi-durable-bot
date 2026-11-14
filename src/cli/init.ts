import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { runningGateway } from "../core/home.ts";
import { checkJudge, checkModel, setUpJudge, setUpModel } from "./ai.ts";
import { createBot, firstWake, idFor, makerOf, waitForBot } from "./bots.ts";
import { chatInteractive } from "./chat.ts";
import { listBots, userError } from "./control.ts";
import { Service } from "./service.ts";

// pots init: 1 create your first bot, 2 give it an AI, 3 choose who decides on group messages that do not mention it
// (the bot itself by default), 4 say in one sentence what it is for (optional), 5 talk to it in this terminal.
// Everything else, such as joining chat apps, the bot does itself on this computer, asking only for what it cannot do,
// like signing in.

const step = (n: number, title: string) => Console.log(`\n${n}  ${title}`);

/** pi runs bash commands; on Windows that is Git Bash. */
function gitBashMissing(): boolean {
  if (process.platform !== "win32") return false;
  const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((dir) => join(dir!, "Git", "bin", "bash.exe"));
  return !candidates.some((file) => existsSync(file)) && !(process.env.PATH ?? "").split(";").some((dir) => existsSync(join(dir, "bash.exe")));
}

export const initCommand = Command.make(
  "init",
  {
    name: Flag.String("name").pipe(Flag.optional, Flag.withDescription("The bot's name. Asked when not given.")),
    model: Flag.String("model").pipe(Flag.optional, Flag.withDescription('The model as "provider/modelId". Asked when not given.')),
    judge: Flag.String("judge").pipe(
      Flag.optional,
      Flag.withDescription(
        'Who decides whether a group message that does not mention the bot wakes it: "off" (the bot itself), "main" (its own model) or a judge model "provider/modelId", such as typesafe/jev-latest. Asked when not given; "off" when there is no terminal to ask in.',
      ),
    ),
    about: Flag.String("about").pipe(Flag.optional, Flag.withDescription("One sentence: what the bot is for.")),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Accept that the bot gets full control of this computer.")),
    noService: Flag.Boolean("no-service").pipe(Flag.withDefault(false), Flag.withDescription("Do not install the background service; run pots start yourself.")),
    noChat: Flag.Boolean("no-chat").pipe(Flag.withDefault(false), Flag.withDescription("Do not open the chat at the end.")),
    system: Flag.Boolean("system").pipe(Flag.withDefault(false), Flag.withDescription("Linux: install a system service (needs sudo) instead of a user service.")),
  },
  (input) =>
    Effect.gen(function* () {
      const interactive = process.stdin.isTTY === true;
      const ask = <A>(prompt: Prompt.Prompt<A>, missing: string) => (interactive ? Prompt.run(prompt) : Effect.fail(userError(`${missing} (no terminal to ask in)`)));
      const user = userInfo().username;

      yield* Console.log("Pots: an AI coworker that lives on this computer.");
      if (gitBashMissing()) return yield* Effect.fail(userError("Pots runs bash commands with Git Bash on Windows. Install Git for Windows (https://git-scm.com/download/win), then run pots init again."));
      if (!input.yes) {
        const accepted = yield* ask(
          Prompt.Confirm({
            message: `Your bot gets full control of this computer as ${user}: it runs commands, installs software and uses the screen, mouse and keyboard, with no approval step. A computer or VM of its own is best. Continue?`,
            initial: false,
          }),
          "pass --yes to accept that the bot gets full control of this computer",
        );
        if (!accepted) return;
      }
      const others = listBots();
      if (others.length > 0) yield* Console.log(`You already have ${others.length === 1 ? "a bot" : `${others.length} bots`} (${others.join(", ")}). This creates another one.`);

      yield* step(1, "Create your bot");
      const name = Option.isSome(input.name) ? input.name.value : yield* ask(Prompt.String({ message: "What is its name?", default: "Pots" }), "pass --name");
      const id = idFor(name);

      yield* step(2, `Give ${name} an AI`);
      const given = Option.getOrUndefined(input.model);
      if (given === undefined && !interactive) return yield* Effect.fail(userError("pass --model"));
      const models = yield* Effect.promise(async () => (await import("../agent/models.ts")).openModels());
      const model = given === undefined ? yield* setUpModel(models) : yield* checkModel(models, given);

      yield* step(3, `Group messages that do not mention ${name}`);
      const judge = Option.isSome(input.judge) ? yield* checkJudge(models, input.judge.value, model) : interactive ? yield* setUpJudge(models, name, model) : "off";

      yield* step(4, `In one sentence, what is ${name} for? (optional)`);
      const about = Option.isSome(input.about)
        ? input.about.value
        : interactive
          ? (yield* Prompt.run(Prompt.String({ message: "For example: our team's research and ops assistant, calm and direct", default: "" }))).trim()
          : "";

      const dir = yield* createBot({ id, name, model, judge, ...(about ? { about } : {}), firstWake: firstWake({ id, ...(about ? { about } : {}) }, makerOf("pots init"), others) });
      yield* Console.log(`Created ${dir}`);

      if (input.noService) {
        yield* Console.log(`\nStart the gateway with pots start; ${name} says hello in its terminal channel. Talk to it with pots chat.`);
        return;
      }
      const service = yield* Service;
      if (runningGateway() !== undefined) {
        yield* Console.log(`The gateway is running; it starts ${name} within a few seconds.`);
      } else if (service.installed()) {
        yield* Console.log(`Starting the gateway (${service.kind}).`);
        yield* service.restart();
      } else {
        yield* Console.log(`Starting the gateway as a background service (${service.kind}). It starts again at login.`);
        yield* service.install({ system: input.system });
      }
      yield* waitForBot(id);

      yield* step(5, `Talk to ${name}`);
      yield* Console.log(`${name} first checks that it can use this computer's screen and helps you with any permission it needs. Then it sets up the chat apps you want, and asks you only for what it cannot do itself.`);
      yield* Console.log(`Leave with Ctrl+C; come back any time with pots chat. ${name} keeps working when you leave.`);
      if (!input.noChat && interactive) yield* chatInteractive(id);
    }),
).pipe(Command.withDescription("Set up your first bot (or another one) on this computer."));
