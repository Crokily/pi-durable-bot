import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withTelemetry } from "@earendil-works/chord/context";
import { type Message, type Models, Type } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type Conversation,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineExtension,
  defineTool,
  Harness,
  type ModelRef,
  type SubmissionId,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Sql } from "../core/sql.ts";
import { modelRef, requireModel } from "./models.ts";

const context = BACKGROUND_CONTEXT;

/**
 * What the agent's channel tools do. The bot provides them; the agent knows no platform. trace: the tool call's span,
 * so the gateway's spans for the action are part of it.
 */
export interface AgentActions {
  send(to: string, text: string, sendId: string, trace?: TelemetrySpan): Promise<{ message: string; recovered?: boolean; repeated?: boolean }>;
  react(message: string, emoji: string, remove: boolean, trace?: TelemetrySpan): Promise<void>;
  call(channel: string, method: string, params: Record<string, unknown>, trace?: TelemetrySpan): Promise<unknown>;
}

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Compaction {
  reserveTokens?: number;
  keepRecentTokens?: number;
  backgroundTokens?: number;
}

/** Open the bot's SQLite file. The one connection is shared: the agent's tables start with pi_, the others use it too. */
export function openDatabase(path: string): Promise<Sql & { close(): Promise<void> }> {
  return openNodeSqliteDatabase(path);
}

export interface AgentOptions {
  database: Sql & { close(): Promise<void> };
  /** pi's model layer, from openModels(). */
  models: Models;
  /** "provider/modelId". */
  model: string;
  thinking: Thinking;
  compaction: () => Compaction;
  workspace: string;
  /** Environment of bash commands. */
  shellEnv: NodeJS.ProcessEnv;
  /** System prompt parts, rendered before each request in this order. */
  sections: readonly { name: string; render: () => Promise<string | undefined> | string | undefined }[];
  actions: AgentActions;
  /** Where pi-durable's and pi-ai's spans go: submissions, task phases, tool calls, model requests. */
  telemetry?: TelemetryContext;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface ContextStatus {
  /** Tokens in the context now. */
  used: number;
  window: number;
  /** Where pi starts compacting on its own. */
  compactAt: number;
}

/** Call results longer than this go to a file in the workspace. */
const CALL_OUTPUT_CHARS = 30_000;
/** The window assumed for a model whose catalog entry gives none. */
const DEFAULT_WINDOW = 200_000;
/** Room kept free for the answer and long tool results; pi's own default is 16K. */
const RESERVE_TOKENS = 32_768;

/**
 * read shrinks, turns upright and converts images as in the pi CLI, so a full-size screenshot reaches the model. One
 * per process, for all bots: it prepares images in a worker thread that exits when idle.
 */
let images: ReturnType<typeof createNodePhotonImages> | undefined;

/**
 * The bot's agent: one long-lived pi-durable conversation (the root). Tools: read, write, edit, bash, and the
 * channel actions send, react and call. Everything else the agent does with code.
 */
export class Agent {
  readonly #options: AgentOptions;
  readonly #harness: Harness;
  readonly #root: Conversation;
  readonly #models: Models;
  #model: ModelRef;
  #runInputs: readonly string[] | undefined;
  readonly #runListeners = new Set<(inputs: readonly string[] | undefined) => void>();
  #disposeView?: () => void;

