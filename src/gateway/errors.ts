import { Data } from "effect";

// What can go wrong in the gateway core, as types. The messages are what the agent and the command line see.

/** A statement on the bot's SQLite file failed. */
export class LogError extends Data.TaggedError("LogError")<{ readonly message: string; readonly cause: unknown }> {
  static from(cause: unknown): LogError {
    return new LogError({ message: message(cause), cause });
  }
}

/** A channel adapter failed to do what it was asked: connect, translate, send, react, call. */
export class ChannelError extends Data.TaggedError("ChannelError")<{ readonly message: string; readonly channel: string; readonly cause: unknown }> {
  static from(channel: string, cause: unknown): ChannelError {
    return new ChannelError({ message: cause instanceof Error ? cause.message : String(cause), channel, cause });
  }
}

/** No running channel made this address. */
export class NoChannelForAddress extends Data.TaggedError("NoChannelForAddress")<{ readonly message: string; readonly address: string }> {
  static of(address: string): NoChannelForAddress {
    return new NoChannelForAddress({ message: `no channel for address ${JSON.stringify(address)}. Copy addresses from a wake message or the log.`, address });
  }
}

/** No running channel has this ID. */
export class UnknownChannel extends Data.TaggedError("UnknownChannel")<{ readonly message: string; readonly channel: string }> {}

/** A send that cannot go out as asked: empty text or send ID. */
export class BadSend extends Data.TaggedError("BadSend")<{ readonly message: string }> {}

/** An adapter turned a raw event into happenings that do not match the Happening schema. */
export class BadHappening extends Data.TaggedError("BadHappening")<{ readonly message: string; readonly channel: string }> {}

/** A timer at a time that is not a number. */
export class BadTime extends Data.TaggedError("BadTime")<{ readonly message: string }> {}

/** The bot is not ready to be woken yet. */
export class NoWakeTarget extends Data.TaggedError("NoWakeTarget")<{ readonly message: string }> {}

/** The judge did not answer, also after retries. */
export class JudgeError extends Data.TaggedError("JudgeError")<{ readonly message: string; readonly cause: unknown }> {}

/** Delivering a wake to the bot failed. */
export class DeliverError extends Data.TaggedError("DeliverError")<{ readonly message: string; readonly cause: unknown }> {}

/** The message of a thrown value. */
export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A failure as the log shows it: the thrown value, as String() gives it ("Error: ..."), or the failure's message. */
export function failureText(failure: unknown): string {
  if (failure && typeof failure === "object" && "_tag" in failure && "message" in failure) {
    const { cause, message: text } = failure as { cause?: unknown; message: string };
    return cause instanceof Error ? String(cause) : text;
  }
  return String(failure);
}
