import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
// read-only shell commands. It is skipped when the main agent wrote memory itself since the last pass. Once a day,
// after enough memory changes, a dream consolidates the memory the same way. A fork is deleted once it ended: nothing
// of it stays in the main conversation or the bot's database but how far the passes got.

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

/** A pass or a dream changed files: the main agent's next wake says so, once. Paths are absolute. */
export interface MemoryNote {
  source: "extract" | "dream";
  written: string[];
  deleted: string[];
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
  saveProgress(progress: MemoryProgress): Promise<void>;
  noted(note: MemoryNote): Promise<void>;
}

/** An extraction pass has at most this many turns, as in Claude Code; a dream has no cap, as there. */
const EXTRACTION_TURNS = 5;
/** Claude Code's auto dream: 24 hours since the last one, and 5 sessions (here: memory changes) since then. */
const DREAM_HOURS = 24;
const DREAM_CHANGES = 5;
const DAY = 86_400_000;
/** A fork's shell command without a timeout of its own ends after this long, as Claude Code's Bash does by default. */
const SHELL_TIMEOUT_SECONDS = 120;

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

/** Whether a path is a .md file inside a memory folder, also after links are followed. */
async function memoryFile(path: string, folders: MemoryFolders): Promise<boolean> {
  if (!path.endsWith(".md") || !folderOf(path, folders)) return false;
  let probe = path;
  const missing: string[] = [];
  let real: string | undefined;
  while (real === undefined) {
    try {
      real = join(await realpath(probe), ...missing);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false;
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
  for (const folder of [folders.own, folders.shared]) {
    if (within(real, await realpath(folder).catch(() => folder))) return true;
  }
  return false;
}

// ---- Shell commands ----

/** The commands a memory fork may run, also joined by pipes, as Claude Code's list; sqlite3 only with -readonly and -safe. */
const READ_ONLY = new Set(["ls", "find", "grep", "cat", "stat", "wc", "head", "tail", "sqlite3"]);
/** find's actions that write, delete or run programs. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** Redirects that write nothing, as Claude Code allows them: to /dev/null, or one output into another. */
const HARMLESS_REDIRECT = /^(?:\d*>&\d+|&?\d*>>?\s*\/dev\/null)(?=[\s|]|$)/;

interface Word {
  text: string;
  /** Has an unquoted glob character, $, or a leading ~: the shell changes it. */
  expands: boolean;
}

/** A command as words of piped commands, or undefined when it is more than that: lists, substitutions, redirects to files. */
export function parseShell(command: string): Word[][] | undefined {
  const pipeline: Word[][] = [[]];
  let word: Word | undefined;
  const add = (text: string, expands = false) => {
    word ??= { text: "", expands: false };
    word.text += text;
    if (expands) word.expands = true;
  };
  const end = () => {
    if (word) pipeline.at(-1)!.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === " " || char === "\t") {
      end();
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      add(command.slice(i + 1, close));
      i = close;
    } else if (char === '"') {
      let text = "";
      let closed = false;
      for (i++; i < command.length; i++) {
        const inner = command[i]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "`" || (inner === "$" && command[i + 1] === "(")) return undefined;
        if (inner === "\\" && i + 1 < command.length) text += command[++i];
        else text += inner;
        if (inner === "$") add("", true);
      }
      if (!closed) return undefined;
      add(text);
    } else if (char === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return undefined;
      add(command[++i]!);
    } else if (char === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") return undefined;
      end();
      if (pipeline.at(-1)!.length === 0) return undefined;
      pipeline.push([]);
    } else if (char === ">" || (char === "&" && command[i + 1] === ">")) {
      // A redirect such as 2>/dev/null or 2>&1: from the digits that start the word, if any.
      const start = word && /^\d+$/.test(word.text) && !word.expands ? i - word.text.length : i;
      const match = HARMLESS_REDIRECT.exec(command.slice(start));
      if (!match) return undefined;
      word = undefined;
      i = start + match[0].length - 1;
    } else if ("\n\r;&<()`".includes(char) || (char === "$" && command[i + 1] === "(") || (char === "#" && !word)) {
      return undefined;
    } else {
      add(char, "*?[$".includes(char) || (char === "~" && !word));
    }
  }
  end();
  if (pipeline.some((words) => words.length === 0)) return undefined;
  return pipeline;
}

