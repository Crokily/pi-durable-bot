import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CacheRetentions } from "../src/agent/retention.ts";

// Which prompt cache retention a request asks for, on its own: the gateway tests in children.test.ts, memory.test.ts and
// pi.test.ts show the same from outside, in the requests the fake model gets.

/** Models that keep the options of each request they get. */
function recording(): { models: Models; seen: (SimpleStreamOptions | undefined)[] } {
  const seen: (SimpleStreamOptions | undefined)[] = [];
  const streamSimple = ((_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
    seen.push(options);
    return undefined;
  }) as unknown as Models["streamSimple"];
  return { models: { streamSimple, getModel: () => undefined } as unknown as Models, seen };
}

/** A model with the prompt cache data pi has for it. */
const model = (data: Partial<Model<Api>> = {}) => ({ id: "m", provider: "p", api: "anthropic-messages", ...data }) as Model<Api>;
/** As pi knows Anthropic's models: a 5-minute and a 1-hour entry. */
const anthropic = model({ promptCache: { short: 300, long: 3600 } });

describe("prompt cache retention by conversation", () => {
  const retentions = new CacheRetentions((conversation) => conversation === "1");
  const send = (models: Models, options: SimpleStreamOptions, on = anthropic) => models.streamSimple(on, { messages: [] }, options);

  it("asks for the long entry for the main conversation's requests only, and the short one by name for the others", () => {
    const { models, seen } = recording();
    const wrapped = retentions.wrap(models);
    const [main, child, unknown] = [new AbortController().signal, new AbortController().signal, new AbortController().signal];
    retentions.request("1", main);
    retentions.request("7", child);
    send(wrapped, { signal: main });
    // A retry of the same task's request, with the same signal.
    send(wrapped, { signal: main });
    send(wrapped, { signal: child });
    send(wrapped, { signal: unknown });
    send(wrapped, {});
    expect(seen.map((options) => options?.cacheRetention)).toEqual(["long", "long", "short", "short", "short"]);
  });

  it("keeps the provider's default for the main conversation on a model pi knows no long entry for", () => {
    const { models, seen } = recording();
    const wrapped = retentions.wrap(models);
    const signal = new AbortController().signal;
    retentions.request("1", signal);
    // Unknown to pi (most providers, Bedrock among them), only a short entry, or the long one turned off.
    send(wrapped, { signal }, model());
    send(wrapped, { signal }, model({ promptCache: { short: 300 } }));
    send(wrapped, { signal }, model({ promptCache: { short: 300, long: 3600 }, compat: { supportsLongCacheRetention: false } } as Partial<Model<Api>>));
    expect(seen.map((options) => options?.cacheRetention)).toEqual([undefined, undefined, undefined]);
  });

  it("keeps a retention the request names, and the other options and members as they are", () => {
    const { models, seen } = recording();
    const wrapped = retentions.wrap(models);
    const [signal, child] = [new AbortController().signal, new AbortController().signal];
    retentions.request("1", signal);
    retentions.request("7", child);
    send(wrapped, { signal, cacheRetention: "none" });
    send(wrapped, { signal: child, cacheRetention: "long" });
    send(wrapped, { signal, maxTokens: 5, sessionId: "s" });
    expect(seen[0]?.cacheRetention).toBe("none");
    expect(seen[1]?.cacheRetention).toBe("long");
    expect(seen[2]).toEqual({ signal, maxTokens: 5, sessionId: "s", cacheRetention: "long" });
    expect(wrapped.getModel("a", "b")).toBeUndefined();
  });
});
