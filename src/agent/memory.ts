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
  ToolTask,
} from "@earendil-works/pi-durable";
import type { Sql } from "../core/sql.ts";

// The background memory passes, as Claude Code's automatic memory. After each run of the main conversation, one at a
// time, an extraction pass: a fork of the main conversation at the run's answer, with the main conversation's provider
// session, so its request starts as the main agent's last one did and the provider's prompt cache serves it. It keeps
// every tool of the main agent, and code refuses each call but reading, writing the memory folders' .md files and
// read-only shell commands; it refuses also a change to a memory file that is not as it was when the pass began, unless
// the fork changed it itself. It is skipped when the main agent wrote memory itself since the last pass. Once a day,
// after enough memory changes, a dream consolidates the memory the same way. A fork is deleted once it ended: nothing
// of it stays in the main conversation or the bot's database but how far the passes got and the memory changes since
// the last dream. What it changed goes to the main agent's next wake from this process, as in Claude Code: a restart
// before that wake loses it.

/** The bot's own memory folder and the one all bots of the POTS_HOME share. Both exist. */
export interface MemoryFolders {
  own: string;
  shared: string;
}

/** How far extraction got (an entry of the main conversation), the memory changes since the last dream, and when it was. */
export interface MemoryProgress {
  cursor?: number;
  changes: number;
  dreamAt?: number;
}

/** A pass or a dream changed files: the main agent's next wake from this process says so, once. Paths are absolute. */
export interface MemoryNote {
  source: MemorySource;
  written: string[];
  deleted: string[];
}

export type MemorySource = "extract" | "dream";

/** How a pass or a dream ended: how the progress moves, in one transaction with the change its fork made. */
export interface MemorySettle {
  /** Extraction got this far. */
  cursor?: number;
  /** One more memory change than what the fork changed: the main agent wrote memory itself. */
  change?: boolean;
  /** A dream ended at this time: the memory changes start again from 0. */
  dreamt?: number;
}

export interface MemoryHost {
  /** settings.autoMemory; false: no pass, no dream and no age note. */
  enabled(): boolean;
  folders: MemoryFolders;
  /** The extraction pass's message. messages: how many messages of the main conversation it looks at. */
  extraction(messages: number): Promise<string>;
  /** The dream's message. */
  dream(progress: MemoryProgress): Promise<string>;
  progress(): Promise<MemoryProgress>;
  /**
   * A fork changed a file for the first time: kept at once, so the change counts for the dream also when the fork fails
   * or the process dies.
   */
  changed(source: MemorySource): Promise<void>;
  /**
   * In one transaction: a change the forks made since the last settle counts, for extraction, as a memory change; and
   * the progress moves as `update` says. Returns the new progress.
   */
  settle(update: MemorySettle): Promise<MemoryProgress>;
  /** The note for the main agent's next wake from this process. */
  noted(note: MemoryNote): void;
}

/** An extraction pass has at most this many turns, as in Claude Code; a dream has no cap, as there. */
const EXTRACTION_TURNS = 5;
/** Claude Code's auto dream: 24 hours since the last one, and 5 sessions (here: memory changes) since then. */
const DREAM_HOURS = 24;
const DREAM_CHANGES = 5;
const DAY = 86_400_000;
/** A fork's shell command without a timeout of its own ends after this long, as Claude Code's Bash does by default. */
const SHELL_TIMEOUT_SECONDS = 120;
/** The codes of the error results pi-durable writes itself for a call that did not run, or did not run to its end. */
const NOT_RUN = new Set(["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"]);

