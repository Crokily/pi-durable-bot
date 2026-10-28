import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { platformFile, readPlatform } from "../../src/channels/test/index.ts";
import type { FakeModel } from "./fake-model.ts";

// A real gateway process (`pots start`) in a home folder of its own, with one bot on a test channel and a fake model.
// Tests act as people on the test platform and look only at what can be seen from outside: the platform file, the
// bot's SQLite log and the requests to the model.

const POTS = fileURLToPath(new URL("../../src/cli/pots.ts", import.meta.url));
export const BOT = "coworker";
export const CHANNEL = "test";
/** The bot's own name on the test platform. */
export const ME = "bot";

export interface BotOptions {
  readonly model: FakeModel;
  /** bot.json "judge". */
  readonly judge?: string;
  readonly settings?: Record<string, unknown>;
}

export interface PlatformRecord {
  readonly id: string;
  readonly type: string;
  readonly at: number;
  readonly place: string;
  readonly person: string;
  readonly text?: string;
  readonly thread?: string;
  readonly send_id?: string;
}

export class TestGateway {
  readonly home: string;
  readonly botDir: string;
  readonly platformDir: string;
  /** Every line the gateway printed, parsed. */
  readonly output: Record<string, unknown>[] = [];
  #process: ChildProcess | undefined;
  #exited: Promise<number | null> = Promise.resolve(null);

  constructor(options: BotOptions) {
    this.home = mkdtempSync(join(tmpdir(), "pots-test-"));
    this.botDir = join(this.home, "bots", BOT);
    this.platformDir = join(this.home, "platform");
    mkdirSync(this.botDir, { recursive: true });
    mkdirSync(join(this.home, "pi"), { recursive: true });
    const definition = {
      name: "Coworker",
      model: "fake/coworker",
      thinking: "off",
      judge: options.judge ?? "off",
      channels: [{ id: CHANNEL, type: "test", dir: this.platformDir, me: ME }],
      settings: { debounceMs: 300, debounceMaxMs: 2_000, ...options.settings },
    };
    writeFileSync(join(this.botDir, "bot.json"), JSON.stringify(definition, null, 2));
    // pi's model layer reads its endpoints from here instead of ~/.pi/agent.
    const models = {
      providers: {
        fake: {
          baseUrl: options.model.url,
          api: "openai-completions",
          apiKey: "fake",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "coworker", contextWindow: 128_000 }],
        },
      },
    };
    writeFileSync(join(this.home, "pi", "models.json"), JSON.stringify(models, null, 2));
  }

  /** Start the gateway and wait until the bot runs. */
  async start(): Promise<void> {
    if (this.#process) throw new Error("already running");
    const from = this.output.length;
    const child = spawn(process.execPath, [POTS, "start"], {
      env: { ...process.env, POTS_HOME: this.home, PI_CODING_AGENT_DIR: join(this.home, "pi"), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#process = child;
    this.#exited = new Promise((resolve) => child.once("exit", (code) => {
      this.#process = undefined;
      resolve(code);
    }));
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.output.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          this.output.push({ message: line });
        }
      }
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    await waitFor(
      () => {
        if (!this.#process) throw new Error(`the gateway exited while starting: ${stderr}`);
        const failed = this.output.slice(from).find((line) => line.message === "bot start failed");
        if (failed) throw new Error(`the bot did not start: ${String(failed.error)}`);
        return this.output.slice(from).some((line) => line.message === "bot started");
      },
      { timeout: 20_000, what: "the bot to start" },
    );
  }

  /** Stop the gateway the normal way (SIGTERM). */
  async stop(): Promise<void> {
    if (!this.#process) return;
    this.#process.kill("SIGTERM");
    await this.#exited;
  }

  /** Kill the gateway with no chance to clean up, like a crash or a power cut. */
  async kill(): Promise<void> {
    if (!this.#process) return;
    this.#process.kill("SIGKILL");
    await this.#exited;
  }

  /** Resolves when the gateway process ends by itself. */
  exited(): Promise<number | null> {
    return this.#exited;
  }

  get running(): boolean {
    return this.#process !== undefined;
  }

  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.home, { recursive: true, force: true });
  }

  /** Run a pots command against this home, and return what it printed. */
  pots(...args: string[]): string {
    return execFileSync(process.execPath, [POTS, ...args], { env: { ...process.env, POTS_HOME: this.home, NO_COLOR: "1" }, encoding: "utf8" });
  }

  /** Make the gateway die right after the platform accepts its next send, before it records the send. */
  crashAfterNextSend(): void {
    writeFileSync(join(this.botDir, "crash-after-send"), "");
  }

  // ---- The test platform ----

  /** A person says something. Returns the new message's ID on the platform. */
  say(place: string, person: string, text: string, thread?: string): string {
    return this.#append({ type: "message", place, person, text, ...(thread ? { thread } : {}) });
  }

  #append(record: Omit<PlatformRecord, "id" | "at">): string {
    const id = `${record.type === "message" ? "m" : "e"}-${randomUUID()}`;
    mkdirSync(this.platformDir, { recursive: true });
    appendFileSync(platformFile(this.platformDir), `${JSON.stringify({ id, at: Date.now(), ...record })}\n`);
    return id;
  }

  records(): PlatformRecord[] {
    return readPlatform(this.platformDir) as PlatformRecord[];
  }

  /** The messages the bot sent on the platform. */
  sent(): PlatformRecord[] {
    return this.records().filter((record) => record.type === "message" && record.person === ME);
  }

  // ---- The bot's log ----

  /** Read-only SQL on the bot's database. */
  query<T>(sql: string, ...params: (string | number)[]): T[] {
    const db = new DatabaseSync(join(this.botDir, "bot.sqlite"), { readOnly: true, timeout: 5_000 });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }
}

/** Poll until the check returns true. A check that throws ends the wait with its error. */
export async function waitFor(check: () => boolean, options: { timeout?: number; what?: string } = {}): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 15_000);
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "a condition"}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Wait a fixed time, to show that something does not happen. */
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
