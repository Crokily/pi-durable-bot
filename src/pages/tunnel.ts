import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Print } from "../gateway/config.ts";

// A Cloudflare Quick Tunnel to the page server: cloudflared runs while the gateway runs, starts again with a growing pause
// when it ends, and its https://<random>.trycloudflare.com address is read from its output, also when it changes.

const ADDRESS = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/;
/** cloudflared says this once a connection to Cloudflare works; the address is reachable from then on. */
const CONNECTED = /Registered tunnel connection/;
/** Lines of cloudflared's output kept, for a failure's message. */
const TAIL_LINES = 8;

export interface TunnelOptions {
  /** The page server, such as http://127.0.0.1:41234. */
  readonly target: string;
  /** POTS_HOME: the tunnel's own config file and process ID file go there. */
  readonly home: string;
  /** The command that runs cloudflared, with any leading arguments; it may download cloudflared first. */
  readonly program: () => Promise<readonly string[]>;
  readonly print: Print;
  /** The first pause before a start again, the longest, and how long a run must last to start again from the first. */
  readonly backoff?: { readonly firstMs: number; readonly maxMs: number; readonly resetAfterMs: number };
  /** How long ensure() waits for the address. */
  readonly startTimeoutMs?: number;
  /** Resolves when a new address can be given out; by default once public DNS has its name. Tests give their own. */
  readonly ready?: (address: string) => Promise<void>;
}

export type TunnelState = "off" | "starting" | "ready" | "waiting";

const DEFAULT_BACKOFF = { firstMs: 1_000, maxMs: 60_000, resetAfterMs: 60_000 };
/** How long a new address may wait for public DNS before it is given out anyway. */
const DNS_WAIT_MS = 20_000;

/**
 * A new Quick Tunnel's name comes into DNS about a second after cloudflared's first connection. A phone that looks it up
 * before then gets "not found" and keeps that answer for a minute, so the address is given out once Cloudflare's and
 * Google's resolvers have it: asked directly, not through this computer's cache, which would keep the "not found" too.
 */
