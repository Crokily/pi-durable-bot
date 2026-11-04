import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "@earendil-works/chord/context";
import { type Message, type Models, Type } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  configure,
  type Conversation,
  type ConversationId,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  type ModelRef,
  type PromptInput,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  type TaskId,
  SystemEntry,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type BashExecution, createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Sql } from "../core/sql.ts";
import { type ChildEnd, type ChildInfo, type ChildRecord, type ChildrenState, Children, childInfo, childrenExtension, reportRequestId } from "./children.ts";
import { deleteLeftForks, lastAnswer, type MemoryHost, MemoryPasses, readPaths, withAgeNote } from "./memory.ts";
import { modelRef, requireModel } from "./models.ts";
import { NO_SCREEN, renderBusy, type Screen, ScreenLeases } from "./screen.ts";

const context = BACKGROUND_CONTEXT;

/** A stopped child, with what its stop must end. */
interface Stop {
  id: string;
  title: string;
  conversationId: ConversationId;
  /** All its reporters, to find their reports in the main agent's queue. */
  reporters: readonly string[];
  /** Those that have not ended yet. */
  live: readonly string[];
}

/**
 * What the agent's channel tools do. The bot provides them; the agent knows no platform. trace: the tool call's span,
 * so the gateway's spans for the action are part of it.
 */
export interface AgentActions {
  send(to: string, text: string, sendId: string, trace?: TelemetrySpan): Promise<{ message: string; recovered?: boolean; repeated?: boolean }>;
  react(message: string, emoji: string, remove: boolean, trace?: TelemetrySpan): Promise<void>;
  call(channel: string, method: string, params: Record<string, unknown>, trace?: TelemetrySpan): Promise<unknown>;
}

/** pi's levels. A level the model does not have becomes the nearest one it has, at each request (pi-ai). */
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /** Environment of bash commands, without the screen's variables. */
  shellEnv: NodeJS.ProcessEnv;
  /** The bot's screen for the screen tool, read at each call, and the bot as other agents see it when it holds a lease. */
  screen: {
    current(): Screen;
    /** The bot's folder. */
    bot: string;
    name(): string;
    /** The leases; by default the one store of this process. */
    leases?: ScreenLeases;
  };
  /**
   * System prompt parts, rendered before each request in this order. pi-durable sends only the parts that changed, at
   * the end of the conversation. Keep the order: a new part goes at the end, and a part in the middle must not come and
   * go, or every part is sent again.
   */
  sections: readonly AgentSection[];
  /** The children the main agent starts with the task tool. */
  children: {
    /** "provider/modelId" of children; unset: the main model. */
    model(): string | undefined;
    /** The thinking level of a new child when the main agent does not choose one. */
    thinking(): Thinking;
    /** How many children may work at once. */
    max(): number;
    /**
     * A child's system prompt parts. Those before the last pinned one stay the same for every child, so children share
     * the start of their requests. A pinned part keeps the text of the child's first request for its whole conversation.
     */
    sections: readonly AgentSection[];
    /** The place the main agent works on now, when it works on one: a new child works for it unless told otherwise. */
    place(): string | undefined;
    /** Hand a child's end to the main agent as a wake; the same reporter is one wake. Returns its submission ID. */
    ended(end: ChildEnd, context: Context): Promise<string>;
  };
  /**
   * Set after an upgrade: the main conversation's requests show the new text of pinned sections, as a new page does, so
   * what the new version tells the agent counts at once. Called once the first of them is about to go out, when its
   * sections are saved in the conversation; until then, after a crash too, the next request does it again.
   */
  refreshPinned?: () => Promise<void>;
  /** The memory passes after each run of the main conversation, the dream and the age note; without it, there are none. */
  memory?: MemoryHost;
  actions: AgentActions;
  /** Where pi-durable's and pi-ai's spans go: submissions, task phases, tool calls, model requests. */
  telemetry?: TelemetryContext;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface AgentSection {
  name: string;
  render: () => Promise<string | undefined> | string | undefined;
  /**
   * Keep the text it had when the page began: a new text shows after the page turns or pi compacts. A change in the
   * middle of a page is sent again at the end of the conversation; on a model that takes system text only at the start,
   * it changes the start of every request, and the provider's prompt cache misses. In a child's sections: keep the text
   * of the child's first request for its whole conversation.
   */
  pin?: boolean;
}

