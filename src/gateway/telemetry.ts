import {
  NOOP_TELEMETRY_CONTEXT,
  type SpanAttributes,
  type SpanLink,
  type SpanOptions,
  type SpanStatus,
  type TelemetryCarrier,
  type TelemetryContext,
  type TelemetryPropagation,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { Context, Effect, Exit, Layer, Option, Tracer } from "effect";

// pi's own telemetry (pi-durable's submissions and task phases, pi-ai's model requests) on the gateway's Effect tracer.
// pi's spans become Effect spans: they go to gw_spans and over OTLP with the gateway's spans, in the same traces, and
// a wake links to the agent's run, the run to its tool calls, and a send tool's call to the gateway's send.

/** pi's telemetry contract, plus the two ways the gateway meets it. */
export interface PiTelemetry extends TelemetryContext {
  readonly propagation: TelemetryPropagation;
  /** A gateway span as a pi context: work pi starts from it is linked to it, or nested in it. */
  view(span: Tracer.AnySpan): TelemetrySpan;
  /** The gateway span behind a pi context, if it is one of ours. */
  spanOf(context: TelemetryContext | undefined): Tracer.AnySpan | undefined;
}

/** The Effect span behind each pi context this module made: spans, extracted parents and views. */
const behind = new WeakMap<object, Tracer.AnySpan>();

/** W3C trace context: pi stores it in its submissions and tasks, so a run that resumes after a restart keeps its trace. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Wall-clock nanoseconds, finer than a millisecond. */
const now = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000_000));

function copy(attributes: SpanAttributes | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
}

function links(list: readonly SpanLink[] | undefined): Tracer.SpanLink[] {
  return (list ?? []).flatMap((link) => {
    const span = behind.get(link.context);
    return span ? [{ span, attributes: copy(link.attributes) }] : [];
  });
}

/** A pi span that ended with an error status, as the failure its Effect span ends with. */
export class PiSpanError extends Error {
  /** False when pi gave no name and message, only the error status. */
  readonly detailed: boolean;

  constructor(status: Extract<SpanStatus, { status: "error" }>) {
    super(status.error?.message ?? "error");
    this.name = status.error?.name ?? "Error";
    this.detailed = status.error !== undefined;
  }
}

export function piTelemetry(tracer: Tracer.Tracer): PiTelemetry {
  const propagation: TelemetryPropagation = {
    inject(context) {
      const span = behind.get(context);
      return span ? { traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}` } : undefined;
    },
    extract(carrier: TelemetryCarrier | undefined) {
      const match = TRACEPARENT.exec(carrier?.traceparent ?? "");
      if (!match) return root;
      const parent = Tracer.externalSpan({ traceId: match[1]!, spanId: match[2]!, sampled: match[3] !== "00" });
      const context: TelemetryContext = { propagation, startSpan: (options, callback) => start(parent, options, callback) };
      behind.set(context, parent);
      return context;
    },
  };

  /** A span that records nothing: the child of a span that has ended. */
  const inert = <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> =>
    NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) => {
      const { metrics: _metrics, ...rest } = noop;
      return callback({ ...rest, propagation, startSpan: inert });
    });

  async function start<T>(parent: Tracer.AnySpan | undefined, options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const span = tracer.span({
      name: options.name,
      parent: Option.fromNullishOr(parent),
      annotations: Context.empty(),
      links: links(options.links),
      startTime: now(),
      kind: "internal",
      root: parent === undefined,
      sampled: parent?.sampled ?? true,
    });
    for (const [key, value] of Object.entries(copy(options.attributes))) span.attribute(key, value);
    let status: SpanStatus = { status: "ok" };
    let explicit = false;
    let settled = false;
    const piSpan: TelemetrySpan = {
      propagation,
      startSpan: (childOptions, childCallback) => (settled ? inert(childOptions, childCallback) : start(span, childOptions, childCallback)),
      addLink(link) {
        if (!settled) span.addLinks(links([link]));
      },
      addEvent(name, attributes) {
        if (!settled) span.event(name, now(), copy(attributes));
      },
      setAttributes(attributes) {
        if (!settled) for (const [key, value] of Object.entries(copy(attributes))) span.attribute(key, value);
      },
      setStatus(value) {
        if (settled) return;
        status = value.status === "error" && value.error ? { status: "error", error: { name: value.error.name, message: value.error.message } } : { status: value.status };
        explicit = true;
      },
    };
    behind.set(piSpan, span);
    try {
      return await callback(piSpan);
    } catch (error) {
      if (!explicit) status = error instanceof Error ? { status: "error", error: { name: error.name, message: error.message } } : { status: "error" };
      throw error;
    } finally {
      settled = true;
      span.end(now(), status.status === "ok" ? Exit.void : Exit.fail(new PiSpanError(status)));
    }
  }

  const root: PiTelemetry = {
    propagation,
    startSpan: (options, callback) => start(undefined, options, callback),
    view(span) {
      const context: TelemetrySpan = {
        propagation,
        startSpan: (options, callback) => start(span, options, callback),
        // The gateway owns its spans; pi only starts work from them.
        addLink() {},
        addEvent() {},
        setAttributes() {},
        setStatus() {},
      };
      behind.set(context, span);
      return context;
    },
    spanOf: (context) => (context ? behind.get(context) : undefined),
  };
  return root;
}

/** The bridge on the gateway's tracer. */
export class Telemetry extends Context.Service<Telemetry, PiTelemetry>()("pots/gateway/Telemetry") {
  static readonly layer = Layer.effect(Telemetry, Effect.map(Effect.tracer, piTelemetry));
}
