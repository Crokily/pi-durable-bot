import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Print } from "../gateway/config.ts";
import { contentType, openFile, pageFolder, pathSegments, type Resolved } from "./files.ts";
import { renderFailed, renderNotFound, renderSecretExpired, renderSecretForm, renderSecretSaved, renderSecretUsed, SECRET_PAGE_HEADERS } from "./secret-page.ts";
import type { BotPages, OpenedLink } from "./store.ts";

// The page server's routes, on 127.0.0.1 only; people reach it through the public address:
//   GET  /p/<token>/<path>            a file of the link's page folder; a folder gives its index.html
//   GET  /p/<token>/__pots/info       {"page", "version"}
//   POST /p/<token>/__pots/submit     a page's answers: wakes the bot, once per submission ID
//   GET  /__pots/kit/<file>           the kit shipped with Pots, also at /p/<token>/__pots/kit/<file> for relative links
//   GET|POST /s/<token>               the password page, Pots's own, and its form
// Every response says Referrer-Policy: no-referrer and X-Content-Type-Options: nosniff. The bot's pages get no CSP; the
// password page gets a sandbox of its own.

/** The largest body of a page's answers or a password page's form. */
export const MAX_BODY = 64 * 1024;
/** The cache of a file: the browser may keep it, but asks again each time, and no shared cache keeps it. */
const FILE_CACHE = "private, no-cache";
/** The Server-Timing name of a page's version, as the kit reads it. */
export const VERSION_TIMING = "pots-version";
const TOKEN = "[A-Za-z0-9_-]{16,128}";
const PAGE_PATH = new RegExp(`^/p/(${TOKEN})(/.*)?$`);
const SECRET_PATH = new RegExp(`^/s/(${TOKEN})/?$`);
/** Tokens found, by the bot they belong to, so a request asks one bot's database, not all. */
const CACHE_LIMIT = 10_000;

export interface PageServerHost {
  /** The bots that run now. */
  bots(): Iterable<BotPages>;
  /** Whether the public address is a Cloudflare Quick Tunnel now, for the password page's warning. */
  quickTunnel(): boolean;
  /** The kit folder shipped with Pots. */
  readonly kitDir: string;
  readonly print: Print;
}

export class PageRequests {
  readonly #host: PageServerHost;
  readonly #owners = new Map<string, string>();

  constructor(host: PageServerHost) {
    this.#host = host;
  }

