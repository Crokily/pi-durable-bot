import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message, Type } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type Conversation,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineExtension,
  defineTool,
  Harness,
  type ModelRef,
  type Storage,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const context = BACKGROUND_CONTEXT;

/** What the agent's channel tools do. The bot provides them; the agent knows no platform. */
export interface AgentActions {
  send(to: string, text: string, sendId: string): Promise<{ message: string; recovered?: boolean; repeated?: boolean }>;
  react(message: string, emoji: string, remove: boolean): Promise<void>;
  call(channel: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Compaction {
  reserveTokens?: number;
  keepRecentTokens?: number;
  backgroundTokens?: number;
}

export interface AgentOptions {
  storage: Storage;
  models: MutableModels;
  model: ModelRef;
  thinking: Thinking;
  compaction: () => Compaction;
  workspace: string;
  /** Environment of bash commands. */
  shellEnv: NodeJS.ProcessEnv;
  /** System prompt parts, rendered before each request in this order. */
  sections: readonly { name: string; render: () => Promise<string | undefined> | string | undefined }[];
  actions: AgentActions;
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

/**
 * The bot's agent: one long-lived pi-durable conversation (the root). Tools: read, write, edit, bash, and the
 * channel actions send, react and call. Everything else the agent does with code.
 */
export class Agent {
  readonly #options: AgentOptions;
  readonly #harness: Harness;
  readonly #root: Conversation;
  #model: ModelRef;
  #runInputs: readonly string[] | undefined;
  readonly #runListeners = new Set<(inputs: readonly string[] | undefined) => void>();
  #disposeView?: () => void;

  private constructor(options: AgentOptions, harness: Harness, root: Conversation) {
    this.#options = options;
    this.#harness = harness;
    this.#root = root;
    this.#model = options.model;
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const { actions } = options;
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
        execute: async (args, api) => {
          const sent = await actions.send(args.to, args.text, `tool:${api.taskId}`);
          return { output: text(`sent: ${sent.message}${sent.recovered ? " (found after a restart, not sent again)" : ""}`) };
        },
      }),
      defineTool({
        name: "react",
        description: "Add an emoji reaction to a message (message address), for example eyes or white_check_mark. remove: true takes it away.",
        parameters: Type.Object({ message: Type.String(), emoji: Type.String(), remove: Type.Optional(Type.Boolean()) }),
        replay: "safe",
        execute: async (args) => {
          await actions.react(args.message, args.emoji, args.remove ?? false);
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
        execute: async (args, api) => {
          const result = JSON.stringify(await actions.call(args.channel, args.method, args.params ?? {}), null, 1) ?? "null";
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
    registry.install(CodingTools);
    registry.install(bot);

    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        settings: {
          // Several queued wakes go into one run.
          steeringMode: "all",
          followUpMode: "all",
          afterFailedRun: "continue",
          retry: { maxRetries: 4 },
          // The fallback when the agent does not turn the page itself.
          get compaction() {
            return options.compaction();
          },
        },
        env: () => new NodeExecutionEnv({ cwd: options.workspace, shellEnv: options.shellEnv }),
        onReport: (error, info) => options.log("pi report", { type: info.type, error: String(error) }),
      },
      context,
    );
    const root = await harness.root(context, { agent: { model: options.model, thinkingLevel: options.thinking } });
    await root.configure({ model: options.model, thinkingLevel: options.thinking, cwd: options.workspace }, context);
    const agent = new Agent(options, harness, root);
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
   * the run to end. Idle: starts a run. The same id is one submission. Returns the submission ID.
   */
  async submit(input: { id: string; text: string; steer: boolean; data?: JsonValue }): Promise<string> {
    const submission = await this.#root.submit(
      {
        type: "input",
        content: input.text,
        requestId: input.id,
        whenBusy: input.steer ? "steer" : "followUp",
        entry: { kind: "bot.wake", ...(input.data === undefined ? {} : { data: input.data }) },
      },
      context,
    );
    return String(submission.id);
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

  async configure(model: ModelRef, thinking: Thinking): Promise<void> {
    this.#model = model;
    await this.#root.configure({ model, thinkingLevel: thinking }, context);
  }

  /**
   * Tokens in the context: the provider's count for the last request, plus an estimate of what came after.
   * pi estimates from characters, which counts Chinese at about half, so the estimate is doubled.
   */
  async contextStatus(): Promise<ContextStatus> {
    const model = this.#options.models.getModel(this.#model.provider, this.#model.modelId);
    const window = model?.contextWindow ?? 200_000;
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
    const policy = { ...DEFAULT_COMPACTION_POLICY, ...this.#options.compaction() };
    const compactAt = window - policy.reserveTokens - (policy.backgroundTokens > 0 ? policy.backgroundTokens : 0);
    return { used, window, compactAt };
  }
}
