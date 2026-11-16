#!/usr/bin/env node
// A screenshot of a page at a real viewport width, in headless Chrome or Chromium, for the pages skill.
//   node shot.mjs <url> <width> <out.png> [dark]
// It emulates the width (a window can not be made narrower than about 500px, so --window-size crops a wider layout),
// takes the whole page, and prints what it measured: the page's innerWidth, whether it scrolls sideways, and script
// errors. It fails when innerWidth is not the width asked for. $CHROME names the browser when it is not on PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [url, widthArg, out, scheme] = process.argv.slice(2);
const width = Number(widthArg);
if (!url || !(width > 0) || !out) {
  console.error("usage: node shot.mjs <url> <width> <out.png> [dark]");
  process.exit(2);
}
const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
const chrome = process.env.CHROME || names.find((n) => (n.startsWith("/") ? existsSync(n) : spawnSync("which", [n]).status === 0));
if (!chrome) {
  console.error("no Chrome or Chromium found; install one, or set CHROME");
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), "shot-"));
const browser = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let status = 1;
let port;
try {
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
    } catch {
      await sleep(100);
    }
  }
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (waiting.has(msg.id)) waiting.get(msg.id)(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    else if (msg.method === "Page.loadEventFired") waiting.get("load")?.();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => (waiting.delete(n), msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  // mobile: as a phone lays out the page, with its viewport meta tag.
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme === "dark" ? "dark" : "light" }] });
  const loaded = new Promise((resolve) => waiting.set("load", resolve));
  await send("Page.navigate", { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(500);
  const { result } = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
    returnByValue: true,
  });
  const seen = JSON.parse(result.value);
  const height = Math.min(seen.height, 16000);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  const report = { file: out, width, innerWidth: seen.innerWidth, height: seen.height, scrollsSideways: seen.scrollWidth > seen.innerWidth, errors };
  console.log(JSON.stringify(report));
  if (seen.innerWidth !== width) console.error(`innerWidth is ${seen.innerWidth}, not ${width}`);
  else status = 0;
  ws.close();
} finally {
  await close(browser, port);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(status);

// Closes the browser as a person would (Browser.close), so its helper processes end before the profile is removed.
async function close(browser, port) {
  const exited = new Promise((resolve) => (browser.exitCode !== null ? resolve() : browser.once("exit", resolve)));
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  } catch {}
  await Promise.race([exited, sleep(5000)]);
  if (browser.exitCode === null) browser.kill("SIGKILL");
  await exited;
}
