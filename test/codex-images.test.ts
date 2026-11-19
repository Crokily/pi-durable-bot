import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImagesContext, Models } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_IMAGE_MODEL, generateCodexImages, withCodexImages } from "../src/agent/codex-images.ts";
import { openModels, piCodexProvider } from "../src/agent/models.ts";

// Images with the ChatGPT login signed in to pi (src/agent/codex-images.ts): a login in pi's auth.json, the bot's
// models from openModels(), and the Codex images endpoint answered here in its place.

const ACCOUNT = "acct-123";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A token shaped like a ChatGPT login's: the account ID in its claims. */
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } })}.signature`;

type Request = { url: string; headers: Headers; body: Record<string, unknown> };

let dir: string;
let requests: Request[];
let answer: () => Response;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pots-codex-images-"));
  requests = [];
  answer = () => Response.json({ created: 1, data: [{ b64_json: PNG }] });
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://chatgpt.com/")) return real(input as string, init);
    requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return answer();
  });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "pi"));
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function signedIn(): Promise<Models> {
  mkdirSync(join(dir, "pi"), { recursive: true });
  const login = { type: "oauth", access: TOKEN, refresh: "refresh", expires: Date.now() + 3_600_000, accountId: ACCOUNT };
  writeFileSync(join(dir, "pi", "auth.json"), JSON.stringify({ "openai-codex": login }));
  return openModels();
}

const ask = (models: Models, context: ImagesContext) => models.generateImages(models.getModelOfType("image", "openai-codex", "gpt-image-2")!, context);

describe("images with the ChatGPT login", () => {
  it("lists gpt-image-2 once signed in to ChatGPT, beside pi's own Codex chat models", async () => {
    const models = await openModels();
    expect((await models.getAvailableOfType("image")).map((model) => `${model.provider}/${model.id}`)).not.toContain("openai-codex/gpt-image-2");

    const signed = await signedIn();
    expect((await signed.getAvailableOfType("image")).map((model) => `${model.provider}/${model.id}`)).toContain("openai-codex/gpt-image-2");
    expect(signed.getModels("openai-codex").map((model) => model.id)).toEqual(openaiCodexProvider().getModels().map((model) => model.id));
  });

  it("makes an image as the Codex CLI does, with the login's token and account", async () => {
    const result = await ask(await signedIn(), { input: [{ type: "text", text: "A red fox" }] });
    expect(result.stopReason).toBe("stop");
    expect(result.output).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request!.headers.get("chatgpt-account-id")).toBe(ACCOUNT);
    expect(request!.body).toEqual({ prompt: "A red fox", model: "gpt-image-2", background: "auto", quality: "auto", size: "auto" });
  });

  it("edits the images given with the prompt", async () => {
    const result = await ask(await signedIn(), { input: [{ type: "text", text: "Add a hat" }, { type: "image", mimeType: "image/png", data: PNG }] });
    expect(result.stopReason).toBe("stop");
    expect(requests[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(requests[0]!.body.images).toEqual([{ image_url: `data:image/png;base64,${PNG}` }]);
  });

  it("takes the base URLs pi takes for Codex: ending in /backend-api, /codex or /codex/responses", async () => {
    for (const baseUrl of ["https://chatgpt.com/backend-api/", "https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex/responses/"]) {
      const result = await generateCodexImages({ ...CODEX_IMAGE_MODEL, baseUrl }, { input: [{ type: "text", text: "A red fox" }] }, { apiKey: TOKEN });
      expect(result.stopReason).toBe("stop");
    }
    expect(requests.map((request) => request.url)).toEqual(Array(3).fill("https://chatgpt.com/backend-api/codex/images/generations"));
  });

  it("gives ChatGPT's refusal as the result's error", async () => {
    answer = () => Response.json({ detail: "Forbidden" }, { status: 403 });
    const result = await ask(await signedIn(), { input: [{ type: "text", text: "A red fox" }] });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("403");
    expect(result.output).toEqual([]);
  });

  it("builds on pi's own provider, and steps aside when pi's makes images itself", async () => {
    const codex = await piCodexProvider();
    expect(codex?.id).toBe("openai-codex");
    // pi adds the pi.dev catalog to its built-in providers; a pi upgrade that moves it fails here.
    expect(codex?.refreshModelsAuth).toBe("configured");
    const images = withCodexImages(codex!);
    expect(images.getAllModels?.().filter((model) => model.type === "image")).toEqual([CODEX_IMAGE_MODEL]);
    expect(images.auth).toBe(codex!.auth);
    const own = { ...codex!, generateImages: vi.fn() };
    expect(withCodexImages(own)).toBe(own);
  });
});