/** Whether a dream is due after a pass. */
export function dreamDue(progress: MemoryProgress, now = Date.now()): boolean {
  return progress.changes >= DREAM_CHANGES && (progress.dreamAt === undefined || now - progress.dreamAt >= DREAM_HOURS * 3_600_000);
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
const READ_ONLY = new Set(["ls", "find", "grep", "cat", "stat", "wc", "head", "tail", "sqlite3"]);
/** find's tests and actions that only read and print, and the operators. */
const FIND_PRIMARIES = new Set(["-print", "-print0", "-ls", "-empty", "!", "-not", "-a", "-and", "-o", "-or", "(", ")"]);
/** find's tests and options that take one argument. */
const FIND_WITH_ARGUMENT = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-newer", "-size"]);
/** sqlite3's output-format flags, after -readonly -safe. */
const SQLITE_FORMATS = new Set(["-ascii", "-box", "-column", "-csv", "-html", "-json", "-line", "-list", "-markdown", "-quote", "-table", "-tabs", "-header", "-noheader"]);
const SQLITE_FORMATS_WITH_ARGUMENT = new Set(["-separator", "-newline", "-nullvalue"]);
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
function notReadOnly(words: readonly string[], first: boolean): string | undefined {
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
  if (program === "sqlite3") {
    if (!first) return "sqlite3 may not read from a pipe";
    if (args[0] !== "-readonly" || args[1] !== "-safe") return "sqlite3 must start with -readonly -safe";
    let i = 2;
    for (; i < args.length && args[i]!.startsWith("-"); i++) {
      if (SQLITE_FORMATS_WITH_ARGUMENT.has(args[i]!) && i + 1 < args.length) i++;
      else if (!SQLITE_FORMATS.has(args[i]!)) return `sqlite3 takes only output-format flags after -readonly -safe, not ${args[i]}`;
    }
    // The database, then SQL: a word that starts with "-" would be an option, one that starts with "." a dot-command.
    if (args.slice(i).some((arg) => /^\s*[-.]/.test(arg))) return 'after the database, sqlite3 takes only SQL, no word that starts with "-" or "."';
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
    `Refused: ${why}. Only read-only shell commands (ls, find, grep, cat, stat, wc, head, tail and sqlite3 -readonly -safe, also joined by pipes) and rm (no flags except -f) of .md files under ${where} are permitted in this context. ` +
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
    const why = pipeline.map((words, index) => notReadOnly(words, index === 0)).find((each) => each !== undefined);
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
  return names && pipeline.some((words, index) => notReadOnly(words, index === 0) !== undefined);
}

// ---- The age note ----

/** Claude Code's note on a memory read 2 days or more after it last changed. */
function ageNote(days: number): string {
  return `<system-reminder>This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about people, places, files or plans may be outdated. Verify against what is true now before asserting as fact.</system-reminder>\n`;
}

/** A read result, with the age note in front when the file is in a memory folder and 2 days old or more, as in Claude Code. */
export async function withAgeNote(result: ToolExecutionResult, path: string, folders: MemoryFolders | undefined, cwd: string): Promise<ToolExecutionResult> {
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
  readonly #host: MemoryHost;
  readonly #sql: Sql;
  readonly #cwd: string;
  readonly #context: Context;
  readonly #log: (message: string, data?: Record<string, unknown>) => void;
  readonly #forks = new Map<number, Fork>();
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

  /** A run of the main conversation answered with entry `at`: a pass for it, now or after the one that runs. */
  queue(at: number): void {
    if (this.#closing || !this.#host.enabled()) return;
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
    const messages = since(await this.#root!.context(this.#context, { at: at as EntryId }), progress.cursor);
    const folders = this.#host.folders;
    // Only a call whose result says it worked: an edit whose text did not match saved nothing.
    const worked = new Set(messages.flatMap((message) => (message.role === "toolResult" && !message.isError ? [message.toolCallId] : [])));
    const wrote = messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && worked.has(part.id) && writesMemory(part.name, part.arguments, folders, this.#cwd)),
    );
    let next: MemoryProgress;
    if (wrote) {
      // The main agent saved what it wanted itself: that counts as a memory change, as Claude Code skips the pass.
      this.#log("memory pass skipped: the main agent wrote memory itself", { messages: messages.length });
      next = await this.#host.settle({ cursor: at, change: true });
    } else {
      this.beforePass?.();
      const ended = await this.#fork("extract", at, await this.#host.extraction(messages.length), EXTRACTION_TURNS);
      if (!ended) return;
      // What it changed counts also when its model failed; then the next pass looks at the same messages again.
      next = await this.#host.settle(ended.answered ? { cursor: at } : {});
      this.#tell("extract", ended);
      if (!ended.answered) return this.#log("memory pass got no answer", { source: "extract", reason: ended.reason });
      this.#log("memory pass", { messages: messages.length, written: ended.written.length, deleted: ended.deleted.length });
    }
    if (!this.#closing && this.#host.enabled() && dreamDue(next)) await this.#dream(at, next);
  }

  async #dream(at: number, progress: MemoryProgress): Promise<void> {
    const ended = await this.#fork("dream", at, await this.#host.dream(progress));
    if (!ended) return;
    await this.#host.settle(ended.answered ? { dreamt: Date.now() } : {});
    this.#tell("dream", ended);
    if (ended.answered) this.#log("memory dream", { written: ended.written.length, deleted: ended.deleted.length });
    else this.#log("memory pass got no answer", { source: "dream", reason: ended.reason });
  }

  /** The note of what a fork changed, for the main agent's next wake. */
  #tell(source: MemorySource, changed: { written: string[]; deleted: string[] }): void {
    if (changed.written.length + changed.deleted.length > 0) this.#host.noted({ source, written: changed.written, deleted: changed.deleted });
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
  ): Promise<{ answered: boolean; reason?: string; written: string[]; deleted: string[] } | undefined> {
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
      return {
        answered,
        ...(answered ? {} : { reason: settled.status === "unanswered" ? settled.reason : "unknown" }),
        written: [...state.written],
        deleted: [...state.deleted],
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
