import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesOptions, Provider } from "@earendil-works/pi-ai";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { getIdentityHeaders } from "@earendil-works/pi-ai/utils/identity";

/**
 * Image generation with the ChatGPT subscription signed in to pi (provider openai-codex), as the Codex CLI does it:
 * gpt-image-2 through the Codex images endpoint (openai/codex: codex-rs/codex-api/src/endpoint/images.rs and
 * codex-rs/ext/image-generation/src/tool.rs). pi keeps the login and refreshes it; this only adds the image model and
 * its requests to pi's own provider. When pi's provider can make images itself, it is left as it is.
 */
export const CODEX_IMAGES_API = "openai-codex-images";

export const CODEX_IMAGE_MODEL: ImageModel<ImageApi> = {
  type: "image",
  id: "gpt-image-2",
  name: "GPT Image 2 (ChatGPT)",
  api: CODEX_IMAGES_API,
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text", "image"],
  output: ["image"],
  // Paid by the subscription's Codex usage, not per token.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** The Codex CLI accepts at most this many images to edit in one request. */
const MAX_EDIT_IMAGES = 5;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** pi's openai-codex provider, with gpt-image-2 and its image requests. */
export function withCodexImages(provider: Provider): Provider {
  if (provider.generateImages) return provider;
  const all = () => provider.getAllModels?.() ?? provider.getModels();
  return {
    ...provider,
    getAllModels: () => {
      const models = all();
      return models.some((model) => model.type === "image" && model.id === CODEX_IMAGE_MODEL.id) ? models : [...models, CODEX_IMAGE_MODEL];
    },
    generateImages: generateCodexImages,
  };
}

/** One image from the prompt, or an edit of the images given with it. Never rejects. */
export async function generateCodexImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages> {
  const result: AssistantImages = { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "stop", timestamp: Date.now() };
  try {
    const token = options?.apiKey;
    if (!token) throw new Error("not signed in to ChatGPT: run pi, then /login and choose ChatGPT");
    const prompt = context.input.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n\n");
    if (!prompt.trim()) throw new Error("no prompt: give the image's description as text");
    const images = context.input.flatMap((item) => (item.type === "image" ? [{ image_url: `data:${item.mimeType};base64,${item.data}` }] : []));
    if (images.length > MAX_EDIT_IMAGES) throw new Error(`at most ${MAX_EDIT_IMAGES} images to edit at once`);
    let body: unknown = { ...(images.length > 0 ? { images } : {}), prompt, model: model.id, background: "auto", quality: "auto", size: "auto" };
    const replaced = await options?.onPayload?.(body, model);
    if (replaced !== undefined) body = replaced;
    const headers = new Headers(providerHeadersToRecord({ originator: "pi", ...getIdentityHeaders(model, options?.identity) }, model.headers, options?.headers));
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("chatgpt-account-id", accountId(token));
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const signals = [options?.signal, options?.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)].filter((signal) => signal !== undefined);
    const response = await (options?.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/codex/images/${images.length > 0 ? "edits" : "generations"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 2000) || response.statusText}`);
    const answer = JSON.parse(text) as { data?: { b64_json?: string; revised_prompt?: string }[]; output_format?: string };
    for (const image of answer.data ?? []) {
      if (image.b64_json) result.output.push({ type: "image", mimeType: mimeType(image.b64_json, answer.output_format), data: image.b64_json });
    }
    if (result.output.length === 0) throw new Error("the answer has no image");
    return result;
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/** The ChatGPT account of a login, which the Codex endpoints need with its token. */
function accountId(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = payload[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  } catch {}
  throw new Error("the ChatGPT login has no account ID: sign in again with pi /login");
}

function mimeType(data: string, format: string | undefined): string {
  if (data.startsWith("iVBOR")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("UklGR")) return "image/webp";
  return format ? `image/${format === "jpg" ? "jpeg" : format}` : "image/png";
}
