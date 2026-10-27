import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Compaction, Thinking } from "../agent/agent.ts";
import type { ChannelConfig } from "../core/channel.ts";

export const DATA_DIR = process.env.PERSONAL_BOT_DATA_DIR ?? join(homedir(), ".local/share/personal-bot");
export const CONFIG_DIR = process.env.PERSONAL_BOT_CONFIG_DIR ?? join(homedir(), ".config/personal-bot");

/** bot.json: who the bot is and where it is. The agent may edit it; changes apply while running. */
export interface BotDefinition {
  name: string;
  /** "provider/modelId". */
  model: string;
  thinking: Thinking;
  channels: ChannelConfig[];
  settings: BotSettings;
}

export interface BotSettings {
  /** Wait this long after the last event in a place before deciding on a wake. */
  debounceMs: number;
  /** Never wait longer than this after the first event. */
  debounceMaxMs: number;
  /** Jev wakes the bot when both answers are at least this probable. */
  jevThreshold: number;
  /** How many earlier messages of the place Jev sees. */
  jevContextMessages: number;
  /** When the agent has no timed wake set, it is woken this often. */
  fallbackWakeMinutes: number;
  /** pi-durable compaction, the fallback when the agent does not turn the page. */
  compaction: Compaction;
}

export const DEFAULT_SETTINGS: BotSettings = {
  debounceMs: 3_000,
  debounceMaxMs: 20_000,
  jevThreshold: 0.5,
  jevContextMessages: 20,
  fallbackWakeMinutes: 120,
  compaction: { reserveTokens: 32_768 },
};

export const DEFAULT_MODEL = "openai/gpt-6.1-sol";

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
    socket: join(dir, "control.sock"),
    modelsStore: join(dir, "models-store.json"),
    crashAfterSend: join(dir, "crash-after-send"),
  };
}

export type BotPaths = ReturnType<typeof botPaths>;

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
  return {
    text,
    definition: {
      name: raw.name.trim(),
      model,
      thinking: raw.thinking ?? "medium",
      channels: raw.channels,
      settings: { ...DEFAULT_SETTINGS, ...raw.settings, compaction: { ...DEFAULT_SETTINGS.compaction, ...raw.settings?.compaction } },
    },
  };
}