  private constructor(options: AgentOptions, harness: Harness, root: Conversation) {
    this.#options = options;
    this.#harness = harness;
    this.#root = root;
    this.#models = options.models;
    this.#model = modelRef(options.model);
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const { actions, models } = options;
    // The connection is the bot's and shared with the gateway, which still writes after the agent has stopped. Closing
    // the harness closes its storage, not the connection; the bot closes that last.
    const connection = new Proxy(options.database, {
      get: (target, property) =>
        property === "close" ? async () => {} : typeof Reflect.get(target, property) === "function" ? Reflect.get(target, property).bind(target) : Reflect.get(target, property),
    });
    const storage = await SqliteStorage.open(connection, { prefix: "pi_" });
    await requireChatModel(models, options.model);
    const text = (value: string) => [{ type: "text" as const, text: value }];
    const tools = [
      defineTool({
        name: "send",
        description:
          "Say something in a channel. to: a place, thread, message or person address, copied from a wake message or the log. " +
          "A place gets a new message; a thread or message gets a reply in that thread; a person gets a DM. text: Markdown; " +
          "write <person address> to mention someone. Sent exactly once, also across restarts. Returns the new message's address.",
        parameters: Type.Object({ to: Type.String(), text: Type.String() }),
        // A rerun after a crash keeps the task ID, so the outbox finds the first attempt instead of sending again.
        replay: "safe",
        execute: async (args, api, call) => {
          const sent = await actions.send(args.to, args.text, `tool:${api.taskId}`, call.telemetry);
          return { output: text(`sent: ${sent.message}${sent.recovered ? " (found after a restart, not sent again)" : ""}`) };
        },
      }),
      defineTool({
        name: "react",
        description: "Add an emoji reaction to a message (message address), for example eyes or white_check_mark. remove: true takes it away.",
        parameters: Type.Object({ message: Type.String(), emoji: Type.String(), remove: Type.Optional(Type.Boolean()) }),
        replay: "safe",
        execute: async (args, _api, call) => {
          await actions.react(args.message, args.emoji, args.remove ?? false, call.telemetry);
          return { output: text("ok") };
        },
      }),
      defineTool({
        name: "call",
        description:
          "Call a platform API method directly, for what send and react do not cover, for example editing your own message or uploading a file. " +
          "channel: the channel account (the part of an address before the first colon). method and params: as the platform's API documents them; " +
          "take platform IDs from the raw column of the log. Returns the platform's answer as JSON.",
        parameters: Type.Object({ channel: Type.String(), method: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
        execute: async (args, api, call) => {
          const result = JSON.stringify(await actions.call(args.channel, args.method, args.params ?? {}, call.telemetry), null, 1) ?? "null";
          if (result.length <= CALL_OUTPUT_CHARS) return { output: text(result) };
          const dir = join(options.workspace, "call-results");
          await mkdir(dir, { recursive: true });
          const file = join(dir, `${api.taskId}.json`);
          await writeFile(file, result);
          return { output: text(`The answer is ${result.length} characters; full JSON in ${file}. First part:\n${result.slice(0, 4_000)}`) };
        },
      }),
    ];

    const bot = defineExtension({
      name: "bot",
      tools,
      sections: options.sections.map((part) => section(part.name, () => part.render(), { tag: false })),
    });
    const registry = createRegistry();
    registry.install(createCodingTools({ images: await (images ??= createNodePhotonImages()) }));
    registry.install(bot);

    let agent: Agent | undefined;
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          // Several queued wakes go into one run.
          steeringMode: "all",
          followUpMode: "all",
          afterFailedRun: "continue",
          retry: { maxRetries: 4 },
          // The fallback when the agent does not turn the page itself.
          get compaction() {
            return compactionFor(models, agent ? agent.#model : modelRef(options.model), options.compaction());
          },
        },
        env: () => new NodeExecutionEnv({ cwd: options.workspace, shellEnv: options.shellEnv }),
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        onReport: (error, info) => options.log("pi report", { type: info.type, error: String(error) }),
      },
      context,
    );
    const model = modelRef(options.model);
    const root = await harness.root(context, { agent: { model, thinkingLevel: options.thinking } });
    await root.configure({ model, thinkingLevel: options.thinking, cwd: options.workspace }, context);
    agent = new Agent(options, harness, root);
    await agent.#watchRun();
    return agent;
  }

  /** Continue the work the last process left unfinished. Call once the channels are up, so its tools can act. */
  resume(): void {
    this.#harness.resume();
  }

  async #watchRun(): Promise<void> {
    const view = await this.#root.viewState(context);
    const update = (value: { docs: Readonly<Record<string, unknown>> }) => {
      const live = value.docs["pi.live"] as { run?: { inputs?: unknown[] } } | undefined;
      const inputs = live?.run ? (live.run.inputs ?? []).map(String) : undefined;
      const changed = (inputs === undefined) !== (this.#runInputs === undefined) || inputs?.join() !== this.#runInputs?.join();
      this.#runInputs = inputs;
      if (changed) for (const listener of this.#runListeners) listener(inputs);
    };
    update(view.value);
    const unsubscribe = view.subscribe(update);
    this.#disposeView = () => {
      unsubscribe();
      view.dispose();
    };
  }

  async close(): Promise<void> {
    this.#disposeView?.();
    await this.#harness.close(context);
  }

