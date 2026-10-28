import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compaction, Thinking } from "../agent/agent.ts";
import type { JudgeSetting } from "../agent/judge.ts";
import { Effect, Schema } from "effect";
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

const DEFAULT_SETTINGS: BotSettings = {
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
    crashAfterWake: join(dir, "crash-after-wake"),
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

const PROVIDER_MODEL = /^[^/]+\/.+$/;

/** bot.json as a schema: the checks, the defaults and the types. */
const Definition = Schema.Struct({
  name: Schema.Trim.check(Schema.isNonEmpty()),
  model: Schema.String.check(Schema.isPattern(PROVIDER_MODEL)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MODEL))),
  thinking: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("medium" as const))),
  judge: Schema.String.check(Schema.makeFilter((judge) => judge === "main" || judge === "off" || PROVIDER_MODEL.test(judge))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_JUDGE)),
  ),
  channels: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)), type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
  settings: Schema.Struct({
    debounceMs: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SETTINGS.debounceMs))),
    debounceMaxMs: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SETTINGS.debounceMaxMs))),
    judgeThreshold: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SETTINGS.judgeThreshold))),
    judgeContextMessages: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SETTINGS.judgeContextMessages))),
    fallbackWakeMinutes: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SETTINGS.fallbackWakeMinutes))),
    compaction: Schema.Struct({
      reserveTokens: Schema.optionalKey(Schema.Finite),
      keepRecentTokens: Schema.optionalKey(Schema.Finite),
      backgroundTokens: Schema.optionalKey(Schema.Finite),
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

const validate = Schema.toStandardSchemaV1(Definition)["~standard"].validate;

/** The message for the first problem in bot.json, in the words people know from earlier versions. */
function problem(raw: unknown, issue: { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] | undefined }): string {
  const path = (issue.path ?? []).map((part) => (typeof part === "object" ? part.key : part));
  const channel = (raw as { channels?: { id?: unknown }[] }).channels?.[Number(path[1])];
  switch (path[0]) {
    case undefined:
      return `must be a JSON object: ${issue.message}`;
    case "name":
      return `"name" is required`;
    case "model":
      return `"model" must be "provider/modelId"`;
    case "judge":
      return `"judge" must be "main", "off" or "provider/modelId"`;
    case "thinking":
      return `"thinking" must be off, minimal, low, medium, high or xhigh`;
    case "channels":
      if (path.length === 1) return `"channels" must be a list`;
      if (path[2] === "type") return `channel ${String(channel?.id)} needs a "type"`;
      return `every channel needs an "id" of lowercase letters, digits and dashes`;
    default:
      return `${path.join(".")}: ${issue.message}`;
  }
}

/** Read and check bot.json. Throws with a readable message when it is wrong. */
export function readDefinition(file: string): { definition: BotDefinition; text: string } {
  const text = readFileSync(file, "utf8");
  const raw: unknown = JSON.parse(text);
  const result = validate(raw);
  if (result instanceof Promise) throw new Error(`${file}: could not be checked`);
  if (result.issues) throw new Error(`${file}: ${problem(raw, result.issues[0]!)}`);
  const decoded = result.value;
  const ids = new Set<string>();
  for (const channel of decoded.channels) {
    if (ids.has(channel.id)) throw new Error(`${file}: channel id ${channel.id} is used twice`);
    ids.add(channel.id);
  }
  return {
    text,
    definition: {
      name: decoded.name,
      model: decoded.model,
      thinking: decoded.thinking,
      judge: decoded.judge,
      channels: decoded.channels.map((channel) => ({ ...channel })),
      settings: { ...decoded.settings, compaction: { ...decoded.settings.compaction } },
    },
  };
}
