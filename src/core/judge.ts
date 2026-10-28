// The interface between the gateway's waker and the judge of events that do not mention the bot. Common words only.

/** One event or earlier message, as the judge sees it. */
export interface JudgeItem {
  readonly what: string;
  readonly author: string;
  readonly time: string;
  readonly text?: string;
  readonly thread?: string;
}

export interface JudgeInput {
  readonly name: string;
  readonly responsibilities: string;
  readonly place: string;
  readonly earlier: readonly JudgeItem[];
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
  judge(input: JudgeInput): Promise<JudgeAnswer>;
}
