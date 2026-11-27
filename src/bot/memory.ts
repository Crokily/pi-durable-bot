import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { MemoryFolders, MemoryProgress, MemorySettle, MemorySource } from "../agent/memory.ts";
import type { Sql } from "../core/sql.ts";

// The bot's memory: files. Each bot has its own folder, <bot folder>/memory/, and the bots of one POTS_HOME share one
// more, POTS_HOME/memory/, for facts about the user. A memory is one markdown file with frontmatter (name, description,
// source, and expires for a fact that stops being true); MEMORY.md in each folder is its index, one line per memory.
// To forget a memory is to delete its file and its line. What the bot keeps about the memory passes is in bot_state.

export const INDEX = "MEMORY.md";
/** MEMORY.md is loaded up to this many lines and characters, as in Claude Code; the rest is cut with a warning. */
const INDEX_LINES = 200;
const INDEX_CHARS = 25_000;
/** A pass's list of memory files: the newest, at most this many, as in Claude Code. */
const LIST_FILES = 200;
/** The head of a memory file that the list reads for its frontmatter, as in Claude Code. */
const HEAD_LINES = 30;
const HEAD_BYTES = 65_536;

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

/** A memory folder's MEMORY.md as the prompt shows it, and what does not match between it and the folder's files. */
export interface LoadedIndex {
  /** MEMORY.md as it is loaded, without the lines of memories whose expires date has passed; "" when there is none or it is empty. */
  text: string;
  /** Links of MEMORY.md to .md files that do not exist, as they are written. */
  missing: string[];
  /** Memory files that no line of MEMORY.md links to, relative to the folder; not those whose expires date has passed. */
  unlisted: string[];
  /** Memory files whose expires date has passed, relative to the folder. */
  expired: string[];
  /** How full MEMORY.md is, and its lines that link to expired memories, in one line: see indexStatus; "" when it is empty. */
  status: string;
}

export interface MemoryFile {
  /** Absolute. */
  path: string;
  mtimeMs: number;
  description?: string;
  /** The frontmatter's expires, YYYY-MM-DD: after that day the memory is no longer true. */
  expires?: string;
}

/** Today's date here, YYYY-MM-DD. */
export function today(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Whether a memory's expires date has passed: it is before `day`. A value that is not a date never expires. */
function expired(file: MemoryFile | undefined, day: string): boolean {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(file?.expires ?? "")?.[0];
  return date !== undefined && date < day;
}

/** The .md files a line of MEMORY.md links to, as written, without an anchor: [Title](file.md). */
function links(line: string): string[] {
  const targets: string[] = [];
  for (const match of line.matchAll(/\]\(<?([^)\s>]+)>?\)/g)) {
    const target = match[1]!.replace(/#.*$/, "");
    if (target.endsWith(".md") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) targets.push(target);
  }
  return targets;
}

/**
 * A folder's MEMORY.md as it is loaded, and the facts the agent needs to fix it: links to files that are not there,
 * and memory files with no line. A line that links to a memory whose expires date has passed is left out; the file stays.
 */
export async function loadIndex(folder: string, day = today()): Promise<LoadedIndex> {
  const raw = await readFile(join(folder, INDEX), "utf8").catch(() => "");
  const files = new Map((await memoryFiles(folder)).map((file) => [file.path, file]));
  const linked = new Set<string>();
  const missing: string[] = [];
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const targets = links(line);
    const paths = targets.map((target) => resolve(folder, safeDecode(target)));
    for (const path of paths) linked.add(path);
    if (paths.some((path) => expired(files.get(path), day))) continue;
    kept.push(line);
    for (const [index, path] of paths.entries()) {
      if (!files.has(path) && !(await stat(path).then((info) => info.isFile()).catch(() => false))) missing.push(targets[index]!);
    }
  }
  const unlisted = [...files.values()].filter((file) => !linked.has(file.path) && !expired(file, day)).map((file) => relative(folder, file.path));
  const gone = [...files.values()].filter((file) => expired(file, day)).map((file) => relative(folder, file.path));
  const text = kept.join("\n");
  return {
    text: text.trim() ? cutIndex(text) : "",
    missing: [...new Set(missing)],
    unlisted: unlisted.sort(),
    expired: gone.sort(),
    status: indexStatus(raw, raw.split("\n").length - kept.length),
  };
}

