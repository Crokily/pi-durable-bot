import { describe, expect, it } from "vitest";
import { GatewaySlackAdapter } from "../src/channels/slack/sdk.ts";

// What the Slack channel posts, without Slack: the SDK translates the bot's Markdown.

describe("Slack channel", () => {
  it("keeps a bare @name as text, since Slack would show <@name> for a name that is not a person's ID", () => {
    const sdk = new GatewaySlackAdapter({ mode: "socket", appToken: "xapp-test", botToken: "xoxb-test", userName: "Pots" });
    const converter = (sdk as unknown as { formatConverter: { toSlackPayload(message: { markdown: string }): unknown } }).formatConverter;
    expect(converter.toSlackPayload({ markdown: "The Telegram bot is @colyclawbot, ask <@U0CC833JMQU> {{emoji:thumbs_up}}" })).toEqual({
      markdown_text: "The Telegram bot is @colyclawbot, ask <@U0CC833JMQU> :+1:",
    });
  });
});
