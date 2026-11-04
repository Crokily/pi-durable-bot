import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MemoryFolders, MemoryProgress, MemorySettle, MemorySource } from "../agent/memory.ts";
import type { Sql } from "../core/sql.ts";

// The bot's memory, as Claude Code's auto memory: files. Each bot has its own folder, <bot folder>/memory/, and the
// bots of one POTS_HOME share one more, POTS_HOME/memory/, for facts about the user. A memory is one markdown file with
// frontmatter (name, description, metadata.type); MEMORY.md in each folder is its index, one line per memory. To
// forget a memory is to delete its file and its line. What the bot keeps about the memory passes is in bot_state.

export const INDEX = "MEMORY.md";
/** MEMORY.md is loaded up to this many lines and characters, as in Claude Code; the rest is cut with a warning. */
const INDEX_LINES = 200;
const INDEX_CHARS = 25_000;
/** A pass's list of memory files: the newest, at most this many, as in Claude Code. */
const LIST_FILES = 200;
/** The head of a memory file that the list reads for its frontmatter, as in Claude Code. */
const HEAD_LINES = 30;
const HEAD_BYTES = 65_536;
const TYPES = ["user", "feedback", "project", "reference"] as const;

/** A size as Claude Code writes it: "512 bytes", "24.4KB". */
function size(chars: number): string {
  const kb = chars / 1024;
  if (kb < 1) return `${chars} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  return `${(kb / 1024).toFixed(1).replace(/\.0$/, "")}MB`;
}

/** At most `chars` characters, cut at a space when one is not too far back, with "…". */
function shorten(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = [...text].slice(0, chars - 1).join("");
  const space = cut.search(/\s\S*$/);
  const words = space === -1 ? "" : cut.slice(0, space).trimEnd();
  return `${words.length > chars / 2 ? words : cut.trimEnd()}…`;
}

/** MEMORY.md as it is loaded: at most 200 lines and 25,000 characters, then Claude Code's warning. */
export function cutIndex(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split("\n").length;
  const chars = trimmed.length;
  const tooManyLines = lines > INDEX_LINES;
  const tooLong = chars > INDEX_CHARS;
  if (!tooManyLines && !tooLong) return trimmed;
  let kept = tooManyLines ? trimmed.split("\n").slice(0, INDEX_LINES).join("\n") : trimmed;
  if (kept.length > INDEX_CHARS) {
    const end = kept.lastIndexOf("\n", INDEX_CHARS);
    kept = kept.slice(0, end > 0 ? end : INDEX_CHARS);
  }
  const keptLines = trimmed[kept.length] === "\n" ? kept.split("\n").length : 0;
  const next = trimmed.indexOf("\n", kept.length + 1);
  const nextLine = trimmed.slice(kept.length + 1, next < 0 ? undefined : next).trim();
  const cutOff =
    keptLines === 0
      ? `everything after the first ${kept.length} characters of line 1 was cut off`
      : `${lines - keptLines} of ${lines} lines were cut off, starting at line ${keptLines + 1}${nextLine ? ` ("${shorten(nextLine, 80)}")` : ""}`;
  const what =
    tooLong && !tooManyLines
      ? `${size(chars)} (limit: ${size(INDEX_CHARS)}) — index entries are too long`
      : tooManyLines && !tooLong
        ? `${lines} lines (limit: ${INDEX_LINES})`
        : `${lines} lines and ${size(chars)}`;
  return `${kept}\n\n> WARNING: ${INDEX} is ${what}. Only part of it was loaded: ${cutOff}. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

/** A folder's MEMORY.md as it is loaded; "" when there is none or it is empty. */
export async function readIndex(folder: string): Promise<string> {
  const text = await readFile(join(folder, INDEX), "utf8").catch(() => "");
  return text.trim() ? cutIndex(text) : "";
}

export interface MemoryFile {
  /** Absolute. */
  path: string;
  mtimeMs: number;
  description?: string;
  type?: (typeof TYPES)[number];
}

/** The memory files of a folder and its subfolders, without MEMORY.md, newest first. */
async function memoryFiles(folder: string): Promise<MemoryFile[]> {
  const names = await readdir(folder, { recursive: true }).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".md") && basename(name) !== INDEX)
      .map(async (name): Promise<MemoryFile | undefined> => {
        const path = join(folder, name);
        try {
          const info = await stat(path);
          if (!info.isFile()) return undefined;
          return { path, mtimeMs: info.mtimeMs, ...frontmatter(await head(path)) };
        } catch {
          return undefined;
        }
      }),
  );
  return files.filter((file) => file !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The first 30 lines of a file, at most 64 KB. */
async function head(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, HEAD_LINES).join("\n");
  } finally {
    await file.close();
  }
}

