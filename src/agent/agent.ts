import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  configure,
  type Conversation,
  type ConversationDocToken,
  type ConversationId,
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  InboxDoc,
  type JsonObject,
  LiveDoc,
  type LiveState,
  type ModelRef,
  type Observer,
  type PromptInput,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  type TaskId,
  SystemEntry,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type BashExecution, createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { bool, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import {
  age,
  type CallTask,
  type ChildActivity,
  type ChildCall,
  type ChildEnd,
  type ChildInfo,
  type ChildRecord,
  type ChildrenState,
  Children,
  childActivity,
  childInfo,
  childrenExtension,
  describeActivity,
  reportRequestId,
} from "./children.ts";
import type { Codemode } from "./codemode.ts";
import type { Mcp } from "./mcp.ts";
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

/** The bot's SQLite connection, pi-durable's. The gateway and the bot use it as `Sql`. */
export type Database = SqliteDatabase;

/** Open the bot's SQLite file. The one connection is shared: the agent's tables start with pi_, the others use it too. */
export function openDatabase(path: string): Promise<Database> {
  return openNodeSqliteDatabase(path);
}

export interface AgentOptions {
  database: Database;
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
  /**
   * The children the main agent starts with the task tool. It chooses each one's model and thinking level; a child
   * without a model of its own has the main model, also after it changes.
   */
  children: {
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
  /** pi's code mode: the codemode tool of the main agent and of every child, also without an MCP server. */
  codemode: Codemode;
  /**
   * The bot's MCP servers, whose tools codemode scripts call: one set of connections for the main agent and its
   * children. Closed with the agent.
   */
  mcp?: Mcp;
  actions: AgentActions;
  /** Where pi-durable's and pi-ai's spans go: submissions, task phases, tool calls, model requests. */
  telemetry?: TelemetryContext;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface AgentSection {
  name: string;
  /** input: the request's, with the tools of its agent; absent when the context use is estimated before an answer. */
  render: (input?: PromptInput, context?: Context) => Promise<string | undefined> | string | undefined;
  /**
   * Keep the text it had when the page began: a new text shows after the page turns or pi compacts. A change in the
   * middle of a page is sent again at the end of the conversation; on a model that takes system text only at the start,
   * it changes the start of every request, and the provider's prompt cache misses. In a child's sections: keep the text
   * of the child's first request for its whole conversation. A section whose render gives no text leaves at once.
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
/** How long an interrupt waits for a child's tool calls to end. */
const INTERRUPT_WAIT_MS = 10_000;
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
 * the screen's environment and a lease on the screen), the channel actions send, react and call, task, and codemode
 * (scripts that call the other tools and the MCP servers' tools). Its children have read, write, edit, bash, screen and
 * codemode. Everything else the agents do with code.
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
  /** The running tool calls that give output as they run, by tool task, with when their last output came. */
  readonly #outputs: Map<string, number | undefined>;
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

  private constructor(options: AgentOptions, harness: Harness, root: Conversation, outputs: Map<string, number | undefined>) {
    this.#options = options;
    this.#harness = harness;
    this.#root = root;
    this.#outputs = outputs;
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
    // When each running call of bash, screen and codemode last gave output, so a child's description can say how old its
    // last output is. Only in memory: a call does not run on after a restart.
    const outputs = new Map<string, number | undefined>();
    const timed = <T extends ToolRegistration>(tool: T): T =>
      defineTool({
        ...tool,
        execute: async (args, api, call) => {
          const key = String(api.taskId);
          outputs.set(key, undefined);
          const output = (chunk: string | Uint8Array, skipped?: Parameters<typeof api.output>[1]) => {
            outputs.set(key, Date.now());
            api.output(chunk, skipped);
          };
          try {
            return await tool.execute(args, new Proxy(api, { get: (target, property) => (property === "output" ? output : Reflect.get(target, property, target)) }), call);
          } finally {
            outputs.delete(key);
          }
        },
      }) as T;
    /** The channel actions, for the main agent only: children have no send, react or call. */
    const channelTools = [
      defineTool({
        name: "send",
        description:
          "Say something in a channel. to: a place, thread, message or person address, copied from a wake message or the log. " +
          "A place gets a new message; a thread or message gets a reply in that thread; a person gets a DM. text: Markdown; " +
          "write <person address> to mention someone. Sent exactly once, also across restarts. Returns the new message's address.",
        parameters: obj({ to: str(), text: str() }, { open: true }),
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
        parameters: obj({ message: str(), emoji: str(), remove: opt(bool()) }, { open: true }),
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
        parameters: obj({ channel: str(), method: str(), params: opt(map(unknown())) }, { open: true }),
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
    const screenTool = timed(
      defineTool({
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
      }),
    );

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
      const text = await part.render(input, context);
      // A section without a text leaves at once, also a pinned one, as the memory section when the memory is turned off.
      if (!part.pin || text === undefined) return text;
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
    const childRender = (part: AgentSection) => async (input: PromptInput, context: Context) => {
      const text = await part.render(input, context);
      if (!part.pin || text === undefined) return text;
      return input.shown[part.name] ?? (await firstText(input.conversationId, part.name, context)) ?? text;
    };
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
        timed(createBashTool({ prepare: environment() })),
      ],
    });
    // pi's code mode, for the main agent and its children. As in pi, a script waits for the MCP servers it names, or for
    // all of them when it looks tools up, so it sees their tools. A server that connected meanwhile came after this
    // call's phase resolved the agent: then the script gets the agent as it is now, with that server's tools.
    const [script, ...scriptModels] = options.codemode.tools;
    const codemodeTool = timed(
      defineTool({
        ...script!,
        execute: async (args, api, call) => {
          const code = (args as { code?: unknown }).code;
          if (!(await options.mcp?.ready(typeof code === "string" ? code : "", call.abortSignal))) return script!.execute(args, api, call);
          const now = await (await harness!.conversation(api.conversationId, call))!.agent(call);
          const current = new Proxy(api, { get: (target, property) => (property === "agent" ? async () => now : Reflect.get(target, property, target)) });
          return script!.execute(args, current, call);
        },
      }),
    );
    const codemode = defineExtension({ name: "codemode", tools: [codemodeTool, ...scriptModels] });
    // The servers' tools, which only scripts call: a new extension of the same name each time servers connect or go.
    const mcp = () => options.mcp?.extension() ?? defineExtension({ name: "mcp" });
    let agent: Agent | undefined;
    const self = () => {
      if (!agent) throw new Error("the agent is still starting");
      return agent;
    };
    const tasks = childrenExtension({
      mainModel: () => self().#model,
      childModel: (model) => childModel(models, model),
      max: () => options.children.max(),
      place: () => options.children.place(),
      extensions: () => ({ child: [coding, child, codemode, mcp()] }),
      ended: (end, context) => options.children.ended(end, context),
      withdraw: async (submission) => {
        await self().#harness.abortSubmission(Number(submission) as SubmissionId, context, ROOT_CONVERSATION_ID);
      },
      stop: (id) => self().stopChild(id),
      activity: (conversation) => self().#activity(conversation),
      interrupt: (child) => self().interruptChild(child),
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
    registry.install(codemode);
    registry.install(mcp());
    options.mcp?.onChange(() => registry.install(mcp()));
    if (memory) registry.install(memory.extension);

    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          // The main agent's; a child selects its own.
          extensions: [coding, bot, tasks, codemode, mcp()],
          // Several queued wakes go into one run.
          steeringMode: "all",
          followUpMode: "all",
          afterFailedRun: "continue",
          retry: { maxRetries: 4 },
          // The fallback when the agent does not turn the page itself.
          get compaction() {
            const main = agent ? agent.#model : modelRef(options.model);
            const set = options.compaction();
            const policy = compactionFor(models, main, set);
            // Children may have other models, with other windows: each model a child has gets its own.
            const others = new Set(children.flatMap((child) => (child.model !== undefined && child.model !== `${main.provider}/${main.modelId}` ? [child.model] : [])));
            if (others.size === 0) return policy;
            return { ...policy, modelOverrides: Object.fromEntries([...others].map((model) => [model, compactionFor(models, modelRef(model), set)])) };
          },
        },
        env: () => new NodeExecutionEnv({ cwd: options.workspace, shellEnv: options.shellEnv }),
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        onReport: (report) => options.log("pi report", { type: report.kind, error: String(report.error) }),
      },
      context,
    );
    const model = modelRef(options.model);
    const root = await harness.root(context, { agent: { model, thinkingLevel: options.thinking } });
    await root.configure({ model, thinkingLevel: options.thinking, cwd: options.workspace }, context);
    agent = new Agent(options, harness, root, outputs);
    if (memory) {
      memory.attach(harness, root);
      memory.beforePass = () => agent?.crashTests.beforeMemoryPass?.();
      agent.#memory = memory;
    }
    await agent.#watchRun();
    await agent.#watchChildren((list) => (children = list));
    await agent.#holdUnfinishedStops();
    // bot.json may have changed the model while the bot was stopped: the children without a model of their own get it.
    await agent.#configureChildren();
    return agent;
  }

  /** Continue the work the last process left unfinished. Call once the channels are up, so its tools can act. */
  async resume(): Promise<void> {
    this.#harness.resume();
    for (const stop of this.#unfinishedStops.splice(0)) await this.#finishStop(stop);
    await this.#memory?.recover();
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
    const update = (live: Readonly<LiveState>) => {
      const inputs = live.run?.inputs.map(String);
      const changed = (inputs === undefined) !== (this.#runInputs === undefined) || inputs?.join() !== this.#runInputs?.join();
      // A run ended (pi-durable can end one and start the next in one commit): the main agent's screen lease ends with
      // it, and a memory pass looks at it.
      const ended = this.#runInputs !== undefined && inputs?.[0] !== this.#runInputs[0] ? this.#runInputs : undefined;
      this.#runInputs = inputs;
      if (!ended && !changed) return;
      // pi-durable calls an observer inside its commit, where it may not call pi-durable: the rest comes after it.
      queueMicrotask(() => {
        try {
          if (ended) {
            this.#releaseScreen(String(ROOT_CONVERSATION_ID));
            void this.#remember(ended);
          }
          if (changed) for (const listener of this.#runListeners) listener(inputs);
        } catch (error) {
          this.#options.log("a run change failed", { error: String(error) });
        }
      });
    };
    this.#disposeView = await this.#observe(LiveDoc, update);
  }

  /**
   * Follow a document of the main conversation: `update` gets its value now, then the value of every commit that changes
   * it, one call each, not folded. It runs inside pi-durable's commit, so it only records. Returns how to stop.
   */
  async #observe<T extends JsonObject>(token: ConversationDocToken<T>, update: (value: Readonly<T>) => void): Promise<() => void> {
    let changed = false;
    const observer: Observer<Readonly<T>> = {
      advance: (call) => {
        if (call.kind !== "value") return;
        changed = true;
        update(call.value);
      },
      end: () => {},
    };
    const observation = await this.#harness.observeDoc(token, ROOT_CONVERSATION_ID, observer, context);
    if (!observation) throw new Error("the main conversation has no such document");
    // A change can come before the attachment resolves, and is newer than the attachment's value.
    if (!changed) update(observation.value);
    return () => observation.detach();
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
    this.#disposeChildren = await this.#observe(Children, (value) => {
      const list = Object.values(value.children)
        .map(childInfo)
        .sort((a, b) => a.startedAt - b.startedAt);
      this.#children = list;
      changed(list);
    });
  }

  /** The main agent's children, oldest first. */
  get children(): readonly ChildInfo[] {
    return this.#children;
  }

  /** Children with what each one that works does now, read from its conversation. */
  async childrenNow(children: readonly ChildInfo[] = this.#children): Promise<ChildInfo[]> {
    return Promise.all(
      children.map(async (child) => {
        if (child.since === undefined || child.stoppedAt !== undefined) return child;
        const activity = await this.#activity(Number(child.conversationId) as ConversationId);
        return activity === undefined ? child : { ...child, activity };
      }),
    );
  }

  /** What a working child does now: its current tool calls or model answer, and the messages that wait for it. */
  async #activity(conversation: ConversationId): Promise<ChildActivity | undefined> {
    try {
      const [live, inbox] = await Promise.all([this.#harness.snapshot(LiveDoc, conversation, context), this.#harness.snapshot(InboxDoc, conversation, context)]);
      const running = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].flatMap((slot) => (slot.taskId !== undefined && slot.status !== "done" ? [slot.taskId] : []));
      const tasks = new Map<string, CallTask>();
      for (const id of running) {
        const record = await this.#harness.getTask(id, context);
        if (!record) continue;
        const checkpoint = record.state.checkpoint as { phase?: unknown; arguments?: JsonObject } | undefined;
        tasks.set(String(id), {
          ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
          ...(checkpoint?.phase === "execute" && checkpoint.arguments ? { arguments: checkpoint.arguments } : {}),
        });
      }
      return childActivity(live, inbox, tasks, this.#outputs);
    } catch (error) {
      this.#options.log("could not read what a child does", { conversation: String(conversation), error: String(error) });
      return undefined;
    }
  }

  /**
   * End the tool calls a working child is in, such as a command that hangs. The child goes on: each call's result says
   * it was aborted, and the child takes the messages that wait for it. Returns what happened, in words for the model.
   */
  async interruptChild(child: ChildInfo): Promise<string> {
    const before = await this.#activity(Number(child.conversationId) as ConversationId);
    if (before === undefined) return `Could not read what ${child.id} does now, so nothing was interrupted.`;
    if (before.calls.length === 0) {
      const now = describeActivity({ ...before, waiting: 0 }, Date.now());
      return `${child.id} is in no tool call now, so nothing was interrupted.${now.length > 0 ? ` ${now.join(" ")}` : ""}`;
    }
    // A tool that does not end on its abort signal would hold the main agent: wait for a while, not for ever.
    const wait = withAbortSignal(AbortSignal.timeout(INTERRUPT_WAIT_MS), context);
    const ended = await Promise.all(
      before.calls.map(async (call): Promise<"aborted" | "ended before" | "running"> => {
        const task = Number(call.task) as TaskId;
        try {
          if ((await this.#harness.abortTask(task, wait)) === "terminal") return "ended before";
          await this.#harness.waitForTask(task, wait);
          return "aborted";
        } catch (error) {
          if (wait.abortSignal?.aborted) return "running";
          throw error;
        }
      }),
    );
    const now = Date.now();
    const named = (call: ChildCall) => `${call.tool}${call.since === undefined ? "" : `, which ran ${age(now - call.since)}`}${call.command === undefined ? "" : ` (${call.command})`}`;
    const done = before.calls.filter((_, index) => ended[index] === "aborted");
    const early = before.calls.filter((_, index) => ended[index] === "ended before");
    const left = before.calls.filter((_, index) => ended[index] === "running");
    const lines: string[] = [];
    if (early.length > 0) lines.push(`${child.id}'s ${early.map((call) => call.tool).join(" and ")} ended by itself just before.`);
    if (done.length > 0) {
      const { waiting } = before;
      const takes = waiting === 0 ? "" : `, and takes the ${waiting === 1 ? "message" : `${waiting} messages`} from you that ${waiting === 1 ? "waits" : "wait"}`;
      lines.push(`Interrupted ${child.id}: ended its ${done.map(named).join("; its ")}. It goes on: it sees that ${done.length === 1 ? "the call was" : "the calls were"} aborted${takes}.`);
    }
    if (left.length > 0) {
      lines.push(`${child.id}'s ${left.map((call) => call.tool).join(" and ")} did not end within ${INTERRUPT_WAIT_MS / 1_000} s of the interrupt; it ends when the tool gives up.`);
    }
    return lines.join("\n");
  }

  /**
   * Give the main model to every child that is not stopped and has no model of its own. A child with its own model
   * keeps it, and every child keeps its thinking level.
   */
  async #configureChildren(): Promise<void> {
    const children = this.#children.filter((child) => child.stoppedAt === undefined && child.model === undefined);
    if (children.length === 0) return;
    const model = this.#model;
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
      // After the harness, so no script calls a server that stops.
      await this.#options.mcp?.close();
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

  /** Whether text with this ID was handed to the agent before: then submit gives that submission, and the new text is not used. */
  async submitted(id: string): Promise<boolean> {
    return this.#root.commit(async (tx) => (await tx.submissionByRequest(ROOT_CONVERSATION_ID, id)) !== undefined, context);
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

  /**
   * Change the model ("provider/modelId") or the thinking level. The children without a model of their own get the new
   * model too. Throws for an unknown model.
   */
  async configure(model: string, thinking: Thinking): Promise<void> {
    await requireChatModel(this.#models, model);
    this.#model = modelRef(model);
    await this.#root.configure({ model: this.#model, thinkingLevel: thinking }, context);
    await this.#configureChildren();
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

/**
 * A child's model ("provider/modelId"), or why it cannot be used: an unknown model, or one that is not signed in on this
 * computer, said now rather than as the child's first failed request.
 */
async function childModel(models: Models, model: string): Promise<{ model: ModelRef } | { refused: string }> {
  const ref = modelRef(model);
  if (!ref.provider || !ref.modelId) return { refused: `the model must be "provider/modelId", not "${model}".` };
  const list = 'a codemode script lists the models you can use with models.getAvailableOfType("chat").';
  try {
    await requireChatModel(models, model);
  } catch {
    return { refused: `unknown model ${model}; ${list}` };
  }
  const available = await models.getAvailable(ref.provider);
  if (available.some((each) => each.id === ref.modelId)) return { model: ref };
  if (available.length === 0) {
    return { refused: `${model} is not signed in on this computer: pi has no login or key for "${ref.provider}". A person signs in with pots login in their terminal; ${list}` };
  }
  return { refused: `the login for "${ref.provider}" on this computer cannot use ${model}; ${list}` };
}
