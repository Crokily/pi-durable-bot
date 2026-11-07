import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A small Bot API server for the Telegram channel's tests, and updates in the shape Telegram sends them.

export const TOKEN = "123456:TEST-token-that-must-not-leak";
export const BOT = { id: 999, is_bot: true, first_name: "Pots", username: "pots_test_bot" };

export interface Call {
  method: string;
  /** The JSON body, or the text fields of a multipart body. */
  params: Record<string, unknown>;
  /** The files of a multipart body, by field name. */
  files: Record<string, { name: string; text: string }>;
}

type Answer = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };

/**
 * Answers as Telegram does for the methods the tests use. Updates stay until getUpdates asks from an offset past
 * them; getUpdates waits for one, as a long poll does, until the client gives up. Every call is recorded.
 */
export async function fakeTelegram() {
  const calls: Call[] = [];
  let updates: { update_id: number }[] = [];
  let wake: (() => void) | undefined;
  const scripted = new Map<string, Answer[]>();
  /** Files on the file host, by file_path. */
  const files = new Map<string, Uint8Array>();
  let nextMessage = 500;

  const answer = async (method: string, params: Record<string, any>, closed: Promise<void>): Promise<Answer> => {
    const next = scripted.get(method)?.shift();
    if (next) return next;
    switch (method) {
      case "getMe":
        return { ok: true, result: BOT };
      case "getUpdates": {
        updates = updates.filter((update) => update.update_id >= (params.offset ?? 0));
        if (updates.length === 0) await Promise.race([new Promise<void>((resolve) => (wake = resolve)), closed]);
        return { ok: true, result: updates };
      }
      case "sendMessage":
      case "sendRichMessage": {
        const chat = Number(params.chat_id);
        const reply = params.reply_parameters?.message_id;
        return {
          ok: true,
          result: {
            message_id: nextMessage++,
            from: BOT,
            chat: chat < 0 ? { id: chat, title: "Ops", type: "supergroup", is_forum: true } : { id: chat, first_name: "Alice", type: "private" },
            date: 1793080400,
            ...(params.message_thread_id ? { message_thread_id: params.message_thread_id, is_topic_message: true } : {}),
            ...(reply ? { reply_to_message: { message_id: reply, chat: { id: chat, type: "supergroup" }, date: 1793080300, text: "earlier" } } : {}),
            text: params.text ?? params.rich_message?.markdown,
          },
        };
      }
      case "getChat": {
        const chat = [team, ops].find((known) => String(known.id) === String(params.chat_id));
        return chat ? { ok: true, result: chat } : { ok: false, error_code: 400, description: "Bad Request: chat not found" };
      }
      case "getFile": {
        const path = `photos/${params.file_id}.jpg`;
        return files.has(path) ? { ok: true, result: { file_id: params.file_id, file_unique_id: "u", file_size: files.get(path)!.length, file_path: path } } : { ok: false, error_code: 400, description: "Bad Request: invalid file_id" };
      }
      default:
        return { ok: true, result: true };
    }
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = Buffer.concat(await request.toArray());
    const closed = new Promise<void>((resolve) => response.on("close", resolve));
    const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) {
      const content = file[1] === TOKEN ? files.get(file[2]!) : undefined;
      response.writeHead(content ? 200 : 404).end(content);
      return;
    }
    const method = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!method || method[1] !== TOKEN) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      return;
    }
    const type = request.headers["content-type"] ?? "";
    const call: Call = { method: method[2]!, params: {}, files: {} };
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      for (const [key, value] of form) {
        if (typeof value === "string") call.params[key] = value;
        else call.files[key] = { name: value.name, text: await value.text() };
      }
    } else if (body.length) {
      call.params = JSON.parse(body.toString("utf8"));
    }
    calls.push(call);
    const result = await answer(call.method, call.params, closed);
    if (!response.destroyed) response.writeHead(result.ok ? 200 : (result.error_code ?? 400), { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    files,
    /** Updates that come with the next getUpdates. */
    push(...more: { update_id: number }[]) {
      updates.push(...more);
      wake?.();
    },
    /** The next answers to a method, instead of the usual one. */
    script(method: string, ...answers: Answer[]) {
      scripted.set(method, [...(scripted.get(method) ?? []), ...answers]);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Updates as Telegram sends them, written from the Bot API's Update and Message objects.

const alice = { id: 111, is_bot: false, first_name: "Alice", last_name: "Smith", username: "alice", language_code: "en" };
const bob = { id: 222, is_bot: false, first_name: "Bob" };
const team = { id: -100200, title: "Team", type: "supergroup" };
const ops = { id: -100300, title: "Ops", type: "supergroup", is_forum: true };
const date = 1793080260;
const topicStart = { message_id: 7, from: alice, chat: ops, date, message_thread_id: 7, is_topic_message: true, forum_topic_created: { name: "Deploys", icon_color: 7322096 } };
const topicMessage = { message_id: 8, from: alice, chat: ops, date: date + 5, message_thread_id: 7, is_topic_message: true, reply_to_message: topicStart, text: "deploy failed on step 3" };

export const updates = {
  dm: {
    update_id: 1001,
    message: {
      message_id: 10,
      from: alice,
      chat: { id: 111, first_name: "Alice", last_name: "Smith", username: "alice", type: "private" },
      date,
      text: "hello there",
      entities: [{ offset: 6, length: 5, type: "bold" }],
    },
  },
  group: { update_id: 1002, message: { message_id: 20, from: alice, chat: team, date, text: "lunch at noon?" } },
  mention: {
    update_id: 1003,
    message: { message_id: 21, from: bob, chat: team, date: date + 1, text: "@pots_test_bot can you check the build?", entities: [{ offset: 0, length: 14, type: "mention" }] },
  },
  replyToBot: {
    update_id: 1004,
    message: { message_id: 23, from: bob, chat: team, date: date + 3, text: "yes please", reply_to_message: { message_id: 22, from: BOT, chat: team, date: date + 2, text: "Shall I deploy?" } },
  },
  topicStart: { update_id: 1005, message: topicStart },
  topicMessage: { update_id: 1006, message: topicMessage },
  topicReply: {
    update_id: 1007,
    message: { message_id: 9, from: bob, chat: ops, date: date + 9, message_thread_id: 7, is_topic_message: true, reply_to_message: topicMessage, text: "which step?" },
  },
  edit: { update_id: 1008, edited_message: { message_id: 20, from: alice, chat: team, date, edit_date: date + 60, text: "lunch at 1pm?" } },
  reaction: {
    update_id: 1009,
    message_reaction: { chat: team, message_id: 20, user: alice, date: date + 70, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] },
  },
  // A group that became a supergroup: a service message in each chat. The new one comes on behalf of the supergroup.
  upgradedGroup: {
    update_id: 1020,
    message: { message_id: 30, from: alice, chat: { id: -5500, title: "Old team", type: "group" }, date: date + 90, migrate_to_chat_id: -100500 },
  },
  upgradedFrom: {
    update_id: 1021,
    message: {
      message_id: 1,
      from: { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
      sender_chat: { id: -100500, title: "Old team", type: "supergroup" },
      chat: { id: -100500, title: "Old team", type: "supergroup" },
      date: date + 90,
      migrate_from_chat_id: -5500,
    },
  },
  botAdded: {
    update_id: 1010,
    my_chat_member: { chat: team, from: alice, date: date - 100, old_chat_member: { user: BOT, status: "left" }, new_chat_member: { user: BOT, status: "member" } },
  },
  photo: {
    update_id: 1011,
    message: {
      message_id: 24,
      from: alice,
      chat: team,
      date: date + 80,
      photo: [
        { file_id: "AgAC-small", file_unique_id: "s1", file_size: 1200, width: 90, height: 60 },
        { file_id: "AgAC-large", file_unique_id: "s2", file_size: 51200, width: 1280, height: 853 },
      ],
      caption: "the error",
    },
  },
};
