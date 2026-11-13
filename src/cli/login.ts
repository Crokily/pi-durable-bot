import type { Models } from "@earendil-works/pi-ai";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { signIn, usable } from "./ai.ts";
import { userError } from "./control.ts";

// pots login: sign in with subscriptions, or add API keys (also TypeSafe's, for the Jev judge) or local servers, one
// after another, for pi and every bot on this computer. It is the one step of a setup that only the person can do: an
// AI agent that sets Pots up asks them to run it once for all they need, then does the rest with pots init --yes and
// the model it names.

/** The models and judges pi can use on this computer, as --list prints them; none, and it says so. */
const listUsable = (models: Models, none: string) =>
  Effect.gen(function* () {
    const found = yield* usable(models);
    if (found.models.length === 0 && found.judges.length === 0) return yield* Console.log(none);
    if (found.models.length > 0) yield* Console.log(`Models (for --model):\n${found.models.map((id) => `  ${id}`).join("\n")}`);
    if (found.judges.length > 0) yield* Console.log(`Judges (for --judge):\n${found.judges.map((id) => `  ${id}`).join("\n")}`);
  });

export const loginCommand = Command.make(
  "login",
  {
    list: Flag.Boolean("list").pipe(Flag.withDefault(false), Flag.withDescription("Only list the models and judges pi can use on this computer, without signing in.")),
  },
  (input) =>
    Effect.gen(function* () {
      const models = yield* Effect.promise(async () => (await import("../agent/models.ts")).openModels());
      if (input.list) return yield* listUsable(models, "pi can use no model on this computer yet. Run pots login in a terminal to sign in or add a key.");
      if (process.stdin.isTTY !== true) {
        return yield* Effect.fail(userError("pots login asks questions, so it needs a terminal: run it in your own terminal. pots login --list works anywhere."));
      }
      yield* signIn(models);
      yield* Console.log("");
      yield* listUsable(models, "pi can use no model on this computer yet.");
    }),
).pipe(Command.withDescription("Sign in with subscriptions, or add API keys or local model servers, for every bot on this computer."));
