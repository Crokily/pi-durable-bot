import type { RecordedTelemetrySpan, SpanStatus } from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { Cause, Exit, Option, Tracer } from "effect";
import { describe, it } from "vitest";
import { PiSpanError, piTelemetry } from "../src/gateway/telemetry.ts";

// pi's own conformance suite for telemetry adapters, run against the bridge from pi's telemetry to Effect spans.

const carrier = (span: Tracer.AnySpan) => ({ traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}` });

function status(span: Tracer.NativeSpan): SpanStatus {
  if (span.status._tag !== "Ended" || Exit.isSuccess(span.status.exit)) return { status: "ok" };
  const error = Cause.squash(span.status.exit.cause);
  return error instanceof PiSpanError && error.detailed ? { status: "error", error: { name: error.name, message: error.message } } : { status: "error" };
}

const conformance = createTelemetryAdapterConformance(async () => {
  const spans: { span: Tracer.NativeSpan; endSequence?: number }[] = [];
  let ends = 0;
  const tracer = Tracer.make({
    span(options) {
      const entry: { span: Tracer.NativeSpan; endSequence?: number } = { span: new Tracer.NativeSpan(options) };
      const end = entry.span.end.bind(entry.span);
      entry.span.end = (endTime, exit) => {
        if (entry.span.status._tag === "Started") entry.endSequence = ++ends;
        end(endTime, exit);
      };
      spans.push(entry);
      return entry.span;
    },
  });
  const context = piTelemetry(tracer);
  return {
    context,
    propagation: context.propagation,
    getSpans: async (): Promise<RecordedTelemetrySpan[]> =>
      spans.map(({ span, endSequence }, index) => {
        const parent = Option.getOrUndefined(span.parent);
        const local = parent ? spans.findIndex((entry) => entry.span === parent) : -1;
        return {
          id: index + 1,
          parentId: local >= 0 ? local + 1 : null,
          context: carrier(span),
          parentContext: parent ? carrier(parent) : null,
          links: span.links.map((link) => ({ context: carrier(link.span), attributes: link.attributes as RecordedTelemetrySpan["attributes"] })),
          name: span.name,
          attributes: Object.fromEntries(span.attributes) as RecordedTelemetrySpan["attributes"],
          events: span.events.map(([name, , attributes]) => ({ name, attributes: attributes as RecordedTelemetrySpan["attributes"] })),
          status: status(span),
          settled: span.status._tag === "Ended",
          ...(endSequence === undefined ? {} : { endSequence }),
        };
      }),
    async [Symbol.asyncDispose]() {},
  };
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(`pi telemetry on Effect spans: ${group}`, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) it(testCase.name, () => testCase.run());
  });
}
