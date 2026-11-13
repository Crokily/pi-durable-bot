import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, AuthEvent, AuthInteraction, AuthPrompt, AuthType, Model, Models } from "@earendil-works/pi-ai";
import { type Context, Console, Effect, Redacted, Terminal } from "effect";
import { Prompt } from "effect/cli";
import { userError } from "./control.ts";

// Step 2 of pots init, and pots login: give the bot an AI. Logins, keys and endpoints are pi's own (~/.pi/agent, or
// PI_CODING_AGENT_DIR), so the pi command line and every bot on this machine share them.

type Way = "existing" | "oauth" | "api_key" | "local" | "done";

/** What one way of getting an AI gave: a model to think with, the judges of a provider that has only judges, or why it failed. */
type Outcome = { model: string } | { judges: string[] } | { failed: string };

/**
 * Ask how the bot gets its AI, set that up, and return the chosen model as "provider/modelId". When that fails, say why
 * and ask again.
 */
export const setUpModel = (models: Models) =>
  Effect.gen(function* () {
    for (;;) {
      const ready = yield* Effect.promise(() => models.getAvailable());
      const way = yield* chooseWay("How should your bot get its AI?", ready.length, false);
      // Not offered here: the bot needs a model.
      if (way === "done") continue;
      const outcome = way === "existing" ? yield* attempt(Effect.map(chooseModel(models, ready), (model) => ({ model }))) : yield* setUpWay(models, way);
      if ("model" in outcome) return outcome.model;
      if ("judges" in outcome) yield* Console.log(`\nReady as a judge: ${outcome.judges.join(", ")}. Step 3 offers it, but the bot also needs a model to think with.\n`);
      else yield* Console.log(`\n${outcome.failed}\n`);
    }
  });

/**
 * pots login: sign in with subscriptions, add API keys or local servers, one after another, until the person chooses
 * Done. After each, say what can be used with it, or why it failed: a model, chosen and tried as pots init does, or
 * the judges of a provider that has only judges, such as TypeSafe's Jev, tried with one message.
 */
export const signIn = (models: Models) =>
  Effect.gen(function* () {
    for (let first = true; ; first = false) {
      const way = yield* chooseWay(first ? "How should your bot get its AI?" : "What next?", 0, true);
      if (way === "done") return;
      if (way === "existing") return yield* Effect.die(new Error("pots login does not offer the models pi has already"));
      const outcome = yield* setUpWay(models, way);
      if ("model" in outcome) {
        yield* Console.log(`\nReady: ${outcome.model}. A new bot can think with it: pots init --model ${outcome.model}\n`);
      } else if ("judges" in outcome) {
        yield* Console.log(`\nReady as a judge: ${outcome.judges.join(", ")}. A new bot can use it: pots init --judge ${outcome.judges[0]}\n`);
      } else {
        yield* Console.log(`\n${outcome.failed}\n`);
      }
    }
  });

/**
 * Sign in, take an API key or add a local server, and name what can be used with it: a model, chosen and tried, or the
 * judges of a provider that has only judges, the first one tried. A failure is told, not an end, and so is Ctrl+C in
 * one of its prompts: the person chooses again.
 */
const setUpWay = (models: Models, way: "oauth" | "api_key" | "local") =>
  attempt(
    Effect.gen(function* () {
      if (way === "local") return { model: yield* setUpLocal(models) };
      const providerId = yield* chooseProvider(models, way);
      const error = yield* tryLogin(models, providerId, way);
      if (error !== undefined) return { failed: `Login failed: ${error}` };
      const chat = yield* Effect.promise(() => models.getAvailable(providerId));
      if (chat.length > 0) return { model: yield* chooseModel(models, chat, yield* Effect.promise(() => piDefaultModel(providerId))) };
      const judges = (yield* Effect.promise(() => models.getAvailableOfType("classifier", providerId))).map((model) => `${model.provider}/${model.id}`);
      if (judges.length === 0) return { failed: "Signed in, but pi lists no model or judge for this login." };
      // As with a model: better to learn here than on the bot's first group message that the key is wrong.
      yield* Console.log(`Trying ${judges[0]}…`);
      const judgeError = yield* tryJudge(models, judges[0]!);
      return judgeError === undefined ? { judges } : { failed: `${judges[0]} cannot be used as the judge: ${judgeError}` };
    }),
  );

