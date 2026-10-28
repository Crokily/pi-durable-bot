import { Context, Layer, type Tracer } from "effect";

/** How many wakes are remembered for linking sends to them. */
const REMEMBERED_WAKES = 1_000;

/**
 * The span of each wake, by the agent's submission ID. A send during an agent run belongs to the wakes the run works
 * on, so its span joins their trace: one trace shows a wake from the events to the messages the bot sent.
 */
export class WakeSpans extends Context.Service<
  WakeSpans,
  {
    remember(submission: string, span: Tracer.AnySpan): void;
    /** The spans of the wakes with these submission IDs that are still remembered, in the same order. */
    find(submissions: readonly string[]): Tracer.AnySpan[];
  }
>()("pots/gateway/WakeSpans") {
  static readonly layer = Layer.sync(WakeSpans, () => {
    const spans = new Map<string, Tracer.AnySpan>();
    return WakeSpans.of({
      remember: (submission, span) => {
        spans.delete(submission);
        spans.set(submission, span);
        if (spans.size > REMEMBERED_WAKES) spans.delete(spans.keys().next().value!);
      },
      find: (submissions) => submissions.flatMap((submission) => spans.get(submission) ?? []),
    });
  });
}
