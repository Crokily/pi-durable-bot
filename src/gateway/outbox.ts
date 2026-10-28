import { Context, Effect, Layer, type Tracer } from "effect";
import type { Address, ChannelAdapter } from "../core/channel.ts";
import { Channels } from "./channels.ts";
import { GatewayConfig } from "./config.ts";
import { BadSend, ChannelError, type LogError, type NoChannelForAddress } from "./errors.ts";
import { Inbox } from "./inbox.ts";
import { MessageLog } from "./log.ts";

export interface SendResult {
  readonly message: Address;
  /** The place the message is in. */
  readonly place?: Address;
  /** True when a crash left the send unclear and the message was found on the platform instead of sent again. */
  readonly recovered?: boolean;
  /** True when this send ID was already sent before. */
  readonly repeated?: boolean;
}

export interface OutboxHooks {
  /** Test hook: runs after the platform accepted a send and before the outbox records it. */
  afterPlatformSend?: (sendId: string) => void;
}

export type SendError = BadSend | LogError | ChannelError | NoChannelForAddress;

/**
 * Sends once per send ID, across crashes:
 * - the outbox says sent → return that message;
 * - the outbox says sending (a crash in the middle) → look on the platform for a message with this send ID, and only
 *   send when there is none ("check, then send");
 * - otherwise record "sending", send, record "sent".
 * A sent message goes into the inbox as an event, so the log gets it the same way as every other message.
 */
export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * The send's span is a child of `parent` (the agent's tool call) and links to `wakes`, the wakes the agent works on.
     * Without a parent, as from the command line, it is a child of the first wake.
     */
    send(sendId: string, to: Address, text: string, wakes?: readonly Tracer.AnySpan[], parent?: Tracer.AnySpan): Effect.Effect<SendResult, SendError>;
    readonly hooks: OutboxHooks;
  }
>()("pots/gateway/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const log = yield* MessageLog;
      const channels = yield* Channels;
      const inbox = yield* Inbox;
      const { print } = yield* GatewayConfig;
      const hooks: OutboxHooks = {};

      const platform = <A>(adapter: ChannelAdapter, run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => ChannelError.from(adapter.id, cause) });

      const send = (sendId: string, to: Address, text: string) =>
        Effect.gen(function* () {
          if (!text.trim()) return yield* Effect.fail(new BadSend({ message: "text is empty" }));
          if (!sendId.trim()) return yield* Effect.fail(new BadSend({ message: "send ID is empty" }));
          const record = yield* log.outbox(sendId);
          if (record?.state === "sent") {
            yield* Effect.annotateCurrentSpan({ result: "repeated", message: record.message! });
            return { message: record.message!, ...placeOf(channels.list(), record.message!), repeated: true };
          }
          const adapter = yield* channels.adapterFor(record?.to_address ?? to);
          if (record) {
            const found = yield* platform(adapter, () => adapter.findSent(record.to_address, sendId, record.created_at)).pipe(
              Effect.withSpan("channel.findSent", { attributes: { channel: adapter.id } }),
            );
            if (found) {
              yield* inbox.receive(adapter.id, `sent:${sendId}`, found.raw);
              yield* log.outboxDone(sendId, found.message);
              print("send recovered", { sendId });
              yield* Effect.annotateCurrentSpan({ result: "recovered", message: found.message });
              return { message: found.message, place: found.place, recovered: true };
            }
          } else {
            yield* log.outboxStart(sendId, to, text);
          }
          const sent = yield* platform(adapter, () => adapter.send(record?.to_address ?? to, text, sendId)).pipe(
            Effect.withSpan("channel.send", { attributes: { channel: adapter.id } }),
          );
          hooks.afterPlatformSend?.(sendId);
          yield* inbox.receive(adapter.id, `sent:${sendId}`, sent.raw);
          yield* log.outboxDone(sendId, sent.message);
          yield* Effect.annotateCurrentSpan({ result: "sent", message: sent.message });
          return { message: sent.message, place: sent.place };
        });

      return Outbox.of({
        hooks,
        send: (sendId, to, text, wakes = [], parent) => {
          const [first, ...rest] = parent ? [parent, ...wakes] : wakes;
          return send(sendId, to, text).pipe(
            Effect.withSpan("send", {
              attributes: { send: sendId, to },
              ...(first ? { parent: first } : {}),
              links: rest.map((span) => ({ span, attributes: {} })),
            }),
          );
        },
      });
    }),
  );
}

function placeOf(adapters: readonly ChannelAdapter[], message: Address): { place?: Address } {
  const adapter = adapters.find((candidate) => candidate.owns(message));
  try {
    const place = adapter?.placeOf(message);
    return place ? { place } : {};
  } catch {
    return {};
  }
}
