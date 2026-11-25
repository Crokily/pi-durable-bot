import type { Models } from "@earendil-works/pi-ai";

/**
 * The usage windows a provider reports in the headers of its responses, as Anthropic does for a subscription
 * (anthropic-ratelimit-unified-5h-utilization 0.97, anthropic-ratelimit-unified-5h-reset 1795608000,
 * anthropic-ratelimit-unified-5h-status rejected, and the same for 7d). pi-ai keeps only the body of a 429, so Pots reads
 * the headers through the fetch that pi-ai takes for each request, before the provider's SDK throws.
 */
export class UsageLimits {
  /** The windows of each provider's last response that had them. */
  readonly #windows = new Map<string, readonly Window[]>();
  /** When the limit that a provider's last response refused a request for ends, by provider, until a response works. */
  readonly #refused = new Map<string, number>();
  /** One fetch per provider, so a provider that keeps its client while the fetch stays the same can keep it. */
  readonly #fetches = new Map<string, typeof fetch>();

  /** The models for pi-durable: each response's headers are read. */
  wrap(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, context, options) =>
      models.streamSimple(model, context, { ...options, fetch: this.#fetch(model.provider, options?.fetch) });
    return new Proxy(models, {
      get(target, property) {
        if (property === "streamSimple") return streamSimple;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  #fetch(provider: string, inner: typeof fetch | undefined): typeof fetch {
    if (inner) return this.#reader(provider, inner);
    let wrapped = this.#fetches.get(provider);
    if (!wrapped) this.#fetches.set(provider, (wrapped = this.#reader(provider, (input, init) => globalThis.fetch(input, init))));
    return wrapped;
  }

  #reader(provider: string, inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await inner(input, init);
      this.read(provider, response.status, response.headers);
      return response;
    };
  }

  /** A response from the provider. */
  read(provider: string, status: number, headers: Headers): void {
    const windows = readWindows(headers);
    if (windows.length > 0) this.#windows.set(provider, windows);
    if (status < 400) this.#refused.delete(provider);
    if (status !== 429) return;
    const end = refusedUntil(headers, windows);
    if (end === undefined) this.#refused.delete(provider);
    else this.#refused.set(provider, end);
  }

  /**
   * When the provider's model may work again after a usage limit, after now. known: its last response refused a request
   * and said until when; otherwise the end of a window that its last answer showed at or near its limit, which may or
   * may not be the limit that refused the request. Undefined when neither says.
   */
  reset(provider: string, now = Date.now()): { at: number; known: boolean } | undefined {
    const refused = this.#refused.get(provider);
    if (refused !== undefined && refused > now) return { at: refused, known: true };
    const resets = (this.#windows.get(provider) ?? []).filter((window) => window.used >= NEAR && window.reset > now).map((window) => window.reset);
    return resets.length > 0 ? { at: Math.min(...resets), known: false } : undefined;
  }
}

interface Window {
  /** 0 to 1. */
  used: number;
  /** Epoch milliseconds. */
  reset: number;
  /** "rejected" for a window that refuses requests now. */
  status?: string;
}

/** A window used this much is at its limit for a request that may need more than one percent of it. */
const NEAR = 0.9;
const PREFIX = "anthropic-ratelimit-unified-";
const UTILIZATION = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/;

function readWindows(headers: Headers): Window[] {
  const windows: Window[] = [];
  headers.forEach((value, name) => {
    const window = UTILIZATION.exec(name.toLowerCase())?.[1];
    if (!window) return;
    const used = Number(value);
    const reset = Number(headers.get(`${PREFIX}${window}-reset`));
    const status = headers.get(`${PREFIX}${window}-status`);
    if (Number.isFinite(used) && Number.isFinite(reset) && reset > 0) windows.push({ used, reset: reset * 1000, ...(status ? { status } : {}) });
  });
  return windows;
}

/**
 * Until when a 429 refuses requests, as its headers say: the windows that refuse, else the provider's own reset for the
 * refusal, else the windows used up. Undefined when they do not say.
 */
function refusedUntil(headers: Headers, windows: readonly Window[]): number | undefined {
  const latest = (list: readonly Window[]) => (list.length > 0 ? Math.max(...list.map((window) => window.reset)) : undefined);
  const rejected = latest(windows.filter((window) => window.status === "rejected"));
  if (rejected !== undefined) return rejected;
  const reset = Number(headers.get(`${PREFIX}reset`));
  if (headers.get(`${PREFIX}status`) === "rejected" && Number.isFinite(reset) && reset > 0) return reset * 1000;
  return latest(windows.filter((window) => window.used >= 1));
}
