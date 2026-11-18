import type { AnyModel, Api, Model, Models, Provider } from "@earendil-works/pi-ai";
import { type LazyStreamObserver, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { withCodexImages } from "./codex-images.ts";

/**
 * A module of pi-coding-agent that its package does not export. Only for what is not in its public entry; check each
 * one when pi is upgraded.
 */
export const piModule = (path: string) => new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;

/**
 * pi's own model layer, shared with the pi CLI: subscription logins and API keys in `~/.pi/agent/auth.json`,
 * OpenAI-compatible and local endpoints (Ollama, LM Studio, vLLM, proxies) in `~/.pi/agent/models.json`,
 * and the llama.cpp router after `pi /login llama.cpp`. Every model pi can use, the bot can use.
 * One per process; all bots share it.
 */
export async function openModels(): Promise<Models> {
  // From pi's public entry. It also loads pi's terminal interface, which the bot does not use: about 0.3 seconds and
  // 20 MB more, once, when the gateway starts.
  const { ModelRuntime: Runtime } = await import("@earendil-works/pi-coding-agent");
  const models = await Runtime.create();
  // pi registers llama.cpp from a built-in extension. It brings the router's chat models and its classifiers (decision
  // models through /v1/systemone, chat models through next-token probabilities).
  const llama: { createLlamaProvider(): { provider: Provider } } = await import(piModule("./extensions/llama/provider.js"));
  models.registerNativeProvider(llama.createLlamaProvider().provider);
  const codex = await piCodexProvider();
  if (codex) models.registerNativeProvider(withCodexImages(codex));
  return observeRequests(models);
}

/**
 * pi's built-in openai-codex provider, made as ModelRuntime.create makes it: with the pi.dev catalog over the shipped
 * one. Undefined when pi's modules have moved; the bot then works without ChatGPT images.
 */
export async function piCodexProvider(): Promise<Provider | undefined> {
  try {
    const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
    const { getBuiltinModelDataGeneratedAt } = await import("@earendil-works/pi-ai/providers/all");
    const catalog: { withRemoteCatalog(provider: Provider, catalogBaseUrl?: string, localGeneratedAt?: number): Provider } = await import(piModule("./core/remote-catalog-provider.js"));
    return catalog.withRemoteCatalog(openaiCodexProvider(), undefined, getBuiltinModelDataGeneratedAt());
  } catch {
    return undefined;
  }
}

type Observe = (model: Parameters<Models["streamSimple"]>[0], options: { telemetry?: TelemetrySpan; reasoning?: unknown } | undefined, poll: boolean) => LazyStreamObserver;

/**
 * Model requests as spans (pi.ai.request: provider, model, tokens, cost; no content), under the span the request
 * options name, which pi-durable sets to the agent's task phase. pi-ai's own Models does this; pi's ModelRuntime does
 * not yet, so the same observer from pi-ai is added around it. pi-ai does not export it; when it cannot be found, the
 * models work as they are.
 */
async function observeRequests(models: ModelRuntime): Promise<Models> {
  let observe: Observe;
  try {
    ({ observeModelRequest: observe } = (await import(new URL("./telemetry.js", import.meta.resolve("@earendil-works/pi-ai")).href)) as { observeModelRequest: Observe });
    if (typeof observe !== "function") return models;
  } catch {
    return models;
  }
  // pi-durable's generations stream, compaction and the judge complete; both go through streamSimple.
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    lazyStream(model, async () => models.streamSimple(model, context, options), observe(model, options, false));
  const completeSimple: Models["completeSimple"] = (model, context, options) => streamSimple(model, context, options).result();
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** "provider/modelId" → its parts. The model ID may contain slashes. */
export function modelRef(model: string): { provider: string; modelId: string } {
  const [provider, ...rest] = model.split("/");
  return { provider: provider!, modelId: rest.join("/") };
}

/** Find a chat or classifier model, refreshing the catalogs once (models.json, dynamic catalogs) when it is not known yet. */
export async function requireModel<T extends AnyModel>(models: Models, model: string, find: (provider: string, modelId: string) => T | undefined): Promise<T> {
  const ref = modelRef(model);
  const found = find(ref.provider, ref.modelId);
  if (found) return found;
  await models.refresh();
  const refreshed = find(ref.provider, ref.modelId);
  if (!refreshed) throw new Error(`unknown model ${model}`);
  return refreshed;
}

/** The model pi itself picks after a login to this provider. */
export async function piDefaultModel(providerId: string): Promise<string | undefined> {
  const { defaultModelPerProvider } = (await import(piModule("./core/model-resolver.js"))) as { defaultModelPerProvider: Record<string, string> };
  return defaultModelPerProvider[providerId];
}

/**
 * This installation's ID in pi's settings, as the pi command line keeps it. Some logins send it: Sign in with ChatGPT
 * fails without one.
 */
export async function piDeviceId(): Promise<string> {
  const { SettingsManager: Settings } = await import("@earendil-works/pi-coding-agent");
  const settings = Settings.create(process.cwd());
  const id = settings.getOrCreateDeviceId();
  await settings.flush();
  return id;
}

/** Ask the model for a word. The reason it cannot answer, or undefined when it can. */
export async function modelProblem(models: Models, model: Model<Api>): Promise<string | undefined> {
  try {
    const reply = await models.completeSimple(model, { messages: [{ role: "user", content: "Say OK.", timestamp: Date.now() }] }, { signal: AbortSignal.timeout(60_000) });
    return reply.stopReason === "error" || reply.stopReason === "aborted" ? (reply.errorMessage ?? reply.stopReason) : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Ask the judge about one message. The reason it cannot answer, or undefined when it can. mainModel: the bot's, for "main". */
export async function judgeProblem(models: Models, judge: string, mainModel = ""): Promise<string | undefined> {
  const { createJudge } = await import("./judge.ts");
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
}

/** What a login page needs of pi, beyond its models: its device ID, its default models, and a try of a model or judge. */
export const piLoginHelpers = {
  deviceId: piDeviceId,
  defaultModel: piDefaultModel,
  tryModel: async (models: Models, name: string) => {
    const { provider, modelId } = modelRef(name);
    const model = models.getModel(provider, modelId);
    return model ? modelProblem(models, model) : `pi does not know ${name}`;
  },
  tryJudge: (models: Models, judge: string) => judgeProblem(models, judge),
};