async function inPublicDns(address: string): Promise<void> {
  const host = new URL(address).hostname;
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const deadline = Date.now() + DNS_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await resolver.resolve4(host);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * cloudflared reads ~/.cloudflared/config.yml (and /etc/cloudflared/…) when it is given no config file, and that
 * file's ingress rules take the place of --url: a Quick Tunnel would then show another service. So it gets a config
 * file of its own, which says nothing but what the flags say.
 */
const CONFIG = "# Written by Pots for its Cloudflare Quick Tunnel, so cloudflared reads no other config file.\nno-autoupdate: true\n";

export class QuickTunnel {
  readonly #options: TunnelOptions;
  readonly #backoff: { firstMs: number; maxMs: number; resetAfterMs: number };
  readonly #configFile: string;
  readonly #pidFile: string;
  #state: TunnelState = "off";
  #address: string | undefined;
  /** An address cloudflared gave before its first connection. */
  #pending: string | undefined;
  /** The pending address whose name is being looked for in DNS. */
  #confirming: string | undefined;
  #child: ChildProcess | undefined;
  #exited: Promise<void> = Promise.resolve();
  #supervising: Promise<void> | undefined;
  #stopped = false;
  #error: string | undefined;
  #tail: string[] = [];
  #waiters = new Set<{ resolve: (address: string) => void; reject: (error: Error) => void }>();
  #endPause: (() => void) | undefined;

  constructor(options: TunnelOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#configFile = join(options.home, "cloudflared.yml");
    this.#pidFile = join(options.home, "cloudflared.pid");
  }

  /** The address while a connection works. */
  get address(): string | undefined {
    return this.#address;
  }

  status(): { state: TunnelState; address?: string; error?: string } {
    return { state: this.#state, ...(this.#address ? { address: this.#address } : {}), ...(this.#error ? { error: this.#error } : {}) };
  }

  /** Start the tunnel if it does not run, and wait until it has an address that works. */
  ensure(): Promise<string> {
    if (this.#stopped) return Promise.reject(new Error("the gateway is stopping"));
    if (this.#address) return Promise.resolve(this.#address);
    const waiting = new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (address: string) => {
          clearTimeout(timer);
          resolve(address);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timeout = this.#options.startTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        const output = this.#tail.length > 0 ? `; cloudflared said:\n${this.#tail.join("\n")}` : "";
        reject(new Error(`the Cloudflare Quick Tunnel had no address after ${Math.round(timeout / 1000)} seconds${this.#error ? ` (${this.#error})` : ""}${output}`));
      }, timeout);
      this.#waiters.add(waiter);
    });
    this.#supervising ??= this.#supervise().finally(() => (this.#supervising = undefined));
    return waiting;
  }

  /** Stop cloudflared, and do not start it again. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#endPause?.();
    for (const waiter of this.#waiters) waiter.reject(new Error("the gateway is stopping"));
    this.#waiters.clear();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const killed = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await this.#exited;
      clearTimeout(killed);
    }
    await this.#supervising;
    this.#state = "off";
  }

  async #supervise(): Promise<void> {
    let pause = this.#backoff.firstMs;
    while (!this.#stopped) {
      let command: readonly string[];
      try {
        command = await this.#options.program();
      } catch (error) {
        // No cloudflared, and no download: the next ensure() tries again.
        this.#fail(error instanceof Error ? error.message : String(error));
        this.#state = "off";
        return;
      }
      if (this.#stopped) return;
      const started = Date.now();
      const code = await this.#run(command);
      this.#address = undefined;
      this.#pending = undefined;
      if (this.#stopped) return;
      if (Date.now() - started >= this.#backoff.resetAfterMs) pause = this.#backoff.firstMs;
      this.#error = `cloudflared ended (${code}); starting it again`;
      this.#options.print("quick tunnel ended", { exit: code, again: pause });
      this.#state = "waiting";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pause);
        this.#endPause = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#endPause = undefined;
      pause = Math.min(pause * 2, this.#backoff.maxMs);
    }
  }

  /** Run cloudflared once, until it ends. Resolves with how it ended. */
  #run(command: readonly string[]): Promise<string> {
    this.#state = "starting";
    this.#tail = [];
    stopLeftoverTunnel(this.#options.home, this.#options.print, this.#child?.pid);
    writeFileSync(this.#configFile, CONFIG);
    const args = [...command.slice(1), "tunnel", "--no-autoupdate", "--config", this.#configFile, "--url", this.#options.target, "--metrics", "127.0.0.1:0"];
    // The person's own tunnel settings in the environment (TUNNEL_TOKEN, TUNNEL_URL, …) are not for this one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TUNNEL_")));
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    } catch (error) {
      return Promise.resolve(`could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#child = child;
    const ended = new Promise<string>((resolve) => {
      child.once("error", (error) => resolve(`could not start: ${error.message}`));
      child.once("close", (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}`));
    });
    this.#exited = ended.then(() => undefined);
    if (child.pid !== undefined) writeFileSync(this.#pidFile, `${child.pid}\n${this.#configFile}\n`);
    for (const stream of [child.stdout!, child.stderr!]) createInterface({ input: stream }).on("line", (line) => this.#line(line));
    return ended.then((how) => {
      this.#child = undefined;
      try {
        if (readFileSync(this.#pidFile, "utf8").startsWith(`${child.pid}\n`)) unlinkSync(this.#pidFile);
      } catch {
        // gone already
      }
      return how;
    });
  }

  #line(line: string): void {
    this.#tail.push(line);
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    const address = ADDRESS.exec(line)?.[0];
    if (address) {
      if (this.#address && address !== this.#address) {
        this.#address = address;
        this.#options.print("quick tunnel address changed", { address });
      } else if (!this.#address) this.#pending = address;
    }
    if (CONNECTED.test(line) && this.#pending && !this.#address && this.#confirming !== this.#pending) {
      const pending = this.#pending;
      this.#confirming = pending;
      void (this.#options.ready ?? inPublicDns)(pending)
        .catch(() => {})
        .then(() => {
          if (this.#confirming === pending) this.#confirming = undefined;
          // cloudflared ended, or another address came, while the name was looked for.
          if (this.#stopped || this.#pending !== pending || this.#address) return;
          this.#address = pending;
          this.#pending = undefined;
          this.#state = "ready";
          this.#error = undefined;
          this.#options.print("quick tunnel ready", { address: pending });
          for (const waiter of this.#waiters) waiter.resolve(pending);
          this.#waiters.clear();
        });
    }
  }

  #fail(error: string): void {
    this.#error = error;
    this.#options.print("quick tunnel failed", { error });
    for (const waiter of this.#waiters) waiter.reject(new Error(error));
    this.#waiters.clear();
  }
}

/**
 * A cloudflared that an earlier gateway of this home started and could not stop, as when it crashed, keeps a public
 * entry to the page server open: the port stays the same, so its old address works again. Stop it, when the process of
 * the ID file is still a cloudflared with this home's config file; the gateway does this at every start, also with a
 * publicUrl, which needs no tunnel.
 */
export function stopLeftoverTunnel(home: string, print: Print, except?: number): void {
  const pidFile = join(home, "cloudflared.pid");
  if (!existsSync(pidFile)) return;
  try {
    const [pidText, config] = readFileSync(pidFile, "utf8").split("\n");
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0 && config && pid !== except && pid !== process.pid) {
      const command =
        process.platform === "win32"
          ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5_000, windowsHide: true })
          : execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
      const ours = process.platform === "win32" ? /cloudflared/i.test(command) : command.includes(config) && command.includes("cloudflared");
      if (ours) {
        process.kill(pid);
        print("stopped a quick tunnel left from before", { pid });
      }
    }
  } catch {
    // not running, or not ours
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // gone already
  }
}
