import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channels/telegram/index.ts";
import type { ChannelAdapter, ChannelSink, Happening } from "../src/core/channel.ts";
import { BOT, TOKEN, fakeTelegram, updates } from "./support/telegram.ts";

// The Telegram channel against a small local Bot API server: what it stores and when, what it makes of updates, and
// what it sends.

let dir: string;
let telegram: Awaited<ReturnType<typeof fakeTelegram>>;
let channel: ChannelAdapter;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pots-telegram-"));
  writeFileSync(join(dir, "telegram.env"), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  telegram = await fakeTelegram();
  channel = createChannel({ id: "telegram", type: "telegram", secrets: join(dir, "telegram.env") }, { botDir: dir, botName: "Pots", log: () => {} }, telegram.url);
});

afterEach(async () => {
  await channel.stop();
  await telegram.close();
  rmSync(dir, { recursive: true, force: true });
});

function sink(receive: ChannelSink["receive"] = async () => {}, logs: string[] = []): ChannelSink {
  return {
    receive,
    newestMessage: async () => undefined,
    threads: async () => [],
    places: async () => [],
    lastAlive: () => undefined,
    form: async () => undefined,
    formOpened: async () => {},
    formOpening: async () => undefined,
    log: (message) => logs.push(message),
  };
}

const methods = (name: string) => telegram.calls.filter((call) => call.method === name);

