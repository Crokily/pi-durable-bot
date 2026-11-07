import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

// A small Slack on this computer, for the Slack channel's tests: the Web API over HTTP, Socket Mode over a WebSocket,
// and a file host. Answers and events are shaped as Slack's docs show them.

export const APP_TOKEN = "xapp-1-A0TEST-1-app-token-that-must-not-leak";
export const BOT_TOKEN = "xoxb-1-bot-token-that-must-not-leak";
/** Slack's legacy verification token, which rides along in every envelope. */
export const VERIFICATION_TOKEN = "verification-token-that-must-not-be-stored";
export const BOT = { user_id: "UBOT", bot_id: "BBOT", user: "pots", team_id: "T0LAB", app_id: "A0TEST" };

/** A Web API call the fake got. */
export interface Call {
  method: string;
  /** The form fields as sent, without the token. Slack's SDK sends an object or a list as JSON text. */
  params: Record<string, string>;
  /** The token: from the Authorization header, or the token field. */
  auth: string | undefined;
  /** The files of a multipart body, by field name. */
  files: Record<string, { name: string; text: string }>;
}

/** A request to the file host. */
export interface FileRequest {
  path: string;
  auth: string | undefined;
}

export type SlackMessage = Record<string, any> & { ts: string };

/** An answer to a Web API call. undefined: the next route answers, or the fake's own answer. */
type Answer = (params: Record<string, string>, call: Call) => Record<string, unknown> | undefined;

/** A file on the file host: its content and type, or a redirect to another URL. */
type HostedFile = { content: string; type: string } | { redirect: string };

/**
 * Slack for the tests. The Web API is under /api/, with the methods the channel uses: messages are kept per
 * conversation, so a post shows in conversations.history and conversations.replies, with its metadata only when
 * include_all_metadata asks for it. apps.connections.open gives a WebSocket URL; on connect the fake says hello, and
 * tests send envelopes with `event`. The client's acks are recorded by envelope ID. Tokens are checked: the app token
 * only for apps.connections.open, the bot token for the rest. A test can answer a method itself with `route`.
 */
export class FakeSlack {
  readonly calls: Call[] = [];
  /** Envelope IDs the client acked, in order, with the payload of the ack. */
  readonly acks: { envelope_id: string; payload?: unknown }[] = [];
  readonly fileRequests: FileRequest[] = [];
  /** Files on the file host, by path, for example /files-pri/T0LAB-F1/plan.png. */
  readonly files = new Map<string, HostedFile>();
  /** Bytes uploaded to an upload URL, by file ID. */
  readonly uploads = new Map<string, string>();
  /** Conversations the bot is in, by ID, as conversations.info gives them. */
  readonly conversations = new Map<string, Record<string, any>>();
  /** People, by ID, as users.info gives them. */
  readonly users = new Map<string, Record<string, any>>();
  /** Reactions of the bot, as "<channel>/<ts>/<name>". */
  readonly reactions = new Set<string>();
  /** How many times a client connected to the socket. */
  connections = 0;
  readonly #messages = new Map<string, SlackMessage[]>();
  readonly #routes: { method: string; answer: Answer }[] = [];
  readonly #server: Server;
  readonly #socketServer: WebSocketServer;
  #socket?: WebSocket;
  #envelopes = 0;
  #events = 0;
  #posts = 0;
  #uploads = 0;

  private constructor(server: Server) {
    this.#server = server;
    this.#socketServer = new WebSocketServer({ server, path: "/link/" });
    this.#socketServer.on("connection", (socket) => this.#connected(socket));
  }