/** An outcome for each way it can end: Ctrl+C in a prompt, or an error meant for the person, is a failure with its reason. */
const attempt = <R>(setUp: Effect.Effect<Outcome, Terminal.QuitError | ReturnType<typeof userError>, R>) =>
  setUp.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed<Outcome>({ failed: "Cancelled." }),
      UserError: (error) => Effect.succeed<Outcome>({ failed: error.message }),
    }),
  );

/**
 * Ask how the bot gets its AI. ready: how many models pi can already use; none, and that choice is not offered. done:
 * offer Done, to leave.
 */
const chooseWay = (message: string, ready: number, done: boolean) =>
  Prompt.run(
    Prompt.Select<Way>({
      message,
      choices: [
        ...(ready > 0 ? [{ title: `A model you have already set up in pi (${ready})`, value: "existing" as const }] : []),
        { title: "Sign in with a subscription", value: "oauth", description: "ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more" },
        { title: "Use an API key", value: "api_key", description: "Any of pi's providers, also TypeSafe for the Jev judge" },
        { title: "A local or OpenAI-compatible server", value: "local", description: "Ollama, LM Studio, llama.cpp, vLLM, a proxy. Your data stays on your machines." },
        ...(done ? [{ title: "Done", value: "done" as const, description: "List what pi can use, and leave" }] : []),
      ],
    }),
  );

const chooseProvider = (models: Models, way: "oauth" | "api_key") =>
  Prompt.run(
    Prompt.Select({
      message: way === "oauth" ? "Which subscription?" : "Which provider?",
      maxPerPage: 15,
      choices: models
        .getProviders()
        .filter((provider) => (way === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login))
        .map((provider) => ({
          title: way === "oauth" ? (provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? provider.name) : provider.name,
          value: provider.id,
        })),
    }),
  );

/** The models and judges pi can use on this computer: those whose provider has a login, a key or a local server. */
export const usable = (models: Models) =>
  Effect.promise(async () => ({
    models: (await models.getAvailable()).map((model) => `${model.provider}/${model.id}`),
    judges: (await models.getAvailableOfType("classifier")).map((model) => `${model.provider}/${model.id}`),
  }));

/** Fail unless pi can use this model on this computer, so a bot is never made with a model it cannot use. */
export const checkModel = (models: Models, model: string) =>
  Effect.gen(function* () {
    const slash = model.indexOf("/");
    if (slash <= 0) return yield* Effect.fail(userError(`--model must be "provider/modelId", for example anthropic/claude-opus-5-5`));
    const provider = model.slice(0, slash);
    const id = model.slice(slash + 1);
    const available = yield* Effect.promise(() => models.getAvailable(provider));
    const found = available.find((item) => item.id === id);
    if (found) {
      const error = yield* tryModel(models, found);
      return error === undefined ? model : yield* Effect.fail(userError(`${model} cannot be used with this login: ${error}`));
    }
    if (available.length === 0) {
      return yield* Effect.fail(userError(`${model} cannot be used: pi has no login or key for "${provider}" on this computer. Run pots login in a terminal to sign in or add a key.`));
    }
    const ids = available.map((item) => item.id);
    return yield* Effect.fail(userError(`${model} cannot be used: "${provider}" has no model "${id}". It has: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}`));
  });

/**
 * Ask for one of these models, and try the chosen one: a login does not unlock every model of its provider (a ChatGPT
 * account cannot use every OpenAI model), and it is better to learn that here than on the bot's first wake. pi's
 * default model for the provider comes first, marked recommended, when it answers with this login.
 */
const chooseModel = (models: Models, available: readonly Model<Api>[], piDefault?: string) =>
  Effect.gen(function* () {
    const name = (model: Model<Api>) => `${model.provider}/${model.id}`;
    let left = [...available];
    let recommended = left.find((model) => model.id === piDefault);
    if (recommended && (yield* tryModel(models, recommended)) !== undefined) {
      left = left.filter((model) => model !== recommended);
      recommended = undefined;
    }
    for (;;) {
      if (left.length === 0) return yield* Effect.fail(userError("No model answers with this login."));
      const chosen = yield* Prompt.run(
        Prompt.Select({
          message: "Which model should it think with? A strong model that calls tools well works best.",
          maxPerPage: 15,
          choices: [...left.filter((model) => model === recommended), ...left.filter((model) => model !== recommended)].map((model) => ({
            title: `${name(model)}${model === recommended ? " (recommended)" : ""}`,
            value: model,
            description: model.name,
          })),
        }),
      );
      if (chosen === recommended) return name(chosen);
      yield* Console.log(`Trying ${name(chosen)}…`);
      const error = yield* tryModel(models, chosen);
      if (error === undefined) return name(chosen);
      yield* Console.log(`${name(chosen)} cannot be used with this login: ${error}`);
      left = left.filter((model) => model !== chosen);
    }
  });

