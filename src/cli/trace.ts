import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { botPaths } from "../bot/definition.ts";
import { botDir, resolveBot, userError } from "./control.ts";

// pots trace: what the bot did, from the spans in its gw_spans table. A wake has three parts, linked to each other: the
// events that woke the bot (one trace each), the wake (its decision and delivery), and the agent's run for it
// (pi-durable's task phases, the model requests, the tool calls, and what the gateway sent for them).

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
      const trace = (id: string) => all("SELECT * FROM gw_spans WHERE trace_id = ? ORDER BY start_at, end_at", id);
      if (Option.isNone(input.id)) {
        const wakes = all("SELECT * FROM gw_spans WHERE name = 'wake' AND parent_id IS NULL ORDER BY start_at DESC LIMIT ?", input.last).reverse();
        if (wakes.length === 0) return yield* Console.log("No wakes in the last 7 days.");
        for (const wake of wakes) yield* Console.log(summary(wake, [...trace(wake.trace_id), ...runs(all, wake).flatMap(trace)]));
        return;
      }
      const key = input.id.value;
      const found =
        all("SELECT * FROM gw_spans WHERE trace_id LIKE ? ORDER BY start_at LIMIT 1", `${key}%`)[0] ??
        all("SELECT * FROM gw_spans WHERE name = 'send' AND json_extract(attributes, '$.send') = ? ORDER BY start_at DESC LIMIT 1", key)[0] ??
        all("SELECT * FROM gw_spans WHERE name = 'wake' AND json_extract(attributes, '$.wake') = ? ORDER BY start_at DESC LIMIT 1", key)[0];
      if (!found) return yield* Effect.fail(userError(`no trace, send or wake ${JSON.stringify(key)} in the last 7 days`));
      // From a run or a send in it, go back to the wake that started the run.
      const start = trace(found.trace_id);
      const wake =
        start.find((span) => span.name === "wake" && span.parent_id === null) ??
        start
          .filter((span) => span.name === "pi.durable.submit")
          .flatMap((span) => links(span))
          .flatMap((id) => all("SELECT * FROM gw_spans WHERE span_id = ? AND name = 'wake'", id))[0];
      const parts = wake ? [trace(wake.trace_id), ...runs(all, wake).map(trace)] : [start];
      const events = (wake ? linkList(wake).filter((link) => !isRun(link)) : [])
        .flatMap((link) => all("SELECT * FROM gw_spans WHERE span_id = ?", link.span_id))
        .flatMap((span) => trace(span.trace_id));
      yield* Console.log(view(parts, events));
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Show what the gateway did: the last wakes, or one wake from its events to the messages sent for it."));

function attributes(span: Span): Record<string, unknown> {
  return span.attributes ? (JSON.parse(span.attributes) as Record<string, unknown>) : {};
}

interface Link {
  trace_id: string;
  span_id: string;
  attributes?: Record<string, unknown>;
}

function linkList(span: Span): Link[] {
  return span.links ? (JSON.parse(span.links) as Link[]) : [];
}

function links(span: Span): string[] {
  return linkList(span).map((link) => link.span_id);
}

/** A wake links to the events it is about and to the agent's run for it (LINK in src/gateway/telemetry.ts). */
const isRun = (link: Link) => link.attributes?.["pots.link"] === "run";

/**
 * The traces of the agent's runs for a wake. The wake links to its run's stored trace context, which stays the first
 * one when the wake is delivered again after a crash. Besides: pi-durable's submission span and the agent's sends link
 * to the wake; a submission that steers a running run links to that run, and a run for several submissions links to
 * the others.
 */
function runs(all: (sql: string, ...params: (string | number)[]) => Span[], wake: Span): string[] {
  const traces = new Set(linkList(wake).filter(isRun).map((link) => link.trace_id));
  const linking = (id: string) => all("SELECT * FROM gw_spans WHERE links LIKE ?", `%"span_id":"${id}"%`);
  for (const span of linking(wake.span_id)) {
    traces.add(span.trace_id);
    if (span.name !== "pi.durable.submit") continue;
    for (const link of linkList(span)) traces.add(link.trace_id);
    for (const linked of linking(span.span_id)) traces.add(linked.trace_id);
  }
  traces.delete(wake.trace_id);
  return [...traces];
}

