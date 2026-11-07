import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { signIn, usable } from "./ai.ts";
import { userError } from "./control.ts";

// pots login: sign in with a subscription, or add an API key (also TypeSafe's, for the Jev judge) or a local server, for
// pi and every bot on this computer. It is the one step of a setup that only the person can do: an AI agent that sets
// Pots up asks them to run it, then does the rest with pots init --yes and the model it names.

export const loginCommand = Command.make(
  "login",
  {
    list: Flag.Boolean("list").pipe(Flag.withDefault(false), Flag.withDescription("Only list the models and judges pi can use on this computer, without signing in.")),
  },
  (input) =>
    Effect.gen(function* () {
      const models = yield* Effect.promise(async () => (await import("../agent/models.ts")).openModels());
      if (input.list) {
        const found = yield* usable(models);
        if (found.models.length === 0 && found.judges.length === 0) {
          yield* Console.log("pi can use no model on this computer yet. Run pots login in a terminal to sign in or add a key.");
          return;
        }
        if (found.models.length > 0) yield* Console.log(`Models (for --model):\n${found.models.map((id) => `  ${id}`).join("\n")}`);
        if (found.judges.length > 0) yield* Console.log(`Judges (for --judge):\n${found.judges.map((id) => `  ${id}`).join("\n")}`);
        return;
      }
      if (process.stdin.isTTY !== true) {
        return yield* Effect.fail(userError("pots login asks questions, so it needs a terminal: run it in your own terminal. pots login --list works anywhere."));
      }
      const result = yield* signIn(models);
      if ("model" in result) {
        yield* Console.log(`\nReady: ${result.model}. A new bot can think with it: pots init --model ${result.model}`);
      } else if (result.judges.length > 0) {
        yield* Console.log(`\nReady as a judge: ${result.judges.join(", ")}. A new bot can use it: pots init --judge ${result.judges[0]}`);
      } else {
        return yield* Effect.fail(userError("signed in, but pi lists no model or judge for this login"));
      }
    }),
).pipe(Command.withDescription("Sign in with a subscription, or add an API key or a local model server, for every bot on this computer."));
