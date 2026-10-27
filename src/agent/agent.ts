import { readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { type Message, Type } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  type ModelRef,
  type Storage,
  type SubmissionId,
  section,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { AgentPort, GatewayPort, Wake } from "../core/types.ts";
import {
  type ContextStatus,
  DEFAULT_PERSONA,
  formatTime,
  MEMORY_RULES,
  NUDGE_TURNOVER,
  PATROL_RULES,
  type PromptPaths,
  renderContext,
  renderHandoff,
  renderWake,
  WORK_RULES,
} from "./prompt.ts";

const context = BACKGROUND_CONTEXT;

export interface AgentOptions {
  storage: Storage;
  models: MutableModels;
  model: ModelRef;
  thinking: "low" | "medium" | "high" | "xhigh";
  gateway: GatewayPort;
  /** The gateway's description of the log tables, for the prompt. */
  logSchema: string;
  personaFile?: string;
  paths: PromptPaths;
  turnoverRatio: number;
  compaction: { reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number };
  log: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * The bot's agent: one long-lived pi-durable conversation (the root) that the model only drives through code mode.
 * It implements AgentPort, so the gateway can wake and steer it without knowing pi-durable.
 */
export class Agent implements AgentPort {
  readonly #options: AgentOptions;
  readonly #harness: Harness;
  readonly #root: Conversation;
  /** Our submissions that are not settled yet, with the channel each one is about. */
  readonly #tracked = new Map<SubmissionId, string | undefined>();
  /** Channels the agent posted to in the current busy period. */
  readonly #posted = new Set<string>();

  private constructor(options: AgentOptions, harness: Harness, root: Conversation) {
    this.#options = options;
    this.#harness = harness;
    this.#root = root;
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const { gateway, paths } = options;
    // Filled in once the Harness is open. Tools and hooks only run after that.
    let agent: Agent | undefined;
    const self = () => {
      if (!agent) throw new Error("agent is not open yet");
      return agent;
    };
    /** Conversation → the context head (reset or compaction) it was last asked to turn the page in. */
    const nudged = new Map<number, number | "start">();

    const codemode = createCodemodeExtension({
      sandbox: new CodemodeSandbox({ timeoutMs: 30 * 60_000, memoryLimitBytes: 512 * 1024 * 1024 }),
      models: false,
    });
    const codemodeTool = codemode.tools!.find((tool) => tool.name === "codemode")!;

    const rows = Type.Array(Type.Record(Type.String(), Type.Any()));
    const tools = [
      defineTool({
        name: "log_query",
        description: "Run one read-only SQL statement (SQLite) on the message log. Returns rows as objects, at most 500.",
        parameters: Type.Object({ sql: Type.String(), params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))) }),
        structuredOutputSchema: rows,
        callers: ["tools"],
        replay: "safe",
        execute: async (args) => {
          const result = await gateway.query(args.sql, args.params ?? []);
          return { output: [{ type: "text", text: JSON.stringify(result) }], structuredOutput: result as JsonValue };
        },
      }),
      defineTool({
        name: "slack_send",
        description:
          "Say something in Slack. channel: channel ID, #name, or a user ID for a DM. thread_ts: reply in that thread. text: Markdown. Returns { channel, ts }. Sent exactly once, also across restarts.",
        parameters: Type.Object({ channel: Type.String(), text: Type.String(), thread_ts: Type.Optional(Type.String()) }),
        structuredOutputSchema: Type.Object({ channel: Type.String(), ts: Type.String() }),
        callers: ["tools"],
        // A rerun after a crash keeps the task ID, so the gateway finds the first attempt instead of sending again.
        replay: "safe",
        execute: async (args, api) => {
          const sent = await gateway.send(`task-${api.taskId}`, { channel: args.channel, text: args.text, ...(args.thread_ts ? { threadTs: args.thread_ts } : {}) });
          self().#posted.add(sent.channel);
          return { output: [{ type: "text", text: `sent: ${JSON.stringify(sent)}` }], structuredOutput: { channel: sent.channel, ts: sent.ts } };
        },
      }),
      defineTool({
        name: "slack_react",
        description: "Add (or with remove: true, remove) an emoji reaction, for example eyes or white_check_mark, on the message ts in channel.",
        parameters: Type.Object({ channel: Type.String(), ts: Type.String(), emoji: Type.String(), remove: Type.Optional(Type.Boolean()) }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args) => {
          try {
            await gateway.react(args);
          } catch (error) {
            // A rerun finds the first attempt's reaction already there.
            if (!/already_reacted|no_reaction/.test(String(error))) throw error;
          }
          return { output: [{ type: "text", text: "ok" }] };
        },
      }),
      defineTool({
        name: "patrol_schedule",
        description: "Set when you next wake up to look around (replaces the pending patrol). minutes: from now. note: what to check first.",
        parameters: Type.Object({ minutes: Type.Number(), note: Type.String() }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args) => {
          const dueAt = await gateway.schedulePatrol(args.minutes, args.note);
          return { output: [{ type: "text", text: `next patrol: ${formatTime(dueAt)}` }] };
        },
      }),
      defineTool({
        name: "clock",
        description: "The current local date and time. Scripts have no real clock; use this.",
        parameters: Type.Object({}),
        callers: ["tools"],
        replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: `${formatTime(Date.now())} (unix ms ${Date.now()})` }] }),
      }),
      defineTool({
        name: "context_status",
        description: "How many tokens your context uses now, and the window size.",
        parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ used: Type.Number(), window: Type.Number() }),
        callers: ["tools"],
        replay: "safe",
        execute: async () => {
          const status = await self().contextStatus();
          return { output: [{ type: "text", text: renderContext(status, options.turnoverRatio) }], structuredOutput: { ...status } };
        },
      }),
      defineTool({
        name: "context_reset",
        description:
          "Turn the page: start a new context. Update your notes file first. note: what the next context should do first. The new context gets your notes file in full and this note. Call it last; the current run ends.",
        parameters: Type.Object({ note: Type.String() }),
        callers: ["tools"],
        execute: async (args, api) => {
          const notes = await readFile(paths.notes, "utf8").catch(() => "");
          const conversation = await self().#harness.conversation(api.conversationId, context);
          if (!conversation) throw new Error("conversation not found");
          // Queued while the run is busy; placed at the end of this tool round, where it ends the run.
          await conversation.reset(renderHandoff(args.note, notes, paths.notes), context);
          options.log("context reset", { notesChars: notes.length });
          return { output: [{ type: "text", text: "Page turned. This run ends now." }] };
        },
      }),
    ];

    const bot = defineExtension({
      name: "personal-bot",
      tools,
      sections: [
        section(
          "persona",
          async () => (options.personaFile ? await readFile(options.personaFile, "utf8").catch(() => undefined) : undefined) ?? DEFAULT_PERSONA(gateway.botName),
          { tag: false },
        ),
        section("work", () => WORK_RULES(gateway.botName, paths), { tag: false }),
        section("log", () => `## 消息日志\n${options.logSchema}`, { tag: false }),
        section("memory", () => MEMORY_RULES(paths, Math.round(options.turnoverRatio * 100)), { tag: false }),
        section("patrol", () => PATROL_RULES, { tag: false }),
      ],
      hooks: [
        hook(GenerationTask, {
          // When a run ends with the context past the line, ask once per context to write notes and turn the page.
          onYield: async (_answer, api) => {
            const status = await self().contextStatus();
            if (status.used < status.window * options.turnoverRatio) return undefined;
            const view = await self().#root.context(context);
            const head: number | "start" = view.head?.id ?? "start";
            if (nudged.get(api.conversationId) === head) return undefined;
            nudged.set(api.conversationId, head);
            options.log("turnover nudge", { used: status.used });
            return { continue: NUDGE_TURNOVER(Math.round((status.used / status.window) * 100)) };
          },
        }),
      ],
    });

    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(codemode);
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
          compaction: options.compaction,
        },
        env: () => new NodeExecutionEnv({ cwd: paths.workspace }),
        onReport: (error, info) => options.log("pi report", { type: info.type, error: String(error) }),
      },
      context,
    );
    const root = await harness.root(context, { agent: { model: options.model, thinkingLevel: options.thinking } });
    await root.configure({ model: options.model, thinkingLevel: options.thinking, cwd: paths.workspace, modelTools: [codemodeTool] }, context);
    agent = new Agent(options, harness, root);
    await agent.#recoverTracking();
    harness.resume();
    return agent;
  }

  async close(): Promise<void> {
    await this.#harness.close(context);
  }

  /** Submissions a previous process left queued or running. Wake IDs are "<reason>:<channel>:<ts>". */
  async #recoverTracking(): Promise<void> {
    const inspection = await this.#harness.inspect(context);
    for (const submission of inspection.submissions) {
      if (submission.conversationId !== this.#root.id || submission.type !== "input") continue;
      if (submission.status !== "queued" && submission.status !== "placed") continue;
      const channel = submission.requestId?.split(":")[1];
      this.#track(submission.id, channel || undefined);
    }
  }

  #track(id: SubmissionId, channel: string | undefined): void {
    if (this.#tracked.has(id)) return;
    this.#tracked.set(id, channel);
    void this.#harness
      .submission(id, context)
      .then((submission) => submission?.wait(context))
      .then((settled) => {
        if (settled?.status === "unanswered") this.#options.log("wake unanswered", { id, reason: settled.reason });
      })
      .catch((error) => this.#options.log("wake wait failed", { id, error: String(error) }))
      .finally(() => this.#tracked.delete(id));
  }

  async #submit(wake: Wake, whenBusy: "steer" | "followUp"): Promise<void> {
    const content = renderWake(wake, await this.contextStatus(), this.#options.turnoverRatio);
    const submission = await this.#root.submit(
      { type: "input", content, requestId: wake.id, whenBusy, entry: { kind: "pb.wake", data: { ...wake } as unknown as JsonValue } },
      context,
    );
    this.#track(submission.id, wake.channel);
  }

  wake(wake: Wake): Promise<void> {
    return this.#submit(wake, "followUp");
  }

  steer(wake: Wake): Promise<void> {
    return this.#submit(wake, "steer");
  }

  /** A channel is active while a placed (running) wake is about it, or the agent posted there during the current run. */
  async isActiveChannel(channel: string): Promise<boolean> {
    let running = false;
    for (const [id, about] of this.#tracked) {
      const record = await (await this.#harness.submission(id, context))?.status(context);
      if (record?.status !== "placed") continue;
      running = true;
      if (about === channel) return true;
    }
    if (!running) {
      this.#posted.clear();
      return false;
    }
    return this.#posted.has(channel);
  }

  /**
   * Tokens in the context: the provider's count for the last request, plus an estimate of what came after.
   * pi estimates from characters, which counts Chinese at about half, so the estimate is doubled.
   */
  async contextStatus(): Promise<ContextStatus> {
    const model = this.#options.models.getModel(this.#options.model.provider, this.#options.model.modelId);
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
    return { used, window };
  }
}
