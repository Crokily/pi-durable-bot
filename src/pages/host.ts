import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Print } from "../gateway/config.ts";
import { ensureCloudflared } from "./cloudflared.ts";
import { readSettings, writeSetting } from "./settings.ts";
import { PageRequests } from "./server.ts";
import { type BotPages, PAGE_DAYS } from "./store.ts";
import { QuickTunnel, stopLeftoverTunnel, type TunnelOptions } from "./tunnel.ts";

// The page server of a gateway: one per POTS_HOME, for every bot. Its port is chosen once and kept in settings.json; its
// public address is settings.json's publicUrl, or else a Cloudflare Quick Tunnel that starts at the first link.

/** kit/ of this package, next to src/ or dist/. */
const KIT_DIR = fileURLToPath(new URL("../../kit/", import.meta.url));
/** How often the server tries its port again while it cannot listen. */
const RETRY_MS = 30_000;
const DAY_MS = 86_400_000;

export type Via = "public-url" | "quick-tunnel";

/** The facts the agent passes on when a link goes through a Quick Tunnel. */
export const QUICK_TUNNEL_NOTE =
  "This link goes through a Cloudflare Quick Tunnel: its address changes when Pots restarts, Cloudflare can see the page's content, and Cloudflare says Quick Tunnels are for testing and development.";
export const QUICK_TUNNEL_SECRET_NOTE =
  "This link goes through a Cloudflare Quick Tunnel: its address changes when Pots restarts, Cloudflare can see what is typed on the page, and Cloudflare says Quick Tunnels are for testing and development.";

export interface PageHostOptions {
  /** POTS_HOME. */
  readonly home: string;
  readonly settingsFile: string;
  /** POTS_HOME/bin: Pots's own cloudflared. */
  readonly binDir: string;
  readonly print: Print;
  readonly kitDir?: string;
  /** The command that runs cloudflared; tests give a fake one. */
  readonly cloudflared?: () => Promise<readonly string[]>;
  readonly tunnel?: Pick<TunnelOptions, "backoff" | "startTimeoutMs" | "ready">;
}

