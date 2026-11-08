import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Context } from "effect";
import type { Judge } from "../core/judge.ts";
import type { Delivered } from "../core/wake.ts";
import type { DueTimer } from "./timers.ts";
import type { WakerSettings } from "./waker.ts";

export type Print = (message: string, data?: Record<string, unknown>) => void;

/**
 * Run a command. onOutput gets stdout and stderr as they come. When signal aborts, the command and the processes it
 * started are stopped. Resolves once the command ended: with its exit code, or why it could not run. Never rejects.
 */
export type RunCommand = (
  command: string,
  env: Record<string, string>,
  signal: AbortSignal,
  onOutput: (text: string) => void,
) => Promise<{ exitCode: number } | { error: string }>;

/** What the bot gives its gateway. Getters, because bot.json can change while the bot runs. */
export interface GatewayOptions {
  /** The bot's ID, for the spans exported over OTLP. */
  readonly bot: string;
  /** The judge of events that do not mention the bot; undefined: every such event wakes the bot. */
  readonly judge: () => Judge | undefined;
  readonly settings: () => WakerSettings;
  /** While no wake set with pots wake is pending, the bot is woken this often. Routines do not count. */
  readonly fallbackWakeMinutes: () => number;
  /** Hand a due timer to the bot. Resolves once the wake is durable. caller: the wake's span. */
  readonly fireTimer: (timer: DueTimer, caller?: TelemetrySpan) => Promise<Delivered>;
  /** Run a routine's command as the bot's bash tool runs one, with env added. Without it, routines with --run fail to start. */
  readonly runCommand?: RunCommand;
  /** Where the files of messages are saved, one folder per message. What is in it is deleted FILE_DAYS days after it was saved. */
  readonly filesDir: string;
  readonly print: Print;
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayOptions>()("pots/gateway/GatewayConfig") {}
