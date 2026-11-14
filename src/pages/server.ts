import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Print } from "../gateway/config.ts";
import { DESKTOP_COOKIE } from "./desktop.ts";
import { desktopHeaders, pickLang, renderDesktopEnded, renderDesktopPage } from "./desktop-page.ts";
import { contentType, openFile, pageFolder, pathSegments, type Resolved } from "./files.ts";
import { renderFailed, renderNotFound, renderSecretExpired, renderSecretForm, renderSecretSaved, renderSecretUsed, SECRET_PAGE_HEADERS } from "./secret-page.ts";
import type { BotPages, OpenedLink } from "./store.ts";

// The page server's routes, on 127.0.0.1 only; people reach it through the public address:
//   GET  /p/<token>/<path>            a file of the link's page folder; a folder gives its index.html
//   GET  /p/<token>/__pots/info       {"page", "version"}
//   POST /p/<token>/__pots/submit     a page's answers: wakes the bot, once per submission ID
//   GET  /__pots/kit/<file>           the kit shipped with Pots, also at /p/<token>/__pots/kit/<file> for relative links
//   GET|POST /s/<token>               the password page, Pots's own, and its form
//   GET  /d/<token>/                  the desktop page, Pots's own; its script and noVNC are in the kit (kit/desktop/)
//   GET  /d/<token>/state             the desktop link's state, for its page
//   POST /d/<token>/start             Start: binds the link to this browser with a cookie
//   POST /d/<token>/end               {"how": "done" | "cannot", "note"}: the person hands the desktop back
//   WebSocket /d/<token>/ws           the VNC connection of a started link, from the browser that started it
// Every response says Referrer-Policy: no-referrer and X-Content-Type-Options: nosniff. The bot's pages get no CSP; the
// password page gets a sandbox of its own, and the desktop page a CSP that lets it load and talk only to this address.

/** The largest body of a page's answers or a password page's form. */
export const MAX_BODY = 64 * 1024;
/** The cache of a file: the browser may keep it, but asks again each time, and no shared cache keeps it. */
const FILE_CACHE = "private, no-cache";
/** The Server-Timing name of a page's version, as the kit reads it. */
export const VERSION_TIMING = "pots-version";
const TOKEN = "[A-Za-z0-9_-]{16,128}";
const PAGE_PATH = new RegExp(`^/p/(${TOKEN})(/.*)?$`);
const SECRET_PATH = new RegExp(`^/s/(${TOKEN})/?$`);
const DESKTOP_PATH = new RegExp(`^/d/(${TOKEN})(/.*)?$`);
const DESKTOP_SOCKET = new RegExp(`^/d/(${TOKEN})/ws$`);
/** The largest message a desktop page's browser sends; noVNC's are small, a pasted text the largest. */
const MAX_SOCKET_MESSAGE = 4 * 1024 * 1024;
/** Tokens found, by the bot they belong to, so a request asks one bot's database, not all. */
const CACHE_LIMIT = 10_000;

export interface PageServerHost {
  /** The bots that run now. */
  bots(): Iterable<BotPages>;
  /** Whether the public address is a Cloudflare Quick Tunnel now, for the warnings of the password and desktop pages. */
  quickTunnel(): boolean;
  /** The hosts people reach the page server at now (publicUrl's, the Quick Tunnel's), for the desktop page's origin checks. */
  publicHosts(): string[];
  /** The kit folder shipped with Pots. */
  readonly kitDir: string;
  readonly print: Print;
}

