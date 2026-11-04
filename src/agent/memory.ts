import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

// The memory, as Claude Code's automatic memory, as the agent sees it: files in the bot's memory folder and in the one
// all bots of the POTS_HOME share. A memory file read 2 days or more after it changed says how old it is.

/** The bot's own memory folder and the one all bots of the POTS_HOME share. Both exist. */
export interface MemoryFolders {
  own: string;
  shared: string;
}

export interface MemoryHost {
  /** settings.autoMemory; false: no age note. */
  enabled(): boolean;
  folders: MemoryFolders;
}

const DAY = 86_400_000;

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