/**
 * A plain fact about a MEMORY.md, against the limits it is loaded to: "MEMORY.md: 69/200 lines, 10/25 KB; 4 lines link
 * to expired memories."; "" when it is empty. KB here is 1,000 characters, as the limit is 25,000 characters.
 */
export function indexStatus(raw: string, expiredLines: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").length;
  const thousands = trimmed.length / 1000;
  const kb = thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : String(Math.round(thousands));
  const expired = expiredLines === 1 ? "1 line links to an expired memory" : `${expiredLines} lines link to expired memories`;
  return `${INDEX}: ${lines}/${INDEX_LINES} lines, ${kb}/${INDEX_CHARS / 1000} KB; ${expired}.`;
}

/** A link's path as a file name: %20 as a space. */
function safeDecode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
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

/** description and expires from a memory file's frontmatter, at its top level. */
export function frontmatter(text: string): Pick<MemoryFile, "description" | "expires"> {
  const match = /^\uFEFF?---\s*\n([\s\S]*?)---\s*(?:\n|$)/.exec(text);
  if (!match) return {};
  const value = (raw: string) => {
    const trimmed = raw.trim();
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted ? quoted[2]!.replace(/\\"/g, '"').replace(/''/g, "'") : trimmed;
  };
  const found: Pick<MemoryFile, "description" | "expires"> = {};
  for (const line of match[1]!.split("\n")) {
    const pair = /^([A-Za-z_][\w-]*):(.*)$/.exec(line.replace(/\r$/, ""));
    if (!pair || !pair[2]!.trim()) continue;
    if (pair[1] === "description") found.description = value(pair[2]!);
    if (pair[1] === "expires") found.expires = value(pair[2]!);
  }
  return found;
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
      const line = `- ${name} (${new Date(file.mtimeMs).toISOString()})${file.expires ? ` expires ${file.expires}` : ""}`;
      return file.description ? `${line}: ${file.description}` : line;
    })
    .join("\n");
}

// ---- What the bot keeps about its memory passes, in bot_state ----
//
// memory_cursor, memory_changes and memory_dream_at: how far extraction got, the memory changes since the last tidy and
// when it was (the key keeps the tidy's old name, the dream). memory_changed: that a fork changed a file since the last
// settle, and which kind of fork, so the change counts also when the fork fails or the process dies. The notes for the main agent's next wake are not here: they
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
  const tidiedAt = value("memory_dream_at");
  return { ...(cursor === undefined ? {} : { cursor: Number(cursor) }), changes: Number(value("memory_changes") ?? 0), ...(tidiedAt === undefined ? {} : { tidiedAt: Number(tidiedAt) }) };
}

export function memoryProgress(sql: Sql): Promise<MemoryProgress> {
  return progressOf(sql);
}

/** Keep at once that a fork changed a file. */
export async function recordMemoryChange(sql: Sql, source: MemorySource): Promise<void> {
  await sql.transaction((tx) => write(tx, "memory_changed", source));
}

/** The main agent or a child changed a memory folder: one more memory change. */
export async function countMemoryChange(sql: Sql): Promise<void> {
  await sql.run("INSERT INTO bot_state (key, value) VALUES ('memory_changes', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
}

/**
 * In one transaction: a change an extraction pass made since the last settle counts as a memory change; then the
 * progress moves as `update` says.
 */
export async function settleMemory(sql: Sql, update: MemorySettle): Promise<MemoryProgress> {
  return sql.transaction(async (tx) => {
    const progress = await progressOf(tx);
    const changed = (await tx.get<{ value: string }>("SELECT value FROM bot_state WHERE key = 'memory_changed'"))?.value;
    const changes = progress.changes + (changed === "extract" ? 1 : 0);
    const next: MemoryProgress = {
      ...(update.cursor !== undefined ? { cursor: update.cursor } : progress.cursor !== undefined ? { cursor: progress.cursor } : {}),
      changes: update.tidied === undefined ? changes : 0,
      ...(update.tidied !== undefined ? { tidiedAt: update.tidied } : progress.tidiedAt !== undefined ? { tidiedAt: progress.tidiedAt } : {}),
    };
    await write(tx, "memory_changed", undefined);
    await write(tx, "memory_cursor", next.cursor === undefined ? undefined : String(next.cursor));
    await write(tx, "memory_changes", String(next.changes));
    await write(tx, "memory_dream_at", next.tidiedAt === undefined ? undefined : String(next.tidiedAt));
    return next;
  });
}
