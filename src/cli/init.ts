import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Console, Effect, Option, Schedule } from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { terminalPerson } from "../channels/terminal/index.ts";
import { runningGateway } from "../core/home.ts";
import { setUpModel } from "./ai.ts";
import { createBot, idFor } from "./bots.ts";
import { chatInteractive } from "./chat.ts";
import { control, listBots, userError } from "./control.ts";
import { Service } from "./service.ts";

// pots init: 1 create your first bot, 2 give it an AI, 3 say in one sentence what it is for (optional), 4 talk to it in
// this terminal. Everything else, such as joining chat apps, the bot does itself on this computer, asking only for
// what it cannot do, like signing in.

const step = (n: number, title: string) => Console.log(`\n${n}  ${title}`);

/** pi runs bash commands; on Windows that is Git Bash. */
function gitBashMissing(): boolean {
  if (process.platform !== "win32") return false;
  const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((dir) => join(dir!, "Git", "bin", "bash.exe"));
  return !candidates.some((file) => existsSync(file)) && !(process.env.PATH ?? "").split(";").some((dir) => existsSync(join(dir, "bash.exe")));
}

function firstWake(user: string, address: string, about: string | undefined): string {
  return [
    `This is your first start. ${user} just created you with pots init on this computer and is waiting in their terminal: ${address}. You talk there until you join other chat apps.`,
    about
      ? `They described you in one sentence: "${about}". Write persona.md and responsibilities.md from it, and refine them as you learn more.`
      : "They did not say what you are for yet. Ask them, then write persona.md and responsibilities.md.",
    `Say hello there. Then check that you can see and use this computer's screen. If something that only ${user} can do stands in the way, such as a permission the system asks for, help them do it now, step by step. If there is no desktop, tell them, and work without one.`,
    `Then find out which chat apps you should work in, for example Slack, and connect them yourself with this computer. Ask ${user} only for what you cannot do yourself, such as signing in or approving an install.`,
  ].join("\n");
}

/** Wait until the new bot answers on its control endpoint. */
const waitForBot = (id: string) =>
  control(id, "GET", "/status").pipe(
    Effect.retry({ times: 90, schedule: Schedule.spaced("1 second") }),
    Effect.mapError(() => userError(`${id} did not start within 90 seconds; see pots service logs`)),
  );

export const initCommand = Command.make(
  "init",
  {
    name: Flag.String("name").pipe(Flag.optional, Flag.withDescription("The bot's name. Asked when not given.")),
    model: Flag.String("model").pipe(Flag.optional, Flag.withDescription('The model as "provider/modelId". Asked when not given.')),
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
      const model = Option.isSome(input.model)
        ? input.model.value
        : interactive
          ? yield* Effect.flatMap(
              Effect.promise(async () => (await import("../agent/models.ts")).openModels()),
              setUpModel,
            )
          : yield* Effect.fail(userError("pass --model"));

      yield* step(3, `In one sentence, what is ${name} for? (optional)`);
      const about = Option.isSome(input.about)
        ? input.about.value
        : interactive
          ? (yield* Prompt.run(Prompt.String({ message: "For example: our team's research and ops assistant, calm and direct", default: "" }))).trim()
          : "";

      const address = `terminal:@${terminalPerson()}`;
      const dir = yield* createBot({ id, name, model, ...(about ? { about } : {}), firstWake: firstWake(user, address, about || undefined) });
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

      yield* step(4, `Talk to ${name}`);
      yield* Console.log(`${name} first checks that it can use this computer's screen and helps you with any permission it needs. Then it sets up the chat apps you want, and asks you only for what it cannot do itself.`);
      yield* Console.log(`Leave with Ctrl+C; come back any time with pots chat. ${name} keeps working when you leave.`);
      if (!input.noChat && interactive) yield* chatInteractive(id);
    }),
).pipe(Command.withDescription("Set up your first bot (or another one) on this computer."));