  /** A bot stopped: forget which tokens were its. */
  forget(bot: string): void {
    for (const [token, owner] of this.#owners) if (owner === bot) this.#owners.delete(token);
  }

  readonly handle = (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    this.#route(request, response).catch((error: unknown) => {
      this.#host.print("page request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) text(response, 500, "Something went wrong.");
      else response.destroy();
    });
  };

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = request.url ?? "/";
    const queryAt = raw.indexOf("?");
    const path = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
    const query = queryAt >= 0 ? raw.slice(queryAt) : "";
    const method = request.method ?? "GET";

    const page = PAGE_PATH.exec(path);
    if (page) {
      const [, token, rest] = page;
      // Relative links in index.html need the closing "/". A relative Location keeps a path the proxy put in front.
      if (rest === undefined) return method === "GET" || method === "HEAD" ? redirect(response, `${token}/${query}`) : text(response, 404, "Not found.");
      const found = await this.#openLink(token!);
      if (!found) return text(response, 404, "Not found.");
      const sub = rest.slice(1);
      if (sub === "__pots/info") return method === "GET" ? this.#info(response, found.bot, found.link) : text(response, 405, "Use GET.");
      if (sub === "__pots/submit") return method === "POST" ? this.#submit(request, response, found.bot, found.link) : text(response, 405, "Use POST.");
      if (sub.startsWith("__pots/kit/")) return this.#kit(request, response, sub.slice("__pots/kit/".length));
      if (sub.startsWith("__pots/")) return text(response, 404, "Not found.");
      if (method !== "GET" && method !== "HEAD") return text(response, 405, "Use GET.");
      return this.#file(request, response, found.bot, found.link, sub, query);
    }
    const secret = SECRET_PATH.exec(path);
    if (secret) return this.#secret(request, response, secret[1]!);
    if (path.startsWith("/__pots/kit/")) return this.#kit(request, response, path.slice("/__pots/kit/".length));
    return text(response, 404, "Not found.");
  }

  /** The link with this token and its bot; it counts as opened now. */
  async #openLink(token: string): Promise<{ bot: BotPages; link: OpenedLink } | undefined> {
    const bots = [...this.#host.bots()];
    const owner = this.#owners.get(token);
    const known = bots.find((bot) => bot.id === owner);
    for (const bot of known ? [known] : bots) {
      const link = await bot.openLink(token);
      if (!link) continue;
      if (this.#owners.size >= CACHE_LIMIT) this.#owners.clear();
      this.#owners.set(token, bot.id);
      return { bot, link };
    }
    return undefined;
  }

  async #file(request: IncomingMessage, response: ServerResponse, bot: BotPages, link: OpenedLink, sub: string, query: string): Promise<void> {
    const folder = await pageFolder(bot.dir, link.page);
    const segments = pathSegments(sub);
    if (!folder || !segments) return text(response, 404, "Not found.");
    // An HTML file says the page's version in a header, bound to this response, which the kit reads: a version read
    // later could be of a page that changed meanwhile. The version is looked at before and after the open; when the
    // page changed between them, no header goes, and the kit asks __pots/info.
    const before = await bot.version(link.page);
    const resolved = await openFile(folder, segments, sub === "" || sub.endsWith("/"), true);
    if (!resolved) return text(response, 404, "Not found.");
    if (resolved.kind === "folder") return redirect(response, `${sub.split("/").pop()}/${query}`);
    if (!contentType(resolved.path).startsWith("text/html")) return sendFile(request, response, resolved);
    const after = await bot.version(link.page);
    await sendFile(request, response, resolved, before !== undefined && before === after ? after : undefined);
  }

  async #kit(request: IncomingMessage, response: ServerResponse, sub: string): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") return text(response, 405, "Use GET.");
    const root = await realpath(this.#host.kitDir).catch(() => undefined);
    const segments = pathSegments(sub);
    if (!root || !segments || segments.length === 0 || sub.endsWith("/")) return text(response, 404, "Not found.");
    const resolved = await openFile(root, segments, false, false);
    if (!resolved || resolved.kind !== "file") return text(response, 404, "Not found.");
    await sendFile(request, response, resolved);
  }

  async #info(response: ServerResponse, bot: BotPages, link: OpenedLink): Promise<void> {
    const version = await bot.version(link.page);
    if (version === undefined) return json(response, 404, { error: "the page is not there" });
    json(response, 200, { page: link.page, version });
  }

  async #submit(request: IncomingMessage, response: ServerResponse, bot: BotPages, link: OpenedLink): Promise<void> {
    const body = await readBody(request);
    if (!body) return json(response, 400, { ok: false, error: `the body is over ${MAX_BODY / 1024} KB` }, true);
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      return json(response, 400, { ok: false, error: "the body is not JSON" });
    }
    const problem = answerProblem(value);
    if (problem) return json(response, 400, { ok: false, error: problem });
    const { submission, version, answers } = value as { submission: string; version: string; answers: Record<string, unknown> };
    try {
      await bot.answer(link, submission, version, answers);
    } catch (error) {
      this.#host.print("page answer failed", { link: link.id, error: error instanceof Error ? error.message : String(error) });
      return json(response, 500, { ok: false, error: "the answer could not be kept; send it again" });
    }
    json(response, 200, { ok: true });
  }

  async #secret(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    for (const [name, value] of Object.entries(SECRET_PAGE_HEADERS)) response.setHeader(name, value);
    const method = request.method ?? "GET";
    let found: { bot: BotPages; view: NonNullable<Awaited<ReturnType<BotPages["secretLink"]>>> } | undefined;
    for (const bot of this.#host.bots()) {
      const view = await bot.secretLink(token);
      if (view) {
        found = { bot, view };
        break;
      }
    }
    if (!found) return html(response, 404, renderNotFound());
    const { bot, view } = found;
    if (method === "GET" || method === "HEAD") {
      if (view.state === "used") return html(response, 410, renderSecretUsed());
      if (view.state === "expired") return html(response, 410, renderSecretExpired());
      return html(response, 200, renderSecretForm(view, bot.botName, { quickTunnel: this.#host.quickTunnel(), now: Date.now() }));
    }
    if (method !== "POST") return html(response, 405, renderNotFound());
    const body = await readBody(request);
    if (!body) return html(response, 400, renderFailed(`The form is over ${MAX_BODY / 1024} KB.`), true);
    let result: Awaited<ReturnType<BotPages["submitSecret"]>>;
    try {
      result = await bot.submitSecret(token, new URLSearchParams(body.toString("utf8")));
    } catch (error) {
      this.#host.print("secret page failed", { link: view.id, error: error instanceof Error ? error.message : String(error) });
      return html(response, 500, renderFailed("Pots could not save the values on its computer."));
    }
    if (result === "saved") return html(response, 200, renderSecretSaved(view, bot.botName));
    if (result === "used") return html(response, 409, renderSecretUsed());
    if (result === "expired") return html(response, 410, renderSecretExpired());
    if (result === "missing") return html(response, 404, renderNotFound());
    html(response, 400, renderSecretForm(view, bot.botName, { quickTunnel: this.#host.quickTunnel(), now: Date.now(), problem: result.problem }));
  }
}

/** Why a page's answers are not as the kit sends them, or undefined. */
function answerProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the body must be a JSON object";
  const body = value as Record<string, unknown>;
  const line = (text: unknown, max: number) => typeof text === "string" && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text);
  if (!line(body.submission, 128) || body.submission === "") return '"submission" must be an ID of 1 to 128 characters, the same on a retry';
  if (!line(body.version, 64)) return '"version" must be the version from __pots/info that the person saw';
  if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) return '"answers" must be a JSON object';
  return undefined;
}

/** The request's body, or undefined when it is larger than MAX_BODY. */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown, close = false): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(close ? { connection: "close" } : {}) });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, status: number, body: string, close = false): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...(close ? { connection: "close" } : {}) });
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(301, { location, "cache-control": "no-store" });
  response.end();
}

