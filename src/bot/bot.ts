import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Agent, type Database, openDatabase } from "../agent/agent.ts";
import { type ChildEnd, describeChild, reportRequestId } from "../agent/children.ts";
import type { MemoryNote } from "../agent/memory.ts";
import { SCREEN_VARIABLES, screenOf } from "../agent/screen.ts";
import { createJudge } from "../agent/judge.ts";
import { openResources } from "../agent/resources.ts";
import { loadChannel } from "../channels/load.ts";
import type { Address, ChannelAdapter, ChannelConfig } from "../core/channel.ts";
import { MEMORY_DIR, SECRETS_DIR } from "../core/home.ts";
import { VERSION } from "../core/version.ts";
import type { Judge } from "../core/judge.ts";
import { formatTime } from "../core/time.ts";
import type { Delivered, PlaceWake, WakeTarget } from "../core/wake.ts";
import type { Print, RunCommand } from "../gateway/config.ts";
import { Gateway, type TimersHandle } from "../gateway/gateway.ts";
import { describeSchedule, describeWork, type RoutineInput, renderRoutines } from "../gateway/routines.ts";
import type { DueTimer } from "../gateway/timers.ts";
import { ControlServer } from "./control.ts";
import { type BotDefinition, type BotPaths, botPaths } from "./definition.ts";
import { describeMachine } from "./machine.ts";
import { listMemoryFiles, memoryProgress, readIndex, recordMemoryChange, settleMemory } from "./memory.ts";
import {
  childMemorySection,
  childSection,
  contextSection,
  folderSection,
  identitySection,
  logSection,
  memorySection,
  type PromptFacts,
  renderCacheUse,
  renderChildWake,
  renderContext,
  renderDream,
  renderExtraction,
  renderHandoff,
  renderMemoryNote,
  renderPlaceWake,
  renderTimerWake,
  workSection,
} from "./prompt.ts";

const WAKES_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_wakes (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  place TEXT,
  text TEXT NOT NULL,
  submission TEXT
);
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

/** What the agent is told about the computer it runs on. Checked once per process, from when the gateway loads. */
const MACHINE = describeMachine();
/** In place of pi's sections when there is nothing to list, so that the sections after them stay where they are. */
const NO_PROJECT_CONTEXT = "Project-specific instructions and guidelines: none found.";
const NO_SKILLS = "Skills: none found.";
/** What the bot says where it was woken when its model fails. */
const FAILURE_NOTICE = "I could not work on this: my model did not answer. The reason is in pots status on the computer I run on.";
/** docs/ of this package, next to src/ or dist/. */
const DOCS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));

/**
 * One bot: a person with a name, an AGENTS.md, responsibilities, memory, timed wakes, a workspace and one long
 * conversation. It joins the gateway (channels) and the agent (pi-durable).
 */
export class Bot implements WakeTarget {
  readonly id: string;
  readonly paths: BotPaths;
  #definition: BotDefinition;
  readonly #env: BotEnvironment;
  readonly #print: Print;
  readonly #sql: Database;
  readonly #gateway: Gateway;
  readonly #timers: TimersHandle;
  readonly #agent: Agent;
  /** The notes of what the memory passes changed, which the next wake that goes out takes. */
  readonly #notes: MemoryNote[];
  /** Undefined when bot.json says "judge": "off". */
  #judge: Judge | undefined;
  readonly #control: ControlServer;
  /** Which place each wake submission is about, for "is the bot working on this place". */
  readonly #submissionPlaces = new Map<string, Address>();
  /** How the last failed run ended, for pots status and pots chat. */
  #lastError: { at: number; error: string } | undefined;
  /**
   * The notices that the agent could not work, by place, until a run works again or the gateway restarts. Without its
   * model, the agent cannot say so itself; the people who woke it would see only silence. A notice that could not be
   * sent is sent again, with the same send ID, after the next failed run there.
   */
  readonly #failureNotices = new Map<Address, { sendId: string; state: "sending" | "sent" | "unsent" }>();
  /** Places the agent sent or reacted to in its current busy period. */
  readonly #touched = new Set<Address>();

