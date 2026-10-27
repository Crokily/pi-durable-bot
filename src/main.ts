import { existsSync, readdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "./bot/bot.ts";
import { botPaths, CONFIG_DIR, DATA_DIR, readDefinition } from "./bot/definition.ts";
import { readSecrets } from "./core/env-file.ts";

// Runs every bot folder in the data directory: a folder with a bot.json is a bot. Checks the folders every few
// seconds, so a new folder starts a bot, a removed one stops it, and a changed bot.json applies while running.

const SCAN_MS = 5_000;
const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

function print(bot: string | undefined) {
  return (message: string, data?: Record<string, unknown>) => {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...(bot ? { bot } : {}), message, ...data }));
  };
}

const log = print(undefined);
const running = new Map<string, { bot: Bot; text: string }>();
const failed = new Map<string, string>();
let scanning: Promise<void> = Promise.resolve();
let stopping = false;

async function scan(): Promise<void> {
  const ids = existsSync(DATA_DIR)
    ? readdirSync(DATA_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]*$/.test(entry.name) && existsSync(join(DATA_DIR, entry.name, "bot.json")))
        .map((entry) => entry.name)
    : [];
  for (const [id, entry] of running) {
    if (ids.includes(id)) continue;
    running.delete(id);
    await entry.bot.stop().catch((error) => log("bot stop failed", { bot: id, error: String(error) }));
  }
  for (const id of ids) {
    const paths = botPaths(join(DATA_DIR, id));
    let read: ReturnType<typeof readDefinition>;
    try {
      read = readDefinition(paths.definition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failed.get(id) !== message) {
        failed.set(id, message);
        print(id)("bot.json is not valid; keeping the running definition", { error: message });
        await writeFile(paths.definitionError, `${message}\n`).catch(() => {});
      }
      continue;
    }
    const current = running.get(id);
    if (current && current.text === read.text) continue;
    if (failed.get(id) === read.text) continue;
    try {
      if (current) {
        await current.bot.applyDefinition(read.definition);
        current.text = read.text;
      } else {
        const jev = readSecrets(join(CONFIG_DIR, "jev.env"), ["JEV_API_KEY"]);
        const bot = await Bot.start(id, paths.dir, read.definition, { dataDir: DATA_DIR, configDir: CONFIG_DIR, binDir, jevApiKey: jev.JEV_API_KEY! }, print(id));
        running.set(id, { bot, text: read.text });
      }
      failed.delete(id);
      if (existsSync(paths.definitionError)) await unlink(paths.definitionError).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Try again only when bot.json changes.
      failed.set(id, read.text);
      print(id)(current ? "applying bot.json failed" : "bot start failed", { error: message });
      await writeFile(paths.definitionError, `${message}\n`).catch(() => {});
    }
  }
}

function rescan(): Promise<void> {
  scanning = scanning.then(() => (stopping ? undefined : scan())).catch((error) => log("scan failed", { error: String(error) }));
  return scanning;
}

await rescan();
log("started", { dataDir: DATA_DIR, bots: [...running.keys()] });
const timer = setInterval(() => void rescan(), SCAN_MS);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("shutdown", { signal });
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 25_000);
  await scanning;
  await Promise.allSettled([...running.values()].map((entry) => entry.bot.stop()));
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => log("unhandled rejection", { error: String(error) }));