export interface ContextStatus {
  /** Tokens in the context now. */
  used: number;
  window: number;
  /** Where pi starts compacting on its own. */
  compactAt: number;
}

/** How the model requests of the current context used the provider's prompt cache. */
export interface CacheUse {
  requests: number;
  /** Input tokens of all requests, read from the cache or not. */
  input: number;
  /** Of them, read from the cache. */
  cacheRead: number;
  /** In USD, as pi prices the model. */
  cost: number;
  /** Requests that read less than half of their input from the cache, and what they cost. */
  missed: number;
  missedCost: number;
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
 * The bot's agent: one long-lived pi-durable conversation (the root). Tools: read, write, edit, bash, screen (bash with
 * the screen's environment and a lease on the screen), the channel actions send, react and call, and task. Its children
 * have read, write, edit, bash and screen. Everything else the agents do with code.
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
  #children: readonly ChildInfo[] = [];
  #disposeChildren?: () => void;
  #memory: MemoryPasses | undefined;
  #closing = false;
  /** Stops the last process did not finish; resume() finishes them. */
  #unfinishedStops: Stop[] = [];
  /**
   * Crash tests: called just before and just after a child's end is handed to the main agent, right after a stop
   * marked a child stopped, before its work ended, and right before a memory pass forks the main conversation.
   */
  readonly crashTests: {
    beforeReport?: (reporter: string) => void;
    afterReport?: (reporter: string) => void;
    afterStopMark?: (child: string) => void;
    beforeMemoryPass?: () => void;
  } = {};

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
    // A memory fork that a stop or a crash cut off is deleted before pi-durable opens, so it does not run on.
    if (options.memory) {
      const left = await deleteLeftForks(options.database);
      if (left > 0) options.log("deleted memory forks a stop left", { forks: left });
    }
    await requireChatModel(models, options.model);
    const text = (value: string) => [{ type: "text" as const, text: value }];
    // Opened at the first screen call, so a bot that never uses the screen leaves no file.
    const leases = () => options.screen.leases ?? ScreenLeases.shared();
    // The children, as the main conversation's document has them; kept up to date once the harness is open.
    let children: readonly ChildInfo[] = [];
    // Who holds a screen, as the other agents read it.
    const describeAgent = (conversation: string) => {
      if (conversation === String(ROOT_CONVERSATION_ID)) return "the main agent";
      const child = children.find((each) => each.conversationId === conversation);
      return child ? `the main agent's child ${child.id} ("${child.title}")` : `the agent of conversation ${conversation}`;
    };
    // Commands get exactly this environment, not the gateway's: the screen's variables only in the screen tool.
    const base = Object.fromEntries(Object.entries(options.shellEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const environment =
      (extra: Record<string, string> = {}) =>
      (execution: BashExecution) => {
        execution.inheritEnv = false;
        execution.env = { ...base, ...extra, ...execution.env };
      };
    /** The channel actions, for the main agent only: children have no send, react or call. */
    const channelTools = [
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
    const screenTool = defineTool({
      ...createBashTool(),
      name: "screen",
      description:
        "Run a bash command on your screen: like bash, with the screen's environment (such as DISPLAY), which bash does not have. " +
        "Use it for anything on the screen: screenshots, mouse, keyboard, and the apps and the browser on it. Only one agent uses a screen at a time: " +
        "your first call takes the screen until your work ends, and while another agent has it, the command does not run and you learn who has it.",
      // A rerun after a crash could click twice: the model gets an interrupted result instead.
      replay: "unsafe",
      execute: async (args, api, call) => {
        const screen = options.screen.current();
        if (screen.key === undefined) return { output: text(NO_SCREEN), isError: true };
        const taken = leases().take(screen.key, {
          bot: options.screen.bot,
          name: options.screen.name(),
          agent: describeAgent(String(api.conversationId)),
          conversation: String(api.conversationId),
        });
        if (!taken.ok) return { output: text(renderBusy(screen, taken.lease, leases().idleMs, options.screen.bot)), isError: true };
        try {
          return await createBashTool({ prepare: environment(screen.env) }).execute(args, api, call);
        } finally {
          taken.done();
        }
      },
    });

    let harness: Harness | undefined;
    // After an upgrade, the main conversation's pinned sections show their new text until a request with it goes out.
    let refresh: "waiting" | "rendered" | "done" = options.refreshPinned ? "waiting" : "done";
    const recordRefresh = hook(GenerationTask, {
      // Here the request's sections are saved in the conversation. Not for a request whose sections an earlier process
      // wrote: those may be the old ones.
      beforeRequest: async (_request, api) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID || refresh !== "rendered") return undefined;
        refresh = "done";
        await options.refreshPinned!().catch((error: unknown) => options.log("could not record the refresh", { error: String(error) }));
        return undefined;
      },
    });
    // All sections of one request preparation get the same input, so this answer is per preparation.
    // Whether the request starts a page: pi-durable then writes every section anew (planSystemEntries). Asked only when
    // a pinned section has a new text.
    const pageStarts = new WeakMap<PromptInput, Promise<boolean>>();
    const startsPage = (input: PromptInput, context: Context) => {
      let answer = pageStarts.get(input);
      if (!answer) {
        answer = (async () => {
          const view = await (await harness?.conversation(input.conversationId, context))?.context(context);
          const head = view?.head;
          return head !== undefined && !view!.entries.some((entry) => entry.id > head.id && SystemEntry.is(entry));
        })();
        pageStarts.set(input, answer);
      }
      return answer;
    };
    const render = (part: AgentSection) => async (input: PromptInput, context: Context) => {
      const text = await part.render();
      if (!part.pin) return text;
      const shown = input.shown[part.name];
      // A memory fork keeps what it took from the main conversation, so its request starts as the main agent's did.
      if (input.conversationId !== ROOT_CONVERSATION_ID) return shown;
      if (refresh !== "done") refresh = "rendered";
      if (refresh !== "done" || shown === undefined || shown === text) return text;
      return (await startsPage(input, context)) ? text : shown;
    };
    const bot = defineExtension({
      name: "bot",
      tools: [...channelTools, screenTool],
      sections: options.sections.map((part) => section(part.name, render(part), { tag: false })),
      hooks: [recordRefresh],
    });
    /** The text a pinned section had at a child's first request: its first system entry has every section. */
    const firstText = async (conversation: ConversationId, name: string, context: Context) => {
      const page = await (await harness?.conversation(conversation, context))?.entries({ order: "ascending" }, 10, undefined, context);
      const first = page?.items.find((entry) => SystemEntry.is(entry))?.model?.find((message) => message.role === "system");
      return first?.role === "system" ? (first.sections?.[name] ?? undefined) : undefined;
    };
    // A child is a conversation of its own, not a fork: a pinned section shows the text of its first request, also after
    // pi compacts the child, when the conversation no longer shows it.
    const childRender = (part: AgentSection) => async (input: PromptInput, context: Context) =>
      part.pin ? (input.shown[part.name] ?? (await firstText(input.conversationId, part.name, context)) ?? (await part.render())) : part.render();
    // A child has the main agent's coding tools and screen, with its own prompt: no channel actions and no task tool.
    const child = defineExtension({
      name: "child",
      tools: [screenTool],
      sections: options.children.sections.map((part) => section(part.name, childRender(part), { tag: false })),
    });
    const read = createReadTool({ images: await (images ??= createNodePhotonImages()) });
    const memoryFolders = () => (options.memory?.enabled() ? options.memory.folders : undefined);
    const coding = defineExtension({
      name: "coding-tools",
      tools: [
        // A memory file read 2 days or more after it changed says so, for every agent of the bot.
        defineTool({ ...read, execute: async (args, api, call) => withAgeNote(await read.execute(args, api, call), args.path, memoryFolders(), options.workspace) }),
        createWriteTool(),
        createEditTool(),
        createBashTool({ prepare: environment() }),
      ],
    });
    let agent: Agent | undefined;
    const self = () => {
      if (!agent) throw new Error("the agent is still starting");
      return agent;
    };
    const tasks = childrenExtension({
      agent: () => ({ model: self().#childModel(), thinkingLevel: options.children.thinking() }),
      max: () => options.children.max(),
      place: () => options.children.place(),
      extensions: () => ({ child: [coding, child] }),
      ended: (end, context) => options.children.ended(end, context),
      withdraw: async (submission) => {
        await self().#harness.abortSubmission(Number(submission) as SubmissionId, context, ROOT_CONVERSATION_ID);
      },
      stop: (id) => self().stopChild(id),
      settled: (conversation) => self().#releaseScreen(conversation),
      beforeReport: (reporter) => self().crashTests.beforeReport?.(reporter),
      afterReport: (reporter) => self().crashTests.afterReport?.(reporter),
    });
    const memory = options.memory ? new MemoryPasses({ host: options.memory, sql: options.database, cwd: options.workspace, context, log: options.log }) : undefined;
    const registry = createRegistry();
    registry.install(coding);
    registry.install(bot);
    registry.install(tasks);
    registry.install(child);
    if (memory) registry.install(memory.extension);

    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          // The main agent's; a child selects its own.
          extensions: [coding, bot, tasks],
          // Several queued wakes go into one run.
          steeringMode: "all",
          followUpMode: "all",
          afterFailedRun: "continue",
          retry: { maxRetries: 4 },
          // The fallback when the agent does not turn the page itself.
          get compaction() {
            const main = agent ? agent.#model : modelRef(options.model);
            const policy = compactionFor(models, main, options.compaction());
            // Children may have another model, with another window.
            const childModel = modelRef(options.children.model() ?? `${main.provider}/${main.modelId}`);
            const key = `${childModel.provider}/${childModel.modelId}`;
            return key === `${main.provider}/${main.modelId}` ? policy : { ...policy, modelOverrides: { [key]: compactionFor(models, childModel, options.compaction()) } };
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
    if (memory) {
      memory.attach(harness, root);
      memory.beforePass = () => agent?.crashTests.beforeMemoryPass?.();
      agent.#memory = memory;
    }
    await agent.#watchRun();
    await agent.#watchChildren((list) => (children = list));
    await agent.#holdUnfinishedStops();
    // bot.json may have changed while the bot was stopped: the children that go on get the model new children get.
    await agent.#configureChildren(agent.#childModel());
    return agent;
  }

  /** Continue the work the last process left unfinished. Call once the channels are up, so its tools can act. */
  async resume(): Promise<void> {
    this.#harness.resume();
    for (const stop of this.#unfinishedStops.splice(0)) await this.#finishStop(stop);
    // What extraction did not cover before the last process stopped: a run that ended, but whose pass did not end.
    if (this.#memory && this.#runInputs === undefined) {
      const at = await lastAnswer(this.#root, context);
      if (at !== undefined) this.#memory.queue(at);
    }
  }

  /**
   * A stop that the last process did not finish: before any work runs, mark the child's work and its reporters to end
   * and withdraw what waits for the child or comes from it, so the child does not go on for a moment after the start.
   * None of this runs work. resume() then finishes these stops.
   */
  async #holdUnfinishedStops(): Promise<void> {
    const state = await this.#harness.snapshot(Children, ROOT_CONVERSATION_ID, context);
    const stops = Object.values(state?.children ?? {}).flatMap((record) => (record.stoppedAt !== undefined && !record.stopFinished ? [stopOf(state!, record)] : []));
    if (stops.length === 0) return;
    const conversations = new Set(stops.map((stop) => stop.conversationId));
    const { tasks, submissions } = await this.#harness.inspect(context);
    for (const { record } of tasks) {
      if (conversations.has(record.conversationId) && record.owner === undefined && !record.background) await this.#harness.abortTask(record.id, context);
    }
    for (const submission of submissions) {
      if (conversations.has(submission.conversationId) && submission.status === "queued") await this.#harness.abortSubmission(submission.id, context);
    }
    for (const stop of stops) {
      for (const reporter of stop.live) await this.#harness.abortTask(Number(reporter) as TaskId, context);
      await this.#withdrawReports(stop);
    }
    this.#unfinishedStops = stops;
  }

  async #watchRun(): Promise<void> {
    const view = await this.#root.viewState(context);
    const update = (value: { docs: Readonly<Record<string, unknown>> }) => {
      const live = value.docs["pi.live"] as { run?: { inputs?: unknown[] } } | undefined;
      const inputs = live?.run ? (live.run.inputs ?? []).map(String) : undefined;
      const changed = (inputs === undefined) !== (this.#runInputs === undefined) || inputs?.join() !== this.#runInputs?.join();
      // A run ended (pi-durable can end one and start the next in one commit): the main agent's screen lease ends with
      // it, and a memory pass looks at it.
      if (this.#runInputs !== undefined && inputs?.[0] !== this.#runInputs[0]) {
        this.#releaseScreen(String(ROOT_CONVERSATION_ID));
        void this.#remember(this.#runInputs);
      }
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

  /** A memory pass for a run that ended with an answer. */
  async #remember(inputs: readonly string[]): Promise<void> {
    if (!this.#memory || this.#closing) return;
    try {
      let at: number | undefined;
      for (const id of inputs) {
        const record = await (await this.#harness.submission(Number(id) as SubmissionId, context))?.status(context);
        if (record?.type === "input" && record.status === "done" && (at === undefined || record.answer > at)) at = record.answer;
      }
      if (at !== undefined && !this.#closing) this.#memory.queue(at);
    } catch (error) {
      if (!this.#closing) this.#options.log("could not start the memory pass", { error: String(error) });
    }
  }

  /** The files the main agent read in its current context, for the note after a memory pass. */
  async readFiles(): Promise<Set<string>> {
    return readPaths((await this.#root.context(context)).messages, this.#options.workspace);
  }

  /** Keep the children list up to date from the main conversation's children document. */
  async #watchChildren(changed: (children: readonly ChildInfo[]) => void): Promise<void> {
    // Created empty at the first start, so there is always one to watch.
    await this.#root.commit(async (tx) => {
      await tx.doc(Children, ROOT_CONVERSATION_ID);
    }, context);
    const state = await this.#harness.documentState(Children, ROOT_CONVERSATION_ID, context);
    if (!state) return;
    const update = (value: Readonly<{ children: Readonly<Record<string, Parameters<typeof childInfo>[0]>> }> | null) => {
      const list = Object.values(value?.children ?? {})
        .map(childInfo)
        .sort((a, b) => a.startedAt - b.startedAt);
      this.#children = list;
      changed(list);
    };
    update(state.value);
    const unsubscribe = state.subscribe(update);
    this.#disposeChildren = () => {
      unsubscribe();
      state.dispose();
    };
  }

  /** The main agent's children, oldest first. */
  get children(): readonly ChildInfo[] {
    return this.#children;
  }

  /** The model of children: bot.json's childModel, else the main model. */
  #childModel(childModel = this.#options.children.model()): ModelRef {
    return childModel ? modelRef(childModel) : this.#model;
  }

  /**
   * Give every child that is not stopped this model for children ("provider/modelId"; unset: the main model), which new
   * children get too. A child keeps its thinking level. Throws for an unknown model.
   */
  async configureChildren(childModel: string | undefined): Promise<void> {
    if (childModel) await requireChatModel(this.#models, childModel);
    // Not #childModel(childModel): for undefined, its default reads bot.json's childModel from before this change.
    await this.#configureChildren(childModel ? modelRef(childModel) : this.#model);
  }

  async #configureChildren(model: ModelRef): Promise<void> {
    const children = this.#children.filter((child) => child.stoppedAt === undefined);
    if (children.length === 0) return;
    await this.#root.commit(async (tx) => {
      for (const child of children) await configure(tx, Number(child.conversationId) as ConversationId, { model });
    }, context);
  }

  /**
   * Stop a child: its work and what it runs end, the messages it has not taken are withdrawn, and nothing comes back
   * from it, also a report that waits in the main agent's queue. Returns what happened, in words for the model.
   */
  async stopChild(id: string): Promise<string> {
    const found = await this.#root.commit(async (tx) => {
      const state = await tx.doc(Children, ROOT_CONVERSATION_ID);
      const record = Object.hasOwn(state.children, id) ? state.children[id] : undefined;
      if (!record) return undefined;
      if (record.stopFinished) return { title: record.title, stopped: true } as const;
      // A stop that a crash cut off is done again from here.
      const marked = record.stoppedAt === undefined;
      record.stoppedAt ??= Date.now();
      delete record.since;
      return { stopped: false, marked, ...stopOf(state, record) } as const;
    }, context);
    if (!found) return `No child ${id}.`;
    if (found.stopped) return `${id} ("${found.title}") was stopped before.`;
    if (found.marked) this.crashTests.afterStopMark?.(id);
    await this.#finishStop(found);
    return `Stopped ${id} ("${found.title}"). Nothing comes back from it.`;
  }

  /** End a stopped child's work, then record that, so a stop cut off by a crash is finished at the next start. */
  async #finishStop(stop: Stop): Promise<void> {
    // Its reporters first, and wait until they ended: then none of them gives the child a message or reports anew.
    for (const reporter of stop.live) {
      const task = Number(reporter) as TaskId;
      await this.#harness.abortTask(task, context);
      await this.#harness.waitForTask(task, context);
    }
    await (await this.#harness.conversation(stop.conversationId, context))?.abort(context);
    await this.#withdrawReports(stop);
    this.#releaseScreen(String(stop.conversationId));
    await this.#root.commit(async (tx) => {
      const record = (await tx.doc(Children, ROOT_CONVERSATION_ID)).children[stop.id];
      if (record) record.stopFinished = true;
    }, context);
  }

