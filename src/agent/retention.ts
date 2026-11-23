import type { CacheRetention, Models } from "@earendil-works/pi-ai";

/**
 * The prompt cache retention of each conversation's requests: pi-ai's "long" for the main conversation, the provider's
 * default ("short") for the others. The main agent is woken minutes to an hour apart, and with the short entry (5
 * minutes at Anthropic) each wake writes its whole context again; a child's requests rarely pause, so the dearer long
 * entry would not pay for itself there. Memory passes, compaction and the judge keep the default too. pi-ai turns "long"
 * into each provider's form (Anthropic's 1-hour cache_control, OpenAI's prompt_cache_retention), and a provider without
 * one ignores it. A retention the request already names, as pi's own compaction does, stays.
 */
export class CacheRetentions {
  readonly #long: (conversation: string) => boolean;
  /** The conversation of a request that is about to go out, by its task's abort signal. */
  readonly #requests = new WeakMap<AbortSignal, string>();

  /** long: whether a conversation's requests keep the long entry. */
  constructor(long: (conversation: string) => boolean) {
    this.#long = long;
  }

  /** A request of the conversation goes out next, with the abort signal of its task. */
  request(conversation: string, signal: AbortSignal | undefined): void {
    if (signal) this.#requests.set(signal, conversation);
  }

  /** The retention a request of this conversation asks for: undefined for the provider's default. */
  retention(conversation: string | undefined): CacheRetention | undefined {
    return conversation !== undefined && this.#long(conversation) ? "long" : undefined;
  }

  /** The models for pi-durable: a request that `request` announced gets its conversation's retention. */
  wrap(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, context, options) => {
      const conversation = options?.signal ? this.#requests.get(options.signal) : undefined;
      const retention = this.retention(conversation);
      return models.streamSimple(model, context, retention && options && options.cacheRetention === undefined ? { ...options, cacheRetention: retention } : options);
    };
    return new Proxy(models, {
      get(target, property) {
        if (property === "streamSimple") return streamSimple;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