  static async start(): Promise<FakeSlack> {
    let fake: FakeSlack | undefined;
    const server = createServer((request, response) => void fake!.#http(request, response));
    fake = new FakeSlack(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** The Web API's base URL, as the Slack SDK's slackApiUrl takes it. */
  get api(): string {
    return `${this.origin}/api/`;
  }

  /** Answer a method. A later route goes before an earlier one. */
  route(method: string, answer: Answer): void {
    this.#routes.unshift({ method, answer });
  }

  called(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Put a message into a conversation's history, as if it was posted while no one listened. */
  post(channel: string, message: SlackMessage): SlackMessage {
    const list = this.#messages.get(channel) ?? [];
    list.push({ type: "message", ...message });
    list.sort((a, b) => compareTs(a.ts, b.ts));
    this.#messages.set(channel, list);
    return message;
  }

  /**
   * Send an event in an events_api envelope, as Socket Mode does. Returns the envelope ID and the event ID. A
   * delivery again gives the same event_id and a retry_attempt, in a new envelope.
   */
  event(event: Record<string, unknown>, options: { event_id?: string; event_time?: number; retry_attempt?: number } = {}): { envelope_id: string; event_id: string } {
    const event_id = options.event_id ?? `Ev0TEST${String(++this.#events).padStart(4, "0")}`;
    const envelope_id = this.#send("events_api", {
      token: VERIFICATION_TOKEN,
      team_id: BOT.team_id,
      context_team_id: BOT.team_id,
      api_app_id: BOT.app_id,
      event,
      type: "event_callback",
      event_id,
      event_time: options.event_time ?? Math.floor(Date.now() / 1000),
      authorizations: [{ enterprise_id: null, team_id: BOT.team_id, user_id: BOT.user_id, is_bot: true, is_enterprise_install: false }],
      is_ext_shared_channel: false,
      event_context: `4-${event_id}`,
    }, { retry_attempt: options.retry_attempt ?? 0, retry_reason: options.retry_attempt ? "timeout" : "" });
    return { envelope_id, event_id };
  }

  /** Send a slash command or an interaction (a button, a shortcut) in its envelope. Returns the envelope ID. */
  send(type: "slash_commands" | "interactive", payload: Record<string, unknown>): string {
    return this.#send(type, { token: VERIFICATION_TOKEN, ...payload }, {});
  }

  acked(envelopeId: string): boolean {
    return this.acks.some((ack) => ack.envelope_id === envelopeId);
  }

  async close(): Promise<void> {
    for (const client of this.#socketServer.clients) client.terminate();
    this.#socketServer.close();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #send(type: string, payload: Record<string, unknown>, extra: Record<string, unknown>): string {
    if (!this.#socket) throw new Error("no socket client");
    const envelope_id = `envelope-${++this.#envelopes}`;
    this.#socket.send(JSON.stringify({ envelope_id, payload, type, accepts_response_payload: type !== "events_api", ...extra }));
    return envelope_id;
  }

  #connected(socket: WebSocket): void {
    this.#socket = socket;
    this.connections++;
    socket.send(
      JSON.stringify({
        type: "hello",
        num_connections: 1,
        debug_info: { host: "applink-test", build_number: 1, approximate_connection_time: 18060 },
        connection_info: { app_id: BOT.app_id },
      }),
    );
    socket.on("message", (data) => {
      const ack = JSON.parse(String(data)) as { envelope_id: string; payload?: unknown };
      this.acks.push(ack);
    });
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = Buffer.concat(await request.toArray());
    const url = new URL(request.url ?? "/", this.origin);
    const header = request.headers.authorization;
    if (request.method === "GET" && url.pathname.startsWith("/files-pri/")) {
      this.fileRequests.push({ path: url.pathname, auth: header });
      const file = this.files.get(url.pathname);
      if (file && "redirect" in file) {
        response.writeHead(302, { location: file.redirect }).end();
      } else if (file && header === `Bearer ${BOT_TOKEN}`) {
        response.writeHead(200, { "content-type": file.type }).end(file.content);
      } else {
        // Without a token that may read the file, Slack answers with its sign-in page.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!DOCTYPE html><title>Slack</title>Sign in");
      }
      return;
    }
    const upload = /^\/upload\/(\w+)$/.exec(url.pathname);
    if (request.method === "POST" && upload) {
      const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData().catch(() => undefined);
      const value = form ? [...form.values()][0] : undefined;
      this.uploads.set(upload[1]!, typeof value === "string" ? value : value ? await value.text() : body.toString("utf8"));
      response.writeHead(200, { "content-type": "text/plain" }).end(`OK - ${body.length}`);
      return;
    }
    const method = /^\/api\/([\w.]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !method) {
      response.writeHead(404).end();
      return;
    }
    const call: Call = { method: method[1]!, params: {}, auth: header, files: {} };
    const type = request.headers["content-type"] ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      for (const [key, value] of form) {
        if (typeof value === "string") call.params[key] = value;
        else call.files[key] = { name: value.name, text: await value.text() };
      }
    } else if (type.startsWith("application/json")) {
      call.params = JSON.parse(body.toString("utf8"));
    } else {
      call.params = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    }
    const { token, ...params } = call.params;
    call.params = params;
    call.auth ??= token ? `Bearer ${token}` : undefined;
    this.calls.push(call);
    const result = this.#answer(call);
    // The Web API answers 200 also for an error, with ok false.
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
  }

  #answer(call: Call): Record<string, unknown> {
    const wanted = call.method === "apps.connections.open" ? APP_TOKEN : BOT_TOKEN;
    if (call.auth !== `Bearer ${wanted}`) return { ok: false, error: call.auth ? "invalid_auth" : "not_authed" };
    for (const route of this.#routes) {
      if (route.method !== call.method) continue;
      const answer = route.answer(call.params, call);
      if (answer) return { ok: true, ...answer };
    }
    return this.#own(call.method, call.params);
  }

  #own(method: string, params: Record<string, string>): Record<string, unknown> {
    switch (method) {
      case "apps.connections.open":
        return { ok: true, url: `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/link/?ticket=ticket-${this.connections + 1}` };
      case "auth.test":
        return { ok: true, url: "https://lab.slack.com/", team: "Lab", user: BOT.user, team_id: BOT.team_id, user_id: BOT.user_id, bot_id: BOT.bot_id, is_enterprise_install: false };
      case "users.info": {
        const user = this.users.get(params.user ?? "");
        return user ? { ok: true, user } : { ok: false, error: "user_not_found" };
      }
      case "conversations.info": {
        const channel = this.conversations.get(params.channel ?? "");
        return channel ? { ok: true, channel } : { ok: false, error: "channel_not_found" };
      }
      case "users.conversations": {
        const all = [...this.conversations.values()];
        return { ok: true, ...page(all, params, "channels") };
      }
      case "conversations.open": {
        const user = params.users ?? "";
        let dm = [...this.conversations.values()].find((conversation) => conversation.is_im && conversation.user === user);
        if (!dm) {
          dm = { id: `D${user.slice(1)}`, is_im: true, user, created: 1793080000, is_user_deleted: false };
          this.conversations.set(dm.id, dm);
        }
        return { ok: true, channel: { id: dm.id } };
      }
      case "conversations.history": {
        const list = this.#messages.get(params.channel ?? "");
        if (!list) return this.conversations.has(params.channel ?? "") ? { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: "" } } : { ok: false, error: "channel_not_found" };
        const shown = list
          .filter((message) => !message.thread_ts || message.thread_ts === message.ts || message.subtype === "thread_broadcast")
          .filter((message) => inRange(message.ts, params))
          .reverse()
          .map((message) => this.#shown(params.channel!, message, params));
        return { ok: true, ...page(shown, params, "messages"), pin_count: 0 };
      }
      case "conversations.replies": {
        const list = this.#messages.get(params.channel ?? "") ?? [];
        const target = list.find((message) => message.ts === params.ts);
        const root = target && list.find((message) => message.ts === (target.thread_ts ?? target.ts));
        if (!root) return { ok: false, error: "thread_not_found" };
        const replies = list.filter((message) => message.thread_ts === root.ts && message.ts !== root.ts && inRange(message.ts, params));
        const shown = [root, ...replies].map((message) => this.#shown(params.channel!, message, params));
        return { ok: true, ...page(shown, params, "messages") };
      }
      case "chat.postMessage": {
        const channel = params.channel ?? "";
        if (!this.conversations.has(channel)) return { ok: false, error: "channel_not_found" };
        if (params.markdown_text !== undefined && (params.text !== undefined || params.blocks !== undefined)) return { ok: false, error: "markdown_text_conflict" };
        const ts = `${Math.floor(Date.now() / 1000)}.${String(++this.#posts).padStart(6, "0")}`;
        const message = this.post(channel, {
          type: "message",
          user: BOT.user_id,
          bot_id: BOT.bot_id,
          app_id: BOT.app_id,
          text: params.markdown_text ?? params.text ?? "",
          ts,
          team: BOT.team_id,
          bot_profile: { id: BOT.bot_id, app_id: BOT.app_id, user_id: BOT.user_id, name: BOT.user, deleted: false, team_id: BOT.team_id },
          ...(params.thread_ts ? { thread_ts: params.thread_ts, parent_user_id: this.#messages.get(channel)?.find((root) => root.ts === params.thread_ts)?.user } : {}),
          ...(params.metadata ? { metadata: JSON.parse(params.metadata) } : {}),
        });
        return { ok: true, channel, ts, message };
      }
      case "chat.update": {
        const message = this.#messages.get(params.channel ?? "")?.find((candidate) => candidate.ts === params.ts);
        if (!message) return { ok: false, error: "message_not_found" };
        message.text = params.markdown_text ?? params.text ?? message.text;
        message.edited = { user: BOT.user_id, ts: `${Math.floor(Date.now() / 1000)}.000000` };
        return { ok: true, channel: params.channel, ts: params.ts, text: message.text, message };
      }
      case "reactions.add":
      case "reactions.remove": {
        const key = `${params.channel}/${params.timestamp}/${params.name}`;
        if (!this.#messages.get(params.channel ?? "")?.some((message) => message.ts === params.timestamp)) return { ok: false, error: "message_not_found" };
        if (method === "reactions.add") {
          if (this.reactions.has(key)) return { ok: false, error: "already_reacted" };
          this.reactions.add(key);
        } else {
          if (!this.reactions.delete(key)) return { ok: false, error: "no_reaction" };
        }
        return { ok: true };
      }
      case "files.getUploadURLExternal": {
        const id = `F0UPLOAD${++this.#uploads}`;
        return { ok: true, upload_url: `${this.origin}/upload/${id}`, file_id: id };
      }
      case "files.completeUploadExternal": {
        const files = JSON.parse(params.files ?? "[]") as { id: string; title?: string }[];
        return { ok: true, files: files.map((file) => ({ id: file.id, title: file.title ?? "", name: file.title ?? "" })) };
      }
      default:
        return { ok: false, error: "unknown_method" };
    }
  }

  /** A message as history shows it: a thread's first message with its replies counted, metadata only when asked. */
  #shown(channel: string, message: SlackMessage, params: Record<string, string>): SlackMessage {
    const { metadata, ...rest } = message;
    const shown: SlackMessage = { ...rest, ...(metadata && params.include_all_metadata === "true" ? { metadata } : {}) };
    const replies = (this.#messages.get(channel) ?? []).filter((reply) => reply.thread_ts === message.ts && reply.ts !== message.ts);
    if (replies.length && !message.thread_ts) shown.thread_ts = message.ts;
    if (replies.length) Object.assign(shown, { reply_count: replies.length, latest_reply: replies.at(-1)!.ts, reply_users: [...new Set(replies.map((reply) => reply.user))] });
    return shown;
  }
}

/** A page of a list, by the limit and the cursor, as Slack's cursor pagination gives it. */
function page<T>(all: T[], params: Record<string, string>, key: string): Record<string, unknown> {
  const start = Number(params.cursor || 0);
  const limit = Number(params.limit || 100);
  const end = start + limit;
  return { [key]: all.slice(start, end), has_more: end < all.length, response_metadata: { next_cursor: end < all.length ? String(end) : "" } };
}

/** Whether a ts is within oldest and latest, each left out unless inclusive. */
function inRange(ts: string, params: Record<string, string>): boolean {
  const inclusive = params.inclusive === "true" || params.inclusive === "1";
  if (params.oldest && (inclusive ? compareTs(ts, params.oldest) < 0 : compareTs(ts, params.oldest) <= 0)) return false;
  if (params.latest && (inclusive ? compareTs(ts, params.latest) > 0 : compareTs(ts, params.latest) >= 0)) return false;
  return true;
}

/** Slack timestamps compared exactly, as microseconds. */
export function compareTs(a: string, b: string): number {
  const micros = (ts: string) => {
    const [seconds, fraction = ""] = ts.split(".");
    return BigInt(seconds!) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  };
  const difference = micros(a) - micros(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