/**
 * An open file, read from its descriptor only, with a validator so the browser can ask whether it changed, and one
 * byte range when asked (video needs it). The descriptor is closed when the file is sent, or at once when no body goes.
 * With a page version (an HTML file of a page): the version in a Server-Timing header, and no validator and no cache,
 * so the browser always gets the header with the file, never a kept copy with an older one.
 */
async function sendFile(request: IncomingMessage, response: ServerResponse, file: Extract<Resolved, { kind: "file" }>, version?: string): Promise<void> {
  const { size, handle } = file;
  const etag = `W/"${size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    "content-type": contentType(file.path),
    "cache-control": FILE_CACHE,
    etag,
    "last-modified": new Date(file.mtimeMs).toUTCString(),
    "accept-ranges": "bytes",
  };
  const html = contentType(file.path).startsWith("text/html");
  if (html) {
    headers["cache-control"] = "no-store";
    delete headers.etag;
    delete headers["last-modified"];
    if (version !== undefined) headers["server-timing"] = `${VERSION_TIMING};desc="${version}"`;
  }
  const done = async (status: number, extra: Record<string, string | number> = {}) => {
    await handle.close().catch(() => {});
    response.writeHead(status, { ...headers, ...extra });
    response.end();
  };
  if (!html && request.headers["if-none-match"] === etag) return done(304);
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) return done(416, { "content-range": `bytes */${size}` });
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  if (request.method === "HEAD" || size === 0) return done(status, { "content-length": size === 0 ? 0 : end - start + 1 });
  headers["content-length"] = end - start + 1;
  response.writeHead(status, headers);
  const stream = handle.createReadStream({ start, end, autoClose: true });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
