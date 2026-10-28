import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Option, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { readFileSync } from "node:fs";
import type { Sql } from "../core/sql.ts";
import { GatewayConfig } from "./config.ts";
import { failureText, LogError } from "./errors.ts";

/**
 * Every span of the gateway, in the bot's SQLite file. `pots trace` shows them; the agent can read them with SQL.
 * Times are Unix ms. status: ok, error or interrupted. attributes: JSON. links: JSON list of {trace_id, span_id}.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  attributes TEXT,
  links TEXT
);
CREATE INDEX IF NOT EXISTS gw_spans_trace ON gw_spans (trace_id);
CREATE INDEX IF NOT EXISTS gw_spans_name ON gw_spans (name, start_at);
`;

/** This package's version, next to src/ or dist/. */
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Spans older than this are deleted. */
export const SPAN_RETENTION_DAYS = 7;
/** Ended spans are written in batches this often. */
const FLUSH_MS = 1_000;
const PRUNE_MS = 3_600_000;
/** How many wakes are remembered for linking sends to them; older ones are looked up in gw_spans. */
const REMEMBERED_WAKES = 1_000;

interface EndedSpan {
  readonly span_id: string;
  readonly trace_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly start_at: number;
  readonly end_at: number;
  readonly status: "ok" | "error" | "interrupted";
  readonly error: string | null;
  readonly attributes: string;
  readonly links: string;
}

const ms = (nanos: bigint) => Number(nanos / 1_000_000n);
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? Number(item) : item));

/** A span of the tracer below it (OTLP or Effect's own), also handed to the store when it ends. */
class StoredSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly #inner: Tracer.Span;
  readonly #ended: (span: EndedSpan) => void;

  constructor(inner: Tracer.Span, ended: (span: EndedSpan) => void) {
    this.#inner = inner;
    this.#ended = ended;
  }

  get name() {
    return this.#inner.name;
  }
  get spanId() {
    return this.#inner.spanId;
  }
  get traceId() {
    return this.#inner.traceId;
  }
  get parent() {
    return this.#inner.parent;
  }
  get annotations() {
    return this.#inner.annotations;
  }
  get status() {
    return this.#inner.status;
  }
  get attributes() {
    return this.#inner.attributes;
  }
  get links() {
    return this.#inner.links;
  }
  get sampled() {
    return this.#inner.sampled;
  }
  get kind() {
    return this.#inner.kind;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const started = this.#inner.status.startTime;
    const first = this.#inner.status._tag === "Started";
    this.#inner.end(endTime, exit);
    if (!first) return;
    const failed = Exit.isFailure(exit);
    const interrupted = failed && Cause.hasInterruptsOnly(exit.cause);
    this.#ended({
      span_id: this.spanId,
      trace_id: this.traceId,
      parent_id: Option.getOrUndefined(this.parent)?.spanId ?? null,
      name: this.name,
      start_at: ms(started),
      end_at: ms(endTime),
      status: !failed ? "ok" : interrupted ? "interrupted" : "error",
      error: failed && !interrupted ? failureText(Cause.squash(exit.cause)) : null,
      attributes: json(Object.fromEntries(this.attributes)),
      links: json(this.links.map((link) => ({ trace_id: link.span.traceId, span_id: link.span.spanId }))),
    });
  }

  attribute(key: string, value: unknown): void {
    this.#inner.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.#inner.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.#inner.addLinks(links);
  }
}

/**
 * Tracing for one bot. Every span goes to gw_spans in the bot's SQLite file, kept SPAN_RETENTION_DAYS days. With the
 * standard OpenTelemetry variables set (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), the spans
 * are also exported over OTLP, to Jaeger, Grafana Tempo, Honeycomb or any other OpenTelemetry tool.
 */
