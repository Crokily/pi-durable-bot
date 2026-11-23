import type { Api, CacheRetention, Model, Models } from "@earendil-works/pi-ai";

/**
 * The prompt cache retention of each conversation's requests. The main agent is woken minutes to an hour apart, and with
 * the short entry (5 minutes at Anthropic) each wake writes its whole context again; a child's requests rarely pause, so
 * the dearer long entry would not pay for itself there, nor for a memory pass or the judge, which run once.
 *
 * The main conversation asks pi-ai for "long" only on a model whose pi model data gives the long entry a lifetime
 * (`promptCache.long`) and does not turn it off (`compat.supportsLongCacheRetention`): pi-ai also sends its long form to
 * models and endpoints that refuse it (a Bedrock model with only the 5-minute entry, an OpenAI-compatible endpoint that
 * rejects `prompt_cache_retention`), and pi's warming needs that lifetime to time a warm. A model pi knows no such
 * lifetime for keeps the provider's default, as before. A models.json entry can give one.
 *
 * Every other request asks for "short" by name, so PI_CACHE_RETENTION=long does not give children, memory passes or the
 * judge the long entry. A retention the request already names, as pi's own compaction does, stays.
 */
export class CacheRetentions {
  readonly #main: (conversation: string) => boolean;
  /** The conversation of a request that is about to go out, by its task's abort signal. */
  readonly #requests = new WeakMap<AbortSignal, string>();

  /** main: whether a conversation is the one that keeps the long entry where the model has it. */
  constructor(main: (conversation: string) => boolean) {
    this.#main = main;
  }

  /** A request of the conversation goes out next, with the abort signal of its task. */
  request(conversation: string, signal: AbortSignal | undefined): void {
    if (signal) this.#requests.set(signal, conversation);
  }

  /** The retention a request of this conversation to this model asks for: undefined for the provider's default. */
  retention(conversation: string | undefined, model: Model<Api>): CacheRetention | undefined {
    if (conversation === undefined || !this.#main(conversation)) return "short";
    return hasLongEntry(model) ? "long" : undefined;
  }

  /** The models for pi-durable: a request gets its conversation's retention, "short" when `request` did not announce it. */
  wrap(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, context, options) => {
      if (options?.cacheRetention !== undefined) return models.streamSimple(model, context, options);
      const conversation = options?.signal ? this.#requests.get(options.signal) : undefined;
      const retention = this.retention(conversation, model);
      return models.streamSimple(model, context, retention ? { ...options, cacheRetention: retention } : options);
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

/** Whether pi's model data says the model keeps a long prompt cache entry, and for how long. */
export function hasLongEntry(model: Model<Api>): boolean {
  const compat = model.compat as { supportsLongCacheRetention?: boolean } | undefined;
  return model.promptCache?.long !== undefined && compat?.supportsLongCacheRetention !== false;
}
