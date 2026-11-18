import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Headless Chrome for the tests of the page kit in a browser: one browser and one small web server for a test file.
// Each page is a new tab at a fixed viewport width, driven over the DevTools protocol. Where no Chrome or Chromium is
// installed, chromePath() is undefined and those tests are skipped.

const NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WINDOWS = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];

/**
 * The environment for Chrome, and for the screenshot script that starts it. On Windows, Chrome with the tests' empty
 * home folder as USERPROFILE runs but never opens its DevTools port, so it gets the user's own; it keeps its profile in
 * --user-data-dir all the same.
 */
export function chromeEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return process.env;
  const home = userInfo().homedir;
  return { ...process.env, HOME: home, USERPROFILE: home };
}

export function chromePath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  if (process.platform === "win32") return WINDOWS.find((p) => existsSync(p));
  if (process.platform === "darwin" && existsSync(MAC)) return MAC;
  return NAMES.find((n) => spawnSync("which", [n]).status === 0);
}

const kitDir = new URL("../../kit/", import.meta.url);

export interface PageOptions {
  width?: number;
  height?: number;
  /** Media features, such as { "prefers-reduced-motion": "reduce" }. */
  media?: Record<string, string>;
  /** A script that runs in the page before any of its own. */
  before?: string;
}

export interface Page {
  /** Evaluates an expression, awaits it, and returns its value; an exception or a timeout fails. */
  eval<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  /** Types a key in the focused element. */
  key(key: string, code: string, keyCode: number): Promise<void>;
  close(): Promise<void>;
}

export interface Chrome {
  /** Serves the HTML at /p/<n>/ and opens it; the kit is at ../../__pots/kit/. */
  open(html: string, options?: PageOptions): Promise<Page>;
  /** The address of the web server, for other browsers. */
  serve(html: string): string;
  stop(): Promise<void>;
}

export async function startChrome(path: string): Promise<Chrome> {
  const pages = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const kit = url.pathname.match(/^\/__pots\/kit\/([\w.-]+)$/);
    const body = kit ? readFileSync(new URL(kit[1], kitDir)) : pages.get(url.pathname);
    if (body === undefined) return void res.writeHead(404).end();
    const type = url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let seq = 0;
  const serve = (html: string) => {
    const p = `/p/${++seq}/`;
    pages.set(p, html);
    return `http://127.0.0.1:${port}${p}`;
  };

  const profile = mkdtempSync(join(tmpdir(), "pots-chrome-"));
  // --use-mock-keychain: with the tests' empty home folder, Chrome on macOS waits for the keychain and never loads a page.
  const browser: ChildProcess = spawn(path, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--use-mock-keychain", "about:blank"], { stdio: "ignore", env: chromeEnv() });
  let devtools: string | undefined;
  // A file that is empty or not yet complete is read again after a wait.
  for (let i = 0; i < 150 && !devtools; i++) {
    try {
      const [p, wsPath] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      if (wsPath) devtools = `ws://127.0.0.1:${p}${wsPath}`;
    } catch {}
    if (!devtools) await sleep(100);
  }
  if (!devtools) throw new Error("Chrome did not start");
  const ws = new WebSocket(devtools);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const waiting = new Map<number, (msg: any) => void>();
  const listeners = new Set<(msg: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
    else for (const l of listeners) l(msg);
  };
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => {
        waiting.delete(n);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });

  async function open(html: string, options: PageOptions = {}): Promise<Page> {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (method: string, params: object = {}) => send(method, params, sessionId);
    await s("Page.enable");
    await s("Emulation.setFocusEmulationEnabled", { enabled: true });
    await s("Emulation.setDeviceMetricsOverride", { width: options.width ?? 1024, height: options.height ?? 800, deviceScaleFactor: 1, mobile: false });
    if (options.media) await s("Emulation.setEmulatedMedia", { features: Object.entries(options.media).map(([name, value]) => ({ name, value })) });
    if (options.before) await s("Page.addScriptToEvaluateOnNewDocument", { source: options.before });
    const loaded = new Promise<void>((resolve) => {
      const l = (msg: any) => {
        if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
          listeners.delete(l);
          resolve();
        }
      };
      listeners.add(l);
    });
    await s("Page.navigate", { url: serve(html) });
    await loaded;
    return {
      async eval<T>(expression: string, timeoutMs = 5000): Promise<T> {
        const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value as T;
      },
      async key(key: string, code: string, keyCode: number) {
        for (const type of ["keyDown", "keyUp"]) await s("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
      },
      close: () => send("Target.closeTarget", { targetId }).then(() => {}),
    };
  }

  return {
    open,
    serve,
    async stop() {
      // As a person closes it, so its helper processes end before the profile is removed.
      const exited = new Promise((resolve) => (browser.exitCode !== null ? resolve(undefined) : browser.once("exit", resolve)));
      // Not awaited: the browser may close before it answers.
      send("Browser.close").catch(() => {});
      await Promise.race([exited, sleep(5000)]);
      if (browser.exitCode === null) browser.kill("SIGKILL");
      await exited;
      ws.close();
      await new Promise((resolve) => server.close(resolve));
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** A page with the kit's stylesheet and pots-ui.js, and the given body. */
export function kitPage(body: string, { lang = "en", dir = "ltr", scripts = 1 } = {}): string {
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="../../__pots/kit/pots.css">${'<script src="../../__pots/kit/pots-ui.js"></script>'.repeat(scripts)}</head>
<body><main>${body}</main></body></html>`;
}
