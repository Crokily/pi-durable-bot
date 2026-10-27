import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

export interface JevItem {
  readonly what: string;
  readonly author: string;
  readonly time: string;
  readonly text?: string;
  readonly thread?: string;
}

export interface JevAnswer {
  /** Probability that the events are about what the bot is responsible for. */
  readonly related: number;
  /** Probability that the bot should respond. */
  readonly respond: number;
}

/**
 * Asks Jev only two questions: is this about me, and do I need to respond. No urgency.
 * Jev sees what the bot is responsible for, so it knows what "about me" means.
 */
export class Jev {
  readonly #client: TypeSafeClient;

  constructor(apiKey: string) {
    this.#client = new TypeSafeClient({ apiKey });
  }

  async judge(input: {
    name: string;
    responsibilities: string;
    place: string;
    earlier: readonly JevItem[];
    latest: readonly JevItem[];
  }): Promise<JevAnswer> {
    const { answers } = await this.#client.systemOne({
      state: {
        team_member: input.name,
        what_this_team_member_is_responsible_for: input.responsibilities,
        place: input.place,
        earlier_messages: input.earlier.map((item) => ({ ...item })),
        new_events: input.latest.map((item) => ({ ...item })),
      },
      questions: {
        related: noul(`Are the new events about something ${input.name} is responsible for, or addressed to ${input.name}?`),
        respond: noul(`Does ${input.name} need to respond to the new events?`),
      },
    });
    return { related: answers.related.noul, respond: answers.respond.noul };
  }
}
