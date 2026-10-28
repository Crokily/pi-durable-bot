import type { AnyModel, Models, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
  return models;
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
