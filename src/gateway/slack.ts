import { AsyncLocalStorage } from "node:async_hooks";
import { SlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import type { Message } from "chat";

/** Slack message metadata type for messages the bot sends. The payload holds the send ID. */
export const SEND_EVENT_TYPE = "personal_bot_send";

const pendingMetadata = new AsyncLocalStorage<{ event_type: string; event_payload: { send_id: string } }>();

type Ack = (response?: Record<string, unknown>) => Promise<void>;

/**
 * The Chat SDK Slack adapter, used only to translate between Slack and plain messages.
 *
 * Two changes to its behavior:
 * - Socket events go to `onSocketEvent`, which stores them, before the ack. The SDK acks first and routes
 *   through Chat handlers; this gateway does neither.
 * - Posts made inside `postWithSendId` carry the send ID as message metadata, so a send can be found again.
 */
export class GatewaySlackAdapter extends SlackAdapter {
  onSocketEvent?: (body: Record<string, unknown>) => Promise<void>;
  onError?: (error: unknown) => void;

  protected override async routeSocketEvent(
    body: Record<string, unknown>,
    eventType: string,
    ack: Ack,
    options?: Parameters<SlackAdapter["routeSocketEvent"]>[3],
    retryNum?: number,
  ): Promise<void> {
    if (eventType !== "events_api" || !this.onSocketEvent) return super.routeSocketEvent(body, eventType, ack, options, retryNum);
    try {
      await this.onSocketEvent(body);
    } catch (error) {
      // No ack: Slack delivers the event again.
      this.onError?.(error);
      return;
    }
    await ack();
  }

  protected override async withToken<T extends Record<string, any>>(options: T): Promise<T & { token: string }> {
    const result = await super.withToken(options);
    const metadata = pendingMetadata.getStore();
    if (metadata && "channel" in options && ("text" in options || "markdown_text" in options || "blocks" in options)) {
      return { ...result, metadata };
    }
    return result;
  }

  /** Post Markdown into a Chat SDK thread ID, with the send ID in the message metadata. */
  postWithSendId(threadId: string, markdown: string, sendId: string): Promise<{ id: string }> {
    return pendingMetadata.run({ event_type: SEND_EVENT_TYPE, event_payload: { send_id: sendId } }, () =>
      this.postMessage(threadId, { markdown }),
    );
  }

  /** Translate a Slack message event into a Chat SDK message: names, mentions and formatting resolved. */
  translate(event: SlackEvent): Promise<Message<unknown>> {
    return this.parseSlackMessage(event, this.threadIdForMessageEvent(event));
  }

  isSelf(event: SlackEvent): boolean {
    return this.isMessageFromSelf(event);
  }

  threadIdFor(channel: string, threadTs?: string): string {
    return this.encodeThreadId({ channel, threadTs: threadTs ?? "" });
  }
}
