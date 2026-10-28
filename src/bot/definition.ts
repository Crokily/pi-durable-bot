import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compaction, Thinking } from "../agent/agent.ts";
import type { JudgeSetting } from "../agent/judge.ts";
import type { ChannelConfig } from "../core/channel.ts";


/** bot.json: who the bot is and where it is. The agent may edit it; changes apply while running. */
export interface BotDefinition {
  name: string;
  /** "provider/modelId", any model pi can use. */
  model: string;
  thinking: Thinking;
  /** Who judges events that do not mention the bot: "main" (its own model), "off" (every event wakes it), or a classifier "provider/modelId". */
  judge: JudgeSetting;
  channels: ChannelConfig[];
  settings: BotSettings;
}

export interface BotSettings {
  /** Wait this long after the last event in a place before deciding on a wake. */
  debounceMs: number;
  /** Never wait longer than this after the first event. */
  debounceMaxMs: number;
  /** The judge wakes the bot when both answers are at least this probable. */
  judgeThreshold: number;
  /** How many earlier messages of the place the judge sees. */
  judgeContextMessages: number;
  /** When the agent has no timed wake set, it is woken this often. */
  fallbackWakeMinutes: number;
  /** pi-durable compaction, the fallback when the agent does not turn the page. Unset values fit the model's context window. */
  compaction: Compaction;
}

export const DEFAULT_SETTINGS: BotSettings = {
  debounceMs: 3_000,
  debounceMaxMs: 20_000,
  judgeThreshold: 0.5,
  judgeContextMessages: 20,
  fallbackWakeMinutes: 120,
  compaction: {},
};

export const DEFAULT_MODEL = "openai/gpt-6.1-sol";
export const DEFAULT_JUDGE: JudgeSetting = "main";

export function botPaths(dir: string) {
  return {
    dir,
    definition: join(dir, "bot.json"),
    definitionError: join(dir, "bot.json.error"),
    persona: join(dir, "persona.md"),
    responsibilities: join(dir, "responsibilities.md"),
    notes: join(dir, "notes.md"),
    workspace: join(dir, "workspace"),
    db: join(dir, "bot.sqlite"),
    socket: controlAddress(dir),
    crashAfterSend: join(dir, "crash-after-send"),
    /** A note from pots init: the bot is woken with it at its first start, then the file is removed. */
    firstWake: join(dir, "first-wake.md"),
  };
}

export type BotPaths = ReturnType<typeof botPaths>;

/**
 * The control endpoint of a bot: a Unix socket in its folder, or a named pipe on Windows. A Unix socket path must be
 * short (104 bytes on macOS), so a deep folder gets its socket in the temporary directory instead.
 */
function controlAddress(dir: string): string {
  const name = `pots-${createHash("sha256").update(process.platform === "win32" ? dir.toLowerCase() : dir).digest("hex").slice(0, 16)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const socket = join(dir, "control.sock");
  return Buffer.byteLength(socket) < 100 ? socket : join(tmpdir(), `${name}.sock`);
}

/** A bot ID: lowercase letters, digits, "_" and "-". It names the bot's folder. */
export const BOT_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Read and check bot.json. Throws with a readable message when it is wrong. */
export function readDefinition(file: string): { definition: BotDefinition; text: string } {
  const text = readFileSync(file, "utf8");
  const raw = JSON.parse(text) as Partial<BotDefinition> & { settings?: Partial<BotSettings> };
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${file}: "name" is required`);
  if (!Array.isArray(raw.channels)) throw new Error(`${file}: "channels" must be a list`);
  const ids = new Set<string>();
  for (const channel of raw.channels) {
    if (!channel || typeof channel.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(channel.id)) {
      throw new Error(`${file}: every channel needs an "id" of lowercase letters, digits and dashes`);
    }
    if (typeof channel.type !== "string") throw new Error(`${file}: channel ${channel.id} needs a "type"`);
    if (ids.has(channel.id)) throw new Error(`${file}: channel id ${channel.id} is used twice`);
    ids.add(channel.id);
  }
  const model = raw.model ?? DEFAULT_MODEL;
  if (!/^[^/]+\/.+$/.test(model)) throw new Error(`${file}: "model" must be "provider/modelId"`);
  const judge = raw.judge ?? DEFAULT_JUDGE;
  if (judge !== "main" && judge !== "off" && !/^[^/]+\/.+$/.test(judge)) throw new Error(`${file}: "judge" must be "main", "off" or "provider/modelId"`);
  return {
    text,
    definition: {
      name: raw.name.trim(),
      model,
      thinking: raw.thinking ?? "medium",
      judge,
      channels: raw.channels,
      settings: { ...DEFAULT_SETTINGS, ...raw.settings, compaction: { ...DEFAULT_SETTINGS.compaction, ...raw.settings?.compaction } },
    },
  };
}
