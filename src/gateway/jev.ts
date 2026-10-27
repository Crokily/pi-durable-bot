import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

export interface JevMessage {
  readonly author: string;
  readonly text: string;
  readonly ts: string;
  readonly thread_ts?: string;
}

export interface JevAnswer {
  /** Probability that the messages are about what the bot is responsible for. */
  readonly related: number;
  /** Probability that the bot should respond. */
  readonly respond: number;
  readonly wake: boolean;
}

/**
 * Asks Jev only two questions: is this about me, and do I need to respond. No urgency.
 * Jev sees the bot's responsibilities file, so it knows what "about me" means.
 */
export class Jev {
  readonly #client: TypeSafeClient;
  readonly #threshold: number;

  constructor(apiKey: string, threshold: number) {
    this.#client = new TypeSafeClient({ apiKey });
    this.#threshold = threshold;
  }

  async judge(input: {
    botName: string;
    responsibilities: string;
    channel: string;
    earlier: readonly JevMessage[];
    latest: readonly JevMessage[];
  }): Promise<JevAnswer> {
    const { answers } = await this.#client.systemOne({
      state: {
        team_member: input.botName,
        what_this_team_member_is_responsible_for: input.responsibilities,
        channel: input.channel,
        earlier_messages: input.earlier.map((message) => ({ ...message })),
        new_messages: input.latest.map((message) => ({ ...message })),
      },
      questions: {
        related: noul(`Are the new messages about something ${input.botName} is responsible for, or addressed to ${input.botName}?`),
        respond: noul(
          `Should ${input.botName} respond to the new messages now, as a helpful team member would? Answer no if people are only talking among themselves and do not need ${input.botName}.`,
        ),
      },
    });
    const related = answers.related.noul;
    const respond = answers.respond.noul;
    return { related, respond, wake: related >= this.#threshold && respond >= this.#threshold };
  }
}
