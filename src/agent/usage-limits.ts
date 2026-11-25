import type { Models } from "@earendil-works/pi-ai";

/**
 * The usage windows a provider reports in the headers of each response, as Anthropic does for a subscription
 * (anthropic-ratelimit-unified-5h-utilization 0.97, anthropic-ratelimit-unified-5h-reset 1795608000, and the same for
 * 7d). A subscription's limit comes back as a 429 with no reset time, so the last answer's headers are the only place
 * that says when the model works again.
 */
export class UsageLimits {
  /** The windows of each provider's last response that had them. */
  readonly #windows = new Map<string, readonly Window[]>();

  /** The models for pi-durable: each response's headers are read. */
  wrap(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, context, options) =>
      models.streamSimple(model, context, {
        ...options,
        onResponse: async (response, model) => {
          const windows = readWindows(response.headers);
          if (windows.length > 0) this.#windows.set(model.provider, windows);
          await options?.onResponse?.(response, model);
        },
      });
    return new Proxy(models, {
      get(target, property) {
        if (property === "streamSimple") return streamSimple;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** When the provider's first window that is at or near its limit starts again, after now; undefined when none is. */
  reset(provider: string, now = Date.now()): number | undefined {
    const resets = (this.#windows.get(provider) ?? []).filter((window) => window.used >= NEAR && window.reset > now).map((window) => window.reset);
    return resets.length > 0 ? Math.min(...resets) : undefined;
  }
}

interface Window {
  /** 0 to 1. */
  used: number;
  /** Epoch milliseconds. */
  reset: number;
}

/** A window used this much is at its limit for a request that may need more than one percent of it. */
const NEAR = 0.9;
const HEADER = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/;

function readWindows(headers: Record<string, string>): Window[] {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const windows: Window[] = [];
  for (const [name, value] of Object.entries(lower)) {
    const window = HEADER.exec(name)?.[1];
    const reset = Number(lower[`anthropic-ratelimit-unified-${window}-reset`]);
    const used = Number(value);
    if (window && Number.isFinite(used) && Number.isFinite(reset) && reset > 0) windows.push({ used, reset: reset * 1000 });
  }
  return windows;
}
