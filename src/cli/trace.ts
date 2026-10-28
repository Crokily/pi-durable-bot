import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { botPaths } from "../bot/definition.ts";
import { botDir, resolveBot, userError } from "./control.ts";

// pots trace: what the gateway did, from the spans in the bot's gw_spans table. One trace is one wake: the events it
// is about, the decision, and the messages the agent sent for it.

interface Span {
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  start_at: number;
  end_at: number;
  status: string;
  error: string | null;
  attributes: string | null;
  links: string | null;
}

const bot = Flag.String("bot").pipe(Flag.optional, Flag.withDescription("Which bot. Default: $POTS_BOT, or the only bot."));

export const traceCommand = Command.make(
  "trace",
  {
    id: Argument.String("id").pipe(
      Argument.optional,
      Argument.withDescription("A trace ID (its first characters are enough), a send ID or a wake ID. Without it: the last wakes."),
    ),
    last: Flag.Int("last").pipe(Flag.withAlias("n"), Flag.withDefault(20), Flag.withDescription("How many wakes to list.")),
    bot,
  },
  (input) =>
    Effect.gen(function* () {
      const id = yield* resolveBot(input.bot);
      const file = botPaths(botDir(id)).db;
      if (!existsSync(file)) return yield* Effect.fail(userError(`bot ${id} has no database yet; start it first`));
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(file, { readOnly: true, timeout: 5_000 })),
        (open) => Effect.sync(() => open.close()),
      );
      const all = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as unknown as Span[];
      if (all("SELECT name AS span_id FROM sqlite_master WHERE name = 'gw_spans'").length === 0) {
        return yield* Effect.fail(userError(`bot ${id} has no traces yet`));
      }
      if (Option.isNone(input.id)) {
        const wakes = all("SELECT * FROM gw_spans WHERE name = 'wake' AND parent_id IS NULL ORDER BY start_at DESC LIMIT ?", input.last).reverse();
        if (wakes.length === 0) return yield* Console.log("No wakes in the last 7 days.");
        for (const wake of wakes) yield* Console.log(summary(wake, all("SELECT * FROM gw_spans WHERE trace_id = ?", wake.trace_id)));
        return;
      }
      const key = input.id.value;
      const found =
        all("SELECT * FROM gw_spans WHERE trace_id LIKE ? ORDER BY start_at LIMIT 1", `${key}%`)[0] ??
        all("SELECT * FROM gw_spans WHERE name = 'send' AND json_extract(attributes, '$.send') = ? ORDER BY start_at DESC LIMIT 1", key)[0] ??
        all("SELECT * FROM gw_spans WHERE name = 'wake' AND json_extract(attributes, '$.wake') = ? ORDER BY start_at DESC LIMIT 1", key)[0];
      if (!found) return yield* Effect.fail(userError(`no trace, send or wake ${JSON.stringify(key)} in the last 7 days`));
      const spans = all("SELECT * FROM gw_spans WHERE trace_id = ? ORDER BY start_at, end_at", found.trace_id);
      const linked = spans.flatMap((span) => links(span)).flatMap((link) => all("SELECT * FROM gw_spans WHERE span_id = ?", link));
      yield* Console.log(tree(spans, linked));
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Show what the gateway did: the last wakes, or one wake from its events to the messages sent for it."));

function attributes(span: Span): Record<string, unknown> {
  return span.attributes ? (JSON.parse(span.attributes) as Record<string, unknown>) : {};
}

function links(span: Span): string[] {
  return span.links ? (JSON.parse(span.links) as { span_id: string }[]).map((link) => link.span_id) : [];
}

/** One line per wake: when, why, where, how many events, how many sends, how long, and its trace ID. */
function summary(wake: Span, trace: Span[]): string {
  const facts = attributes(wake);
  const events = typeof facts.events === "string" && facts.events ? facts.events.split(",").length : 0;
  const sends = trace.filter((span) => span.name === "send");
  const end = Math.max(...trace.map((span) => span.end_at));
  const failed = trace.some((span) => span.status === "error");
  return [
    time(wake.start_at),
    String(facts.reason ?? "?").padEnd(9),
    String(facts.place ?? (facts.timer !== undefined ? `timer ${String(facts.timer)}` : "-")).padEnd(28),
    (events ? `${events} event${events === 1 ? "" : "s"}` : "").padEnd(10),
    (sends.length ? `sent ${sends.length}` : "").padEnd(8),
    duration(end - wake.start_at).padStart(8),
    wake.trace_id.slice(0, 12),
    failed ? "  (an error; see the trace)" : "",
  ].join("  ");
}

/** The trace as a tree, with each span's time from the start and its duration, then the spans it links to. */
function tree(spans: Span[], linked: Span[]): string {
  const start = Math.min(...spans.map((span) => span.start_at));
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string | null, Span[]>();
  for (const span of spans) {
    const parent = span.parent_id && ids.has(span.parent_id) ? span.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const lines = [`trace ${spans[0]!.trace_id}  ${time(start)}`];
  const walk = (parent: string | null, indent: string) => {
    const list = children.get(parent) ?? [];
    list.forEach((span, index) => {
      const last = index === list.length - 1;
      const branch = parent === null ? "" : last ? "└─ " : "├─ ";
      lines.push(`${indent}${branch}${line(span, start)}`);
      walk(span.span_id, parent === null ? indent : `${indent}${last ? "   " : "│  "}`);
    });
  };
  walk(null, "");
  if (linked.length > 0) {
    lines.push("events:");
    for (const span of linked) lines.push(`  ${line(span, start)}`);
  }
  return lines.join("\n");
}

function line(span: Span, start: number): string {
  const facts = Object.entries(attributes(span))
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const offset = span.start_at - start;
  const status = span.status === "ok" ? "" : span.status === "error" ? `  ERROR ${span.error ?? ""}` : `  (${span.status})`;
  return `${span.name}  ${facts}  ${offset < 0 ? "-" : "+"}${duration(Math.abs(offset))}  ${duration(span.end_at - span.start_at)}${status}`;
}

function duration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function time(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
