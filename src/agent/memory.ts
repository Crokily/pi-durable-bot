import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ContextView,
  type Conversation,
  type ConversationId,
  configure,
  defineExtension,
  type EntryId,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionResult,
  type ToolPark,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { Sql } from "../core/sql.ts";

// The background memory upkeep. With settings.memoryExtraction (off by default), after each run of the main
// conversation, one at a time, an extraction pass: a fork of the main conversation at the run's answer, with the main conversation's provider
// session, so its request starts as the main agent's last one did and the provider's prompt cache serves it. It keeps
// every tool of the main agent, and code refuses each call but reading, writing the memory folders' .md files and
// read-only shell commands; it refuses also a change to a memory file that is not as it was when the pass began, unless
// the fork changed it itself. It is skipped when the main agent wrote memory itself since the last pass. With
// settings.memoryTidy (on by default), after a run of the main conversation, at most once a day and after enough memory
// changes, a tidy forks the same way: it deletes expired and duplicate memories, shortens long index lines and corrects
// contradictions. A memory change is an agent of the bot (the main agent, a child or an extraction pass) that changed
// a memory folder between two ends of a main run. A fork is deleted once it ended: nothing of it stays in the main
// conversation or the bot's database but how far extraction got and the memory changes since the last tidy. What it
// changed, and the tidy's summary, go to the main agent's next wake from this process, as in Claude Code: a restart
// before that wake loses it.

/** The bot's own memory folder and the one all bots of the POTS_HOME share. Both exist. */
export interface MemoryFolders {
  own: string;
  shared: string;
}

/** How far extraction got (an entry of the main conversation), the memory changes since the last tidy, and when it was. */
export interface MemoryProgress {
  cursor?: number;
  changes: number;
  tidiedAt?: number;
}

/**
 * A pass or a tidy changed files, or a tidy answered: the main agent's next wake from this process says so, once.
 * Paths are absolute.
 */
export interface MemoryNote {
  source: MemorySource;
  written: string[];
  deleted: string[];
  /** The tidy's answer: what it changed, and the memories that read as rules or preferences. */
  summary?: string;
}

export type MemorySource = "extract" | "tidy";

/** How a pass or a tidy ended: how the progress moves, in one transaction with the change its fork made. */
export interface MemorySettle {
  /** Extraction got this far. */
  cursor?: number;
  /** A tidy ended at this time: the memory changes start again from 0. */
  tidied?: number;
}

export interface MemoryHost {
  /** settings.autoMemory; false: no pass, no tidy and no age note. */
  enabled(): boolean;
  /** settings.memoryExtraction (off by default): the extraction pass after each run of the main conversation. */
  extracts(): boolean;
  /** settings.memoryTidy (on by default): the tidy, at most once a day after enough memory changes. */
  tidies(): boolean;
  folders: MemoryFolders;
  /** The extraction pass's message. messages: how many messages of the main conversation it looks at. */
  extraction(messages: number): Promise<string>;
  /** The tidy's message. */
  tidy(progress: MemoryProgress): Promise<string>;
  progress(): Promise<MemoryProgress>;
  /**
   * A fork changed a file for the first time: kept at once, so the change counts for the tidy also when the fork fails
   * or the process dies.
   */
  changed(source: MemorySource): Promise<void>;
  /** The main agent or a child changed a memory folder: one more memory change, kept at once. */
  counted(): Promise<void>;
  /**
   * In one transaction: a change an extraction pass made since the last settle counts as a memory change; and the
   * progress moves as `update` says. Returns the new progress.
   */
  settle(update: MemorySettle): Promise<MemoryProgress>;
  /** The note for the main agent's next wake from this process. */
  noted(note: MemoryNote): void;
}

/** An extraction pass has at most this many turns, as in Claude Code; a tidy has no cap, as Claude Code's dream. */
const EXTRACTION_TURNS = 5;
/** Claude Code's auto dream: 24 hours since the last one, and 5 sessions (here: memory changes) since then. */
const TIDY_HOURS = 24;
const TIDY_CHANGES = 5;
const DAY = 86_400_000;
/** A fork's shell command without a timeout of its own ends after this long, as Claude Code's Bash does by default. */
const SHELL_TIMEOUT_SECONDS = 120;
/** The codes of the error results pi-durable writes itself for a call that did not run, or did not run to its end. */
const NOT_RUN = new Set(["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"]);