/** One line per wake: when, why, where, events, sends, model requests, how long, and its trace ID. */
function summary(wake: Span, spans: Span[]): string {
  const facts = attributes(wake);
  const events = typeof facts.events === "string" && facts.events ? facts.events.split(",").length : 0;
  const sends = spans.filter((span) => span.name === "send").length;
  const requests = spans.filter((span) => span.name === "pi.ai.request");
  const tokens = requests.reduce((sum, span) => sum + Number(attributes(span)["usage.input"] ?? 0) + Number(attributes(span)["usage.output"] ?? 0), 0);
  const end = Math.max(...spans.map((span) => span.end_at));
  const failed = spans.some((span) => span.status === "error");
  return [
    time(wake.start_at),
    String(facts.reason ?? "?").padEnd(9),
    String(facts.place ?? (facts.timer !== undefined ? `timer ${String(facts.timer)}` : "-")).padEnd(28),
    (events ? `${events} event${events === 1 ? "" : "s"}` : "").padEnd(10),
    (sends ? `sent ${sends}` : "").padEnd(8),
    (requests.length ? `model ${requests.length}×, ${tokens} tokens` : "").padEnd(24),
    duration(end - wake.start_at).padStart(8),
    wake.trace_id.slice(0, 12),
    failed ? "  (an error; see the trace)" : "",
  ].join("  ");
}

/** A wake as trees: the wake, then the agent's runs for it, then the events it is about. Times count from the wake. */
function view(parts: Span[][], events: Span[]): string {
  const start = Math.min(...parts.flat().map((span) => span.start_at));
  const lines: string[] = [];
  parts.forEach((spans, index) => {
    if (spans.length === 0) return;
    lines.push(`${index === 0 ? "trace" : "agent run, trace"} ${spans[0]!.trace_id}  ${time(spans[0]!.start_at)}`);
    lines.push(...tree(spans, start));
  });
  if (events.length > 0) {
    lines.push("events:");
    lines.push(...tree(events, start).map((text) => `  ${text}`));
  }
  return lines.join("\n");
}

/** Spans as a tree, with each span's time from `start` and its duration. */
function tree(spans: Span[], start: number): string[] {
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string | null, Span[]>();
  for (const span of spans) {
    const parent = span.parent_id && ids.has(span.parent_id) ? span.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const lines: string[] = [];
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
  return lines;
}

/** A span in a few words. pi's spans get short names; the gateway's show their attributes. */
function label(span: Span): string {
  const facts = attributes(span);
  switch (span.name) {
    case "pi.durable.submit":
      return `submission ${String(facts["submission.id"] ?? "?")} (${String(facts.result ?? "?")})`;
    case "pi.durable.phase": {
      const task = String(facts["task.name"] ?? "task").replace(/^pi\./, "");
      const tool = facts["tool.name"] ? ` ${String(facts["tool.name"])}` : "";
      return `${task}${tool} ${String(facts.phase ?? "")} → ${String(facts.outcome ?? "?")}${facts.resumed === true ? " (resumed)" : ""}`;
    }
    case "pi.ai.request": {
      const cost = Number(facts["cost.total"] ?? 0);
      return `model ${String(facts.provider)}/${String(facts.model)}, ${String(facts["usage.input"] ?? "?")} in, ${String(facts["usage.output"] ?? "?")} out${cost ? `, $${cost.toFixed(4)}` : ""}, ${String(facts.stop ?? "?")}`;
    }
    default:
      return [span.name, ...Object.entries(facts).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)].join(" ");
  }
}

function line(span: Span, start: number): string {
  const offset = span.start_at - start;
  const status = span.status === "ok" ? "" : span.status === "error" ? `  ERROR ${span.error ?? ""}` : `  (${span.status})`;
  return `${label(span)}  ${offset < 0 ? "-" : "+"}${duration(Math.abs(offset))}  ${duration(span.end_at - span.start_at)}${status}`;
}

function duration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function time(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