export class PageRequests {
  readonly #host: PageServerHost;
  readonly #owners = new Map<string, string>();
  readonly #sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_SOCKET_MESSAGE, clientTracking: false });

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
    const desktop = DESKTOP_PATH.exec(path);
    if (desktop) return this.#desktop(request, response, desktop[1]!, desktop[2], query);
    if (path.startsWith("/__pots/kit/")) return this.#kit(request, response, path.slice("/__pots/kit/".length));
    return text(response, 404, "Not found.");
  }

  /** A WebSocket: only a desktop page's connection, of a started link, from the browser that started it. */
  readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    this.#upgrade(request, socket, head).catch((error: unknown) => {
      this.#host.print("page connection failed", { error: error instanceof Error ? error.message : String(error) });
      socket.destroy();
    });
  };

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const token = DESKTOP_SOCKET.exec((request.url ?? "/").split("?")[0]!)?.[1];
    if (!token) return refuse("404 Not Found");
    if (!this.#sameSite(request)) return refuse("403 Forbidden");
    const bot = await this.#desktopOwner(token);
    if (!bot) return refuse("404 Not Found");
    const secret = cookie(request, DESKTOP_COOKIE);
    const view = await bot.desktop.view(token, secret);
    if (view?.state !== "started") return refuse("410 Gone");
    if (!view.mine) return refuse("403 Forbidden");
    this.#sockets.handleUpgrade(request, socket, head, (ws) => {
      bot.desktop.attach(token, secret, ws).catch((error: unknown) => {
        this.#host.print("desktop page connection failed", { link: view.id, error: error instanceof Error ? error.message : String(error) });
        ws.terminate();
      });
    });
  }

  /** The bot whose desktop link has this token. */
  async #desktopOwner(token: string): Promise<BotPages | undefined> {
    const bots = [...this.#host.bots()];
    const owner = this.#owners.get(token);
    const known = bots.find((bot) => bot.id === owner);
    for (const bot of known ? [known] : bots) {
      if (!(await bot.desktop.view(token))) continue;
      if (this.#owners.size >= CACHE_LIMIT) this.#owners.clear();
      this.#owners.set(token, bot.id);
      return bot;
    }
    return undefined;
  }

  /**
   * A request from the desktop page itself: its Origin is an address of this page server. A cross-site page cannot
   * set the headers that would pass, so a link that leaked into another site's page still cannot be started or used.
   */
  #sameSite(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    const forwarded = request.headers["x-forwarded-host"];
    const allowed = [request.headers.host, ...(Array.isArray(forwarded) ? forwarded : forwarded ? forwarded.split(",") : []), ...this.#host.publicHosts()];
    return allowed.some((each) => each?.trim().toLowerCase() === host.toLowerCase());
  }

  async #desktop(request: IncomingMessage, response: ServerResponse, token: string, rest: string | undefined, query: string): Promise<void> {
    const method = request.method ?? "GET";
    // Relative links in the page need the closing "/", as a page's.
    if (rest === undefined) return method === "GET" || method === "HEAD" ? redirect(response, `${token}/${query}`) : text(response, 404, "Not found.");
    const lang = pickLang(request.headers["accept-language"]);
    for (const [name, value] of Object.entries(desktopHeaders([request.headers.host, ...this.#host.publicHosts()]))) response.setHeader(name, value);
    const bot = await this.#desktopOwner(token);
    const secret = cookie(request, DESKTOP_COOKIE);
    if (rest === "/") {
      if (method !== "GET" && method !== "HEAD") return text(response, 405, "Use GET.");
      const view = bot ? await bot.desktop.view(token, secret) : undefined;
      if (!bot || !view) return html(response, 404, renderDesktopEnded("missing", "", lang));
      if (view.state === "open" || view.state === "started") {
        return html(response, 200, renderDesktopPage(view, bot.botName, { lang, quickTunnel: this.#host.quickTunnel(), remote: process.platform }));
      }
      return html(response, 410, renderDesktopEnded(view.state, bot.botName, lang));
    }
    if (rest === "/state") {
      if (method !== "GET") return text(response, 405, "Use GET.");
      const view = bot ? await bot.desktop.view(token, secret) : undefined;
      if (!view) return json(response, 404, { state: "missing" });
      return json(response, 200, {
        state: view.state,
        mine: view.mine,
        now: Date.now(),
        expires: view.expiresAt,
        started: view.startedAt,
        resizable: view.resizable,
        size: view.mine ? view.size : null,
      });
    }
    if (rest !== "/start" && rest !== "/end") return text(response, 404, "Not found.");
    if (method !== "POST") return text(response, 405, "Use POST.");
    if (!this.#sameSite(request)) return json(response, 403, { ok: false, error: "This request did not come from the desktop page." });
    if (!bot) return json(response, 404, { ok: false, code: "missing", error: "This link does not work." });
    if (rest === "/start") {
      request.resume();
      const result = await bot.desktop.start(token, secret);
      if (!result.ok) return json(response, result.status, { ok: false, code: result.code, error: result.error });
      const seconds = Math.max(60, Math.ceil((result.view.expiresAt - Date.now()) / 1000) + 60);
      // No Path: the browser takes the folder of this request's path, /d/<token>, with any path a proxy put in front.
      response.setHeader("set-cookie", `${DESKTOP_COOKIE}=${result.secret}; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secureRequest(request) ? "; Secure" : ""}`);
      return json(response, 200, { ok: true, now: Date.now(), expires: result.view.expiresAt, started: result.view.startedAt, resizable: result.view.resizable, size: result.view.size });
    }
    const body = await readBody(request);
    if (!body) return json(response, 400, { ok: false, error: `the body is over ${MAX_BODY / 1024} KB` }, true);
    let value: { how?: unknown; note?: unknown };
    try {
      value = JSON.parse(body.toString("utf8")) as { how?: unknown; note?: unknown };
    } catch {
      return json(response, 400, { ok: false, error: "the body is not JSON" });
    }
    if (value.how !== "done" && value.how !== "cannot") return json(response, 400, { ok: false, error: '"how" must be "done" or "cannot"' });
    const result = await bot.desktop.end(token, secret, value.how, typeof value.note === "string" ? value.note : "");
    if (!result.ok) return json(response, result.status, { ok: false, error: result.error });
    json(response, 200, result);
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

/** The value of a cookie the request sent, or undefined. */
function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

/** Whether the person's browser reached the page server over HTTPS, as the proxy in front says. */
function secureRequest(request: IncomingMessage): boolean {
  const proto = request.headers["x-forwarded-proto"];
  if ((Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim() === "https") return true;
  return /"scheme"\s*:\s*"https"/.test(String(request.headers["cf-visitor"] ?? ""));
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
