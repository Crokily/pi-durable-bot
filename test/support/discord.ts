import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/** A request the fake Discord got. path is as sent, after /api/v10, with its escapes. */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Parsed JSON, or the raw text of another body (a multipart upload). */
  body: any;
  auth: string | undefined;
  type: string | undefined;
}

/** An answer with a status other than 200, for example new Reply(404, { message: "Unknown Channel", code: 10003 }). */
export class Reply {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    this.status = status;
    this.body = body;
  }
}

type Answer = (request: FakeRequest, match: RegExpExecArray) => unknown;

/**
 * A small Discord on this computer: the REST API under /api/v10, and a gateway WebSocket that says hello, takes an
 * identify, answers heartbeats and sends READY. Tests give REST answers per route and send gateway dispatches.
 * A route with no answer gets 404. An answer of undefined is 204.
 */
export class FakeDiscord {
  readonly requests: FakeRequest[] = [];
  /** How many times a client identified, that is, started a session. */
  identifies = 0;
  /** The servers READY lists. */
  guilds: string[] = [];
  /** Runs after each READY, for example to send GUILD_CREATE. */
  onReady?: () => void;
  readonly #routes: { method: string; path: RegExp; answer: Answer }[] = [];
  readonly #server: Server;
  readonly #gateway: WebSocketServer;
  #socket?: WebSocket;
  #sequence = 0;

  private constructor(server: Server) {
    this.#server = server;
    this.#gateway = new WebSocketServer({ server, path: "/gateway" });
    this.#gateway.on("connection", (socket) => this.#connected(socket));
  }

  static async start(): Promise<FakeDiscord> {
    let fake: FakeDiscord | undefined;
    const server = createServer((request, response) => void fake!.#http(request, response));
    fake = new FakeDiscord(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get #origin(): string {
    return `127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** The REST base URL, as discord.js's "api" option takes it. */
  get api(): string {
    return `http://${this.#origin}/api`;
  }

  /** Answer requests whose method and path (anchored, after /api/v10) match. A later route wins over an earlier one. */
  route(method: string, path: string, answer: Answer): void {
    this.#routes.unshift({ method, path: new RegExp(`^${path}$`), answer });
  }

  requested(method: string, path: string): FakeRequest[] {
    const pattern = new RegExp(`^${path}$`);
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  /** Send a gateway dispatch to the connected client. */
  dispatch(t: string, d: unknown): void {
    this.#send({ op: 0, t, s: ++this.#sequence, d });
  }

  /** Tell the client its session is gone, so it starts a new one. */
  invalidSession(): void {
    this.#send({ op: 9, d: false });
  }

  async close(): Promise<void> {
    for (const client of this.#gateway.clients) client.terminate();
    this.#gateway.close();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #send(payload: unknown): void {
    if (!this.#socket) throw new Error("no gateway client");
    this.#socket.send(JSON.stringify(payload));
  }

  #connected(socket: WebSocket): void {
    this.#socket = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));
    socket.on("message", (data) => {
      const payload = JSON.parse(String(data)) as { op: number; d: any };
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op !== 2) return;
      this.identifies++;
      this.#sequence = 0;
      this.dispatch("READY", {
        v: 10,
        user: { id: "100", username: "pots", global_name: "Pots", discriminator: "0", avatar: null, bot: true },
        guilds: this.guilds.map((id) => ({ id, unavailable: true })),
        session_id: `session-${this.identifies}`,
        resume_gateway_url: `ws://${this.#origin}/gateway`,
        application: { id: "100", flags: 0 },
        shard: [0, 1],
      });
      this.onReady?.();
    });
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const url = new URL(request.url ?? "/", `http://${this.#origin}`);
    const raw = (request.url ?? "/").split("?")[0]!.replace(/^\/api\/v10/, "");
    const type = request.headers["content-type"];
    const recorded: FakeRequest = {
      method: request.method ?? "GET",
      path: raw,
      query: url.searchParams,
      body: type?.startsWith("application/json") && text ? JSON.parse(text) : text,
      auth: request.headers.authorization,
      type,
    };
    this.requests.push(recorded);
    let answer: unknown = new Reply(404, { message: "404: Not Found", code: 0 });
    if (recorded.method === "GET" && raw === "/gateway/bot") {
      answer = { url: `ws://${this.#origin}/gateway`, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } };
    } else {
      for (const route of this.#routes) {
        const match = route.method === recorded.method ? route.path.exec(raw) : null;
        if (match) {
          answer = route.answer(recorded, match);
          break;
        }
      }
    }
    const reply = answer instanceof Reply ? answer : answer === undefined ? new Reply(204) : new Reply(200, answer);
    if (reply.body === undefined) {
      response.writeHead(reply.status).end();
      return;
    }
    response.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  }
}