describe("receiving", () => {
  it("says the token is wrong when Telegram does not know it", async () => {
    telegram.script("getMe", { ok: false, error_code: 404, description: "Not Found" });
    const failed = await channel.start(sink()).then(() => undefined, (error: Error) => error.message);
    expect(failed).toBe(`Telegram does not know the token in ${join(dir, "telegram.env")} (Telegram getMe: Not Found); copy it again from @BotFather`);
    expect(failed).not.toContain(TOKEN);
  });

  it("stores each update before it asks Telegram for the ones after it, so one not stored comes again", { timeout: 10_000 }, async () => {
    const stored: string[] = [];
    let failed = false;
    const logs: string[] = [];
    telegram.push(updates.dm, updates.group, updates.mention);
    await channel.start(
      sink(async (eventId) => {
        if (eventId === "update:1002" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        stored.push(eventId);
      }, logs),
    );
    await vi.waitFor(() => expect(stored).toContain("update:1003"), { timeout: 5_000 });
    // The poll after the last update stored, which tells Telegram it is stored.
    await vi.waitFor(() => expect(methods("getUpdates").length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
    // The webhook is removed first, and the updates that wait are kept.
    expect(telegram.calls[1]).toMatchObject({ method: "deleteWebhook", params: { drop_pending_updates: false } });
    // The second poll asks again from the update that was not stored; the third from after the last one stored.
    const polls = methods("getUpdates").map((call) => call.params);
    expect(polls.slice(0, 3).map((params) => params.offset)).toEqual([undefined, 1002, 1004]);
    expect(polls[0]).toMatchObject({
      timeout: 50,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "message_reaction", "my_chat_member", "callback_query"],
    });
    expect(stored).toEqual(["update:1001", "update:1002", "update:1003"]);
    expect(logs).toContain("update not stored; Telegram gives it again with the next poll");
    // A long poll in progress ends at once on stop.
    const started = Date.now();
    await channel.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers a button press as soon as it is stored, with no text, and names the button", { timeout: 10_000 }, async () => {
    const stored: { id: string; raw: unknown }[] = [];
    /** How many answers Telegram had when the press was stored. */
    let answersBefore = -1;
    const team = { id: -100200, title: "Team", type: "supergroup" };
    const keyboard = { inline_keyboard: [[{ text: "Test", callback_data: "deploy:test" }, { text: "Production", callback_data: "deploy:prod" }]] };
    const press = {
      update_id: 1030,
      callback_query: {
        id: "4382bfdwdsb323b2d9",
        from: { id: 111, is_bot: false, first_name: "Alice", last_name: "Smith", username: "alice", language_code: "en" },
        message: { message_id: 40, from: BOT, chat: team, date: 1793080400, text: "Where to?", reply_markup: keyboard },
        chat_instance: "-8212831289223871",
        data: "deploy:prod",
      },
    };
    telegram.push(press);
    await channel.start(
      sink(async (id, raw) => {
        answersBefore = methods("answerCallbackQuery").length;
        stored.push({ id, raw: JSON.parse(JSON.stringify(raw)) });
      }),
    );
    await vi.waitFor(() => expect(methods("answerCallbackQuery")).toHaveLength(1), { timeout: 5_000 });
    expect(stored.map((event) => event.id)).toEqual(["update:1030"]);
    expect(answersBefore).toBe(0);
    expect(methods("answerCallbackQuery")).toEqual([{ method: "answerCallbackQuery", params: { callback_query_id: "4382bfdwdsb323b2d9" }, files: {} }]);
    expect(await channel.translate(stored[0]!.raw)).toEqual([
      expect.objectContaining({
        kind: "interaction",
        place: { address: "telegram:#-100200", kind: "channel", name: "Team" },
        message: "telegram:#-100200/40",
        person: { address: "telegram:@111", name: "alice", realName: "Alice Smith" },
        fromMe: false,
        text: 'clicked button "Production" (callback_data deploy:prod)',
      }),
    ]);
  });

  it("says so when another process polls with the same token", { timeout: 10_000 }, async () => {
    const logs: string[] = [];
    telegram.script("getUpdates", { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" });
    await channel.start(sink(undefined, logs));
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("another process gets this bot's updates"))).toBe(true));
  });
});

describe("translate", () => {
  const translate = async (update: object) => channel.translate(JSON.parse(JSON.stringify(update)));

  it("turns updates into happenings", async () => {
    await channel.start(sink());
    expect(channel.me).toEqual({ address: "telegram:@999", name: "pots_test_bot", realName: "Pots" });

    expect(await translate(updates.dm)).toEqual([
      expect.objectContaining({
        kind: "message",
        at: 1793080260_000,
        place: { address: "telegram:#111", kind: "dm", name: "Alice Smith" },
        message: "telegram:#111/10",
        person: { address: "telegram:@111", name: "alice", realName: "Alice Smith" },
        fromMe: false,
        mentionsMe: false,
        text: "hello **there**",
        mentions: [],
      }),
    ]);
    const [group] = await translate(updates.group);
    expect(group).toMatchObject({ kind: "message", place: { address: "telegram:#-100200", kind: "channel", name: "Team" }, message: "telegram:#-100200/20" });
    expect(group).not.toHaveProperty("thread");

    expect(await translate(updates.mention)).toEqual([
      expect.objectContaining({ person: { address: "telegram:@222", name: "Bob" }, mentionsMe: true, mentions: ["telegram:@999"] }),
    ]);
    // A reply to the bot addresses it, and its thread is the message it answers.
    expect(await translate(updates.replyToBot)).toEqual([
      expect.objectContaining({ mentionsMe: true, thread: "telegram:#-100200/22", threadRoot: "telegram:#-100200/22", text: "yes please" }),
    ]);

    // A forum topic is a thread; its first message is the service message that created it, with the topic's name.
    expect(await translate(updates.topicStart)).toEqual([
      expect.objectContaining({ kind: "message", message: "telegram:#-100300/7", thread: "telegram:#-100300/7", text: "Deploys", mentionsMe: false }),
    ]);
    expect(await translate(updates.topicMessage)).toEqual([
      expect.objectContaining({ message: "telegram:#-100300/8", thread: "telegram:#-100300/7", threadRoot: "telegram:#-100300/7", mentionsMe: false }),
    ]);
    // A reply inside the topic stays in the topic's thread.
    expect(await translate(updates.topicReply)).toEqual([expect.objectContaining({ message: "telegram:#-100300/9", thread: "telegram:#-100300/7" })]);

    expect(await translate(updates.edit)).toEqual([
      expect.objectContaining({ kind: "edit", at: 1793080320_000, message: "telegram:#-100200/20", text: "lunch at 1pm?", fromMe: false }),
    ]);
    expect(await translate(updates.reaction)).toEqual([
      expect.objectContaining({ kind: "reaction_added", message: "telegram:#-100200/20", person: expect.objectContaining({ address: "telegram:@111" }), text: "👍" }),
    ]);
    expect(await translate(updates.botAdded)).toEqual([
      expect.objectContaining({
        kind: "join",
        place: expect.objectContaining({ address: "telegram:#-100200" }),
        person: expect.objectContaining({ address: "telegram:@999" }),
        fromMe: false,
        text: "added by alice (telegram:@111)",
      }),
    ]);
    // A group that became a supergroup has a new address; each chat says where the other one is, and no one spoke.
    expect(await translate(updates.upgradedGroup)).toEqual([
      expect.objectContaining({
        kind: "system",
        place: expect.objectContaining({ address: "telegram:#-5500" }),
        person: expect.objectContaining({ address: "telegram:@111" }),
        fromMe: false,
        text: "became a supergroup with a new address: telegram:#-100500",
      }),
    ]);
    const [from] = await translate(updates.upgradedFrom);
    expect(from).toMatchObject({ kind: "system", place: { address: "telegram:#-100500" }, fromMe: false, text: "was the group telegram:#-5500" });
    expect(from).not.toHaveProperty("person");
    // Other service messages are system events in words too; a pin is about the pinned message, a closed topic is in it.
    expect(await translate(updates.pinned)).toEqual([
      expect.objectContaining({ kind: "system", message: "telegram:#-100200/20", person: expect.objectContaining({ address: "telegram:@111" }), text: "pinned a message" }),
    ]);
    expect(await translate(updates.renamed)).toEqual([expect.objectContaining({ kind: "system", place: expect.objectContaining({ address: "telegram:#-100200" }), text: 'changed the name to "Team 2"' })]);
    expect(await translate(updates.topicClosed)).toEqual([expect.objectContaining({ kind: "system", message: "telegram:#-100300/12", thread: "telegram:#-100300/7", text: "closed the topic" })]);
  });

  it("gives the files of a message with URLs that hold no token, and fetchFile downloads them", async () => {
    await channel.start(sink());
    const happenings: Happening[] = await translate(updates.photo);
    expect(happenings[0]).toMatchObject({ text: "the error", files: [{ name: "photo.jpg", type: "image/jpeg", url: "telegram-file:AgAC-large", size: 51200 }] });
    expect(JSON.stringify(happenings)).not.toContain(TOKEN);

    const content = new TextEncoder().encode("jpeg bytes");
    telegram.files.set("photos/AgAC-large.jpg", content);
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await channel.fetchFile!(happenings[0]!.files![0]!, AbortSignal.timeout(5_000))) as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("jpeg bytes");
    expect(methods("getFile").map((call) => call.params)).toEqual([{ file_id: "AgAC-large" }]);
  });
});