  /** Withdraw the reports of a stopped child that wait in the main agent's queue. */
  async #withdrawReports(stop: Stop): Promise<void> {
    const queued = await this.#root.commit(async (tx) => {
      const ids: SubmissionId[] = [];
      for (const reporter of stop.reporters) {
        const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, reportRequestId(reporter));
        if (submission?.status === "queued") ids.push(submission.id);
      }
      return ids;
    }, context);
    for (const submission of queued) await this.#harness.abortSubmission(submission, context, ROOT_CONVERSATION_ID);
  }

  /** Stop every child that is not stopped yet. Returns what happened to each. */
  async stopChildren(): Promise<string[]> {
    const results: string[] = [];
    for (const child of this.#children) if (child.stoppedAt === undefined) results.push(await this.stopChild(child.id));
    return results;
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#disposeView?.();
    this.#disposeChildren?.();
    // The pass that runs ends when pi-durable closes; its fork is deleted at the next start.
    const passes = this.#memory?.close();
    try {
      await this.#harness.close(context);
      await passes;
    } finally {
      this.#releaseScreen();
    }
  }

  /** Give up the screen lease of one conversation of the bot, or of all of them. */
  #releaseScreen(conversation?: string): void {
    try {
      (this.#options.screen.leases ?? ScreenLeases.opened)?.release(this.#options.screen.bot, conversation);
    } catch (error) {
      this.#options.log("could not give up the screen", { error: String(error) });
    }
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

  /** The prompt cache use of the model requests in the current context, from the usage pi recorded for each answer. */
  async cacheUse(): Promise<CacheUse> {
    const use: CacheUse = { requests: 0, input: 0, cacheRead: 0, cost: 0, missed: 0, missedCost: 0 };
    for (const message of (await this.#root.context(context)).messages) {
      if (message.role !== "assistant") continue;
      const { input, cacheRead, cacheWrite, cost } = message.usage;
      const all = input + cacheRead + cacheWrite;
      if (all === 0) continue;
      use.requests++;
      use.input += all;
      use.cacheRead += cacheRead;
      use.cost += cost.total;
      if (cacheRead * 2 < all) {
        use.missed++;
        use.missedCost += cost.total;
      }
    }
    return use;
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

/** A stopped child as its stop sees it: its reporters, and those still live. */
function stopOf(state: Readonly<ChildrenState>, record: Readonly<ChildRecord>): Stop {
  return {
    id: record.id,
    title: record.title,
    conversationId: record.conversationId,
    reporters: [...record.reporters],
    live: Object.entries(state.live).flatMap(([reporter, child]) => (child === record.id ? [reporter] : [])),
  };
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
