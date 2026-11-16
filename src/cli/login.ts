import type { Models } from "@earendil-works/pi-ai";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { signIn, usable } from "./ai.ts";
import { userError } from "./control.ts";

// pots login: sign in with subscriptions, or add API keys (also TypeSafe's, for the Jev judge) or local servers, one
// after another, for pi and every bot on this computer. It is the one step of a setup that only the person can do: an
// AI agent that sets Pots up asks them to run it once for all they need, then does the rest with pots init --yes and
// the model it names. With --link, the person does it on Pots' login page instead, from any device.

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
    link: Flag.Boolean("link").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Print a link to Pots' login page instead of asking here: someone signs in from any device, with a subscription or an API key. It needs no terminal and no bot that runs: Pots serves the page until they press Done or the link ends, then prints what was signed in.",
      ),
    ),
    provider: Flag.String("provider").pipe(Flag.optional, Flag.withDescription("With --link: the provider to sign in to, as pi names it. Default: the person chooses.")),
    text: Flag.String("text").pipe(Flag.optional, Flag.withDescription("With --link: what the page says to the person.")),
  },
  (input) =>
    Effect.gen(function* () {
      const models = yield* Effect.promise(async () => (await import("../agent/models.ts")).openModels());
      if (input.list) return yield* listUsable(models, "pi can use no model on this computer yet. Run pots login in a terminal to sign in or add a key.");
      if (input.link) {
        const { loginLink } = yield* Effect.promise(() => import("./login-link.ts"));
        // Ctrl+C ends the link, and the command ends only when its page server, tunnel and folder are gone.
        yield* Effect.suspend(() => {
          const stop = new AbortController();
          const running = loginLink(models, {
            ...(Option.isSome(input.provider) ? { provider: input.provider.value } : {}),
            ...(Option.isSome(input.text) ? { text: input.text.value } : {}),
            say: (line) => console.log(line),
            signal: stop.signal,
          });
          return Effect.tryPromise({ try: () => running, catch: (error) => userError(error instanceof Error ? error.message : String(error)) }).pipe(
            Effect.onInterrupt(() =>
              Effect.promise(async () => {
                stop.abort();
                await running.catch(() => {});
              }),
            ),
          );
        });
        yield* Console.log("");
        return yield* listUsable(models, "pi can use no model on this computer yet.");
      }
      if (process.stdin.isTTY !== true) {
        return yield* Effect.fail(userError("pots login asks questions, so it needs a terminal: run it in your own terminal. pots login --list works anywhere."));
      }
      yield* signIn(models);
      yield* Console.log("");
      yield* listUsable(models, "pi can use no model on this computer yet.");
    }),
).pipe(Command.withDescription("Sign in with subscriptions, or add API keys or local model servers, for every bot on this computer."));
