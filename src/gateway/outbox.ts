import type { Address, ChannelAdapter } from "../core/channel.ts";
import type { MessageLog } from "./log.ts";

export interface SendResult {
  readonly message: Address;
  /** The place the message is in. */
  readonly place?: Address;
  /** True when a crash left the send unclear and the message was found on the platform instead of sent again. */
  readonly recovered?: boolean;
  /** True when this send ID was already sent before. */
  readonly repeated?: boolean;
}

/**
 * Sends once per send ID, across crashes:
 * - the outbox says sent → return that message;
 * - the outbox says sending (a crash in the middle) → look on the platform for a message with this send ID, and only
 *   send when there is none ("check, then send");
 * - otherwise record "sending", send, record "sent".
 * A sent message goes into the inbox as an event, so the log gets it the same way as every other message.
 */
export class Outbox {
  readonly #log: MessageLog;
  readonly #adapterFor: (address: Address) => ChannelAdapter;
  readonly #receive: (channel: string, eventId: string, raw: unknown) => Promise<void>;
  readonly #print: (message: string, data?: Record<string, unknown>) => void;
  /** Test hook: runs after the platform accepted a send and before the outbox records it. */
  afterPlatformSend?: (sendId: string) => void;

  constructor(
    log: MessageLog,
    adapterFor: (address: Address) => ChannelAdapter,
    receive: (channel: string, eventId: string, raw: unknown) => Promise<void>,
    print: (message: string, data?: Record<string, unknown>) => void,
  ) {
    this.#log = log;
    this.#adapterFor = adapterFor;
    this.#receive = receive;
    this.#print = print;
  }

  async send(sendId: string, to: Address, text: string): Promise<SendResult> {
    if (!text.trim()) throw new Error("text is empty");
    if (!sendId.trim()) throw new Error("send ID is empty");
    const record = await this.#log.outbox(sendId);
    if (record?.state === "sent") return { message: record.message!, ...placeOf(this.#adapterFor, record.message!), repeated: true };
    const adapter = this.#adapterFor(record?.to_address ?? to);
    if (record) {
      const found = await adapter.findSent(record.to_address, sendId, record.created_at);
      if (found) {
        await this.#receive(adapter.id, `sent:${sendId}`, found.raw);
        await this.#log.outboxDone(sendId, found.message);
        this.#print("send recovered", { sendId });
        return { message: found.message, place: found.place, recovered: true };
      }
    } else {
      await this.begin(sendId, to, text);
    }
    const sent = await adapter.send(record?.to_address ?? to, text, sendId);
    this.afterPlatformSend?.(sendId);
    await this.#receive(adapter.id, `sent:${sendId}`, sent.raw);
    await this.#log.outboxDone(sendId, sent.message);
    return { message: sent.message, place: sent.place };
  }

  /** Record the intent to send. Split out so a test can crash between this and the platform's answer. */
  begin(sendId: string, to: Address, text: string): Promise<void> {
    return this.#log.outboxStart(sendId, to, text);
  }
}

function placeOf(adapterFor: (address: Address) => ChannelAdapter, message: Address): { place?: Address } {
  try {
    const place = adapterFor(message).placeOf(message);
    return place ? { place } : {};
  } catch {
    return {};
  }
}