/** description and metadata.type from a memory file's frontmatter. A type at the top level counts too, as in Claude Code. */
export function frontmatter(text: string): Pick<MemoryFile, "description" | "type"> {
  const match = /^\uFEFF?---\s*\n([\s\S]*?)---\s*(?:\n|$)/.exec(text);
  if (!match) return {};
  const value = (raw: string) => {
    const trimmed = raw.trim();
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted ? quoted[2]!.replace(/\\"/g, '"').replace(/''/g, "'") : trimmed;
  };
  let description: string | undefined;
  let top: string | undefined;
  let nested: string | undefined;
  let inMetadata = false;
  for (const line of match[1]!.split("\n")) {
    const pair = /^(\s*)([A-Za-z_][\w-]*):(.*)$/.exec(line.replace(/\r$/, ""));
    if (!pair) continue;
    const [, indent, key, rest] = pair;
    if (!indent) {
      inMetadata = key === "metadata";
      if (key === "description" && rest!.trim()) description = value(rest!);
      if (key === "type") top = value(rest!);
    } else if (inMetadata && key === "type") {
      nested = value(rest!);
    }
  }
  const type = TYPES.find((each) => each === (nested ?? top));
  return { ...(description ? { description } : {}), ...(type ? { type } : {}) };
}

/**
 * The "## Existing memory files" list of a pass, as Claude Code writes it, of both folders, newest first: the bot's own
 * by name, the shared ones with the shared folder in front.
 */
export async function listMemoryFiles(folders: MemoryFolders): Promise<string> {
  const files = [...(await memoryFiles(folders.own)), ...(await memoryFiles(folders.shared))].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LIST_FILES);
  return files
    .map((file) => {
      const name = file.path.startsWith(folders.own) ? file.path.slice(folders.own.length + 1) : file.path;
      const line = `- ${file.type ? `[${file.type}] ` : ""}${name} (${new Date(file.mtimeMs).toISOString()})`;
      return file.description ? `${line}: ${file.description}` : line;
    })
    .join("\n");
}

// ---- What the bot keeps about its memory passes, in bot_state ----
//
// memory_cursor, memory_changes and memory_dream_at: how far extraction got, the memory changes since the last dream and
// when it was. memory_changed: that a fork changed a file since the last settle, and which kind of fork, so the change
// counts also when the fork fails or the process dies. The notes for the main agent's next wake are not here: they
// live in the process, as in Claude Code.

type Executor = Parameters<Parameters<Sql["transaction"]>[0]>[0];

async function write(tx: Executor, key: string, value: string | undefined): Promise<void> {
  if (value === undefined) await tx.run("DELETE FROM bot_state WHERE key = ?", key);
  else await tx.run("INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

async function progressOf(tx: Executor): Promise<MemoryProgress> {
  const rows = await tx.all<{ key: string; value: string }>("SELECT key, value FROM bot_state WHERE key IN ('memory_cursor', 'memory_changes', 'memory_dream_at')");
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const cursor = value("memory_cursor");
  const dreamAt = value("memory_dream_at");
  return { ...(cursor === undefined ? {} : { cursor: Number(cursor) }), changes: Number(value("memory_changes") ?? 0), ...(dreamAt === undefined ? {} : { dreamAt: Number(dreamAt) }) };
}

export function memoryProgress(sql: Sql): Promise<MemoryProgress> {
  return progressOf(sql);
}

/** Keep at once that a fork changed a file. */
export async function recordMemoryChange(sql: Sql, source: MemorySource): Promise<void> {
  await sql.transaction((tx) => write(tx, "memory_changed", source));
}

/**
 * In one transaction: a change a fork made since the last settle counts, for extraction, as a memory change; then the
 * progress moves as `update` says.
 */
export async function settleMemory(sql: Sql, update: MemorySettle): Promise<MemoryProgress> {
  return sql.transaction(async (tx) => {
    const progress = await progressOf(tx);
    const changed = (await tx.get<{ value: string }>("SELECT value FROM bot_state WHERE key = 'memory_changed'"))?.value;
    const changes = progress.changes + (changed === "extract" ? 1 : 0) + (update.change ? 1 : 0);
    const next: MemoryProgress = {
      ...(update.cursor !== undefined ? { cursor: update.cursor } : progress.cursor !== undefined ? { cursor: progress.cursor } : {}),
      changes: update.dreamt === undefined ? changes : 0,
      ...(update.dreamt !== undefined ? { dreamAt: update.dreamt } : progress.dreamAt !== undefined ? { dreamAt: progress.dreamAt } : {}),
    };
    await write(tx, "memory_changed", undefined);
    await write(tx, "memory_cursor", next.cursor === undefined ? undefined : String(next.cursor));
    await write(tx, "memory_changes", String(next.changes));
    await write(tx, "memory_dream_at", next.dreamAt === undefined ? undefined : String(next.dreamAt));
    return next;
  });
}