  /**
   * Hand text to the agent. Busy: steer joins the running work after the current tool round; otherwise it waits for
   * the run to end. Idle: starts a run. The same id is one submission. caller: the span of what woke the agent;
   * pi-durable links the submission to it. Returns the submission ID and its stored trace context, which is the first
   * one for a submission made before.
   */
  async submit(input: { id: string; text: string; steer: boolean; data?: JsonValue; caller?: TelemetrySpan | undefined }): Promise<{
    id: string;
    trace?: TelemetryCarrier;
  }> {
    const submission = await this.#root.submit(
      {
        type: "input",
        content: input.text,
        requestId: input.id,
        whenBusy: input.steer ? "steer" : "followUp",
        entry: { kind: "bot.wake", ...(input.data === undefined ? {} : { data: input.data }) },
      },
      input.caller ? withTelemetry(input.caller, context) : context,
    );
    const { trace } = await submission.status(context);
    return { id: String(submission.id), ...(trace ? { trace } : {}) };
  }

  /** Why a run with these submissions got no answer, such as a missing login; undefined when they were answered. */
  async runError(inputs: readonly string[]): Promise<string | undefined> {
    for (const id of inputs) {
      const submission = await this.#harness.submission(Number(id) as SubmissionId, context);
      const record = (submission ? await submission.status(context) : undefined) as { status: string; reason?: string; detail?: unknown } | undefined;
      if (record?.status === "unanswered" && record.reason === "model_error") return String(record.detail ?? "the model request failed");
    }
    return undefined;
  }

  /** The submissions the current run works on, or undefined while idle. */
  get runInputs(): readonly string[] | undefined {
    return this.#runInputs;
  }

  onRunChange(listener: (inputs: readonly string[] | undefined) => void): void {
    this.#runListeners.add(listener);
  }

  /** Start a new context whose first message is the handoff. While busy, the current run ends at the next boundary. */
  async turnPage(handoff: string): Promise<void> {
    await this.#root.reset(handoff, context);
  }

  /** Change the model ("provider/modelId") or the thinking level. Throws for an unknown model. */
  async configure(model: string, thinking: Thinking): Promise<void> {
    await requireChatModel(this.#models, model);
    this.#model = modelRef(model);
    await this.#root.configure({ model: this.#model, thinkingLevel: thinking }, context);
  }

  /**
   * Tokens in the context: the provider's count for the last request, plus an estimate of what came after.
   * pi estimates from characters, which counts Chinese at about half, so the estimate is doubled.
   */
  async contextStatus(): Promise<ContextStatus> {
    const window = this.#models.getModel(this.#model.provider, this.#model.modelId)?.contextWindow ?? DEFAULT_WINDOW;
    const messages: readonly Message[] = (await this.#root.context(context)).messages;
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && calculateContextTokens(message.usage) > 0) {
        index = i;
        break;
      }
    }
    let used = index >= 0 ? calculateContextTokens((messages[index] as Extract<Message, { role: "assistant" }>).usage) : 0;
    for (const message of messages.slice(index + 1)) used += 2 * estimateMessageTokens(message);
    // Before the first answer in this context, the provider has not counted the system prompt yet.
    if (index < 0) {
      const parts = await Promise.all(this.#options.sections.map(async (part) => (await part.render()) ?? ""));
      used += 2 * estimateMessageTokens({ role: "user", content: parts.join("\n\n"), timestamp: 0 });
    }
    // pi compacts in the background from (window - reserve - background), and blocks at (window - reserve).
    const policy = compactionFor(this.#models, this.#model, this.#options.compaction());
    const compactAt = window - policy.reserveTokens - (policy.backgroundTokens > 0 ? policy.backgroundTokens : 0);
    return { used, window, compactAt };
  }
}

/**
 * Compaction for the model's context window: what bot.json sets, else the defaults, each at most 15% of the window,
 * so a small local model still has room to work.
 */
function compactionFor(models: Models, ref: ModelRef, set: Compaction): Required<Compaction> {
  const window = models.getModel(ref.provider, ref.modelId)?.contextWindow ?? DEFAULT_WINDOW;
  const fit = (tokens: number) => Math.min(tokens, Math.floor(window * 0.15));
  return {
    reserveTokens: set.reserveTokens ?? fit(RESERVE_TOKENS),
    keepRecentTokens: set.keepRecentTokens ?? fit(DEFAULT_COMPACTION_POLICY.keepRecentTokens),
    backgroundTokens: set.backgroundTokens ?? fit(DEFAULT_COMPACTION_POLICY.backgroundTokens),
  };
}

async function requireChatModel(models: Models, model: string): Promise<void> {
  await requireModel(models, model, (provider, id) => models.getModel(provider, id));
}