/** Whether a tidy is due. */
export function tidyDue(progress: MemoryProgress, now = Date.now()): boolean {
  return progress.changes >= TIDY_CHANGES && (progress.tidiedAt === undefined || now - progress.tidiedAt >= TIDY_HOURS * 3_600_000);
}

// ---- Paths ----

/** A path as pi's file tools take it: no leading "@", odd spaces as spaces, ~ for home, relative to the working directory. */
function toolPath(cwd: string, path: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // As in pi: a malformed URL is an ordinary path.
    }
  }
  return resolve(cwd, normalized);
}

function within(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** The memory folder a path is in, by its name alone. */
function folderOf(path: string, folders: MemoryFolders): string | undefined {
  return [folders.own, folders.shared].find((folder) => within(path, folder));
}

/**
 * Whether a path, absolute and normalized, is a .md file inside a memory folder with no symbolic link below the folder,
 * also a dangling one: a tool that follows a link would write or delete outside the folder.
 */
async function memoryFile(path: string, folders: MemoryFolders): Promise<boolean> {
  const folder = folderOf(path, folders);
  if (!folder || !path.endsWith(".md")) return false;
  let current = folder;
  for (const part of path.slice(folder.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      // Nothing more of the path exists, so no link either; anything else is refused.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

// ---- Shell commands ----
//
// A fork's bash command is checked as bash runs it. The words are taken only from what bash passes on unchanged: plain
// characters, single quotes, and double quotes without $, backticks or backslashes. Anything bash would expand or
// interpret ($, backticks, backslashes, globs, braces, ~, ;, &, (, ), <, and > but in a redirect alone) is refused, so the
// words checked are the words that run. Then each command of the pipeline must be one of a short list, with its options
// allowlisted where an option could write or run something.

/** The commands a memory fork may run, also joined by pipes; rm only alone, of .md files in the memory folders. */
const READ_ONLY = new Set(["ls", "find", "grep", "cat", "stat", "wc", "head", "tail"]);
/** find's tests and actions that only read and print, and the operators. */
const FIND_PRIMARIES = new Set(["-print", "-print0", "-ls", "-empty", "!", "-not", "-a", "-and", "-o", "-or", "(", ")"]);
/** find's tests and options that take one argument. */
const FIND_WITH_ARGUMENT = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-newer", "-size"]);
/** A redirect that writes nothing, alone as a word: errors to /dev/null, or one output into another. */
const REDIRECT = /^(?:2>\/dev\/null|\d>&\d)(?=[ \t|]|$)/;

/** A command as the words of its piped commands, as bash passes them; or why it is refused. */
export function parseShell(command: string): string[][] | string {
  const pipeline: string[][] = [[]];
  let word: string | undefined;
  const end = () => {
    if (word !== undefined) pipeline.at(-1)!.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === " " || char === "\t") {
      end();
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return "a quote is not closed";
      word = (word ?? "") + command.slice(i + 1, close);
      i = close;
    } else if (char === '"') {
      const close = command.indexOf('"', i + 1);
      if (close < 0) return "a quote is not closed";
      const text = command.slice(i + 1, close);
      if (/[$`\\]/.test(text)) return "$, backticks and backslashes are refused in double quotes; use single quotes";
      word = (word ?? "") + text;
      i = close;
    } else if (char === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") return "|| and |& are refused";
      end();
      if (pipeline.at(-1)!.length === 0) return "a pipe has no command before it";
      pipeline.push([]);
    } else if (word === undefined && REDIRECT.test(command.slice(i))) {
      // Not a word of the command: bash takes it away.
      i += REDIRECT.exec(command.slice(i))![0].length - 1;
    } else if ("$`\\*?[]{}~;&()<>#\n\r".includes(char)) {
      return `${char === "\n" || char === "\r" ? "a new line" : char} is refused outside single quotes; a redirect may only be 2>/dev/null or N>&M, alone`;
    } else {
      word = (word ?? "") + char;
    }
  }
  end();
  if (pipeline.some((words) => words.length === 0)) return "a pipe has no command after it";
  return pipeline;
}

/** Why a command of a pipeline is not one of the read-only ones, or undefined when it is. */
function notReadOnly(words: readonly string[]): string | undefined {
  const [program, ...args] = words;
  if (!program || !READ_ONLY.has(program)) return `${program ?? "it"} is not one of the commands that are permitted`;
  if (program === "find") {
    let i = 0;
    while (i < args.length && !args[i]!.startsWith("-") && !["!", "(", ")"].includes(args[i]!)) i++;
    for (; i < args.length; i++) {
      if (FIND_WITH_ARGUMENT.has(args[i]!) && i + 1 < args.length) i++;
      else if (!FIND_PRIMARIES.has(args[i]!)) return `find takes only ${[...FIND_WITH_ARGUMENT, ...FIND_PRIMARIES].join(" ")} here, not ${args[i]}`;
    }
  }
  return undefined;
}

/** The files of an rm as Claude Code allows it: one command, no flags but -f, absolute paths with no "..". */
function rmTargets(pipeline: readonly string[][]): string[] | undefined {
  if (pipeline.length !== 1 || pipeline[0]![0] !== "rm") return undefined;
  const paths: string[] = [];
  let options = true;
  for (const arg of pipeline[0]!.slice(1)) {
    if (options && arg === "--") options = false;
    else if (options && arg.startsWith("-")) {
      if (arg !== "-f" && arg !== "--force") return undefined;
    } else if (!isAbsolute(arg) || arg.split(/[/\\]/).includes("..")) return undefined;
    else paths.push(resolve(arg));
  }
  return paths.length > 0 ? paths : undefined;
}

/** The constraints a fork's refused bash command is told, with why it was refused. */
function shellConstraints(why: string, where: string): string {
  return (
    `Refused: ${why}. Only read-only shell commands (ls, find, grep, cat, stat, wc, head and tail, also joined by pipes) and rm (no flags except -f) of .md files under ${where} are permitted in this context. ` +
    "Anything else that writes, redirects to a file, runs other programs or modifies state is denied."
  );
}

/** The files a fork's tool call changes: write and edit's path, rm's files. */
function targets(name: string, args: Record<string, unknown>, cwd: string): string[] {
  if ((name === "write" || name === "edit") && typeof args.path === "string") return [toolPath(cwd, args.path)];
  if (name !== "bash" || typeof args.command !== "string") return [];
  const pipeline = parseShell(args.command);
  return (typeof pipeline !== "string" && rmTargets(pipeline)) || [];
}

/** Why a memory fork may not run this tool call, or undefined when it may. */
export async function forkRefusal(name: string, args: Record<string, unknown>, folders: MemoryFolders, cwd: string): Promise<string | undefined> {
  const where = `${folders.own} or ${folders.shared}`;
  if (name === "read") return undefined;
  if ((name === "write" || name === "edit") && typeof args.path === "string" && (await memoryFile(toolPath(cwd, args.path), folders))) return undefined;
  if (name === "bash") {
    const pipeline = typeof args.command === "string" ? parseShell(args.command) : "there is no command";
    if (typeof pipeline === "string") return shellConstraints(pipeline, where);
    const why = pipeline.map((words) => notReadOnly(words)).find((each) => each !== undefined);
    if (why === undefined) return undefined;
    if (pipeline[0]![0] !== "rm") return shellConstraints(why, where);
    const files = rmTargets(pipeline);
    if (!files) return shellConstraints("rm runs only alone, with no flags but -f, of absolute paths without ..", where);
    for (const file of files) if (!(await memoryFile(file, folders))) return shellConstraints(`${file} is not a .md file in a memory folder, or a link is on its way`, where);
    return undefined;
  }
  return `only read, read-only bash, and write/edit of .md files within ${where} are allowed in this context`;
}

/**
 * Whether a main agent's tool call meant to write, edit or delete a file in a memory folder: write or edit of a path
 * there, an rm of a .md file there, or a command that names a path there and is not read-only by the fork's list. A
 * command the checker cannot read says nothing either way, and does not count.
 */
function writesMemory(name: string, args: Record<string, unknown>, folders: MemoryFolders, cwd: string): boolean {
  if ((name === "write" || name === "edit") && typeof args.path === "string") return folderOf(toolPath(cwd, args.path), folders) !== undefined;
  if ((name !== "bash" && name !== "screen") || typeof args.command !== "string") return false;
  const pipeline = parseShell(args.command);
  if (typeof pipeline === "string") return false;
  const removed = rmTargets(pipeline);
  if (removed) return removed.some((path) => path.endsWith(".md") && folderOf(path, folders) !== undefined);
  const names = pipeline.some((words) => words.some((word) => folderOf(toolPath(cwd, word), folders) !== undefined));
  return names && pipeline.some((words) => notReadOnly(words) !== undefined);
}

// ---- The age note ----

/** Claude Code's note on a memory read 2 days or more after it last changed. */
function ageNote(days: number): string {
  return `<system-reminder>This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about people, places, files or plans may be outdated. Verify against what is true now before asserting as fact.</system-reminder>\n`;
}

/** A read result, with the age note in front when the file is in a memory folder and 2 days old or more, as in Claude Code. */
export async function withAgeNote<Result extends ToolExecutionResult | ToolPark>(
  result: Result,
  path: string,
  folders: MemoryFolders | undefined,
  cwd: string,
): Promise<Result> {
  const file = toolPath(cwd, path);
  const [first, ...rest] = result.output ?? [];
  if (!folders || !folderOf(file, folders) || first?.type !== "text") return result;
  const changed = (await stat(file).catch(() => undefined))?.mtimeMs;
  const days = changed === undefined ? 0 : Math.floor((Date.now() - changed) / DAY);
  return days < 2 ? result : { ...result, output: [{ ...first, text: ageNote(days) + first.text }, ...rest] };
}

// ---- The passes ----

/** A file's state: its modification time, or undefined when it is not there. */
type FileState = number | undefined;

interface Fork {
  source: MemorySource;
  /** Every file of both memory folders when the pass began. */
  snapshot: Map<string, number>;
  /** The state of each file the fork changed itself, as it left it. */
  own: Map<string, FileState>;
  /** Whether the bot knows already that this fork changed a file. */
  recorded: boolean;
  rounds: number;
  maxTurns?: number;
  written: Set<string>;
  deleted: Set<string>;
}

async function stateOf(path: string): Promise<FileState> {
  return (await lstat(path).catch(() => undefined))?.mtimeMs;
}

/** Every file of the memory folders and their subfolders, with its modification time. */
async function snapshotOf(folders: MemoryFolders): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  for (const folder of [folders.own, folders.shared]) {
    for (const name of await readdir(folder, { recursive: true }).catch(() => [] as string[])) {
      const path = join(folder, name);
      const state = await stateOf(path);
      if (state !== undefined) snapshot.set(path, state);
    }
  }
  return snapshot;
}

/** Whether two snapshots of the memory folders hold the same files with the same modification times. */
function same(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([path, time]) => b.get(path) === time);
}

/** The tools that run commands or scripts: what they change in the memory folders is seen on the disk. */
const SHELLS = new Set(["bash", "screen", "codemode"]);

/** What a file should be for the fork to change it: as the fork left it, or else as it was when the pass began. */
function expected(state: Fork, path: string): FileState {
  return state.own.has(path) ? state.own.get(path) : state.snapshot.get(path);
}

/** The messages of the context after entry `after`, all of them without it: what came in, what the agent said and its tool results. */
function since(view: ContextView, after: number | undefined): Message[] {
  return view.entries
    .flatMap((entry, index) => (after === undefined || entry.id > after ? [...(view.contributions[index] ?? [])] : []))
    .filter((message) => message.role !== "system");
}

export class MemoryPasses {
  /** Selected in a fork only: the tool limits, the turn cap and the record of what it changed. */
  readonly extension: Extension;
  /** For every agent of the bot: counts the memory changes of the main agent and of children. */
  readonly counter: ReturnType<typeof hook>;
  readonly #host: MemoryHost;
  readonly #sql: Sql;
  readonly #cwd: string;
  readonly #context: Context;
  readonly #log: (message: string, data?: Record<string, unknown>) => void;
  readonly #forks = new Map<number, Fork>();
  /** The conversations whose memory change counted since the main conversation's last run ended. */
  readonly #counted = new Set<number>();
  /** The memory folders' files before a command or a script of the main agent or a child, by its tool task. */
  readonly #before = new Map<string, Map<string, number>>();
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #running: Promise<void> | undefined;
  /** A run that ended while a pass ran: one trailing pass covers it, as in Claude Code. */
  #trailing: number | undefined;
  #closing = false;
  /** Crash tests: called right before a pass forks the main conversation. */
  beforePass?: () => void;

  constructor(options: { host: MemoryHost; sql: Sql; cwd: string; context: Context; log: (message: string, data?: Record<string, unknown>) => void }) {
    this.#host = options.host;
    this.#sql = options.sql;
    this.#cwd = options.cwd;
    this.#context = options.context;
    this.#log = options.log;
    const fork = (id: ConversationId) => this.#forks.get(Number(id));
    // A write or edit of a path in a memory folder that worked changes the memory. A command or a script may change it in
    // any way, so for those the folders' files are compared before and after the call.
    const counts = (id: number) => !this.#forks.has(id) && !this.#counted.has(id) && this.#host.enabled();
    this.counter = hook(ToolTask, {
      beforeTool: async (call, api) => {
        if (SHELLS.has(call.name) && counts(Number(api.conversationId))) this.#before.set(String(api.taskId), await snapshotOf(this.#host.folders));
        return undefined;
      },
      afterTool: async (call, result, api) => {
        const id = Number(api.conversationId);
        const before = this.#before.get(String(api.taskId));
        this.#before.delete(String(api.taskId));
        if (!counts(id)) return undefined;
        const changed =
          call.name === "write" || call.name === "edit"
            ? !result.isError && typeof call.arguments.path === "string" && folderOf(toolPath(this.#cwd, call.arguments.path), this.#host.folders) !== undefined
            : before !== undefined && !same(before, await snapshotOf(this.#host.folders));
        if (!changed) return undefined;
        this.#counted.add(id);
        await this.#host.counted().catch((error: unknown) => this.#log("could not count a memory change", { error: String(error) }));
        return undefined;
      },
    });
    this.extension = defineExtension({
      name: "memory-fork",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api) => {
            const refusal = await forkRefusal(call.name, call.arguments, this.#host.folders, this.#cwd);
            if (refusal !== undefined) return { block: refusal };
            // A file another writer, such as the main agent, changed, created or deleted after the pass began: the
            // fork's copy is old.
            const state = fork(api.conversationId);
            for (const path of state ? targets(call.name, call.arguments, this.#cwd) : []) {
              if ((await stateOf(path)) !== expected(state!, path)) {
                return { block: `${path} changed after this memory pass began, so this pass may not change it: another writer has a newer copy.` };
              }
            }
            // The passes run one at a time: a command that never ends, such as tail -f, must not hold up the next ones.
            if (call.name === "bash" && call.arguments.timeout === undefined) return { arguments: { ...call.arguments, timeout: SHELL_TIMEOUT_SECONDS } };
            return undefined;
          },
          afterTool: async (call, result, api) => {
            const state = fork(api.conversationId);
            // pi-durable also gives the results it writes itself, for a call that did not run, such as one refused above:
            // a change on the disk then is another writer's.
            if (!state || result.diagnostics?.some((each) => each.code !== undefined && NOT_RUN.has(each.code))) return undefined;
            // By what is on the disk: an rm that failed for one file may have deleted another.
            for (const path of targets(call.name, call.arguments, this.#cwd)) {
              const now = await stateOf(path);
              const before = expected(state, path);
              if (now === before) continue;
              state.own.set(path, now);
              if (now === undefined) {
                state.written.delete(path);
                state.deleted.add(path);
              } else {
                state.deleted.delete(path);
                state.written.add(path);
              }
              if (!state.recorded) {
                state.recorded = true;
                await this.#host.changed(state.source);
              }
            }
            return undefined;
          },
        }),
        hook(GenerationTask, {
          afterTools: (_assistant, _results, api) => {
            const state = fork(api.conversationId);
            if (state) state.rounds++;
          },
          // After the last turn's tools there is no next request: the run ends, as Claude Code's maxTurns ends it.
          beforeRequest: async (_request, api, context) => {
            const state = fork(api.conversationId);
            if (state?.maxTurns === undefined || state.rounds < state.maxTurns) return undefined;
            const signal = context.abortSignal;
            void this.#harness?.abortTask(api.taskId as TaskId, this.#context).catch(() => {});
            await new Promise((done) => (signal?.aborted ? done(undefined) : signal?.addEventListener("abort", done, { once: true })));
            throw signal?.reason ?? new Error("the memory pass reached its turn cap");
          },
        }),
      ],
    });
  }

  attach(harness: Harness, root: Conversation): void {
    this.#harness = harness;
    this.#root = root;
  }

  /** What a fork changed before the last process stopped or died: its note and memory change, before any new pass. */
  async recover(): Promise<void> {
    await this.#host.settle({});
  }

  /** A run of the main conversation answered with entry `at`: a pass for it and a tidy when one is due, now or after the one that runs. */
  queue(at: number): void {
    if (this.#closing || !this.#host.enabled()) return;
    // From here, each agent's next memory change counts again.
    this.#counted.clear();
    if (this.#running) {
      this.#trailing = Math.max(this.#trailing ?? 0, at);
      return;
    }
    this.#running = (async () => {
      for (let next: number | undefined = at; next !== undefined && !this.#closing; next = this.#takeTrailing()) {
        try {
          await this.#pass(next);
        } catch (error) {
          if (!this.#closing) this.#log("memory pass could not finish", { error: String(error) });
        }
      }
    })().finally(() => (this.#running = undefined));
  }

  /** Whether extraction runs: the memory and its extraction are both on. */
  #extracts(): boolean {
    return this.#host.enabled() && this.#host.extracts();
  }

  /** Whether the tidy runs: the memory and its tidy are both on. */
  #tidies(): boolean {
    return this.#host.enabled() && this.#host.tidies();
  }

  #takeTrailing(): number | undefined {
    const next = this.#trailing;
    this.#trailing = undefined;
    return next;
  }

  /** Stop: the fork that runs is left to the next start, which deletes it and passes again from the cursor. */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#running?.catch(() => {});
  }

  async #pass(at: number): Promise<void> {
    if (!this.#host.enabled()) return;
    const progress = await this.#host.progress();
    if (progress.cursor !== undefined && at <= progress.cursor) return;
    const next = this.#extracts() ? await this.#extract(at, progress) : await this.#host.settle({ cursor: at });
    if (next && !this.#closing && this.#tidies() && tidyDue(next)) await this.#tidy(at, next);
  }

  /** The extraction pass for the messages up to `at`; the progress after it, or undefined when the gateway stops. */
  async #extract(at: number, progress: MemoryProgress): Promise<MemoryProgress | undefined> {
    const messages = since(await this.#root!.context(this.#context, { at: at as EntryId }), progress.cursor);
    const folders = this.#host.folders;
    // Only a call whose result says it worked: an edit whose text did not match saved nothing.
    const worked = new Set(messages.flatMap((message) => (message.role === "toolResult" && !message.isError ? [message.toolCallId] : [])));
    const wrote = messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && worked.has(part.id) && writesMemory(part.name, part.arguments, folders, this.#cwd)),
    );
    if (wrote) {
      // The main agent saved what it wanted itself, as Claude Code skips the pass; its change counted already.
      this.#log("memory pass skipped: the main agent wrote memory itself", { messages: messages.length });
      return this.#host.settle({ cursor: at });
    }
    this.beforePass?.();
    const ended = await this.#fork("extract", at, await this.#host.extraction(messages.length), EXTRACTION_TURNS);
    if (!ended) return undefined;
    // What it changed counts also when its model failed; then the next pass looks at the same messages again.
    const next = await this.#host.settle(ended.answered ? { cursor: at } : {});
    this.#tell("extract", ended);
    if (!ended.answered) {
      this.#log("memory pass got no answer", { source: "extract", reason: ended.reason });
      return undefined;
    }
    this.#log("memory pass", { messages: messages.length, written: ended.written.length, deleted: ended.deleted.length });
    return next;
  }

  async #tidy(at: number, progress: MemoryProgress): Promise<void> {
    const ended = await this.#fork("tidy", at, await this.#host.tidy(progress));
    if (!ended) return;
    await this.#host.settle(ended.answered ? { tidied: Date.now() } : {});
    this.#tell("tidy", ended);
    if (ended.answered) this.#log("memory tidy", { written: ended.written.length, deleted: ended.deleted.length });
    else this.#log("memory pass got no answer", { source: "tidy", reason: ended.reason });
  }

  /** The note of what a fork changed, and the tidy's summary, for the main agent's next wake. */
  #tell(source: MemorySource, ended: { written: string[]; deleted: string[]; summary?: string }): void {
    if (ended.written.length + ended.deleted.length > 0 || ended.summary !== undefined) {
      this.#host.noted({ source, written: ended.written, deleted: ended.deleted, ...(ended.summary === undefined ? {} : { summary: ended.summary }) });
    }
  }

  /**
   * Fork the main conversation at `at`, give the fork the message, and wait until it ends. Returns whether it ended as
   * it should (answered, or at its turn cap), why not, and the files it wrote and deleted, or undefined when the gateway
   * stops. The fork is deleted after. The caller logs how it ended once it has recorded it, so that a log line means the
   * pass is over: its fork deleted and its progress stored.
   */
  async #fork(
    source: MemorySource,
    at: number,
    message: string,
    maxTurns?: number,
  ): Promise<{ answered: boolean; reason?: string; written: string[]; deleted: string[]; summary?: string } | undefined> {
    const root = this.#root!;
    const context = this.#context;
    // Before the fork exists: a file that changes after this, the fork may not change.
    const snapshot = await snapshotOf(this.#host.folders);
    const id = await root.commit(async (tx) => {
      const conversation = await tx.forkConversation(ROOT_CONVERSATION_ID, at as EntryId, { ownership: { kind: "ownerless" } });
      // pi-durable gives a fork a session of its own; with the main conversation's, the provider finds its cache.
      (await tx.doc(ProviderDoc, conversation.id)).sessionId = (await tx.doc(ProviderDoc, ROOT_CONVERSATION_ID)).sessionId;
      // Only hooks: the sections and tools stay those of the main conversation, so the start of the request does.
      await configure(tx, conversation.id, { extensions: { add: [this.extension] } });
      return conversation.id;
    }, context);
    const state: Fork = { source, snapshot, own: new Map(), recorded: false, rounds: 0, ...(maxTurns === undefined ? {} : { maxTurns }), written: new Set(), deleted: new Set() };
    this.#forks.set(Number(id), state);
    try {
      const fork = (await this.#harness!.conversation(id, context))!;
      const submission = await fork.submit({ type: "input", content: message, requestId: `memory:${String(id)}`, whenBusy: "followUp", entry: { kind: "bot.memory" } }, context);
      const settled = await submission.wait(context);
      if (this.#closing) return undefined;
      const capped = state.maxTurns !== undefined && state.rounds >= state.maxTurns;
      const answered = settled.status === "done" || capped;
      // The tidy's answer is for the main agent: it decides about the memories that read as rules or preferences.
      const summary = source === "tidy" && settled.status === "done" ? await answerOf(fork, context) : undefined;
      return {
        answered,
        ...(answered ? {} : { reason: settled.status === "unanswered" ? settled.reason : "unknown" }),
        written: [...state.written],
        deleted: [...state.deleted],
        ...(summary ? { summary } : {}),
      };
    } finally {
      this.#forks.delete(Number(id));
      if (!this.#closing) await this.#delete(id);
    }
  }

  /** Delete a fork once nothing of it runs any more. */
  async #delete(id: ConversationId): Promise<void> {
    const live = await this.#sql.all<{ id: number }>("SELECT id FROM pi_tasks WHERE conversation_id = ? AND status != 'terminal'", Number(id));
    for (const task of live) {
      await this.#harness!.abortTask(task.id as TaskId, this.#context);
      await this.#harness!.waitForTask(task.id as TaskId, this.#context);
    }
    await deleteConversation(this.#sql, Number(id));
  }
}

/**
 * Delete a conversation and everything of it from pi-durable's tables: its entries, submissions, tasks and documents.
 * pi-durable has no call for this; it is safe for a fork whose tasks have all ended, which nothing refers to.
 */
async function deleteConversation(sql: Sql, id: number): Promise<void> {
  const documents =
    "SELECT id FROM pi_documents WHERE (scope_kind = 'conversation' AND owner_id = ?) OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM pi_tasks WHERE conversation_id = ?))";
  await sql.transaction(async (tx) => {
    await tx.run(`DELETE FROM pi_document_revisions WHERE document_id IN (${documents})`, id, id);
    await tx.run(`DELETE FROM pi_record_ids WHERE id IN (${documents})`, id, id);
    await tx.run(`DELETE FROM pi_documents WHERE id IN (${documents})`, id, id);
    for (const table of ["pi_entries", "pi_submissions", "pi_tasks"]) {
      await tx.run(`DELETE FROM pi_record_ids WHERE id IN (SELECT id FROM ${table} WHERE conversation_id = ?)`, id);
      await tx.run(`DELETE FROM ${table} WHERE conversation_id = ?`, id);
    }
    await tx.run("DELETE FROM pi_record_ids WHERE id = ?", id);
    await tx.run("DELETE FROM pi_conversations WHERE id = ?", id);
  });
}

/**
 * Delete the memory forks a pass left when the last process stopped or died in the middle of it: forks of the main
 * conversation that nothing owns. Before pi-durable opens, so none of them runs again.
 */
export async function deleteLeftForks(sql: Sql): Promise<number> {
  const forks = await sql.all<{ id: number }>(
    "SELECT id FROM pi_conversations WHERE id != ? AND owner_conversation_id IS NULL AND owner_task_id IS NULL AND json_extract(record, '$.parent.conversationId') = ?",
    ROOT_CONVERSATION_ID,
    ROOT_CONVERSATION_ID,
  );
  for (const fork of forks) await deleteConversation(sql, fork.id);
  return forks.length;
}

/** The text of a conversation's newest answer, or undefined when it has none. */
async function answerOf(conversation: Conversation, context: Context): Promise<string | undefined> {
  const page = await conversation.entries({}, 20, undefined, context);
  for (const entry of page.items) {
    if (!AssistantEntry.is(entry)) continue;
    const message = entry.model?.[0] as AssistantMessage | undefined;
    if (message?.stopReason !== "stop" && message?.stopReason !== "length") continue;
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
    return text || undefined;
  }
  return undefined;
}

/** The newest answer of the main conversation that ended a run, for a pass that the last process did not make. */
export async function lastAnswer(root: Conversation, context: Context): Promise<EntryId | undefined> {
  const page = await root.entries({}, 50, undefined, context);
  for (const entry of page.items) {
    if (!AssistantEntry.is(entry)) continue;
    const stop = (entry.model?.[0] as AssistantMessage | undefined)?.stopReason;
    if (stop === "stop" || stop === "length") return entry.id;
    if (stop === "toolUse") return undefined;
  }
  return undefined;
}

/** The files the main agent read with the read tool in this context. */
export function readPaths(messages: readonly Message[], cwd: string): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) if (part.type === "toolCall" && part.name === "read" && typeof part.arguments.path === "string") paths.add(toolPath(cwd, part.arguments.path));
  }
  return paths;
}
