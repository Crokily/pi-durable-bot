import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, AuthEvent, AuthInteraction, AuthPrompt, AuthType, Model, Models } from "@earendil-works/pi-ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Redacted } from "effect";
import { Prompt } from "effect/cli";
import { userError } from "./control.ts";

// Step 2 of pots init: give the bot an AI. Logins, keys and endpoints are pi's own (~/.pi/agent), so the pi command
// line and every bot on this machine share them.

const PI_MODELS_FILE = join(homedir(), ".pi/agent/models.json");

type Way = "existing" | "oauth" | "api_key" | "local";

/** Ask how the bot gets its AI, set that up, and return the chosen model as "provider/modelId". */
export const setUpModel = (models: Models) =>
  Effect.gen(function* () {
    const ready = yield* Effect.promise(() => models.getAvailable());
    const way = yield* Prompt.run(
      Prompt.Select<Way>({
        message: "How should your bot get its AI?",
        choices: [
          ...(ready.length > 0 ? [{ title: `A model you have already set up in pi (${ready.length})`, value: "existing" as const }] : []),
          { title: "Sign in with a subscription", value: "oauth", description: "ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more" },
          { title: "Use an API key", value: "api_key", description: "Any of pi's providers" },
          { title: "A local or OpenAI-compatible server", value: "local", description: "Ollama, LM Studio, llama.cpp, vLLM, a proxy. Your data stays on your machines." },
        ],
      }),
    );
    if (way === "existing") return yield* chooseModel(ready);
    if (way === "local") return yield* setUpLocal(models);
    const providers = models.getProviders().filter((provider) => (way === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login));
    const providerId = yield* Prompt.run(
      Prompt.Select({
        message: way === "oauth" ? "Which subscription?" : "Which provider?",
        maxPerPage: 15,
        choices: providers.map((provider) => ({
          title: way === "oauth" ? (provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? provider.name) : provider.name,
          value: provider.id,
        })),
      }),
    );
    yield* login(models, providerId, way);
    return yield* chooseModel(yield* Effect.promise(() => models.getAvailable(providerId)));
  });

const chooseModel = (available: readonly Model<Api>[]) =>
  Effect.gen(function* () {
    if (available.length === 0) return yield* Effect.fail(userError("no models are available with this login"));
    return yield* Prompt.run(
      Prompt.Select({
        message: "Which model should it think with? A strong model that calls tools well works best.",
        maxPerPage: 15,
        choices: available.map((model) => ({ title: `${model.provider}/${model.id}`, value: `${model.provider}/${model.id}`, description: model.name })),
      }),
    );
  });

/** Run pi's login flow for a provider in this terminal. */
const login = (models: Models, providerId: string, type: AuthType) =>
  Effect.tryPromise({
    try: () => models.login(providerId, type, terminalInteraction),
    catch: (error) => userError(`login failed: ${error instanceof Error ? error.message : String(error)}`),
  }).pipe(Effect.tap(() => Console.log("Signed in.")));

/** pi's login callbacks, answered with prompts in this terminal. */
const terminalInteraction: AuthInteraction = {
  prompt: (prompt: AuthPrompt) => Effect.runPromise(Prompt.run(toPrompt(prompt)).pipe(Effect.provide(NodeServices.layer))),
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
};

function toPrompt(prompt: AuthPrompt): Prompt.Prompt<string> {
  switch (prompt.type) {
    case "select":
      return Prompt.Select({ message: prompt.message, choices: prompt.options.map((option) => ({ title: option.label, value: option.id, description: option.description })) });
    case "secret":
      return Prompt.Password({ message: prompt.message }).pipe(Prompt.map(Redacted.value));
    default:
      return Prompt.String({ message: prompt.message });
  }
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command as string, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

const LOCAL_SERVERS = [
  { title: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  { title: "LM Studio", provider: "lmstudio", baseUrl: "http://localhost:1234/v1" },
  { title: "llama.cpp server", provider: "llama-server", baseUrl: "http://localhost:8080/v1" },
  { title: "Another OpenAI-compatible server", provider: "local", baseUrl: "http://localhost:8000/v1" },
] as const;

/** Add an OpenAI-compatible endpoint to pi's models.json, the same file the pi command line reads. */
const setUpLocal = (models: Models) =>
  Effect.gen(function* () {
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
    const file = existsSync(PI_MODELS_FILE) ? (JSON.parse(readFileSync(PI_MODELS_FILE, "utf8")) as { providers?: Record<string, { models?: { id: string }[] }> }) : {};
    const providers = file.providers ?? {};
    const existing = providers[server.provider]?.models?.filter((model) => model.id !== modelId) ?? [];
    providers[server.provider] = {
      baseUrl,
      api: "openai-completions",
      apiKey,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [...existing, { id: modelId, contextWindow }],
    } as (typeof providers)[string];
    mkdirSync(dirname(PI_MODELS_FILE), { recursive: true });
    writeFileSync(PI_MODELS_FILE, `${JSON.stringify({ ...file, providers }, null, 2)}\n`);
    yield* Effect.promise(() => models.refresh());
    yield* Console.log(`Added ${server.provider}/${modelId} to ${PI_MODELS_FILE}.`);
    return `${server.provider}/${modelId}`;
  });
