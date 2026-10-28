import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Agent, openDatabase } from "../agent/agent.ts";
import { createJudge } from "../agent/judge.ts";
import { loadChannel } from "../channels/load.ts";
import type { Address, ChannelAdapter, ChannelConfig } from "../core/channel.ts";
import { SECRETS_DIR } from "../core/home.ts";
import type { Judge } from "../core/judge.ts";
import type { Sql } from "../core/sql.ts";
import type { PlaceWake, WakeTarget } from "../core/wake.ts";
import { Gateway, type TimersHandle } from "../gateway/gateway.ts";
import { ControlServer } from "./control.ts";
import { type BotDefinition, type BotPaths, botPaths } from "./definition.ts";
import { describeMachine } from "./machine.ts";
import {
  folderSection,
  identitySection,
  logSection,
  memorySection,
  type PromptFacts,
  renderContext,
  renderHandoff,
  renderPlaceWake,
  renderTimerWake,
  workSection,
} from "./prompt.ts";
import type { Timer } from "./timers.ts";

const WAKES_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_wakes (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  place TEXT,
  text TEXT NOT NULL,
  submission TEXT
);
`;

export interface BotEnvironment {
  /** The folder with every bot's folder. */
  botsDir: string;
  /** The `pots` command for the agent's shell, scripts and scheduled jobs. */
  potsCommand: string;
  /** pi's model layer, shared by all bots of the process. */
  models: Models;
}

/** What the agent is told about the computer it runs on. Checked once per process. */
const MACHINE = describeMachine();
/** docs/ of this package, next to src/ or dist/. */
const DOCS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));

type Print = (message: string, data?: Record<string, unknown>) => void;

/**
 * One bot: a person with a name, persona, responsibilities, memory, timed wakes, a workspace and one long
 * conversation. It joins the gateway (channels) and the agent (pi-durable).
 */
export class Bot implements WakeTarget {
  readonly id: string;
  readonly paths: BotPaths;
  #definition: BotDefinition;
  readonly #env: BotEnvironment;
  readonly #print: Print;
  readonly #sql: Sql & { close(): Promise<void> };
  readonly #gateway: Gateway;
  readonly #timers: TimersHandle;
  readonly #agent: Agent;
  /** Undefined when bot.json says "judge": "off". */
  #judge: Judge | undefined;
  readonly #control: ControlServer;
  /** Which place each wake submission is about, for "is the bot working on this place". */
  readonly #submissionPlaces = new Map<string, Address>();
  /** How the last failed run ended, for pots status and pots chat. */
  #lastError: { at: number; error: string } | undefined;
  /** Places the agent sent or reacted to in its current busy period. */
  readonly #touched = new Set<Address>();

  private constructor(init: {
    id: string;
    paths: BotPaths;
    definition: BotDefinition;
    env: BotEnvironment;
    print: Print;
    sql: Sql & { close(): Promise<void> };
    gateway: Gateway;
    timers: TimersHandle;
    agent: Agent;
    judge: Judge | undefined;
  }) {
    this.id = init.id;
    this.paths = init.paths;
    this.#definition = init.definition;
    this.#env = init.env;
    this.#print = init.print;
    this.#sql = init.sql;
    this.#gateway = init.gateway;
    this.#timers = init.timers;
    this.#agent = init.agent;
    this.#judge = init.judge;
    this.#control = new ControlServer(init.paths.socket, this.#routes());
    let working: readonly string[] = [];
    this.#agent.onRunChange((inputs) => {
      if (!inputs) this.#touched.clear();
      this.#print(inputs ? "agent working" : "agent idle", inputs ? { inputs } : {});
      if (inputs) {
        working = inputs;
        return;
      }
      void this.#agent.runError(working).then((error) => {
        if (!error) return;
        this.#lastError = { at: Date.now(), error };
        this.#print("agent run failed", { error });
      });
    });
  }

  static async start(id: string, dir: string, definition: BotDefinition, env: BotEnvironment, print: Print): Promise<Bot> {
    const paths = botPaths(dir);
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
    for (const file of [paths.persona, paths.responsibilities, paths.notes]) if (!existsSync(file)) await writeFile(file, "");

    // One SQLite file: gateway (gw_), bot (bot_) and pi-durable (pi_) tables on one connection.
    const sql = await openDatabase(paths.db);
    let started: Bot | undefined;
    let agent: Agent | undefined;
    try {
      started = await Bot.#open(id, paths, sql, definition, env, print, (opened) => (agent = opened));
      return started;
    } finally {
      if (!started) {
        await agent?.close().catch(() => {});
        await sql.close().catch(() => {});
      }
    }
  }

  static async #open(
    id: string,
    paths: BotPaths,
    sql: Sql & { close(): Promise<void> },
    definition: BotDefinition,
    env: BotEnvironment,
    print: Print,
    opened: (agent: Agent) => void,
  ): Promise<Bot> {
    await sql.exec(WAKES_SCHEMA);

    let bot: Bot | undefined;
    const self = () => {
      if (!bot) throw new Error("the bot is still starting");
      return bot;
    };
    const current = () => (bot ? bot.#definition : definition);
    const settings = () => current().settings;
    const judge = createJudge(definition.judge, env.models, () => current().model);
    const gateway = await Gateway.open(sql, {
      bot: id,
      judge: () => (bot ? bot.#judge : judge),
      settings,
      fallbackWakeMinutes: () => settings().fallbackWakeMinutes,
      fireTimer: (timer, caller) => self().#deliverTimer(timer, caller),
      print,
    });
    const timers = gateway.timers;
    const facts = (): PromptFacts => ({
      id,
      name: current().name,
      paths,
      botsDir: env.botsDir,
      pots: env.potsCommand,
      machine: MACHINE,
      docs: DOCS_DIR,
      secretsDir: SECRETS_DIR,
      fallbackWakeMinutes: current().settings.fallbackWakeMinutes,
      accounts: gateway.channels.map((channel) => ({ channel: channel.id, ...(channel.me ? { me: channel.me } : {}) })),
    });
    const agent = await Agent.open({
      database: sql,
      models: env.models,
      model: definition.model,
      thinking: definition.thinking,
      compaction: () => settings().compaction,
      workspace: paths.workspace,
      shellEnv: {
        ...process.env,
        POTS_BOT: id,
        PATH: `${dirname(env.potsCommand)}${delimiter}${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? homedir(),
      },
      sections: [
        { name: "identity", render: async () => identitySection(facts(), await readFile(paths.persona, "utf8").catch(() => "")) },
        { name: "work", render: () => workSection(facts()) },
        { name: "log", render: () => logSection(facts()) },
        { name: "folder", render: () => folderSection(facts()) },
        { name: "memory", render: () => memorySection(facts()) },
      ],
      actions: {
        send: (to, text, sendId, trace) => self().send(to, text, sendId, trace),
        react: (message, emoji, remove, trace) => self().react(message, emoji, remove, trace),
        call: (channel, method, params, trace) => self().call(channel, method, params, trace),
      },
      telemetry: gateway.telemetry,
      log: print,
    }).catch(async (error: unknown) => {
      await gateway.stop().catch(() => {});
      throw error;
    });
    opened(agent);

    bot = new Bot({ id, paths, definition, env, print, sql, gateway, timers, agent, judge });
    // Crash test: with this file in the bot folder, the process dies right after the platform accepts the next send,
    // before the outbox records it. The next start must find that message instead of sending it again.
    gateway.outbox.afterPlatformSend = (sendId) => {
      if (!existsSync(paths.crashAfterSend)) return;
      unlinkSync(paths.crashAfterSend);
      print("crash test: dying after the platform send", { sendId });
      process.kill(process.pid, "SIGKILL");
    };
    // The same for a wake: the process dies right after the bot took it, before the gateway records that. The next
    // start must deliver the same wake again, which the agent counts once, instead of deciding its events anew.
    gateway.waker.afterDeliver = (wakeId) => {
      if (!existsSync(paths.crashAfterWake)) return;
      unlinkSync(paths.crashAfterWake);
      print("crash test: dying after the wake", { wakeId });
      process.kill(process.pid, "SIGKILL");
    };
    for (const row of await sql.all<{ submission: string; place: string }>(
      "SELECT submission, place FROM bot_wakes WHERE submission IS NOT NULL AND place IS NOT NULL ORDER BY at DESC LIMIT 1000",
    )) {
      bot.#submissionPlaces.set(row.submission, row.place);
    }
    let adapters: ChannelAdapter[] = [];
    try {
      adapters = await Promise.all(definition.channels.map((channel) => bot!.#loadChannel(channel)));
      await gateway.start(bot, adapters);
      agent.resume();
      await timers.start();
      if (existsSync(paths.firstWake)) {
        await timers.add(Date.now(), await readFile(paths.firstWake, "utf8"));
        unlinkSync(paths.firstWake);
      }
      await bot.#control.start();
    } catch (error) {
      await timers.stop();
      await gateway.stop();
      throw error;
    }
    print("bot started", { name: definition.name, model: definition.model, judge: definition.judge, channels: adapters.map((adapter) => adapter.id) });
    return bot;
  }

  async stop(): Promise<void> {
    await this.#control.stop();
    await this.#timers.stop();
    await this.#gateway.stop();
    await this.#agent.close();
    await this.#sql.close().catch(() => {});
    this.#print("bot stopped");
  }

  get definition(): BotDefinition {
    return this.#definition;
  }

  /** Apply a changed bot.json while running. The new definition counts only once every step worked, so a retry redoes all. */
  async applyDefinition(next: BotDefinition): Promise<void> {
    const before = this.#definition;
    if (before.model !== next.model || before.thinking !== next.thinking) await this.#agent.configure(next.model, next.thinking);
    const old = new Map(before.channels.map((channel) => [channel.id, JSON.stringify(channel)]));
    const fresh = new Map(next.channels.map((channel) => [channel.id, JSON.stringify(channel)]));
    const nameChanged = before.name !== next.name;
    for (const [channelId, config] of old) {
      if (fresh.get(channelId) !== config || nameChanged) await this.#gateway.removeChannel(channelId);
    }
    for (const channel of next.channels) {
      const running = this.#gateway.channels.some((adapter) => adapter.id === channel.id);
      if (!running) await this.#gateway.addChannel(await this.#loadChannel(channel, next.name));
    }
    this.#definition = next;
    if (before.judge !== next.judge) this.#judge = createJudge(next.judge, this.#env.models, () => this.#definition.model);
    if (before.settings.fallbackWakeMinutes !== next.settings.fallbackWakeMinutes) await this.#timers.resetFallback();
    this.#print("definition applied", { name: next.name, model: next.model, judge: next.judge, channels: next.channels.map((channel) => channel.id) });
  }

  #loadChannel(config: ChannelConfig, botName = this.#definition.name): Promise<ChannelAdapter> {
    return loadChannel(config, {
      botDir: this.paths.dir,
      botName,
      log: (message, data) => this.#print(`${config.id}: ${message}`, data),
    });
  }

  // ---- WakeTarget ----

  get name(): string {
    return this.#definition.name;
  }

  isWorkingOn(place: Address): boolean {
    const inputs = this.#agent.runInputs;
    if (!inputs) return false;
    if (this.#touched.has(place)) return true;
    return inputs.some((submission) => this.#submissionPlaces.get(submission) === place);
  }

  async deliver(wake: PlaceWake, caller?: TelemetrySpan): Promise<string> {
    const text = renderPlaceWake(wake, await this.#agent.contextStatus());
    return this.#submit(wake.id, wake.reason, wake.place.address, text, wake.reason === "steer", caller);
  }

  responsibilities(): Promise<string> {
    return readFile(this.paths.responsibilities, "utf8").catch(() => "");
  }

  async #deliverTimer(timer: Timer, caller?: TelemetrySpan): Promise<string> {
    const text = renderTimerWake(timer, await this.#agent.contextStatus(), this.#definition.settings.fallbackWakeMinutes);
    return this.#submit(`timer:${timer.id}`, timer.set_by === "fallback" ? "fallback" : "timer", undefined, text, false, caller);
  }

  /** Returns the submission ID. */
  async #submit(id: string, reason: string, place: Address | undefined, text: string, steer: boolean, caller?: TelemetrySpan): Promise<string> {
    const submission = await this.#agent.submit({ id, text, steer, data: { reason, ...(place ? { place } : {}) }, caller });
    if (place) this.#submissionPlaces.set(submission, place);
    await this.#sql.run(
      "INSERT OR IGNORE INTO bot_wakes (id, at, reason, place, text, submission) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      Date.now(),
      reason,
      place ?? null,
      text,
      submission,
    );
    return submission;
  }

  // ---- Actions, for the agent's tools and the command line ----

  /** trace: the agent's tool call, when the action comes from one. */
  async send(to: Address, text: string, sendId: string, trace?: TelemetrySpan) {
    // The wakes the agent works on now: the send links to them.
    const sent = await this.#gateway.send(sendId, to, text, this.#agent.runInputs ?? [], trace);
    this.#touch(sent.place);
    return sent;
  }

  async react(message: Address, emoji: string, remove: boolean, trace?: TelemetrySpan): Promise<void> {
    await this.#gateway.react(message, emoji, remove, trace);
    this.#touch(this.#gateway.adapterFor(message).placeOf(message));
  }

  call(channel: string, method: string, params: Record<string, unknown>, trace?: TelemetrySpan): Promise<unknown> {
    return this.#gateway.call(channel, method, params, trace);
  }

  #touch(place: Address | undefined): void {
    if (place && this.#agent.runInputs) this.#touched.add(place);
  }

  async turnPage(note: string): Promise<{ notesChars: number }> {
    const notes = await readFile(this.paths.notes, "utf8").catch(() => "");
    await this.#agent.turnPage(renderHandoff(note, notes, this.paths.notes));
    this.#print("turn page", { notesChars: notes.length });
    return { notesChars: notes.length };
  }

  #routes() {
    const text = (value: unknown, name: string) => {
      if (typeof value !== "string") throw new Error(`"${name}" is required`);
      return value;
    };
    return {
      "POST /send": async (body: Record<string, unknown>) =>
        this.send(text(body.to, "to"), text(body.text, "text"), typeof body.id === "string" && body.id ? body.id : `cli:${randomUUID()}`),
      "POST /react": async (body: Record<string, unknown>) => {
        await this.react(text(body.message, "message"), text(body.emoji, "emoji"), body.remove === true);
        return "ok";
      },
      "POST /call": async (body: Record<string, unknown>) =>
        this.call(text(body.channel, "channel"), text(body.method, "method"), (body.params as Record<string, unknown> | undefined) ?? {}),
      "POST /wake": async (body: Record<string, unknown>) => {
        const at = typeof body.at === "number" ? body.at : Date.now();
        return this.#timers.add(at, typeof body.note === "string" ? body.note : "");
      },
      "GET /wakes": async () => this.#timers.pending(),
      "POST /wakes/cancel": async (body: Record<string, unknown>) => {
        if (!(await this.#timers.cancel(Number(body.id)))) throw new Error(`no pending wake ${String(body.id)}`);
        return "cancelled";
      },
      "GET /context": async () => {
        const status = await this.#agent.contextStatus();
        return { ...status, text: renderContext(status) };
      },
      "POST /turn-page": async (body: Record<string, unknown>) => this.turnPage(text(body.note, "note")),
      "GET /status": async () => ({
        id: this.id,
        name: this.#definition.name,
        model: this.#definition.model,
        judge: this.#definition.judge,
        busy: this.#agent.runInputs !== undefined,
        ...(this.#lastError ? { lastError: this.#lastError } : {}),
        channels: this.#gateway.channels.map((channel) => ({ id: channel.id, me: channel.me?.address })),
      }),
    };
  }
}
