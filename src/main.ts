import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openModels } from "./agent/models.ts";
import { Bot } from "./bot/bot.ts";
import { BOT_ID, botPaths, readDefinition } from "./bot/definition.ts";
import { BIN_DIR, BOTS_DIR, PID_FILE, POTS_HOME } from "./core/home.ts";

// The gateway: runs every bot folder in ~/.pots/bots. A folder with a bot.json is a bot. Checks the folders every few
// seconds, so a new folder starts a bot, a removed one stops it, and a changed bot.json applies while running.

const SCAN_MS = 5_000;
/** A bot that failed to start or to apply bot.json is tried again after this long (for example while the network is not up yet). */
const RETRY_MS = 60_000;
/** The `pots` command line next to this file: src/cli/pots.ts, or dist/cli/pots.js in the built package. */
const potsEntry = fileURLToPath(new URL(`./cli/pots${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url));

function print(bot: string | undefined) {
  return (message: string, data?: Record<string, unknown>) => {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...(bot ? { bot } : {}), message, ...data }));
  };
}

/** The process ID in the pid file, when that process is still running. */
export function runningGateway(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/**
 * Write the `pots` command that the bots' shells and scheduled jobs use: this node and this package, so it works where
 * PATH has neither (cron, Git Bash on Windows).
 */
function writePotsCommand(): string {
  mkdirSync(BIN_DIR, { recursive: true });
  const path = (file: string) => (process.platform === "win32" ? file.replaceAll("\\", "/") : file);
  const command = join(BIN_DIR, "pots");
  writeFileSync(command, `#!/bin/sh\nexec "${path(process.execPath)}" "${path(potsEntry)}" "$@"\n`, { mode: 0o755 });
  return command;
}

/** Run the gateway until SIGTERM or SIGINT. Only one gateway runs per POTS_HOME. */
export async function runGateway(): Promise<void> {
  mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 });
  const other = runningGateway();
  if (other !== undefined && other !== process.pid) throw new Error(`a gateway is already running for ${POTS_HOME} (process ${other})`);
  writeFileSync(PID_FILE, `${process.pid}\n`);
  const potsCommand = writePotsCommand();
  const log = print(undefined);
  const models = await openModels();
  const running = new Map<string, { bot: Bot; text: string }>();
  /** Bots whose bot.json could not be read (the error) or used (the bot.json text and when it failed). */
  const invalid = new Map<string, string>();
  const failed = new Map<string, { text: string; at: number }>();
  let scanning: Promise<void> = Promise.resolve();
  let stopping = false;

  async function scan(): Promise<void> {
    const ids = existsSync(BOTS_DIR)
      ? readdirSync(BOTS_DIR, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && BOT_ID.test(entry.name) && existsSync(join(BOTS_DIR, entry.name, "bot.json")))
          .map((entry) => entry.name)
      : [];
    for (const [id, entry] of running) {
      if (ids.includes(id)) continue;
      running.delete(id);
      await entry.bot.stop().catch((error) => log("bot stop failed", { bot: id, error: String(error) }));
    }
    for (const id of ids) {
      const paths = botPaths(join(BOTS_DIR, id));
      let read: ReturnType<typeof readDefinition>;
      try {
        read = readDefinition(paths.definition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (invalid.get(id) !== message) {
          invalid.set(id, message);
          print(id)("bot.json is not valid; keeping the running definition", { error: message });
          await writeFile(paths.definitionError, `${message}\n`).catch(() => {});
        }
        continue;
      }
      invalid.delete(id);
      const current = running.get(id);
      if (current && current.text === read.text) {
        // Back to the definition that runs: nothing to apply, and no error left.
        failed.delete(id);
        if (existsSync(paths.definitionError)) await unlink(paths.definitionError).catch(() => {});
        continue;
      }
      const failure = failed.get(id);
      if (failure && failure.text === read.text && Date.now() - failure.at < RETRY_MS) continue;
      try {
        if (current) {
          await current.bot.applyDefinition(read.definition);
          current.text = read.text;
        } else {
          const bot = await Bot.start(id, paths.dir, read.definition, { botsDir: BOTS_DIR, potsCommand, models }, print(id));
          running.set(id, { bot, text: read.text });
        }
        failed.delete(id);
        if (existsSync(paths.definitionError)) await unlink(paths.definitionError).catch(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.set(id, { text: read.text, at: Date.now() });
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
  log("started", { home: POTS_HOME, bots: [...running.keys()] });
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
    if (runningGateway() === process.pid) await unlink(PID_FILE).catch(() => {});
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (error) => log("unhandled rejection", { error: String(error) }));
}
