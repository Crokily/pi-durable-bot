import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Context } from "effect";
import type { Judge } from "../core/judge.ts";
import type { Timer } from "./timers.ts";
import type { WakerSettings } from "./waker.ts";

export type Print = (message: string, data?: Record<string, unknown>) => void;

/** What the bot gives its gateway. Getters, because bot.json can change while the bot runs. */
export interface GatewayOptions {
  /** The bot's ID, for the spans exported over OTLP. */
  readonly bot: string;
  /** The judge of events that do not mention the bot; undefined: every such event wakes the bot. */
  readonly judge: () => Judge | undefined;
  readonly settings: () => WakerSettings;
  /** When the agent has no timed wake set, it is woken this often. */
  readonly fallbackWakeMinutes: () => number;
  /** Hand a due timer to the bot. Resolves with the submission ID once the wake is durable. caller: the wake's span. */
  readonly fireTimer: (timer: Timer, caller?: TelemetrySpan) => Promise<string>;
  readonly print: Print;
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayOptions>()("pots/gateway/GatewayConfig") {}