export interface PageServerStatus {
  port?: number;
  listening: boolean;
  /** Why the server does not listen, or why settings.json cannot be used. */
  problem?: string;
  via?: Via;
  address?: string;
  tunnel?: ReturnType<QuickTunnel["status"]>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export class PageHost {
  readonly #options: PageHostOptions;
  readonly #bots = new Map<string, BotPages>();
  readonly #requests: PageRequests;
  #server: Server | undefined;
  #port: number | undefined;
  #problem: string | undefined;
  #retry: ReturnType<typeof setInterval> | undefined;
  #tunnel: QuickTunnel | undefined;
  #stopped = false;

  constructor(options: PageHostOptions) {
    this.#options = options;
    this.#requests = new PageRequests({
      bots: () => this.#bots.values(),
      quickTunnel: () => this.#quickTunnel(),
      kitDir: options.kitDir ?? KIT_DIR,
      print: options.print,
    });
  }

  get port(): number | undefined {
    return this.#port;
  }

  /** Listen on the kept port, or choose one and keep it. A port that is taken is reported, and tried again now and then. */
  async start(): Promise<void> {
    // A tunnel a crashed gateway left would make the kept port public again, at its old address.
    stopLeftoverTunnel(this.#options.home, this.#options.print);
    await this.#listen();
    if (!this.#server) this.#retry = setInterval(() => void this.#listen(), RETRY_MS).unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#retry);
    await this.#tunnel?.stop();
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  register(bot: BotPages): void {
    this.#bots.set(bot.id, bot);
  }

  unregister(id: string): void {
    this.#bots.delete(id);
    this.#requests.forget(id);
  }

  async #listen(): Promise<void> {
    if (this.#server || this.#stopped) return;
    const file = this.#options.settingsFile;
    let port: number | undefined;
    try {
      port = readSettings(file).pagePort;
    } catch (error) {
      return this.#report(error instanceof Error ? error.message : String(error));
    }
    const server = createServer(this.#requests.handle);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port ?? 0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return this.#report(
        code === "EADDRINUSE" || code === "EACCES"
          ? `port ${port} (pagePort in ${file}) is taken by another program, so pages are not served; free it, or set another pagePort there and restart Pots (a Funnel or proxy that points at the old port must change too)`
          : `the page server could not listen on 127.0.0.1:${port ?? 0}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const chosen = (server.address() as { port: number }).port;
    if (port === undefined) {
      try {
        await writeSetting("pagePort", chosen, file);
      } catch (error) {
        server.close();
        return this.#report(`could not keep the page server's port in ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#server = server;
    this.#port = chosen;
    this.#problem = undefined;
    clearInterval(this.#retry);
    this.#options.print("page server started", { port: chosen });
  }

  #report(problem: string): void {
    if (this.#problem !== problem) this.#options.print("page server not running", { problem });
    this.#problem = problem;
  }

  #quickTunnel(): boolean {
    try {
      return readSettings(this.#options.settingsFile).publicUrl === undefined;
    } catch {
      return true;
    }
  }

  /**
   * The public address links use now. With publicUrl in settings.json, that one, and a Quick Tunnel that still runs is
   * stopped. Without it, the Quick Tunnel's address; start: start it if it does not run and wait for its address.
   */
  async #address(start: boolean): Promise<{ base?: string; via: Via }> {
    const settings = readSettings(this.#options.settingsFile);
    if (settings.publicUrl) {
      if (this.#tunnel) {
        const tunnel = this.#tunnel;
        this.#tunnel = undefined;
        await tunnel.stop();
        this.#options.print("quick tunnel stopped: settings.json has a publicUrl");
      }
      return { base: settings.publicUrl, via: "public-url" };
    }
    if (!start) return { ...(this.#tunnel?.address ? { base: this.#tunnel.address } : {}), via: "quick-tunnel" };
    if (this.#port === undefined) throw new Error(`the page server is not running: ${this.#problem ?? "it is starting"}`);
    this.#tunnel ??= new QuickTunnel({
      target: `http://127.0.0.1:${this.#port}`,
      home: this.#options.home,
      program: this.#options.cloudflared ?? (async () => [await ensureCloudflared(this.#options.binDir, { print: this.#options.print })]),
      print: this.#options.print,
      ...this.#options.tunnel,
    });
    return { base: await this.#tunnel.ensure(), via: "quick-tunnel" };
  }

  #ready(): void {
    if (this.#port === undefined) throw new Error(`the page server is not running: ${this.#problem ?? "it is starting"}`);
  }

  /** pots page link: a new link to a page, written before it is given out. */
  async link(bot: BotPages, page: string, person?: string): Promise<{ link: string; url: string; via: Via; note?: string }> {
    this.#ready();
    const made = await bot.createLink(page, person);
    let address: { base?: string; via: Via };
    try {
      address = await this.#address(true);
    } catch (error) {
      await bot.revoke(made.id);
      throw error;
    }
    return { link: made.id, url: `${address.base}/p/${made.token}/`, via: address.via, ...(address.via === "quick-tunnel" ? { note: QUICK_TUNNEL_NOTE } : {}) };
  }

  /** pots page secret: a password link for one submission, open for an hour. */
  async secret(
    bot: BotPages,
    input: { file: string; keys: readonly string[]; text?: string; person?: string },
  ): Promise<{ link: string; url: string; expires: string; via: Via; note?: string }> {
    this.#ready();
    const made = await bot.createSecretLink(input);
    let address: { base?: string; via: Via };
    try {
      address = await this.#address(true);
    } catch (error) {
      await bot.revoke(made.id);
      throw error;
    }
    return {
      link: made.id,
      url: `${address.base}/s/${made.token}`,
      expires: new Date(made.expiresAt).toISOString(),
      via: address.via,
      ...(address.via === "quick-tunnel" ? { note: QUICK_TUNNEL_SECRET_NOTE } : {}),
    };
  }

  /** pots page unlink: by link ID or by URL. */
  async unlink(bot: BotPages, link: string): Promise<string> {
    const token = /\/(?:p|s)\/([A-Za-z0-9_-]{16,128})(?:\/|$)/.exec(link)?.[1];
    const revoked = await bot.revoke(token ?? link.trim());
    if (!revoked) throw new Error(`there is no link ${JSON.stringify(link)} of this bot (pots page list shows them)`);
    return `Unlinked ${revoked}.`;
  }

  /** pots page list: the bot's pages and links, with their URLs at the address links use now. */
  async list(bot: BotPages): Promise<unknown> {
    const listing = await bot.list();
    let address: { base?: string; via: Via } = { via: "quick-tunnel" };
    let problem: string | undefined;
    try {
      address = await this.#address(false);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    const url = (path: string) => (address.base ? `${address.base}${path}` : null);
    return {
      via: address.via,
      address: address.base ?? null,
      ...(address.base ? {} : { addressNote: problem ?? "no Quick Tunnel runs now; the next pots page link or pots page secret starts one, and these links work again at its address" }),
      pages: listing.pages.map((page) => ({
        page: page.page,
        kept: page.kept,
        version: page.version,
        lastOpened: iso(page.lastOpened),
        lastChanged: iso(page.lastChanged),
        deleteAfter: page.kept || page.lastChanged === null ? null : iso(Math.max(page.lastOpened ?? 0, page.lastChanged) + PAGE_DAYS * DAY_MS),
        links: page.links.map((link) => ({ link: link.link, url: url(`/p/${link.token}/`), for: link.for, created: iso(link.created) })),
      })),
      secretLinks: listing.secretLinks.map((link) => ({
        link: link.link,
        url: url(`/s/${link.token}`),
        file: link.file,
        keys: link.keys,
        for: link.for,
        created: iso(link.created),
        expires: iso(link.expires),
        state: link.state,
      })),
    };
  }

  /** For pots status. */
  status(): PageServerStatus {
    let via: Via | undefined;
    let address: string | undefined;
    let problem = this.#problem;
    try {
      const publicUrl = readSettings(this.#options.settingsFile).publicUrl;
      via = publicUrl ? "public-url" : "quick-tunnel";
      address = publicUrl ?? this.#tunnel?.address;
    } catch (error) {
      problem ??= error instanceof Error ? error.message : String(error);
    }
    return {
      ...(this.#port === undefined ? {} : { port: this.#port }),
      listening: this.#server !== undefined,
      ...(problem ? { problem } : {}),
      ...(via ? { via } : {}),
      ...(address ? { address } : {}),
      ...(this.#tunnel ? { tunnel: this.#tunnel.status() } : {}),
    };
  }
}

/** One line for pots status. */
export function describePageServer(status: PageServerStatus | undefined, keptPort: number | undefined): string {
  if (!status) return `pages: not running${keptPort === undefined ? "" : ` (port ${keptPort})`}`;
  if (!status.listening) return `pages: not served: ${status.problem ?? "starting"}`;
  const port = `port ${status.port}`;
  if (status.problem) return `pages: ${port}; ${status.problem}`;
  if (status.address) return `pages: ${port}, ${status.address} (${status.via})`;
  const tunnel = status.tunnel?.error ? `; ${status.tunnel.error}` : "";
  return `pages: ${port}, no public address yet (quick-tunnel: it starts at the first pots page link${tunnel})`;
}
