import type { AnyModel, Models, Provider } from "@earendil-works/pi-ai";
import { type LazyStreamObserver, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";

/**
 * pi's own model layer, shared with the pi CLI: subscription logins and API keys in `~/.pi/agent/auth.json`,
 * OpenAI-compatible and local endpoints (Ollama, LM Studio, vLLM, proxies) in `~/.pi/agent/models.json`,
 * and the llama.cpp router after `pi /login llama.cpp`. Every model pi can use, the bot can use.
 * One per process; all bots share it.
 */
export async function openModels(): Promise<Models> {
  const models = await ModelRuntime.create();
  // pi registers llama.cpp from a built-in extension that the package does not export. It brings the router's chat
  // models and its classifiers (decision models through /v1/systemone, chat models through next-token probabilities).
  const llama: { createLlamaProvider(): { provider: Provider } } = await import(
    new URL("./extensions/llama/provider.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  );
  models.registerNativeProvider(llama.createLlamaProvider().provider);
  return observeRequests(models);
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
