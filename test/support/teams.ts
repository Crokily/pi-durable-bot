import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake got. path is as sent, with its escapes, without the query. */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth: string | undefined;
}

/** An answer with a status other than 200, and headers, for example new Reply(429, {}, { "retry-after": "0" }). */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, body?: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

type Answer = (request: FakeRequest, match: RegExpExecArray) => unknown;

/**
 * Microsoft's services for the Teams channel, on this computer, in one HTTP server: Teams' Bot Connector under
 * /teams (the service URL), Microsoft Graph under /graph/v1.0, and a file host under /files. Tests give answers per
 * route; a route with no answer gets 404, an answer of undefined is 200 with no body.
 */
export class FakeTeams {
  readonly requests: FakeRequest[] = [];
  readonly #routes: { method: string; path: RegExp; answer: Answer }[] = [];
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeTeams> {
    let fake: FakeTeams | undefined;
    const server = createServer((request, response) => void fake!.#http(request, response));
    fake = new FakeTeams(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  get serviceUrl(): string {
    return `${this.origin}/teams`;
  }

  get graph(): string {
    return `${this.origin}/graph/v1.0`;
  }

  /** Answer requests whose method and path (anchored, with its escapes) match. A later route wins over an earlier one. */
  route(method: string, path: string, answer: Answer): void {
    this.#routes.unshift({ method, path: new RegExp(`^${path}$`), answer });
  }

  requested(method: string, path: string): FakeRequest[] {
    const pattern = new RegExp(`^${path}$`);
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const url = new URL(request.url ?? "/", this.origin);
    const recorded: FakeRequest = {
      method: request.method ?? "GET",
      path: (request.url ?? "/").split("?")[0]!,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
      auth: request.headers.authorization,
    };
    this.requests.push(recorded);
    let answer: unknown = new Reply(404, { error: { code: "NotFound", message: "no such route" } });
    for (const route of this.#routes) {
      const match = route.method === recorded.method ? route.path.exec(recorded.path) : null;
      if (match) {
        answer = route.answer(recorded, match);
        break;
      }
    }
    const reply = answer instanceof Reply ? answer : new Reply(200, answer);
    if (reply.body === undefined) {
      response.writeHead(reply.status, reply.headers).end();
      return;
    }
    if (reply.body instanceof Uint8Array) {
      response.writeHead(reply.status, { "content-type": "application/octet-stream", ...reply.headers }).end(reply.body);
      return;
    }
    response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers }).end(JSON.stringify(reply.body));
  }
}
