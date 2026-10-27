import { AsyncLocalStorage } from "node:async_hooks";
import { SlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import type { Message } from "chat";

/** Slack message metadata type on messages the bot sends. The payload holds the send ID. */
export const SEND_EVENT_TYPE = "personal_bot_send";

const pendingMetadata = new AsyncLocalStorage<{ event_type: string; event_payload: { send_id: string } }>();

type Ack = (response?: Record<string, unknown>) => Promise<void>;

/**
 * The Chat SDK Slack adapter, used only to translate between Slack and plain text.
 * Changes to its behavior:
 * - Socket events, interactions and slash commands go to `onSocketEvent`, which stores them, before the ack. The SDK
 *   acks first and routes through Chat handlers; this bot does neither.
 * - Posts made inside `postWithSendId` carry the send ID as message metadata, so a send can be found again.
 * - Link previews are not awaited: the SDK waits for unfurls that only its own handlers would store.
 */
export class GatewaySlackAdapter extends SlackAdapter {
  /** Every event, interaction and slash command, before the ack. */
  onSocketEvent?: (body: Record<string, unknown>, type: string) => Promise<void>;
  onSocketError?: (error: unknown) => void;

  protected override async routeSocketEvent(
    body: Record<string, unknown>,
    eventType: string,
    ack: Ack,
    options?: Parameters<SlackAdapter["routeSocketEvent"]>[3],
    retryNum?: number,
  ): Promise<void> {
    if (!this.onSocketEvent || !["events_api", "interactive", "slash_commands"].includes(eventType)) {
      return super.routeSocketEvent(body, eventType, ack, options, retryNum);
    }
    try {
      await this.onSocketEvent(body, eventType);
    } catch (error) {
      // No ack: Slack delivers the event again.
      this.onSocketError?.(error);
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

  protected override async enrichLinks(links: Parameters<SlackAdapter["enrichLinks"]>[0]): ReturnType<SlackAdapter["enrichLinks"]> {
    return links;
  }

  /** Post Markdown into a Chat SDK thread ID, with the send ID in the message metadata. */
  postWithSendId(threadId: string, markdown: string, sendId: string) {
    return pendingMetadata.run({ event_type: SEND_EVENT_TYPE, event_payload: { send_id: sendId } }, () => this.postMessage(threadId, { markdown }));
  }

  /** A Slack message as plain text: names, mentions and formatting resolved. */
  translate(event: SlackEvent): Promise<Message<unknown>> {
    return this.parseSlackMessage(event, this.encodeThreadId({ channel: event.channel ?? "", threadTs: event.thread_ts ?? event.ts ?? "" }));
  }

  threadIdFor(channel: string, threadTs?: string): string {
    return this.encodeThreadId({ channel, threadTs: threadTs ?? "" });
  }
}
