// The interface between the gateway's waker and the judge of events that do not mention the bot. Common words only.
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";

/** A new event, as the judge sees it. */
export interface JudgeItem {
  readonly what: string;
  readonly author: string;
  readonly time: string;
  readonly text?: string;
  /** Who started the thread the event is in; none when it is not in a thread. */
  readonly threadStartedBy?: string;
  /** The author of the message it answers. */
  readonly replyingTo?: string;
}

/** A message of the place, or a new event, in its thread. */
export interface JudgeMessage {
  /** One of the new events. */
  readonly new?: boolean;
  /** What it is, when it is not a plain message: a deleted message, an edit, a reaction. */
  readonly what?: string;
  readonly author: string;
  /** The author of the message it answers. */
  readonly replyingTo?: string;
  readonly time: string;
  readonly text?: string;
}

/** A thread, or a message that is not in a thread, with its messages in time order. */
export interface JudgeThread {
  /** Who started the thread; none for a message that is not in a thread. */
  readonly startedBy?: string;
  /** New events are in it. */
  readonly hasNew: boolean;
  readonly messages: readonly JudgeMessage[];
}

export interface JudgeInput {
  readonly name: string;
  readonly responsibilities: string;
  readonly place: string;
  /** The earlier messages and the new events by thread: threads in order of their last message, those with new events last. */
  readonly conversation: readonly JudgeThread[];
  readonly latest: readonly JudgeItem[];
}

export interface JudgeAnswer {
  /** Probability that the events are about what the bot is responsible for. */
  readonly related: number;
  /** Probability that the bot should respond. */
  readonly respond: number;
}

/**
 * Asks only two questions: is this about me, and do I need to respond. No urgency.
 * The judge sees what the bot is responsible for, so it knows what "about me" means.
 */
export interface Judge {
  /** trace: the gateway's span for this judgment; a model request of the judge is recorded under it. */
  judge(input: JudgeInput, trace?: TelemetrySpan): Promise<JudgeAnswer>;
}
