import { Cron, Result } from "effect";
import { formatTime } from "../core/time.ts";
import { SPAN_RETENTION_DAYS } from "./tracing.ts";

// Routines: repeating work on a schedule. A routine either wakes the bot with a note, or runs a command in the bot's
// shell, which decides itself whether to wake the bot. Their tables are in the bot's SQLite file, next to bot_timers.

export const ROUTINES_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_routines (
  name TEXT PRIMARY KEY,
  every_ms INTEGER,
  cron TEXT,
  note TEXT,
  run TEXT,
  timeout_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  failing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT NOT NULL,
  exit_code INTEGER,
  output TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bot_routine_runs_routine ON bot_routine_runs (routine, id);
CREATE INDEX IF NOT EXISTS bot_routine_runs_started ON bot_routine_runs (started_at);
`;

/** A command runs at most this long when its routine gives no timeout. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Runs are kept as long as gw_spans. */
export const RUN_DAYS = SPAN_RETENTION_DAYS;
/** What is kept of a command's output: its last lines, at most this many and this many characters. */
export const OUTPUT_LINES = 20;
export const OUTPUT_CHARS = 4_000;

export interface Routine {
  name: string;
  /** --every, or null for --cron. */
  every_ms: number | null;
  /** --cron, in this computer's time zone. */
  cron: string | null;
  /** --note: what the wake says. Null for --run. */
  note: string | null;
  /** --run: the command. Null for --note. */
  run: string | null;
  timeout_ms: number;
  /** When it was added or last replaced. --every counts from here. */
  created_at: number;
  /** Its next time. */
  next_at: number;
  /** 1: a failed run woke the bot, and the next failures do not, until a run succeeds. */
  failing: number;
}

/**
 * How a run ended. running: it still runs. exit: the command ended, with exit_code. timeout: Pots stopped it at the
 * timeout. error: the command could not start (output says why). stopped: the gateway stopped it, or a crash cut it
 * off. woke: a --note routine woke the bot.
 */
export type RunResult = "running" | "exit" | "timeout" | "error" | "stopped" | "woke";

export interface RoutineRun {
  id: number;
  routine: string;
  started_at: number;
  ended_at: number | null;
  result: RunResult;
  exit_code: number | null;
  /** The last lines of the command's output, stdout and stderr as they came. */
  output: string;
}

/** What pots routine add gives. Times in ms. */
export interface RoutineInput {
  name: string;
  every?: number;
  cron?: string;
  note?: string;
  run?: string;
  timeout?: number;
}

/** A routine's name, and a wake's source: short, so they read as names in a wake. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Why a name is not good, or undefined. what: how the command line calls it. */
export function nameProblem(name: string, what: string): string | undefined {
  return NAME.test(name) ? undefined : `bad ${what} ${JSON.stringify(name)}: use letters, digits, "-" and "_", at most 64 characters`;
}

/** A failed run: a non-zero exit code, a timeout, or a command that could not start. */
export function failed(run: Pick<RoutineRun, "result" | "exit_code">): boolean {
  return run.result === "timeout" || run.result === "error" || (run.result === "exit" && run.exit_code !== 0);
}

/** Why the routine cannot be added as given, its name aside, or undefined. now: when it is added. */
export function routineProblem(input: RoutineInput, now: number): string | undefined {
  if ((input.every === undefined) === (input.cron === undefined)) return "give exactly one of --every and --cron";
  if ((input.note === undefined) === (input.run === undefined)) return "give exactly one of --note and --run";
  if (input.every !== undefined && !(Number.isFinite(input.every) && input.every > 0)) return "--every must be more than 0";
  if (input.run !== undefined && !input.run.trim()) return "--run is empty";
  if (input.timeout !== undefined) {
    if (input.run === undefined) return "--timeout is for --run";
    if (!(Number.isFinite(input.timeout) && input.timeout > 0)) return "--timeout must be more than 0";
  }
  if (input.cron !== undefined) {
    const parsed = Cron.parse(input.cron);
    if (Result.isFailure(parsed)) return `bad cron expression ${JSON.stringify(input.cron)}: ${parsed.failure.message}`;
    try {
      Cron.next(parsed.success, new Date(now));
    } catch {
      return `bad cron expression ${JSON.stringify(input.cron)}: its time never comes`;
    }
  }
  return undefined;
}

/**
 * The routine's first time strictly after `after`. --every counts from when the routine was added; --cron is in this
 * computer's time zone. Undefined when its time never comes.
 */
export function nextAfter(routine: Pick<Routine, "every_ms" | "cron" | "created_at">, after: number): number | undefined {
  if (routine.every_ms !== null) {
    const steps = Math.max(0, Math.floor((after - routine.created_at) / routine.every_ms)) + 1;
    return routine.created_at + steps * routine.every_ms;
  }
  const parsed = Cron.parse(routine.cron ?? "");
  if (Result.isFailure(parsed)) return undefined;
  try {
    return Cron.next(parsed.success, new Date(after)).getTime();
  } catch {
    return undefined;
  }
}

/** The end of a command's output, as it comes. */
export class OutputTail {
  #text = "";

  push(chunk: string): void {
    this.#text += chunk;
    // Enough for the last lines, without keeping all of a command that writes a lot.
    if (this.#text.length > 16 * OUTPUT_CHARS) this.#text = this.#text.slice(-4 * OUTPUT_CHARS);
  }

  get text(): string {
    return lastLines(this.#text);
  }
}

/** The last OUTPUT_LINES lines of a text, at most OUTPUT_CHARS characters. */
export function lastLines(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const last = lines.slice(-OUTPUT_LINES).join("\n");
  return last.length > OUTPUT_CHARS ? last.slice(-OUTPUT_CHARS) : last;
}

/** A duration as pots wake --in takes it: 90s, 30m, 2h, 1d. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

/** How long something took, roughly: "3s", "4m 10s", "2h 5m". */
function took(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

/** "every 30m" or 'cron "0 9 * * 1-5"'. */
export function describeSchedule(routine: Pick<Routine, "every_ms" | "cron">): string {
  return routine.every_ms !== null ? `every ${formatDuration(routine.every_ms)}` : `cron ${JSON.stringify(routine.cron)}`;
}

/** What the routine does, in one line. */
export function describeWork(routine: Pick<Routine, "note" | "run" | "timeout_ms">): string {
  return routine.run !== null
    ? `runs ${JSON.stringify(routine.run)} (timeout ${formatDuration(routine.timeout_ms)})`
    : `wakes the bot with the note ${JSON.stringify(routine.note ?? "")}`;
}

/** How a run ended, in a few words: "exit code 2 after 3s, failed". */
export function describeRun(run: RoutineRun, now: number): string {
  const after = run.ended_at === null ? "" : ` after ${took(run.ended_at - run.started_at)}`;
  const fail = failed(run) ? ", failed" : "";
  switch (run.result) {
    case "running":
      return `running since ${formatTime(run.started_at)} (${took(now - run.started_at)})`;
    case "woke":
      return `${formatTime(run.started_at)}, woke the bot`;
    case "exit":
      return `${formatTime(run.started_at)}, exit code ${run.exit_code}${after}${fail}`;
    case "timeout":
      return `${formatTime(run.started_at)}, stopped at its timeout${after}${fail}`;
    case "error":
      return `${formatTime(run.started_at)}, could not start: ${run.output.split("\n")[0]}${fail}`;
    case "stopped":
      return `${formatTime(run.started_at)}, stopped when the gateway stopped`;
  }
}

/** The routines and the fallback check-in, as pots routine list gives them. */
export interface RoutineListing {
  routines: (Routine & { last?: RoutineRun })[];
  /** next: when the fallback check-in comes; undefined while a wake set with pots wake is pending. */
  fallback: { minutes: number; next?: number };
}

/** pots routine list, for people and the bot. */
export function renderRoutines(listing: RoutineListing, now: number): string {
  const lines: string[] = [];
  for (const routine of listing.routines) {
    lines.push(`- ${routine.name}: ${describeSchedule(routine)}, ${describeWork(routine)}`);
    lines.push(`  next: ${formatTime(routine.next_at)}`);
    lines.push(`  last: ${routine.last ? describeRun(routine.last, now) : `none in the last ${RUN_DAYS} days`}`);
  }
  const fallback = listing.fallback;
  lines.push(`- fallback check-in (built in, cannot be removed): every ${fallback.minutes} minutes while no wake set with pots wake is pending`);
  lines.push(fallback.next === undefined ? "  next: waits, because a wake set with pots wake is pending" : `  next: ${formatTime(fallback.next)}`);
  return [listing.routines.length === 0 ? "No routines added." : `Routines (${listing.routines.length}):`, ...lines].join("\n");
}