describe("sending", () => {
  it("refuses a text over 32768 characters as Telegram counts them, and never cuts one", async () => {
    await channel.start(sink());
    expect(channel.checkText!("telegram:#111", "x".repeat(32768))).toBeUndefined();
    expect(channel.checkText!("telegram:#111", "x".repeat(32769))).toBe("Telegram allows at most 32768 characters in one message; this one has 32769. Send it in parts.");
    // Telegram counts the text it shows, in characters: Markdown marks do not count, and an emoji is one character.
    expect(channel.checkText!("telegram:#111", `**${"x".repeat(32768)}**`)).toBeUndefined();
    expect(channel.checkText!("telegram:#111", "👍".repeat(32768))).toBeUndefined();
    await expect(channel.send("telegram:#111", "y".repeat(40000), "s1")).rejects.toThrow("this one has 40000");
    expect(telegram.calls.filter((call) => call.method.startsWith("send"))).toEqual([]);

    const long = "z".repeat(5000);
    await channel.send("telegram:#111", long, "s2");
    expect(methods("sendRichMessage")[0]!.params).toEqual({ chat_id: "111", rich_message: { markdown: long } });
  });

  it("sends a rich message that replies in the topic of the message it answers, with mentions", async () => {
    await channel.start(sink());
    for (const update of [updates.dm, updates.topicMessage]) await channel.translate(JSON.parse(JSON.stringify(update)));
    telegram.script("getChatMember", { ok: true, result: { status: "member", user: { id: 222, is_bot: false, first_name: "Bob" } } });

    const sent = await channel.send("telegram:#-100300/8", "**done**, <telegram:@111> and <telegram:@222>", "s1");
    expect(methods("sendRichMessage")[0]!.params).toEqual({
      chat_id: "-100300",
      message_thread_id: 7,
      reply_parameters: { message_id: 8, allow_sending_without_reply: true },
      rich_message: { markdown: "**done**, @alice and [Bob](tg://user?id=222)" },
    });
    // Bob, not seen before and without a username, was looked up as a member of the chat.
    expect(methods("getChatMember").map((call) => call.params)).toEqual([{ chat_id: "-100300", user_id: 222 }]);
    expect(sent).toMatchObject({ message: "telegram:#-100300/500", place: "telegram:#-100300" });
    // The sent message comes back only from send, as the bot's own.
    expect(await channel.translate(JSON.parse(JSON.stringify(sent.raw)))).toEqual([
      expect.objectContaining({ kind: "message", message: "telegram:#-100300/500", thread: "telegram:#-100300/7", fromMe: true, sendId: "s1", person: channel.me }),
    ]);

    // To a topic's first message: a message in the topic, not a reply.
    await channel.send("telegram:#-100300/7", "next", "s2");
    expect(methods("sendRichMessage")[1]!.params).toEqual({ chat_id: "-100300", message_thread_id: 7, rich_message: { markdown: "next" } });
  });

  it("keeps each line break of the text: Telegram reads a single one in rich Markdown as a space", async () => {
    await channel.start(sink());
    const text = "Done:\n• one\n• two `a\nb` <b>x\ny</b>\n\n> quote\n> more\n\n- item\n  next\n\n```\ncode\nline\n```\n\nhard  \nalready\\\nhard\r\nwindows\\\\\nescaped";
    await channel.send("telegram:#111", text, "s1");
    expect(methods("sendRichMessage")[0]!.params.rich_message).toEqual({
      markdown:
        "Done:  \n• one  \n• two `a\nb` <b>x  \ny</b>\n\n> quote  \n> more\n\n- item  \n  next\n\n```\ncode\nline\n```\n\nhard  \nalready\\\nhard  \r\nwindows\\\\  \nescaped",
    });
  });

  it("sends MarkdownV2 where Telegram does not take a rich message, with the lower limit of a plain message", async () => {
    await channel.start(sink());
    await channel.translate(JSON.parse(JSON.stringify(updates.topicMessage)));
    const notTaken = { ok: false as const, error_code: 400, description: "Bad Request: RICH_MESSAGE_UNSUPPORTED" };

    telegram.script("sendRichMessage", notTaken);
    await channel.send("telegram:#-100300/8", "**done**", "s1");
    expect(methods("sendMessage")[0]!.params).toEqual({
      chat_id: "-100300",
      message_thread_id: 7,
      reply_parameters: { message_id: 8, allow_sending_without_reply: true },
      text: "*done*",
      parse_mode: "MarkdownV2",
    });

    // MarkdownV2 escapes each dot, so the text sent is twice as long, but Telegram counts what it shows.
    telegram.script("sendRichMessage", notTaken);
    await channel.send("telegram:#111", ".".repeat(4000), "s2");
    expect(methods("sendMessage")[1]!.params).toEqual({ chat_id: "111", text: "\\.".repeat(4000), parse_mode: "MarkdownV2" });

    telegram.script("sendRichMessage", notTaken);
    await expect(channel.send("telegram:#111", "y".repeat(5000), "s3")).rejects.toThrow(
      "This chat does not take rich messages (Telegram sendRichMessage: Bad Request: RICH_MESSAGE_UNSUPPORTED), so the text goes as a plain message, and Telegram allows at most 4096 characters in one of those; this one has 5000. Send it in parts.",
    );
    // Another error is not a reason to send it differently.
    telegram.script("sendRichMessage", { ok: false, error_code: 400, description: "Bad Request: chat not found" });
    await expect(channel.send("telegram:#-100999", "hi", "s4")).rejects.toThrow("Telegram sendRichMessage: Bad Request: chat not found");
    // Telegram gives the new chat ID of a group that became a supergroup only in the error's parameters.
    telegram.script("sendRichMessage", {
      ok: false,
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -100500 },
    });
    await expect(channel.send("telegram:#-5500", "hi", "s5")).rejects.toThrow(
      "Telegram sendRichMessage: Bad Request: group chat was upgraded to a supergroup chat; its new address is telegram:#-100500",
    );
    expect(methods("sendMessage")).toHaveLength(2);
  });

  it("lets Telegram refuse a reply in a forum when the message is gone and its topic is not known, so it does not go to General", async () => {
    await channel.start(sink());
    // The adapter has not seen the message since it started, so it does not know the message's topic.
    await channel.send("telegram:#-100300/8", "on it", "s1");
    expect(methods("sendRichMessage")[0]!.params).toEqual({ chat_id: "-100300", reply_parameters: { message_id: 8 }, rich_message: { markdown: "on it" } });

    telegram.script("sendRichMessage", { ok: false, error_code: 400, description: "Bad Request: message to be replied not found" });
    await expect(channel.send("telegram:#-100300/8", "on it", "s2")).rejects.toThrow(
      "Telegram sendRichMessage: Bad Request: message to be replied not found. The message telegram:#-100300/8 is gone; send to its place (telegram:#-100300) or to its topic instead.",
    );
    // Whether the chat has topics was looked up once.
    expect(methods("getChat").map((call) => call.params)).toEqual([{ chat_id: "-100300" }]);

    // In a group without topics and in a private chat, a reply to a message that is gone still goes out.
    await channel.send("telegram:#-100200/20", "ok", "s3");
    await channel.send("telegram:#111/10", "ok", "s4");
    expect(methods("sendRichMessage").slice(2).map((call) => call.params.reply_parameters)).toEqual([
      { message_id: 20, allow_sending_without_reply: true },
      { message_id: 10, allow_sending_without_reply: true },
    ]);
  });

  it("writes to a person in their private chat, and says what to do when they never started the bot", async () => {
    await channel.start(sink());
    await channel.send("telegram:@111", "hi", "s1");
    expect(methods("sendRichMessage")[0]!.params).toEqual({ chat_id: "111", rich_message: { markdown: "hi" } });

    telegram.script("sendRichMessage", { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    await expect(channel.send("telegram:@555", "hi", "s2")).rejects.toThrow(
      "Telegram sendRichMessage: Forbidden: bot can't initiate conversation with a user. A bot can write to a person only after they started a chat with it",
    );
  });

  it("reacts with the emoji Telegram allows", async () => {
    await channel.start(sink());
    await channel.react("telegram:#-100200/20", ":thumbsup:", false);
    await channel.react("telegram:#-100200/20", "❤️", false);
    await channel.react("telegram:#-100200/20", "👀", true);
    expect(methods("setMessageReaction").map((call) => call.params.reaction)).toEqual([[{ type: "emoji", emoji: "👍" }], [{ type: "emoji", emoji: "❤" }], []]);
    await expect(channel.react("telegram:#-100200/20", ":no_such_emoji:", false)).rejects.toThrow("no emoji is known by the name :no_such_emoji:");
  });

  it("stores a message the bot sends or edits with call as its own, as Telegram does not send it back", async () => {
    const stored: { id: string; raw: unknown }[] = [];
    await channel.start(sink(async (id, raw) => void stored.push({ id, raw: JSON.parse(JSON.stringify(raw)) })));
    const chat = { id: 111, first_name: "Alice", type: "private" };
    const sizes = [
      { file_id: "AgAC-small", file_unique_id: "s", file_size: 300, width: 90, height: 56 },
      { file_id: "AgAC-large", file_unique_id: "l", file_size: 700, width: 320, height: 200 },
    ];
    const photo = { message_id: 30, from: BOT, chat, date: 1_800_000_000, caption: "the chart", photo: sizes };
    telegram.script("sendPhoto", { ok: true, result: photo });
    telegram.script("sendMediaGroup", { ok: true, result: [31, 32].map((id) => ({ ...photo, message_id: id, caption: undefined })) });
    telegram.script(
      "editMessageCaption",
      { ok: true, result: { ...photo, caption: "the new chart", edit_date: 1_800_000_100 } },
      { ok: true, result: { ...photo, caption: "the newest chart", edit_date: 1_800_000_100 } },
    );
    await channel.call("sendPhoto", { chat_id: 111, photo: "AgAC-large", caption: "the chart" });
    await channel.call("sendMediaGroup", { chat_id: 111, media: [{ type: "photo", media: "AgAC-large" }, { type: "photo", media: "AgAC-large" }] });
    await channel.call("editMessageCaption", { chat_id: 111, message_id: 30, caption: "the new chart" });
    // A second edit in the same second is another event.
    await channel.call("editMessageCaption", { chat_id: 111, message_id: 30, caption: "the newest chart" });
    await channel.call("pinChatMessage", { chat_id: 111, message_id: 30 });

    const calls = stored.filter((event) => event.id.startsWith("call:"));
    expect(calls.map((event) => event.id)).toEqual(["call:111:30", "call:111:31", "call:111:32", expect.stringMatching(/^call:111:30:1800000100:\w{16}$/), expect.stringMatching(/^call:111:30:1800000100:\w{16}$/)]);
    expect(calls[3]!.id).not.toBe(calls[4]!.id);
    expect(await channel.translate(calls[0]!.raw)).toEqual([
      expect.objectContaining({ kind: "message", message: "telegram:#111/30", fromMe: true, text: "the chart", files: [expect.objectContaining({ url: "telegram-file:AgAC-large", size: 700 })] }),
    ]);
    expect(await channel.translate(calls[3]!.raw)).toEqual([expect.objectContaining({ kind: "edit", message: "telegram:#111/30", fromMe: true, text: "the new chart" })]);
  });

  it("gives Telegram's description when it refuses a call, a send or a reaction, and never the token", async () => {
    await channel.start(sink());
    telegram.script("sendMessage", { ok: false, error_code: 400, description: "Bad Request: BUTTON_DATA_INVALID" });
    const refused = await channel
      .call("sendMessage", { chat_id: -100200, text: "Where to?", reply_markup: { inline_keyboard: [[{ text: "Test", callback_data: "x".repeat(65) }]] } })
      .then(() => undefined, (error: Error) => error.message);
    expect(refused).toBe("Telegram sendMessage: Bad Request: BUTTON_DATA_INVALID");
    telegram.script("setMessageReaction", { ok: false, error_code: 400, description: "Bad Request: message to react not found" });
    const reacted = await channel.react("telegram:#-100200/99", "👀", false).then(() => undefined, (error: Error) => error.message);
    expect(reacted).toBe("Telegram setMessageReaction: Bad Request: message to react not found");
    for (const text of [refused, reacted]) expect(text).not.toContain(TOKEN);
  });

  it("calls any method, and uploads a file parameter given as a local path", async () => {
    await channel.start(sink());
    const report = join(dir, "report.txt");
    writeFileSync(report, "all green");
    await channel.call("sendDocument", { chat_id: 111, document: report, caption: "/status", reply_parameters: { message_id: 10 } });
    expect(methods("sendDocument")[0]).toEqual({
      method: "sendDocument",
      params: { chat_id: "111", caption: "/status", reply_parameters: '{"message_id":10}' },
      files: { document: { name: "report.txt", text: "all green" } },
    });

    await channel.call("sendMediaGroup", { chat_id: 111, media: [{ type: "document", media: report }, { type: "photo", media: "AgAC-large" }] });
    const group = methods("sendMediaGroup")[0]!;
    expect(JSON.parse(group.params.media as string)).toEqual([{ type: "document", media: "attach://file1" }, { type: "photo", media: "AgAC-large" }]);
    expect(group.files).toEqual({ file1: { name: "report.txt", text: "all green" } });

    // Without a local file, the call is plain JSON.
    await channel.call("pinChatMessage", { chat_id: -100200, message_id: 20 });
    expect(methods("pinChatMessage")[0]!.params).toEqual({ chat_id: -100200, message_id: 20 });
  });
});
