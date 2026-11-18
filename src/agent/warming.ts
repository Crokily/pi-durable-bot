import type { Api, AssistantMessage, Context as ModelContext, Model, Models, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { piModule } from "./models.ts";

/** pi's setting cacheWarming: "idle" by default, as in pi. */
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** pi's CacheWarmer (pi-coding-agent's core/cache-warmer.js): the pi CLI's warming of one session's prompt cache. */
interface PiCacheWarmer {
  start(request: { model: Model<Api>; context: ModelContext; options: SimpleStreamOptions }, isCurrent: () => boolean): void;
  onAgentSettled(): void;
  cancel(): void;
}

/** What pi's CacheWarmer reads of its session: the usage of the last answer, for the prompt size; and where it writes a warm's usage. */
interface WarmerSession {
  getBranch(): { type: "message"; message: { role: "assistant"; usage: Usage } }[];
  appendUsage(kind: string, provider: string, model: string, usage: Usage): unknown;
}

type CacheWarmerClass = new (models: Models, session: WarmerSession, getMode: () => CacheWarmingMode) => PiCacheWarmer;

interface Warmed {
  warmer: PiCacheWarmer;
  /** Of the conversation's last answer. */
  usage?: Usage;
}

/**
 * pi's prompt cache warming, for the main agent and its children, as the pi CLI warms its session: shortly before the
 * provider's cache entry of a conversation's last request expires, the same request goes out again with a one-token
 * answer, while it pays for itself by pi's numbers. During a run up to an hour after the request, after the run up to 30
 * minutes; pi's setting cacheWarming (off, streaming, idle) is the switch, shared with the pi CLI. Memory passes,
 * compaction and the judge are not warmed. A warm is a model request like the others, in `pots trace`.
 */
export class CacheWarming {
  readonly #Warmer: CacheWarmerClass;
  readonly #models: Models;
  readonly #mode: () => CacheWarmingMode;
  /** Whether a conversation may be warmed now: the main one, or a child that is not stopped. */
  readonly #warmable: (conversation: string) => boolean;
  readonly #warmed = new Map<string, Warmed>();
  /** The request of a warmable conversation that is about to go out, by its task's abort signal. */
  readonly #requests = new WeakMap<AbortSignal, string>();

  private constructor(Warmer: CacheWarmerClass, models: Models, mode: () => CacheWarmingMode, warmable: (conversation: string) => boolean) {
    this.#Warmer = Warmer;
    this.#models = models;
    this.#mode = mode;
    this.#warmable = warmable;
  }

  /**
   * models: what warms send, as the requests they repeat went. Undefined when pi's CacheWarmer cannot be found: then
   * nothing is warmed.
   */
  static async open(models: Models, mode: () => CacheWarmingMode, warmable: (conversation: string) => boolean): Promise<CacheWarming | undefined> {
    try {
      const { CacheWarmer } = (await import(piModule("./core/cache-warmer.js"))) as { CacheWarmer?: CacheWarmerClass };
      return typeof CacheWarmer === "function" ? new CacheWarming(CacheWarmer, models, mode, warmable) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The models for pi-durable: a request that `request` announced starts warming its conversation. */
  wrap(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, context, options) => {
      const conversation = options?.signal ? this.#requests.get(options.signal) : undefined;
      if (conversation !== undefined && options) {
        this.#requests.delete(options.signal!);
        // pi-durable's onPayload runs the request's beforeProviderRequest hooks, which fail once its task ended: a warm
        // then sends the body as pi-ai built it. The bot's hooks leave the body as it is.
        const { onPayload, telemetry } = options;
        const warm: SimpleStreamOptions = { ...options };
        if (onPayload) warm.onPayload = (payload, model) => Promise.resolve(onPayload(payload, model)).catch(() => undefined);
        // A warm's span is a child of the request's span, which has ended by then and takes no children: the warm's
        // parent is named by its trace context instead, so the warm is in the same trace.
        const propagation = telemetry?.propagation;
        const carrier = propagation?.inject(telemetry!);
        if (propagation && carrier) warm.telemetry = propagation.extract(carrier) as TelemetrySpan;
        this.#warmer(conversation).start({ model, context, options: warm }, () => this.#warmable(conversation));
      }
      return models.streamSimple(model, context, options);
    };
    return new Proxy(models, {
      get(target, property) {
        if (property === "streamSimple") return streamSimple;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** A request of the conversation goes out next, with the abort signal of its task. */
  request(conversation: string, signal: AbortSignal | undefined): void {
    if (signal && this.#warmable(conversation)) this.#requests.set(signal, conversation);
  }

  /** The conversation's request got its answer. An answer without tool calls ends the run. */
  response(conversation: string, message: AssistantMessage): void {
    const warmed = this.#warmed.get(conversation);
    if (!warmed) return;
    if (message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0) warmed.usage = message.usage;
    if (message.stopReason !== "toolUse") warmed.warmer.onAgentSettled();
  }

  /** Stop warming one conversation, as when its context changes without a request, or all of them. */
  cancel(conversation?: string): void {
    for (const [key, warmed] of this.#warmed) {
      if (conversation !== undefined && key !== conversation) continue;
      warmed.warmer.cancel();
      this.#warmed.delete(key);
    }
  }

  #warmer(conversation: string): PiCacheWarmer {
    let warmed = this.#warmed.get(conversation);
    if (!warmed) {
      const session: WarmerSession = {
        getBranch: () => (warmed?.usage ? [{ type: "message", message: { role: "assistant", usage: warmed.usage } }] : []),
        // The warm's model request is a span in `pots trace`, like every request; nothing else keeps it.
        appendUsage: () => undefined,
      };
      warmed = { warmer: new this.#Warmer(this.#models, session, this.#mode) };
      this.#warmed.set(conversation, warmed);
    }
    return warmed.warmer;
  }
}