/** Whether every command of the pipeline is one of the read-only ones, with no action that writes. */
function readOnly(pipeline: Word[][]): boolean {
  return pipeline.every((words) => {
    const [program, ...args] = words;
    if (!program || program.expands || !READ_ONLY.has(program.text)) return false;
    if (program.text === "find") return !args.some((arg) => FIND_WRITES.has(arg.text));
    if (program.text === "sqlite3") {
      const flags = new Set(args.map((arg) => arg.text.replace(/^--/, "-")));
      return flags.has("-readonly") && flags.has("-safe");
    }
    return true;
  });
}

/** The files of an rm as Claude Code allows it: one command, no flags but -f, absolute paths the shell does not change. */
function rmTargets(pipeline: Word[][]): string[] | undefined {
  if (pipeline.length !== 1) return undefined;
  const [program, ...args] = pipeline[0]!;
  if (program?.text !== "rm" || program.expands) return undefined;
  const paths: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg.text === "--") {
      options = false;
      continue;
    }
    if (options && arg.text.startsWith("-")) {
      if (arg.text === "-f" || arg.text === "--force") continue;
      return undefined;
    }
    if (arg.expands || !isAbsolute(arg.text) || arg.text.split(/[/\\]/).includes("..")) return undefined;
    paths.push(arg.text);
  }
  return paths.length > 0 ? paths : undefined;
}

/** Why a memory fork may not run this tool call, or undefined when it may. */
export async function forkRefusal(name: string, args: Record<string, unknown>, folders: MemoryFolders, cwd: string): Promise<string | undefined> {
  const where = `${folders.own} or ${folders.shared}`;
  if (name === "read") return undefined;
  if ((name === "write" || name === "edit") && typeof args.path === "string" && (await memoryFile(toolPath(cwd, args.path), folders))) return undefined;
  if (name === "bash") {
    const pipeline = typeof args.command === "string" ? parseShell(args.command) : undefined;
    if (pipeline && readOnly(pipeline)) return undefined;
    const targets = pipeline && rmTargets(pipeline);
    if (targets && (await Promise.all(targets.map((path) => memoryFile(path, folders)))).every(Boolean)) return undefined;
    return (
      `Only read-only shell commands (ls, find, grep, cat, stat, wc, head, tail and sqlite3 -readonly -safe, also joined by pipes) and rm (no flags except -f) of .md files under ${where} are permitted in this context. ` +
      "Anything else that writes, redirects to a file, runs other programs or modifies state is denied."
    );
  }
  return `only read, read-only bash, and write/edit of .md files within ${where} are allowed in this context`;
}

