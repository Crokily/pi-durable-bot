import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CONFIG_DIR = process.env.PERSONAL_BOT_CONFIG_DIR ?? join(homedir(), ".config/personal-bot");
export const DATA_DIR = process.env.PERSONAL_BOT_DATA_DIR ?? join(homedir(), ".local/share/personal-bot");

export interface BotConfig {
  /** Directory name and log label. */
  id: string;
  /** Name in Slack. */
  name: string;
  /** Env file with SLACK_APP_TOKEN and SLACK_BOT_TOKEN. */
  slackEnv: string;
  /** Env file with JEV_API_KEY. */
  jevEnv: string;
  /** "provider/modelId". */
  model: string;
  thinking: "low" | "medium" | "high" | "xhigh";
  /** File with the bot's persona and context prompt. Optional. */
  persona?: string;
  /** Text that seeds the bot's responsibilities file on first start. The agent maintains the file after that. */
  responsibilities: string;
  dataDir: string;
  /** Wait this long after the last message before deciding. */
  debounceMs: number;
  /** Never wait longer than this after the first message. */
  debounceMaxMs: number;
  /** Jev wakes the agent when both answers are at least this probable. */
  jevThreshold: number;
  /** pi-durable compaction, the fallback when the agent does not turn the page. Fields as in pi-durable's CompactionPolicy. */
  compaction: { reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number };
  /** Patrol interval when the agent has not set one. */
  defaultPatrolMinutes: number;
}

const DEFAULTS = {
  model: "openai/gpt-6.1-sol",
  thinking: "medium",
  responsibilities: "我是 coly，用户的个人助理。我负责：回答用户的问题，帮用户处理个人事务，跟进用户交给我的事情。",
  debounceMs: 3_000,
  debounceMaxMs: 20_000,
  jevThreshold: 0.5,
  compaction: { reserveTokens: 32_768 },
  defaultPatrolMinutes: 120,
} satisfies Partial<BotConfig>;

/**
 * Read `bots.json` in the config directory. Without it, run one personal bot named coly.
 * Relative paths in the file are relative to the config directory.
 */
export function loadBots(): BotConfig[] {
  const file = join(CONFIG_DIR, "bots.json");
  const raw: { bots: Partial<BotConfig>[] } = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { bots: [{ id: "personal", name: "coly" }] };
  const resolve = (path: string) => (isAbsolute(path) ? path : join(CONFIG_DIR, path));
  const bots = raw.bots.map((bot): BotConfig => {
    if (!bot.id || !bot.name) throw new Error(`bots.json: every bot needs "id" and "name"`);
    if (!/^[a-z0-9_-]+$/.test(bot.id)) throw new Error(`bots.json: bad id ${JSON.stringify(bot.id)}`);
    return {
      ...DEFAULTS,
      ...bot,
      id: bot.id,
      name: bot.name,
      slackEnv: resolve(bot.slackEnv ?? "slack.env"),
      jevEnv: resolve(bot.jevEnv ?? "jev.env"),
      persona: bot.persona === undefined ? undefined : resolve(bot.persona),
      dataDir: bot.dataDir ?? join(DATA_DIR, bot.id),
    };
  });
  const ids = new Set(bots.map((bot) => bot.id));
  if (ids.size !== bots.length) throw new Error("bots.json: bot ids must be unique");
  return bots;
}

/** Read KEY=value lines. Values are never logged. */
export function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

export function requireKeys(path: string, keys: readonly string[]): Record<string, string> {
  const values = readEnvFile(path);
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`${path}: missing ${missing.join(", ")}`);
  return values;
}
