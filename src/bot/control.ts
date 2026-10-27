import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";

export type Route = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * The bot's local command line endpoint: HTTP on a Unix socket in the bot folder, readable only by its owner.
 * The `pb` command talks to it. Tokens stay in this process.
 */
export class ControlServer {
  readonly #path: string;
  readonly #routes: Record<string, Route>;
  #server?: Server;

  constructor(path: string, routes: Record<string, Route>) {
    this.#path = path;
    this.#routes = routes;
  }

  async start(): Promise<void> {
    if (existsSync(this.#path)) unlinkSync(this.#path);
    const server = createServer((request, response) => {
      void (async () => {
        let status = 200;
        let payload: unknown;
        try {
          const route = this.#routes[`${request.method} ${request.url}`];
          if (!route) {
            status = 404;
            throw new Error(`unknown command ${request.method} ${request.url}`);
          }
          payload = { ok: true, result: (await route(await readJson(request))) ?? null };
        } catch (error) {
          if (status === 200) status = 400;
          payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#path, () => resolve());
    });
    await chmod(this.#path, 0o600);
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.#path)) unlinkSync(this.#path);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
}