  private constructor(init: {
    id: string;
    paths: BotPaths;
    definition: BotDefinition;
    env: BotEnvironment;
    print: Print;
    sql: Database;
    gateway: Gateway;
    timers: TimersHandle;
    agent: Agent;
    judge: Judge | undefined;
    notes: MemoryNote[];
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
    this.#notes = init.notes;
    this.#judge = init.judge;
    this.#control = new ControlServer(init.paths.socket, this.#routes());
    let working: readonly string[] = [];
    this.#agent.onRunChange((inputs) => {
      if (!inputs) this.#touched.clear();
      this.#print(inputs ? "agent working" : "agent idle", inputs ? { inputs } : {});
      // A run grows by the inputs that come while it works, and it ended when its first input changes: pi-durable can
      // end one run and start the next in one commit, with no idle between.
      const ran = working.length > 0 && inputs?.[0] !== working[0] ? working : undefined;
      working = inputs ?? [];
      if (!ran) return;
      void this.#agent.runError(ran).then((error) => {
        if (!error) {
          this.#failureNotices.clear();
          return;
        }
        this.#lastError = { at: Date.now(), error };
        this.#print("agent run failed", { error });
        this.#tellFailure(ran);
      });
    });
  }

  static async start(id: string, dir: string, definition: BotDefinition, env: BotEnvironment, print: Print): Promise<Bot> {
    const paths = botPaths(dir);
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
    for (const folder of [paths.memory, MEMORY_DIR]) await mkdir(folder, { recursive: true, mode: 0o700 });
    // Before 0.3 the bot's AGENTS.md was persona.md.
    const persona = join(dir, "persona.md");
    if (existsSync(persona) && !existsSync(paths.agents)) await rename(persona, paths.agents);
    for (const file of [paths.responsibilities, paths.notes]) if (!existsSync(file)) await writeFile(file, "");

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
    sql: Database,
    definition: BotDefinition,
    env: BotEnvironment,
    print: Print,
    opened: (agent: Agent) => void,
  ): Promise<Bot> {
    await sql.exec(WAKES_SCHEMA);
    // The version whose prompt the conversation shows.
    const shownVersion = (await sql.all<{ value: string }>("SELECT value FROM bot_state WHERE key = 'prompt_version'"))[0]?.value;

    let bot: Bot | undefined;
    const self = () => {
      if (!bot) throw new Error("the bot is still starting");
      return bot;
    };
    const current = () => (bot ? bot.#definition : definition);
    const settings = () => current().settings;
    const judge = createJudge(definition.judge, env.models, () => current().model);
    // The environment of bash commands, and of routines' commands. Without the screen's variables: a command that uses
    // the screen goes through the screen tool, which holds the screen for one agent at a time. Without POTS_FROM, which
    // only a routine's command has.
    const left = new Set<string>([...SCREEN_VARIABLES, "POTS_FROM"]);
    const shellEnv: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !left.has(entry[0]))),
      POTS_BOT: id,
      PATH: `${dirname(env.potsCommand)}${delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? homedir(),
    };
    const gateway = await Gateway.open(sql, {
      bot: id,
      judge: () => (bot ? bot.#judge : judge),
      settings,
      fallbackWakeMinutes: () => settings().fallbackWakeMinutes,
      fireTimer: (timer, caller) => self().#deliverTimer(timer, caller),
      runCommand: commandRunner(paths.workspace, shellEnv),
      filesDir: paths.files,
      print,
    });
    const timers = gateway.timers;
    const machine = await MACHINE;
    const facts = (): PromptFacts => ({
      id,
      name: current().name,
      paths,
      botsDir: env.botsDir,
      pots: env.potsCommand,
      machine,
      docs: DOCS_DIR,
      secretsDir: SECRETS_DIR,
      fallbackWakeMinutes: current().settings.fallbackWakeMinutes,
      sharedMemory: MEMORY_DIR,
    });
    // AGENTS.md and skills as a pi session finds them from the bot's working directory, so its own folder's AGENTS.md.
    const resources = await openResources(paths.workspace, print);
    // After the bot's own sections, as pi puts them after a custom system prompt. Rendered in this order, so the skills
    // are those of the same scan.
    const projectContext = {
      name: "project_context",
      render: async () => {
        await resources.reload();
        return resources.projectContext() ?? NO_PROJECT_CONTEXT;
      },
    };
    const skills = { name: "skills", render: () => resources.skills() ?? NO_SKILLS };
    // The memory, as Claude Code's auto memory: files in the bot's memory folder and in the one all bots share.
    const folders = { own: paths.memory, shared: MEMORY_DIR };
    const memoryOn = () => settings().autoMemory;
    const indexes = async () => ({ own: await readIndex(folders.own), shared: await readIndex(folders.shared) });
    /** The notes of what the memory passes changed, for the next wake: in the process, as in Claude Code. */
    const notes: MemoryNote[] = [];
    const agent = await Agent.open({
      database: sql,
      models: env.models,
      model: definition.model,
      thinking: definition.thinking,
      compaction: () => settings().compaction,
      workspace: paths.workspace,
      shellEnv,
      screen: { current: () => screenOf(current().screen, process.env), bot: paths.dir, name: () => current().name },
      // The start of every request, so the provider's prompt cache can keep it: only facts that stay the same. What
      // changes from one wake to the next (the time, the context use, the bot's own address in a channel) is in the
      // wake. The bot's own sections are pinned for the page; a new name shows at once, as AGENTS.md and skills do,
      // since people change them on purpose. New sections go at the end, and every section always has a text.
      sections: [
        { name: "identity", render: () => identitySection(facts()) },
        { name: "work", render: () => workSection(facts()), pin: true },
        { name: "log", render: () => logSection(facts()), pin: true },
        { name: "folder", render: () => folderSection(facts()), pin: true },
        // About the context; its name is from before the bot had a memory, and a new name would move it.
        { name: "memory", render: () => contextSection(facts()), pin: true },
        projectContext,
        skills,
        // Without the memory, no section: it is the last one, so the others stay where they are.
        { name: "remembered", render: async () => (memoryOn() ? memorySection(facts(), await indexes()) : undefined), pin: true },
      ],
      children: {
        model: () => current().childModel,
        thinking: () => current().childThinking,
        max: () => settings().maxChildren,
        // The same for every child, so children share the start of their requests; then the memory's indexes, as they
        // were when the child started.
        sections: [
          { name: "child", render: () => childSection(facts()) },
          { name: "log", render: () => logSection(facts()) },
          { name: "folder", render: () => folderSection(facts(), true) },
          projectContext,
          skills,
          { name: "remembered", render: async () => (memoryOn() ? childMemorySection(facts(), await indexes()) : undefined), pin: true },
        ],
        place: () => (bot ? bot.#currentPlace() : undefined),
        ended: (end) => self().#deliverChildEnd(end),
      },
      // What a new version says counts at once; without an upgrade, the sections stay as the page began.
      ...(shownVersion === VERSION
        ? {}
        : {
            refreshPinned: () =>
              sql.run("INSERT INTO bot_state (key, value) VALUES ('prompt_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", VERSION),
          }),
      memory: {
        enabled: memoryOn,
        folders,
        extraction: async (messages) => renderExtraction(messages, await listMemoryFiles(folders), folders),
        dream: async (progress) => renderDream(facts(), progress),
        progress: () => memoryProgress(sql),
        changed: (source) => recordMemoryChange(sql, source),
        settle: (update) => settleMemory(sql, update),
        noted: (note) => notes.push(note),
      },
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

    bot = new Bot({ id, paths, definition, env, print, sql, gateway, timers, agent, judge, notes });
    // Crash tests: with one of these files in the bot folder, the process dies at that point, once.
    const crashTest = (file: string, message: string, key: string) => (id: string) => {
      if (!existsSync(file)) return;
      unlinkSync(file);
      print(message, { [key]: id });
      process.kill(process.pid, "SIGKILL");
    };
    // Right after the platform accepts the next send, before the outbox records it. The next start must find that
    // message instead of sending it again.
    gateway.outbox.afterPlatformSend = crashTest(paths.crashAfterSend, "crash test: dying after the platform send", "sendId");
    // Right after the bot took a wake, before the gateway records that. The next start must deliver the same wake again,
    // which the agent counts once, instead of deciding its events anew.
    gateway.waker.afterDeliver = crashTest(paths.crashAfterWake, "crash test: dying after the wake", "wakeId");
    // Around the report of a child's end to the main agent. The next start must report it once.
    agent.crashTests.beforeReport = crashTest(paths.crashBeforeChildReport, "crash test: dying before the child's report", "reporter");
    agent.crashTests.afterReport = crashTest(paths.crashAfterChildReport, "crash test: dying after the child's report", "reporter");
    // Right after a stop marked a child stopped, before its work ended. The next start must end that work.
    agent.crashTests.afterStopMark = crashTest(paths.crashAfterChildStop, "crash test: dying after marking the child stopped", "child");
    // Right before a memory pass forks the main conversation. The next start must make the pass.
    agent.crashTests.beforeMemoryPass = () => crashTest(paths.crashBeforeMemoryPass, "crash test: dying before the memory pass", "bot")(id);
    for (const row of await sql.all<{ submission: string; place: string }>(
      "SELECT submission, place FROM bot_wakes WHERE submission IS NOT NULL AND place IS NOT NULL ORDER BY at DESC LIMIT 1000",
    )) {
      bot.#submissionPlaces.set(row.submission, row.place);
    }
    let adapters: ChannelAdapter[] = [];
    try {
      adapters = await Promise.all(definition.channels.map((channel) => bot!.#loadChannel(channel)));
      await gateway.start(bot, adapters);
      await agent.resume();
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

  /**
   * Stop in this order: no new wakes (a decision in progress is finished and delivered), then the agent (its work in
   * progress is interrupted and goes on after the next start), then the gateway. The gateway takes the agent's actions
   * until the agent has stopped, so an action is never refused while the agent still works.
   */
  async stop(): Promise<void> {
    try {
      await this.#control.stop();
      await this.#gateway.pauseWakes();
      await this.#agent.close();
    } finally {
      // Also when a step above failed: a bot that is stopped must not keep its channels or its file open.
      try {
        await this.#gateway.stop();
      } finally {
        await this.#sql.close().catch(() => {});
      }
    }
    this.#print("bot stopped");
  }

  /** Apply a changed bot.json while running. The new definition counts only once every step worked, so a retry redoes all. */
  async applyDefinition(next: BotDefinition): Promise<void> {
    const before = this.#definition;
    if (before.model !== next.model || before.thinking !== next.thinking) await this.#agent.configure(next.model, next.thinking);
    // Also for the children that exist: those without a model of their own use the main one. A child keeps its thinking
    // level; childThinking counts for new children.
    if (before.model !== next.model || before.childModel !== next.childModel) await this.#agent.configureChildren(next.childModel);
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
    // A child that works for the place: new events there go to the main agent, which can pass them on.
    if (this.#workingChildren(place).length > 0) return true;
    const inputs = this.#agent.runInputs;
    if (!inputs) return false;
    if (this.#touched.has(place)) return true;
    return inputs.some((submission) => this.#submissionPlaces.get(submission) === place);
  }

  /** The children that work now, for one place or all. */
  #workingChildren(place?: Address) {
    return this.#agent.children.filter((child) => child.since !== undefined && child.stoppedAt === undefined && (place === undefined || child.place === place));
  }

  /** The place the main agent works on now, when its run is about one place. */
  #currentPlace(): Address | undefined {
    const places = new Set((this.#agent.runInputs ?? []).map((submission) => this.#submissionPlaces.get(submission)).filter((place) => place !== undefined));
    return places.size === 1 ? [...places][0] : undefined;
  }

  async deliver(wake: PlaceWake, caller?: TelemetrySpan): Promise<Delivered> {
    const me = this.#gateway.channels.find((channel) => channel.owns(wake.place.address))?.me;
    const text = renderPlaceWake(wake, await this.#agent.contextStatus(), me, this.#workingChildren(wake.place.address));
    return this.#submit(wake.id, wake.reason, wake.place.address, text, wake.reason === "steer", caller);
  }

  responsibilities(): Promise<string> {
    return readFile(this.paths.responsibilities, "utf8").catch(() => "");
  }

  async #deliverTimer(timer: DueTimer, caller?: TelemetrySpan): Promise<Delivered> {
    const text = renderTimerWake(timer, await this.#agent.contextStatus(), this.#definition.settings.fallbackWakeMinutes, this.#workingChildren());
    return this.#submit(`timer:${timer.id}`, timer.set_by === "agent" ? "timer" : timer.set_by, undefined, text, false, caller);
  }

  /** A child ended: a wake for the main agent, once per reporter, also when this runs again after a restart. */
  async #deliverChildEnd(end: ChildEnd): Promise<string> {
    // Handed over before a restart: the same submission, and no second wake in the trace.
    const id = reportRequestId(end.reporter);
    const before = (await this.#sql.all<{ submission: string }>("SELECT submission FROM bot_wakes WHERE id = ?", id))[0];
    if (before) return before.submission;
    const text = renderChildWake(end, await this.#agent.contextStatus());
    const delivered = await this.#gateway.wake({ reason: "child", child: end.child.id, ...(end.child.place ? { place: end.child.place } : {}) }, (caller) =>
      this.#submit(id, "child", end.child.place, text, false, caller),
    );
    return delivered.submission;
  }

  async #submit(id: string, reason: string, place: Address | undefined, text: string, steer: boolean, caller?: TelemetrySpan): Promise<Delivered> {
    // What the memory passes changed since the last wake, once, at the end of this one, as Claude Code tells it. Taken
    // at once, so two wakes never give the same note; not by a wake given again after a crash, which does not go out
    // again; and put back when the wake could not go out.
    const notes = (await this.#agent.submitted(id)) ? [] : this.#notes.splice(0);
    if (notes.length > 0) {
      const read = await this.#agent.readFiles().catch(() => new Set<string>());
      const stale = (paths: readonly string[]) => paths.filter((path) => basename(path) === "MEMORY.md" || read.has(path));
      text = [text, ...notes.map((note) => renderMemoryNote(note, stale([...note.written, ...note.deleted])))].join("\n\n");
    }
    let submitted;
    try {
      submitted = await this.#agent.submit({ id, text, steer, data: { reason, ...(place ? { place } : {}) }, caller });
    } catch (error) {
      this.#notes.unshift(...notes);
      throw error;
    }
    const { id: submission, trace } = submitted;
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
    return { submission, run: trace };
  }

  /**
   * Say in each place that woke this run, once until a run works again, that the agent could not work. Not why: the
   * reason can name the model's configuration, such as the command that gives its key, and the place can be shared.
   * pots status and pots chat show it on this computer.
   */
  #tellFailure(inputs: readonly string[]): void {
    const places = new Set(inputs.map((submission) => this.#submissionPlaces.get(submission)).filter((place) => place !== undefined));
    for (const place of places) {
      if ((this.#failureNotices.get(place)?.state ?? "unsent") !== "unsent") continue;
      const notice = { sendId: this.#failureNotices.get(place)?.sendId ?? `failed:${inputs[0]}:${place}`, state: "sending" as const };
      this.#failureNotices.set(place, notice);
      const settle = (state: "sent" | "unsent") => {
        if (this.#failureNotices.get(place)?.sendId === notice.sendId) this.#failureNotices.set(place, { ...notice, state });
      };
      this.#gateway.send(notice.sendId, place, FAILURE_NOTICE, inputs).then(
        () => settle("sent"),
        (cause: unknown) => {
          settle("unsent");
          this.#print("could not say that the run failed", { place, error: String(cause) });
        },
      );
    }
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
    await this.#agent.turnPage(renderHandoff(note, notes, this.paths.notes, this.#workingChildren()));
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
        const options = {
          ...(typeof body.from === "string" && body.from ? { source: body.from } : {}),
          ...(typeof body.id === "string" && body.id ? { requestId: body.id } : {}),
        };
        return this.#timers.add(at, typeof body.note === "string" ? body.note : "", options);
      },
      "GET /wakes": async () => this.#timers.pending(),
      "POST /wakes/cancel": async (body: Record<string, unknown>) => {
        if (!(await this.#timers.cancel(Number(body.id)))) throw new Error(`no pending wake ${String(body.id)}`);
        return "cancelled";
      },
      "GET /routines": async () => {
        const listing = await this.#timers.routines();
        return { ...listing, text: renderRoutines(listing, Date.now()) };
      },
      "POST /routines/add": async (body: Record<string, unknown>) => {
        const input: RoutineInput = { name: text(body.name, "name") };
        if (typeof body.every === "number") input.every = body.every;
        if (typeof body.cron === "string") input.cron = body.cron;
        if (typeof body.note === "string") input.note = body.note;
        if (typeof body.run === "string") input.run = body.run;
        if (typeof body.timeout === "number") input.timeout = body.timeout;
        const { routine, replaced } = await this.#timers.addRoutine(input);
        return `${replaced ? "Replaced" : "Added"} routine ${routine.name}: ${describeSchedule(routine)}, ${describeWork(routine)}\n  next: ${formatTime(routine.next_at)}`;
      },
      "POST /routines/remove": async (body: Record<string, unknown>) => {
        const name = text(body.name, "name");
        if (!(await this.#timers.removeRoutine(name))) throw new Error(`there is no routine ${JSON.stringify(name)}`);
        return `Removed routine ${name}.`;
      },
      "GET /context": async () => {
        const [status, cache] = await Promise.all([this.#agent.contextStatus(), this.#agent.cacheUse()]);
        return { ...status, cache, text: `${renderContext(status)}\n${renderCacheUse(cache)}` };
      },
      "POST /turn-page": async (body: Record<string, unknown>) => this.turnPage(text(body.note, "note")),
      "GET /children": async () => {
        const now = Date.now();
        const children = this.#agent.children;
        return { children, text: children.length === 0 ? "No children." : children.map((child) => describeChild(child, now, { thinking: true })).join("\n") };
      },
      "POST /children/stop": async (body: Record<string, unknown>) => {
        if (body.all === true) {
          const results = await this.#agent.stopChildren();
          return results.length === 0 ? "No children to stop." : results.join("\n");
        }
        return this.#agent.stopChild(text(body.id, "id"));
      },
      "GET /status": async () => ({
        id: this.id,
        name: this.#definition.name,
        model: this.#definition.model,
        judge: this.#definition.judge,
        busy: this.#agent.runInputs !== undefined,
        children: this.#workingChildren().length,
        ...(this.#lastError ? { lastError: this.#lastError } : {}),
        channels: this.#gateway.channels.map((channel) => ({ id: channel.id, me: channel.me?.address })),
      }),
    };
  }
}

/** Runs a routine's command as the bash tool runs one: the same shell, environment and working directory. */
function commandRunner(workspace: string, shellEnv: Record<string, string>): RunCommand {
  const shell = new NodeExecutionEnv({ cwd: workspace, shellEnv });
  return async (command, env, signal, onOutput) => {
    const result = await shell.exec(command, { env: { ...shellEnv, ...env }, inheritEnv: false, onOutput: (text) => onOutput(text) }, withAbortSignal(signal, BACKGROUND_CONTEXT));
    return result.ok ? { exitCode: result.value.exitCode } : { error: result.error.message };
  };
}
