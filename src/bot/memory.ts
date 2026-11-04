import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The bot's memory, as Claude Code's auto memory: files. Each bot has its own folder, <bot folder>/memory/, and the
// bots of one POTS_HOME share one more, POTS_HOME/memory/, for facts about the user. A memory is one markdown file with
// frontmatter (name, description, metadata.type); MEMORY.md in each folder is its index, one line per memory. To
// forget a memory is to delete its file and its line.

export const INDEX = "MEMORY.md";
/** MEMORY.md is loaded up to this many lines and characters, as in Claude Code; the rest is cut with a warning. */
const INDEX_LINES = 200;
const INDEX_CHARS = 25_000;

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