/** Whether a main agent's tool call wrote, edited or deleted a file in a memory folder. */
function writesMemory(name: string, args: Record<string, unknown>, folders: MemoryFolders, cwd: string): boolean {
  if ((name === "write" || name === "edit") && typeof args.path === "string") return folderOf(toolPath(cwd, args.path), folders) !== undefined;
  if ((name !== "bash" && name !== "screen") || typeof args.command !== "string") return false;
  const command = args.command;
  const mentioned = command
    .split(/[\s'"`;|&<>()=]+/)
    .some((token) => token.length > 0 && folderOf(resolve(cwd, token.replace(/^~(?=\/|$)/, homedir())), folders) !== undefined);
  if (!mentioned) return false;
  const pipeline = parseShell(command);
  return !pipeline || !readOnly(pipeline);
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

interface Fork {
  rounds: number;
  maxTurns?: number;
  written: Set<string>;
  deleted: Set<string>;
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
          beforeTool: async (call) => {
            const refusal = await forkRefusal(call.name, call.arguments, this.#host.folders, this.#cwd);
            if (refusal !== undefined) return { block: refusal };
            // The passes run one at a time: a command that never ends, such as tail -f, must not hold up the next ones.
            if (call.name === "bash" && call.arguments.timeout === undefined) return { arguments: { ...call.arguments, timeout: SHELL_TIMEOUT_SECONDS } };
            return undefined;
          },
          afterTool: (call, result, api) => {
            const state = fork(api.conversationId);
            if (!state || result.isError) return undefined;
            const args = call.arguments;
            if ((call.name === "write" || call.name === "edit") && typeof args.path === "string") state.written.add(toolPath(this.#cwd, args.path));
            if (call.name === "bash" && typeof args.command === "string") {
              const pipeline = parseShell(args.command);
              for (const path of (pipeline && rmTargets(pipeline)) ?? []) if (!existsSync(path)) state.deleted.add(path);
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
    const wrote = messages.some(
      (message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && writesMemory(part.name, part.arguments, folders, this.#cwd)),
    );
    let next: MemoryProgress;
    if (wrote) {
      // The main agent saved what it wanted itself: that counts as a memory change, as Claude Code skips the pass.
      this.#log("memory pass skipped: the main agent wrote memory itself", { messages: messages.length });
      next = { ...progress, cursor: at, changes: progress.changes + 1 };
    } else {
      this.beforePass?.();
      const changed = await this.#fork(at, await this.#host.extraction(messages.length), EXTRACTION_TURNS);
      if (!changed) return;
      this.#log("memory pass", { messages: messages.length, written: changed.written.length, deleted: changed.deleted.length });
      const any = changed.written.length + changed.deleted.length > 0;
      next = { ...progress, cursor: at, changes: progress.changes + (any ? 1 : 0) };
      if (any) await this.#host.noted({ source: "extract", ...changed });
    }
    await this.#host.saveProgress(next);
    if (!this.#closing && this.#host.enabled() && dreamDue(next)) await this.#dream(at, next);
  }

  async #dream(at: number, progress: MemoryProgress): Promise<void> {
    const changed = await this.#fork(at, await this.#host.dream(progress));
    if (!changed) return;
    this.#log("memory dream", { written: changed.written.length, deleted: changed.deleted.length });
    await this.#host.saveProgress({ ...(progress.cursor === undefined ? {} : { cursor: progress.cursor }), changes: 0, dreamAt: Date.now() });
    if (changed.written.length + changed.deleted.length > 0) await this.#host.noted({ source: "dream", ...changed });
  }

  /**
   * Fork the main conversation at `at`, give the fork the message, and wait until it ends. Returns the files it wrote
   * and deleted, or undefined when its model failed or the gateway stops. The fork is deleted after.
   */
  async #fork(at: number, message: string, maxTurns?: number): Promise<{ written: string[]; deleted: string[] } | undefined> {
    const root = this.#root!;
    const context = this.#context;
    const id = await root.commit(async (tx) => {
      const conversation = await tx.forkConversation(ROOT_CONVERSATION_ID, at as EntryId, { ownership: { kind: "ownerless" } });
      // pi-durable gives a fork a session of its own; with the main conversation's, the provider finds its cache.
      (await tx.doc(ProviderDoc, conversation.id)).sessionId = (await tx.doc(ProviderDoc, ROOT_CONVERSATION_ID)).sessionId;
      // Only hooks: the sections and tools stay those of the main conversation, so the start of the request does.
      await configure(tx, conversation.id, { extensions: { add: [this.extension] } });
      return conversation.id;
    }, context);
    const state: Fork = { rounds: 0, ...(maxTurns === undefined ? {} : { maxTurns }), written: new Set(), deleted: new Set() };
    this.#forks.set(Number(id), state);
    try {
      const fork = (await this.#harness!.conversation(id, context))!;
      const submission = await fork.submit({ type: "input", content: message, requestId: `memory:${String(id)}`, whenBusy: "followUp", entry: { kind: "bot.memory" } }, context);
      const settled = await submission.wait(context);
      if (this.#closing) return undefined;
      const capped = state.maxTurns !== undefined && state.rounds >= state.maxTurns;
      if (settled.status !== "done" && !capped) {
        this.#log("memory pass got no answer", { reason: settled.status === "unanswered" ? settled.reason : "unknown" });
        return undefined;
      }
      const deleted = [...state.deleted];
      return { written: [...state.written].filter((path) => !deleted.includes(path)), deleted };
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