/** Ask the model for a word. The reason it cannot answer, or undefined when it can. */
const tryModel = (models: Models, model: Model<Api>) =>
  Effect.promise(async () => {
    try {
      const reply = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "Say OK.", timestamp: Date.now() }] },
        { signal: AbortSignal.timeout(60_000) },
      );
      return reply.stopReason === "error" || reply.stopReason === "aborted" ? (reply.errorMessage ?? reply.stopReason) : undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

/** The model pi itself picks after a login to this provider. */
async function piDefaultModel(providerId: string): Promise<string | undefined> {
  const { piModule } = await import("../agent/models.ts");
  const { defaultModelPerProvider } = (await import(piModule("./core/model-resolver.js"))) as { defaultModelPerProvider: Record<string, string> };
  return defaultModelPerProvider[providerId];
}

/**
 * Run pi's login flow for a provider in this terminal. Why it failed, or undefined when it worked; Ctrl+C in one of its
 * prompts fails with the prompt's QuitError.
 */
const tryLogin = (models: Models, providerId: string, type: AuthType) =>
  Effect.gen(function* () {
    const terminal = yield* Effect.context<Prompt.Environment>();
    const deviceId = yield* Effect.promise(piDeviceId);
    const error = yield* Effect.promise(() =>
      models.login(providerId, type, terminalInteraction(terminal), { getDeviceId: () => deviceId }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    if (error === undefined) {
      yield* Console.log("Signed in.");
      return undefined;
    }
    if (Terminal.isQuitError(error)) return yield* Effect.fail(error);
    return error instanceof Error ? error.message : String(error);
  });

/** Jev, a fast judge from TypeSafe: pi's provider "typesafe", with an API key. */
const JEV = "typesafe/jev-latest";

/**
 * Step 3 of pots init: who decides whether a group message that does not mention the bot wakes it. The bot itself
 * ("off": every such message wakes it), Jev with the person's TypeSafe API key, or a judge model already set up in pi.
 * The chosen judge is tried with one message first; one that cannot answer is not kept. When Jev could not answer,
 * choosing it again asks for a key again: the one pi has may be wrong or revoked.
 */
export const setUpJudge = (models: Models, name: string, mainModel: string) =>
  Effect.gen(function* () {
    let newKey = false;
    for (;;) {
      const ready = (yield* Effect.promise(() => models.getAvailableOfType("classifier"))).map((model) => `${model.provider}/${model.id}`).filter((model) => model !== JEV);
      const choice = yield* Prompt.run(
        Prompt.Select<string>({
          message: `Who decides whether ${name} answers a group message that does not mention it?`,
          maxPerPage: 15,
          choices: [
            { title: `${name} itself`, value: "off", description: "Every such message wakes it, and its own model decides" },
            { title: "Jev, a fast judge from TypeSafe", value: JEV, description: `About 0.3 seconds; ${name} wakes only for messages about its work. Needs a TypeSafe API key` },
            ...ready.map((model) => ({ title: model, value: model, description: "A judge model you already set up in pi" })),
          ],
        }),
      );
      if (choice === "off") return choice;
      if (choice === JEV && (newKey || (yield* Effect.promise(() => models.getAvailableOfType("classifier", "typesafe"))).length === 0)) {
        const error = yield* tryLogin(models, "typesafe", "api_key").pipe(Effect.catchTag("QuitError", () => Effect.succeed("cancelled")));
        if (error !== undefined) {
          yield* Console.log(`The TypeSafe API key was not saved: ${error}`);
          continue;
        }
      }
      yield* Console.log(`Trying ${choice}…`);
      const error = yield* tryJudge(models, choice, mainModel);
      if (error === undefined) return choice;
      yield* Console.log(`${choice} cannot be used as the judge: ${error}`);
      if (choice === JEV) {
        newKey = true;
        yield* Console.log("Choose Jev again to give another TypeSafe API key.");
      }
    }
  });

/** Fail unless the judge given with --judge can answer, so a bot is never made with a judge it cannot use. */
export const checkJudge = (models: Models, judge: string, mainModel: string) =>
  Effect.gen(function* () {
    // main is the bot's model, which checkModel has tried.
    if (judge === "off" || judge === "main") return judge;
    if (judge.indexOf("/") <= 0) return yield* Effect.fail(userError(`--judge must be "off", "main" or "provider/modelId", for example ${JEV}`));
    const provider = judge.slice(0, judge.indexOf("/"));
    const known = models.getProviders().some((item) => item.id === provider);
    if (known && (yield* Effect.promise(() => models.getAvailableOfType("classifier", provider))).length === 0) {
      return yield* Effect.fail(userError(`${judge} cannot be used as the judge: pi has no key for "${provider}" on this computer. Run pots login in a terminal to add one.`));
    }
    const error = yield* tryJudge(models, judge, mainModel);
    return error === undefined ? judge : yield* Effect.fail(userError(`${judge} cannot be used as the judge: ${error}`));
  });

/** Ask the judge about one message. The reason it cannot answer, or undefined when it can. mainModel: the bot's, for "main". */
const tryJudge = (models: Models, judge: string, mainModel = "") =>
  Effect.promise(async () => {
    const { createJudge } = await import("../agent/judge.ts");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer within 60 seconds")), 60_000)));
    try {
      const asked = createJudge(judge, models, () => mainModel)?.judge({
        name: "Pots",
        responsibilities: "The team's releases.",
        place: "general (channel)",
        earlier: [],
        latest: [{ what: "new message", author: "alice", time: new Date().toISOString(), text: "Is the build green?" }],
      });
      await Promise.race([asked, timeout]);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  });

/**
 * This installation's ID in pi's settings, as the pi command line keeps it. Some logins send it: Sign in with ChatGPT
 * fails without one.
 */
async function piDeviceId(): Promise<string> {
  const { SettingsManager: Settings } = await import("@earendil-works/pi-coding-agent");
  const settings = Settings.create(process.cwd());
  const id = settings.getOrCreateDeviceId();
  await settings.flush();
  return id;
}

/**
 * pi's login callbacks, answered with prompts in this terminal. They use the same terminal as the other prompts: a
 * second one would let the first switch raw mode off a moment later, and the arrow keys would print as ^[[B.
 */
const terminalInteraction = (terminal: Context.Context<Prompt.Environment>): AuthInteraction => ({
  // The login can withdraw a prompt, such as "paste the redirect URL" once the browser has called back.
  prompt: (prompt: AuthPrompt) =>
    Effect.runPromiseWith(terminal)(
      Prompt.run(toPrompt(prompt)).pipe(Effect.onInterrupt(() => Console.log(""))),
      { signal: prompt.signal },
    ),
  notify: (event: AuthEvent) => {
    if (event.type === "auth_url") {
      console.log(`\nOpen this page to sign in${event.instructions ? ` (${event.instructions})` : ""}:\n  ${event.url}\n`);
      openBrowser(event.url);
    } else if (event.type === "device_code") {
      console.log(`\nGo to ${event.verificationUri} and enter the code ${event.userCode}\n`);
      openBrowser(event.verificationUri);
    } else {
      console.log(event.message);
      if (event.type === "info") for (const link of event.links ?? []) console.log(`  ${link.label ?? ""} ${link.url}`);
    }
  },
});

function toPrompt(prompt: AuthPrompt): Prompt.Prompt<string> {
  switch (prompt.type) {
    case "select":
      return Prompt.Select({ message: prompt.message, choices: prompt.options.map((option) => ({ title: option.label, value: option.id, description: option.description })) });
    case "secret":
      // pi saves an empty key as it is, over the key it had, and then counts the provider as not signed in.
      return Prompt.Password({
        message: prompt.message,
        validate: (value) => (value.trim() === "" ? Effect.fail("It cannot be empty: paste it, or press Ctrl+C to go back") : Effect.succeed(value)),
      }).pipe(Prompt.map(Redacted.value));
    default:
      return Prompt.String({ message: prompt.message });
  }
}

/**
 * Open a page. xdg-open reads $BROWSER itself; macOS's open and Windows's start do not, so there pots reads it: on macOS
 * as xdg-open does, a list of commands, which can have arguments, split by ":"; on Windows as one program.
 */
export function openBrowser(url: string): void {
  const browser = process.env.BROWSER?.trim() ?? "";
  const listed =
    process.platform === "darwin"
      ? browser.split(":").map((entry) => entry.trim().split(/\s+/)).filter(([command]) => command)
      : process.platform === "win32" && browser ? [[browser]] : [];
  const system = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  openWithFirst(listed.length > 0 ? listed : [system], url);
}

/** Run the first of the commands that starts, with the URL as its last argument. */
function openWithFirst(commands: string[][], url: string): void {
  const [[command, ...args] = [], ...rest] = commands;
  if (!command) return;
  spawn(command, [...args, url], { stdio: "ignore", detached: true })
    .on("error", () => openWithFirst(rest, url))
    .unref();
}

const LOCAL_SERVERS = [
  { title: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  { title: "LM Studio", provider: "lmstudio", baseUrl: "http://localhost:1234/v1" },
  { title: "llama.cpp server", provider: "llama-server", baseUrl: "http://localhost:8080/v1" },
  { title: "Another OpenAI-compatible server", provider: "local", baseUrl: "http://localhost:8000/v1" },
] as const;

/**
 * Add an OpenAI-compatible endpoint to pi's models.json, the same file the pi command line reads, in the format pi
 * documents. pi itself has no prompts for this; its documentation has people write the file.
 */
const setUpLocal = (models: Models) =>
  Effect.gen(function* () {
    const { getAgentDir } = yield* Effect.promise(() => import("@earendil-works/pi-coding-agent"));
    const modelsFile = join(getAgentDir(), "models.json");
    const server = yield* Prompt.run(Prompt.Select({ message: "Which server?", choices: LOCAL_SERVERS.map((item) => ({ title: item.title, value: item })) }));
    const baseUrl = yield* Prompt.run(Prompt.String({ message: "Its OpenAI-compatible base URL", default: server.baseUrl }));
    const apiKey = yield* Prompt.run(Prompt.String({ message: "API key (leave as is when it needs none)", default: "none" }));
    const listed = yield* Effect.tryPromise(async () => {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) });
      const body = (await response.json()) as { data?: { id: string }[] };
      return (body.data ?? []).map((item) => item.id);
    }).pipe(Effect.orElseSucceed(() => [] as string[]));
    const modelId =
      listed.length > 0
        ? yield* Prompt.run(Prompt.Select({ message: "Which model?", maxPerPage: 15, choices: listed.map((id) => ({ title: id, value: id })) }))
        : yield* Prompt.run(Prompt.String({ message: `No model list at ${baseUrl}. Model ID` }));
    const contextWindow = yield* Prompt.run(
      Prompt.Int({ message: "Its context window in tokens (the bot needs 32768 or more)", min: 8_192, default: 32_768 } as Prompt.IntOptions),
    );
    const file = existsSync(modelsFile) ? (JSON.parse(readFileSync(modelsFile, "utf8")) as { providers?: Record<string, { models?: { id: string }[] }> }) : {};
    const providers = file.providers ?? {};
    const existing = providers[server.provider]?.models?.filter((model) => model.id !== modelId) ?? [];
    providers[server.provider] = {
      baseUrl,
      api: "openai-completions",
      apiKey,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [...existing, { id: modelId, contextWindow }],
    } as (typeof providers)[string];
    mkdirSync(dirname(modelsFile), { recursive: true });
    writeFileSync(modelsFile, `${JSON.stringify({ ...file, providers }, null, 2)}\n`);
    yield* Effect.promise(() => models.refresh());
    const name = `${server.provider}/${modelId}`;
    yield* Console.log(`Added ${name} to ${modelsFile}.`);
    // As with a login: better to learn here than on the bot's first wake that the server is not running.
    const added = models.getModel(server.provider, modelId);
    if (!added) return yield* Effect.fail(userError(`pi does not find ${name} in ${modelsFile}`));
    for (;;) {
      yield* Console.log(`Trying ${name}…`);
      const error = yield* tryModel(models, added);
      if (error === undefined) return name;
      yield* Console.log(`${name} does not answer: ${error}`);
      const again = yield* Prompt.run(Prompt.Confirm({ message: "Try again, for example once the server runs?", initial: true }));
      if (!again) return yield* Effect.fail(userError(`${name} does not answer. It stays in ${modelsFile}.`));
    }
  });