export function tracingLayer(sql: Sql, bot: string) {
  const store = Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const below = yield* Tracer.Tracer;
      const { print } = yield* GatewayConfig;
      const db = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: LogError.from });
      yield* db(() => sql.exec(SCHEMA));
      let ended: EndedSpan[] = [];

      const flush = Effect.suspend(() => {
        if (ended.length === 0) return Effect.void;
        const batch = ended;
        ended = [];
        return db(() =>
          sql.transaction(async (tx) => {
            for (const span of batch) {
              await tx.run(
                `INSERT OR REPLACE INTO gw_spans (span_id, trace_id, parent_id, name, start_at, end_at, status, error, attributes, links)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                span.span_id,
                span.trace_id,
                span.parent_id,
                span.name,
                span.start_at,
                span.end_at,
                span.status,
                span.error,
                span.attributes,
                span.links,
              );
            }
          }),
        );
      }).pipe(Effect.catch((error) => Effect.sync(() => print("trace write failed", { error: error.message }))));

      const prune = Effect.suspend(() => db(() => sql.run("DELETE FROM gw_spans WHERE start_at < ?", Date.now() - SPAN_RETENTION_DAYS * 86_400_000))).pipe(
        Effect.catch((error) => Effect.sync(() => print("trace cleanup failed", { error: error.message }))),
      );

      // Writing and cleaning up follow the wall clock, not Effect's Clock: they are about the disk, and a test's
      // TestClock must not make them run once per simulated second.
      yield* prune;
      const flushing = setInterval(() => void Effect.runPromise(flush), FLUSH_MS).unref();
      const pruning = setInterval(() => void Effect.runPromise(prune), PRUNE_MS).unref();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearInterval(flushing);
          clearInterval(pruning);
        }).pipe(Effect.andThen(flush)),
      );

      return Tracer.make({
        span: (options) => new StoredSpan(below.span(options), (span) => ended.push(span)),
        ...(below.context ? { context: below.context } : {}),
      });
    }),
  );
  // OpenTelemetry's default for OTEL_TRACES_EXPORTER is "otlp"; Effect needs it said. An endpoint is enough to export,
  // and OTEL_TRACES_EXPORTER=none or OTEL_SDK_DISABLED=true still turn it off.
  const env = ConfigProvider.fromEnvRecord({ OTEL_TRACES_EXPORTER: "otlp", ...process.env });
  const otlp = OtlpTracer.layerFromConfig({ resource: { serviceName: "pots", serviceVersion: VERSION, attributes: { "pots.bot": bot } } }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(ConfigProvider.layer(env)),
    // A wrong OTEL_ variable must not stop the bot: it runs without the export, and says why.
    Layer.catchCause((cause) =>
      Layer.effectDiscard(
        Effect.gen(function* () {
          const { print } = yield* GatewayConfig;
          print("trace export off", { error: failureText(Cause.squash(cause)) });
        }),
      ),
    ),
  );
  return store.pipe(Layer.provide(otlp));
}

/**
 * The span of each wake, by the agent's submission ID. A send during an agent run belongs to the wakes the run works
 * on, so its span joins their trace: one trace shows a wake from the events to the messages the bot sent. Recent wakes
 * are in memory; older ones, and those from before a restart, are found in gw_spans.
 */
export class WakeSpans extends Context.Service<
  WakeSpans,
  {
    remember(submission: string, span: Tracer.AnySpan): void;
    /** The spans of the wakes with these submission IDs that are known, in the same order. */
    find(submissions: readonly string[]): Effect.Effect<Tracer.AnySpan[]>;
  }
>()("pots/gateway/WakeSpans") {
  static layer(sql: Sql) {
    return Layer.sync(WakeSpans, () => {
      const spans = new Map<string, Tracer.AnySpan>();
      const stored = (submission: string) =>
        Effect.tryPromise(() =>
          sql.get<{ trace_id: string; span_id: string }>(
            "SELECT trace_id, span_id FROM gw_spans WHERE name = 'wake' AND json_extract(attributes, '$.submission') = ? ORDER BY start_at DESC LIMIT 1",
            submission,
          ),
        ).pipe(
          Effect.map((row) => (row ? [Tracer.externalSpan({ traceId: row.trace_id, spanId: row.span_id })] : [])),
          Effect.orElseSucceed(() => []),
        );
      return WakeSpans.of({
        remember: (submission, span) => {
          spans.delete(submission);
          spans.set(submission, span);
          if (spans.size > REMEMBERED_WAKES) spans.delete(spans.keys().next().value!);
        },
        find: (submissions) =>
          Effect.map(
            Effect.forEach(submissions, (submission) => {
              const span = spans.get(submission);
              return span ? Effect.succeed([span]) : stored(submission);
            }),
            (found) => found.flat(),
          ),
      });
    });
  }
}
