import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, type ModelThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineSignal,
  defineTask,
  defineTool,
  type EntryId,
  type Extension,
  type InboxState,
  type JsonObject,
  LiveDoc,
  type LiveState,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";

// Children: agents the main agent starts for longer work, so it stays free to talk. A child is a conversation of its
// own that starts with only the brief, and has read, write, edit, bash, grep, find, screen, codemode and the task tool:
// not the channel actions send, react and call. The main agent or a child starts one with the task tool, or a routine
// starts one at its time; all of them share one cap. When it ends, its final message is kept, also across restarts, and
// wakes no one: the agent that started it reads it with the task tool, or waits for it, and a child that judges the main
// agent needs to know wakes it itself (pots wake). A child that cannot go on, such as when its model fails, tells the
// child that started it while that one works, and else wakes the main agent once, also across restarts. A stop stops
// what the child started too. The main agent sees and manages them all; a child, those it started.
// Built on pi-durable's example of background subagents: an anchor task owns each child's conversation, and a reporter
// task delivers each message to the child and keeps how it ended. All of them are tasks of the main conversation, and
// its children document keeps every child.

/** A child, as the main conversation's children document keeps it. */
export type ChildRecord = {
  id: string;
  title: string;
  conversationId: ConversationId;
  /** The place the child works for, when there is one. */
  place?: string;
  /** The routine that started it, when one did. */
  routine?: string;
  /** The child that started it, when one did. */
  parent?: string;
  /** The model the main agent chose for it, "provider/modelId", for its whole life; absent: the main agent's model. */
  model?: string;
  /** Its thinking level, for its whole life. */
  thinking: ModelThinkingLevel;
  startedAt: number;
  /** Since when it works on its current message; absent while it waits for one. */
  since?: number;
  /** When it last ended. */
  endedAt?: number;
  stoppedAt?: number;
  /** The stop ended all its work; a stop that a crash cut off is finished at the next start, or by another stop. */
  stopFinished?: boolean;
  /** Every reporter made for it. */
  reporters: string[];
  /** Its answers, oldest first: several messages can end in one answer, which is kept once. */
  reported: EntryId[];
  /**
   * How it last ended: with its answer, the last of reported, or failed: why it could not answer. Absent in a child
   * that ended only before this was kept.
   */
  result?: { at: number; failed?: string };
  /** The tool tasks of the task tool's waits for its end; each sleeps on the key of the child's ID. */
  waiters?: string[];
  /** The reporters that give the child that started it a message of its failure, which a stop withdraws while queued. */
  told?: string[];
};

export type ChildrenState = {
  next: number;
  children: Record<string, ChildRecord>;
  /** Reporters that have not ended yet, and their child. */
  live: Record<string, string>;
};

export const Children = defineDoc<ChildrenState>({
  checkpointWhen: () => false,
  kind: "bot.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ next: 1, children: {}, live: {} }),
});

/** A child as the bot and the main agent see it. */
export interface ChildInfo {
  id: string;
  title: string;
  conversationId: string;
  place?: string;
  /** The routine that started it, when one did. */
  routine?: string;
  /** The child that started it, when one did. */
  parent?: string;
  /** The model chosen for it; absent: the main agent's model. */
  model?: string;
  thinking: ModelThinkingLevel;
  startedAt: number;
  /** Since when it works, while it works. */
  since?: number;
  endedAt?: number;
  stoppedAt?: number;
  /** Why it could not answer, when its last message ended so. */
  failed?: string;
  /** What it does now, while it works: read from its conversation when it is described, not kept. */
  activity?: ChildActivity;
}

/** What a working child does now. */
export interface ChildActivity {
  /** The tool calls it is in, in call order. */
  calls: ChildCall[];
  /** Its model is answering, outside a tool call; retry: its last request failed, and it tries again at that time. */
  model?: { retry?: { at: number; error: string } };
  /** It summarizes its context before it goes on. */
  compacting?: true;
  /** Messages from the main agent that it has not taken yet: it takes them only when its current tool calls end. */
  waiting: number;
}

/** A tool call a child is in. */
export interface ChildCall {
  /** Its tool task. */
  task: string;
  tool: string;
  /** When it started to run. */
  since?: number;
  /** The start of what it runs: the command, the script, or the arguments. */
  command?: string;
  /** For a call that gives output as it runs: its last line, absent while there is none, and when output last came. */
  output?: { line?: string; at?: number };
  /** The newest call its script makes that still runs (codemode). */
  inner?: ChildCall;
}

/** A tool task as childActivity needs it: when it started, and the arguments it runs with once it runs. */
export interface CallTask {
  startedAt?: number;
  arguments?: JsonObject;
}

/**
 * What a working child does now, from its conversation: its live state (the current tool calls or model answer), its
 * queue, its running tool tasks (by task ID), and the running calls that give output as they run, with when their last
 * output came (by task ID; undefined while they gave none).
 */
export function childActivity(
  live: Readonly<LiveState> | undefined,
  inbox: Readonly<InboxState> | undefined,
  tasks: ReadonlyMap<string, CallTask>,
  outputs: ReadonlyMap<string, number | undefined>,
): ChildActivity {
  const call = (slot: { taskId: TaskId; name: string; output?: string }, args: JsonObject | undefined): ChildCall => {
    const key = String(slot.taskId);
    const task = tasks.get(key);
    const command = commandOf(args ?? task?.arguments);
    const line = slot.output === undefined ? undefined : lastLine(slot.output);
    const at = outputs.get(key);
    const output = outputs.has(key) || line !== undefined ? { ...(line === undefined ? {} : { line }), ...(at === undefined ? {} : { at }) } : undefined;
    return {
      task: key,
      tool: slot.name,
      ...(task?.startedAt === undefined ? {} : { since: task.startedAt }),
      ...(command === undefined ? {} : { command }),
      ...(output === undefined ? {} : { output }),
    };
  };
  const nested = (live?.nestedTools ?? []).filter((slot) => slot.status !== "done");
  const calls = (live?.tools ?? []).flatMap((slot) => {
    if (slot.taskId === undefined || slot.status === "done") return [];
    const inner = nested.findLast((each) => each.callId.startsWith(`${slot.callId}/`));
    return [{ ...call({ ...slot, taskId: slot.taskId }, undefined), ...(inner ? { inner: call(inner, inner.arguments) } : {}) }];
  });
  const generation = live?.generation;
  return {
    calls,
    ...(calls.length === 0 && generation ? { model: generation.retry ? { retry: { at: generation.retry.at, error: generation.retry.error } } : {} } : {}),
    ...(live?.compactions?.some((compaction) => compaction.blocking) ? { compacting: true as const } : {}),
    waiting: (inbox?.items ?? []).filter((item) => item.mode !== "write").length,
  };
}

/** The longest result the task tool gives in its output, under pi's cut at 50 KB or 2,000 lines; a longer one goes to a file. */
const RESULT_BYTES = 40_000;
const RESULT_LINES = 1_500;

/** How much of a command or an output line a description shows. */
const SHOWN_CHARS = 150;

function clip(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length <= SHOWN_CHARS ? line : `${line.slice(0, SHOWN_CHARS - 1)}…`;
}

/** The start of what a call runs, on one line: a command, a script, or else its arguments. */
function commandOf(args: JsonObject | undefined): string | undefined {
  if (args === undefined) return undefined;
  const text = typeof args.command === "string" ? args.command : typeof args.code === "string" ? args.code : JSON.stringify(args);
  return clip(text);
}

/** The last line of output that has text, as a terminal shows it: after its last carriage return, without escapes. */
function lastLine(output: string): string | undefined {
  const lines = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => clip((line.split("\r").findLast((part) => part.trim() !== "") ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")));
  return lines.findLast((line) => line !== undefined);
}

export function childInfo(record: Readonly<ChildRecord>): ChildInfo {
  return {
    id: record.id,
    title: record.title,
    conversationId: String(record.conversationId),
    ...(record.place === undefined ? {} : { place: record.place }),
    ...(record.routine === undefined ? {} : { routine: record.routine }),
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    ...(record.model === undefined ? {} : { model: record.model }),
    thinking: record.thinking,
    startedAt: record.startedAt,
    ...(record.since === undefined ? {} : { since: record.since }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
    ...(record.result?.failed === undefined ? {} : { failed: record.result.failed }),
  };
}

/** How a child ended, as a wait keeps it the first time: its answer then, why it could not answer, whether it was stopped. */
type End = { answer?: number; failed?: string; stopped?: boolean };

/** A child's end, for the task tool's waits, under the child's ID: how it ended. */
const ChildEnded = defineSignal({ name: "bot.child-ended", version: 1, schema: obj({ answer: opt(num()), failed: opt(str()), stopped: opt(bool()) }) });

function endOf(record: Readonly<ChildRecord>): End {
  const failed = record.result?.failed;
  const answer = record.reported.at(-1);
  return { ...(failed !== undefined ? { failed } : answer !== undefined ? { answer: Number(answer) } : {}), ...(record.stoppedAt === undefined ? {} : { stopped: true }) };
}

/**
 * Children ended or were stopped: wake the waits for them, each with how its child ended. In a commit, before its first
 * table write: each delivery reads its task before it writes it, so all of them start before the first one writes.
 */
export async function endWaits(tx: Tx, records: readonly ChildRecord[]): Promise<void> {
  const deliveries = records.flatMap((record) => [...new Set(record.waiters ?? [])].map((task) => tx.signal(Number(task) as TaskId, ChildEnded, record.id, endOf(record))));
  for (const record of records) delete record.waiters;
  await Promise.all(deliveries);
}

/** Keep an answer of a child, once: several messages can end in one answer. */
export function keepAnswer(record: ChildRecord, answer: EntryId, now: number): void {
  if (record.reported.includes(answer)) return;
  record.reported.push(answer);
  record.result = { at: now };
}

/**
 * Which children a list shows: those that work, the last `limit` of the others, and the chain of children that started
 * each shown one, so none shows apart from the one that started it.
 */
export function shownChildren(listed: readonly ChildInfo[], limit = 20): ChildInfo[] {
  const byId = new Map(listed.map((child) => [child.id, child]));
  const shown = new Set([...listed.filter(isWorking), ...listed.filter((child) => !isWorking(child)).slice(-limit)].map((child) => child.id));
  for (const id of [...shown]) {
    for (let up = byId.get(id)?.parent; up !== undefined && byId.has(up) && !shown.has(up); up = byId.get(up)?.parent) shown.add(up);
  }
  return listed.filter((child) => shown.has(child.id));
}

/** Whether a child works now. */
const isWorking = (child: Readonly<ChildRecord> | ChildInfo) => child.since !== undefined && child.stoppedAt === undefined;

/** The IDs of a child's descendants, nearest first. */
export function descendants(state: Readonly<ChildrenState>, id: string): string[] {
  const found: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of Object.values(state.children)) {
      if (child.parent === parent) {
        found.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return found;
}

/** A child that could not go on, for the main agent's wake. */
export interface ChildFailure {
  /** The reporter's task ID: one wake per reporter, also when its phase runs again after a restart. */
  reporter: string;
  child: ChildInfo;
  /** Why it could not go on. */
  reason: string;
  /** What it did last, from its conversation, when that can be read. */
  last?: string;
}

/** The thinking level of a child the main agent starts without choosing one. */
export const DEFAULT_CHILD_THINKING = "xhigh" satisfies ModelThinkingLevel;

export interface ChildrenHost {
  /** The main agent's model now, which a child started without a model of its own has. */
  mainModel(): ModelRef;
  /** The model of "provider/modelId", or why a child cannot have it: unknown, or not signed in on this computer. */
  childModel(model: string): Promise<{ model: ModelRef } | { refused: string }>;
  /** How many children may work at once. */
  max(): number;
  /** The place the main agent works on now, when it works on one. */
  place(): string | undefined;
  /**
   * A child's extensions as a change to the main agent's: the child's own added, the main agent's that a child does not
   * get removed. Stored as this change, not as a list, so a child follows what the main agent has now, such as the MCP
   * servers that come and go.
   */
  extensions(): { add: readonly Extension[]; remove: readonly Extension[] };
  /** What a child did last, read from its conversation, when that can be read. */
  last(conversationId: ConversationId, context: Context): Promise<string | undefined>;
  /** Hand a child's failure to the main agent as a wake. The same reporter is one wake. Returns its submission ID. */
  failed(failure: ChildFailure, context: Context): Promise<string>;
  /** Withdraw the main agent's queued submission, for the wake of a child stopped in the meantime. */
  withdraw(submission: string): Promise<void>;
  /** Stop a child: it does nothing more. Returns what happened, for the model. */
  stop(id: string): Promise<string>;
  /** What a working child does now, read from its conversation; undefined when it cannot be read. */
  activity(conversationId: ConversationId): Promise<ChildActivity | undefined>;
  /** End the tool calls a working child is in; the child goes on. Returns what happened, for the model. */
  interrupt(child: ChildInfo): Promise<string>;
  /** A child's work ended: it holds nothing any more, such as the screen. */
  settled(conversationId: string): void;
  /** Save a result that is too long for a tool's output to a file, named after a child or "wait": its path. */
  saveResult(name: string, text: string): Promise<string>;
  /** Crash tests: before a child's start commits, with the ID of the child that starts it. */
  beforeStart?(starter: string): Promise<void>;
  /** Crash tests: before a reporter keeps how its child ended; ends early when the reporter is aborted. */
  beforeKeep?(child: string, signal: AbortSignal): Promise<void>;
  /** Crash tests: just before and just after a child's failure is handed to the main agent. */
  beforeFailed?(reporter: string): void;
  afterFailed?(reporter: string): void;
}

/** A new child, as the task tool or a routine starts it. */
export interface ChildStart {
  title: string;
  brief: string;
  /** Who gives the brief, for its first line: "the main agent", "child <ID>", or "routine <name>". */
  from: string;
  /** The child that starts it, when one does. */
  parent?: string;
  place?: string;
  /** The routine that starts it, when one does. */
  routine?: string;
  /** The model chosen for it, "provider/modelId", already checked; absent: the main agent's model. */
  chosen?: string;
  model: ModelRef;
  thinking: ModelThinkingLevel;
}

export type ChildStarted = { id: string } | { full: ChildInfo[] } | { working: string } | { stopped: string };

/** The task extension, and how the bot starts a child itself, for a routine. */
export interface ChildrenTools {
  extension: Extension;
  /**
   * Start a child in a commit of the main conversation: its ID; at the cap, the children that work; for a routine whose
   * earlier child works again, that child; or, for a child that starts it and was stopped meanwhile, that child.
   */
  start(tx: Tx, start: ChildStart, now: number): Promise<ChildStarted>;
}

/** How long, in words: "12 s", "4 min", "2.5 h". */
export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
}

/**
 * A child, for the task tool, wakes and pots children: one line, which in the lists also has its thinking level and the
 * model chosen for it, and for a child that works and whose activity was read, indented lines on what it does now.
 */
export function describeChild(child: ChildInfo, now = Date.now(), options: { thinking?: boolean } = {}): string {
  const state =
    child.stoppedAt !== undefined
      ? `stopped ${age(now - child.stoppedAt)} ago`
      : child.since !== undefined
        ? `working, for ${age(now - child.since)}`
        : `${child.failed === undefined ? "ended" : `failed (${clip(child.failed) ?? "no reason"})`} ${age(now - (child.endedAt ?? child.startedAt))} ago, waits for a message`;
  const line = `${child.id} "${child.title}": ${state}${child.parent ? `, started by ${child.parent}` : ""}${child.place ? `, for ${child.place}` : ""}${options.thinking ? `${child.model ? `, model ${child.model}` : ""}, thinking ${child.thinking}` : ""}`;
  if (child.activity === undefined || child.since === undefined || child.stoppedAt !== undefined) return line;
  return [line, ...describeActivity(child.activity, now).map((each) => `  ${each}`)].join("\n");
}

/** What a working child does now, in lines. */
export function describeActivity(activity: ChildActivity, now = Date.now()): string[] {
  const lines: string[] = [];
  const call = (each: ChildCall) => `${each.tool}${each.since === undefined ? "" : ` for ${age(now - each.since)}`}${each.command === undefined ? "" : `: ${each.command}`}`;
  for (const each of activity.calls) {
    lines.push(`In ${call(each)}`);
    if (each.inner) lines.push(`Its script is in ${call(each.inner)}`);
    const output = (each.inner ?? each).output;
    if (output?.line !== undefined) lines.push(`Last output${output.at === undefined ? "" : ` ${age(now - output.at)} ago`}: ${output.line}`);
    else if (output) lines.push("No output yet.");
  }
  const retry = activity.model?.retry;
  if (retry) lines.push(`Its model's last request failed (${clip(retry.error) ?? "no error text"}); it tries again in ${age(retry.at - now)}.`);
  else if (activity.model) lines.push("Its model is answering.");
  if (activity.compacting) lines.push("It is compacting its context.");
  if (activity.waiting > 0) {
    const messages = activity.waiting === 1 ? "1 message from you waits" : `${activity.waiting} messages from you wait`;
    lines.push(
      activity.calls.length > 0
        ? `${messages} until its current tool calls end.`
        : `${messages} until it answers, or until the tool calls of its next step end.`,
    );
  }
  return lines;
}

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** What a child did last, from the newest step in its conversation: the tools it called, or the start of its text. */
export async function lastStep(conversation: Pick<Conversation, "entries"> | undefined, context: Context): Promise<string | undefined> {
  const page = await conversation?.entries({}, 20, undefined, context);
  // Not a failed or aborted request's entry: its tool calls never ran.
  const message = page?.items
    .flatMap((entry) => (AssistantEntry.is(entry) ? [entry.model?.[0] as AssistantMessage | undefined] : []))
    .find((each) => each && each.content.length > 0 && each.stopReason !== "error" && each.stopReason !== "aborted");
  if (!message) return undefined;
  const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [`${part.name}${commandOf(part.arguments as JsonObject) ? `: ${commandOf(part.arguments as JsonObject)}` : ""}`] : []));
  if (calls.length > 0) return `called ${calls.join("; ")}`;
  const said = clip(textOf(message));
  return said === undefined ? undefined : `wrote: ${said}`;
}

/** A child's last final message, or why it could not answer; undefined while it has neither. */
async function childResult(tx: Tx, record: Readonly<ChildRecord>): Promise<string | undefined> {
  if (record.result?.failed !== undefined) return `It could not answer: ${record.result.failed}`;
  const answer = record.reported.at(-1);
  if (answer === undefined) return undefined;
  return textOf((await tx.entry(AssistantEntry, answer))?.model?.[0] as AssistantMessage | undefined).trim() || "(empty)";
}

/**
 * The task extension of the main agent: the task tool and the tasks behind it. Installed once per bot, so pending
 * reporters go on after a restart.
 */
export function childrenExtension(host: ChildrenHost): ChildrenTools {
  // Owns a child's conversation and ends at once: a background task, so the main agent's own work, its stop and its
  // idle waits do not reach the child.
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "bot.child-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
    },
    abort: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** about: the child whose failure the message tells, which a stop of it withdraws. */
  type ReporterInput = { child: string; conversationId: ConversationId; message: string; about?: string };
  // end: failed: why the child could not go on, for the main agent's wake. answered: only in a reporter that 0.8.8 left
  // in its report phase, which handed the end to the main agent.
  type ReporterState = { phase: "deliver" } | { phase: "report"; end?: { status: "answered" | "failed"; text: string } };

  /**
   * The reporter ends: it is no longer live, and its child waits for a message once no other reporter is live, which
   * wakes the waits for it. Before the commit's first table write.
   */
  const finish = async (tx: Tx, state: ChildrenState, reporter: string, now: number) => {
    const id = state.live[reporter];
    delete state.live[reporter];
    const child = id === undefined ? undefined : state.children[id];
    if (!child || Object.values(state.live).includes(child.id)) return;
    if (child.since !== undefined && child.stoppedAt === undefined) child.endedAt = now;
    delete child.since;
    await endWaits(tx, [child]);
  };

  // Every reporter and anchor is a task of the main conversation, also for a child that a child starts.
  const background = { ownership: { kind: "conversation" }, background: true, conversationId: ROOT_CONVERSATION_ID } as const;

  /** Give a child a message, for one of a child's failure about that child: a reporter delivers it. Returns the reporter. */
  const deliver = async (tx: Tx, state: ChildrenState, record: ChildRecord, message: string, now: number, about?: string) => {
    const reporter = String(await tx.createTask(Reporter, { child: record.id, conversationId: record.conversationId, message, ...(about === undefined ? {} : { about }) }, background));
    record.reporters.push(reporter);
    record.since ??= now;
    state.live[reporter] = record.id;
    return reporter;
  };

  // Delivers one message to a child, waits for its answer and keeps how it ended; only a failure wakes the main agent.
  // A background task of the main conversation; each phase ends with a checkpoint, and request IDs make a phase that
  // runs again after a restart find the first submission, so the child gets the message once and the main agent the
  // failure once.
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "bot.child-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { conversationId, message } = reporter.input;
        // Stopped before its message reached the child, or the child the message is about: the child does not get it.
        const state = await runtime.snapshot(Children, runtime.conversationId, context);
        const stopped = (id: string | undefined) => id !== undefined && state?.children[id]?.stoppedAt !== undefined;
        if (stopped(reporter.input.child) || stopped(reporter.input.about)) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report" } }), context);
          return;
        }
        const child = (await runtime.conversation(conversationId, context))!;
        const submission = await child.submit(
          { type: "input", content: message, whenBusy: "steer", requestId: `child:${reporter.id}`, entry: { kind: "bot.brief" } },
          context,
        );
        const settled = await submission.wait(context);
        host.settled(String(conversationId));
        await host.beforeKeep?.(reporter.input.child, runtime.signal);
        // One commit keeps how the child ended, so a restart does not decide again.
        await runtime.commit(async (tx) => {
          const next = { status: "running" as const, checkpoint: { phase: "report" as const } };
          const state = await tx.doc(Children, runtime.conversationId);
          const record = state.children[reporter.input.child];
          if (!record) return next;
          if (settled.status === "unanswered") {
            // Stopped, or withdrawn while queued: nothing to keep.
            if (settled.reason === "aborted" || record.stoppedAt !== undefined) return next;
            const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
            const failed = `${settled.reason}${detail}`;
            record.result = { at: runtime.now(), failed };
            // The inputs that joined one run settle together: only the reporter of the run's first input wakes the main
            // agent. When the failure is no longer there to tell, this one wakes.
            const run = (await tx.doc(LiveDoc, conversationId)).runFailure;
            const first = run?.inputs.includes(submission.id) ? await tx.submission(run.inputs[0]!) : undefined;
            if (first && first.id !== submission.id && first.requestId?.startsWith("child:")) return next;
            return { ...next, checkpoint: { phase: "report" as const, end: { status: "failed" as const, text: failed } } };
          }
          // An answer is kept also when a stop came after it.
          if (settled.type === "input") keepAnswer(record, settled.answer, runtime.now());
          return next;
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const end = reporter.state.checkpoint.end;
        /** The child that started this one, which works, when the failure goes to it. */
        let parent: { id: string; message: string } | undefined;
        if (end?.status === "failed") {
          const read = () => runtime.snapshot(Children, runtime.conversationId, context);
          const state = await read();
          const before = state?.children[reporter.input.child];
          const started = before?.parent === undefined ? undefined : state?.children[before.parent];
          // To the child that started it while that one works; else to the main agent. Decided once, also across restarts.
          const to = before && before.stoppedAt === undefined ? await runtime.memo("failure-to", started && isWorking(started) ? started.id : "main", context) : undefined;
          if (to === "main") {
            host.beforeFailed?.(String(reporter.id));
            const submission = await host.failed({ reporter: String(reporter.id), child: childInfo(before!), reason: end.text }, context);
            host.afterFailed?.(String(reporter.id));
            // A stop that came in the meantime did not find this wake yet; it must not reach the main agent.
            if ((await read())?.children[reporter.input.child]?.stoppedAt !== undefined) await host.withdraw(submission);
          } else if (to !== undefined) {
            const last = await host.last(reporter.input.conversationId, context);
            const message = [`[your child ${before!.id} "${before!.title}" failed: ${end.text}]`, ...(last === undefined ? [] : [`Last, it ${last}`])].join("\n");
            parent = { id: to, message };
          }
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Children, runtime.conversationId);
          // An end that 0.8.8 had not kept yet: kept, as now.
          const record = state.children[reporter.input.child];
          if (end && record && (end.status === "answered" || record.stoppedAt === undefined)) record.result = end.status === "failed" ? { at: runtime.now(), failed: end.text } : { at: runtime.now() };
          await finish(tx, state, String(reporter.id), runtime.now());
          // Also when a wait of the parent gives the failure too. Not when one of them was stopped meanwhile; a later stop
          // of this child withdraws the message while it waits in the parent's queue.
          const to = parent === undefined ? undefined : state.children[parent.id];
          if (to && to.stoppedAt === undefined && record && record.stoppedAt === undefined) {
            record.told = [...(record.told ?? []), await deliver(tx, state, to, parent!.message, runtime.now(), record.id)];
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (reporter, runtime, context) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Children, runtime.conversationId);
        // A stop that came after the child answered, before the reporter kept the answer: the answer is kept.
        const record = state.children[reporter.input.child];
        const submission = await tx.submissionByRequest(reporter.input.conversationId, `child:${reporter.id}`);
        if (record && submission?.type === "input" && submission.status === "done") keepAnswer(record, submission.answer, runtime.now());
        await finish(tx, state, String(reporter.id), runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
  /** At the cap, the children that work; checked in the commit that would make one more child work. */
  const atCap = (state: Readonly<ChildrenState>) => {
    const working = Object.values(state.children).filter(isWorking);
    return working.length < host.max() ? undefined : working.map(childInfo);
  };
  /** A working child with what it does now. */
  const withActivity = async (child: ChildInfo): Promise<ChildInfo> => {
    if (!isWorking(child)) return child;
    const activity = await host.activity(Number(child.conversationId) as ConversationId);
    return activity === undefined ? child : { ...child, activity };
  };
  /** What the model learns at the cap instead. */
  const capText = async (not: string, working: readonly ChildInfo[], at: number) =>
    `${not}: ${working.length} children work now, as many as the cap (settings.maxChildren in bot.json). They are:\n` +
    (await Promise.all(working.map(withActivity))).map((child) => describeChild(child, at)).join("\n");
  /** Text for the model after a head: whole, or in a file named after `name` when it is too long for a tool's output. */
  const fitted = async (head: string, body: string, name: string, what: string) => {
    // Tool output is cut at 2,000 lines or 50 KB: a longer text goes to a file, whole.
    if (Buffer.byteLength(head + body) <= RESULT_BYTES && `${head}\n${body}`.split("\n").length <= RESULT_LINES) return `${head}\n${body}`;
    const file = await host.saveResult(name, body);
    return `${head}\n${what} ${body.length} characters; all of it is in ${file}. Its start:\n${body.split("\n").slice(0, 100).join("\n").slice(0, 4_000)}`;
  };
  /** A child's last final message for the model: whole, or in a file when it is too long for a tool's output. */
  const resultText = async (tx: Tx, child: Readonly<ChildRecord>, at: number) => {
    const result = await childResult(tx, child);
    const now = describeChild(childInfo(child), at);
    if (result === undefined) return `${now}\nNo final message yet.`;
    return fitted(`${now}\nIts last final message:`, result, child.id, "It is");
  };
  /** How a child ended for a wait, with its final message then. */
  const endText = async (tx: Tx, end: End) => {
    if (end.failed !== undefined) return `It could not answer: ${end.failed}`;
    if (end.answer === undefined) return end.stopped ? "It was stopped before it gave a final message." : "No final message.";
    const answer = textOf((await tx.entry(AssistantEntry, end.answer as EntryId))?.model?.[0] as AssistantMessage | undefined).trim() || "(empty)";
    return `${end.stopped ? "It was stopped. Its last final message" : "Its final message"}:\n${answer}`;
  };
  /** Take a wait's task out of the children it waits for. */
  const unwait = (state: ChildrenState, task: TaskId) => {
    for (const child of Object.values(state.children)) {
      if (!child.waiters?.includes(String(task))) continue;
      child.waiters = child.waiters.filter((each) => each !== String(task));
      if (child.waiters.length === 0) delete child.waiters;
    }
  };

  /**
   * A new child, in a commit of the main conversation; none at the cap, or for a routine while its earlier child works,
   * which the routine looked at before, but a message may have made that child work again since. Its first message says
   * its ID.
   */
  const start = async (tx: Tx, input: ChildStart, now: number): Promise<ChildStarted> => {
    const state = await tx.doc(Children, ROOT_CONVERSATION_ID);
    const earlier = input.routine === undefined ? undefined : Object.values(state.children).find((child) => child.routine === input.routine && isWorking(child));
    if (earlier) return { working: earlier.id };
    // A stop marks a child and all it started in one commit: a child stopped since it looked starts none.
    if (input.parent !== undefined && state.children[input.parent]?.stoppedAt !== undefined) return { stopped: input.parent };
    const full = atCap(state);
    if (full !== undefined) return { full };
    const id = `c${state.next++}`;
    const anchor = await tx.createTask(Anchor, null, background);
    const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    // The child's tools and prompt, and its model.
    await configure(tx, conversation.id, { extensions: host.extensions(), model: input.model, thinkingLevel: input.thinking });
    const message = `[brief from ${input.from}; you are child ${id}]\n${input.brief}`;
    const reporter = await tx.createTask(Reporter, { child: id, conversationId: conversation.id, message }, background);
    state.children[id] = {
      id,
      title: input.title,
      conversationId: conversation.id,
      ...(input.place ? { place: input.place } : {}),
      ...(input.routine === undefined ? {} : { routine: input.routine }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      ...(input.chosen === undefined ? {} : { model: input.chosen }),
      thinking: input.thinking,
      startedAt: now,
      since: now,
      reporters: [String(reporter)],
      reported: [],
    };
    state.live[String(reporter)] = id;
    return { id };
  };

  /** Children in a tree: each under the child that started it, indented, when that one is in the list too. */
  const tree = (children: readonly ChildInfo[], at: number): string => {
    const shown = new Set(children.map((child) => child.id));
    const lines: string[] = [];
    const add = (child: ChildInfo, depth: number) => {
      lines.push(...describeChild(child, at, { thinking: true }).split("\n").map((line) => `${"  ".repeat(depth)}${line}`));
      for (const each of children) if (each.parent === child.id) add(each, depth + 1);
    };
    for (const child of children) if (child.parent === undefined || !shown.has(child.parent)) add(child, 0);
    return lines.join("\n");
  };

  /** Where a wait is: its time limit, and how each child that ended has ended, the first time. */
  type Waiting = { until?: number; ended: Record<string, End> };

  const task = defineTool({
    name: "task",
    description:
      "Children: agents that work in the background, so you stay free to talk. action start: a new child with a short title and a brief " +
      "(place: the address of the place it works for, by default the place you work on; model: \"provider/modelId\", which it keeps, by default yours; " +
      "thinking: its thinking level, which it keeps, by default xhigh); it starts with an empty conversation and the brief, and has this tool too. " +
      "list: your children and the children they started, and what each one that works does now. result: a child's last final message (child: its ID). " +
      "wait: waits until all the children listed in children have ended, or any one of them (any: true), or until seconds have passed, " +
      "then says which of these ended it and gives, for each child that ended, how it ended and its final message then; while you wait you do nothing else. " +
      "send: a message to a child; a child that waits starts on it " +
      "at once, and one that works takes it when its current tool calls end. interrupt: ends the tool calls a child is in, such as a command " +
      "that hangs; the child goes on, sees that they were aborted, and takes the messages that wait for it. " +
      "stop: stops a child, what it runs and the children it started. A child's end wakes no one. A child that fails tells the child that started it " +
      "while that one works, and else wakes the main agent, once. Any child can wake the main agent with pots wake. " +
      "All children share the cap settings.maxChildren.",
    parameters: obj(
      {
        action: StringEnum(["start", "list", "result", "wait", "send", "interrupt", "stop"] as const),
        title: opt(str()),
        brief: opt(str()),
        place: opt(str()),
        model: opt(str()),
        thinking: opt(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
        child: opt(str()),
        children: opt(arr(str())),
        any: opt(bool()),
        seconds: opt(num()),
        message: opt(str()),
      },
      { open: true },
    ),
    // A call cut off by a crash is not run again: a repeated start would start a second child. The model sees that the
    // call was interrupted and can look with list. A wait holds no process and goes on after a restart.
    replay: "unsafe",
    // A wait that is aborted while it sleeps: the children it waited for no longer name it.
    cancel: async (args, api, call) => {
      if (args.action !== "wait") return;
      await api.commit(async (tx) => unwait(await tx.doc(Children, ROOT_CONVERSATION_ID), api.taskId), call);
    },
    execute: async (args, api, call) => {
      const state = (await api.snapshot(Children, ROOT_CONVERSATION_ID, call)) ?? { next: 1, children: {}, live: {} };
      // The main agent manages every child; a child, those it started.
      const caller = Object.values(state.children).find((child) => child.conversationId === api.conversationId);
      const from = caller ? `child ${caller.id}` : "the main agent";
      const mine = (child: Readonly<ChildRecord> | ChildInfo) => caller === undefined || child.parent === caller.id;
      const all = Object.values(state.children).map(childInfo);
      if (args.action === "list") {
        // A child sees what it started, and what those started.
        const below = caller === undefined ? undefined : new Set(descendants(state, caller.id));
        const listed = all.filter((child) => below === undefined || below.has(child.id));
        if (listed.length === 0) return text("No children.");
        return text(tree(await Promise.all(shownChildren(listed).map(withActivity)), api.now()));
      }
      if (args.action === "start") {
        if (!args.title?.trim() || !args.brief?.trim()) return text("start needs a title and a brief.");
        const place = args.place?.trim() || (caller ? caller.place : host.place());
        // A model of its own is checked now, so a child never starts with a model it cannot use. Without one, the
        // child has its starter's: for the main agent's, the main model, also when bot.json changes it later.
        const chosen = args.model?.trim() || caller?.model;
        const found = chosen === undefined ? { model: host.mainModel() } : await host.childModel(chosen);
        if ("refused" in found) return text(`Not started: ${found.refused}`);
        const { model } = found;
        // As pi does, a level the model does not have becomes the nearest one it has, at each request (pi-ai).
        const thinkingLevel = args.thinking ?? DEFAULT_CHILD_THINKING;
        const title = args.title!.trim();
        if (caller) await host.beforeStart?.(caller.id);
        const started = await api.commit(
          (tx) =>
            start(
              tx,
              {
                title,
                brief: args.brief!,
                from,
                ...(caller ? { parent: caller.id } : {}),
                ...(place ? { place } : {}),
                ...(chosen === undefined ? {} : { chosen }),
                model,
                thinking: thinkingLevel,
              },
              api.now(),
            ),
          call,
        );
        if ("stopped" in started) return text("Not started: you were stopped.");
        if (!("id" in started)) return text("full" in started ? await capText("Not started", started.full, api.now()) : "Not started.");
        return text(
          `Started ${started.id} ("${title}")${place ? ` for ${place}` : ""}, model ${model.provider}/${model.modelId}${args.model?.trim() ? "" : " (yours)"}, ` +
            `thinking ${thinkingLevel}.`,
        );
      }
      if (args.action === "wait") {
        const ids = [...new Set(args.children ?? [])];
        if (ids.length === 0) return text("wait needs children: the IDs of the children to wait for.");
        const unknown = ids.filter((id) => !Object.hasOwn(state.children, id) || !mine(state.children[id]!));
        if (unknown.length > 0) return text(`No child ${unknown.join(", ")} of yours.`);
        const before = api.checkpoint as Waiting | undefined;
        const until = before ? before.until : args.seconds === undefined ? undefined : api.now() + args.seconds * 1_000;
        const ended: Record<string, End> = { ...before?.ended };
        if (before === undefined) {
          // Looked at and, for those that work, kept in the children document in one commit, so no end comes in between.
          Object.assign(
            ended,
            await api.commit(async (tx) => {
              const state = await tx.doc(Children, ROOT_CONVERSATION_ID);
              const now: Record<string, End> = {};
              for (const id of ids) {
                const record = state.children[id]!;
                if (isWorking(record)) record.waiters = [...(record.waiters ?? []), String(api.taskId)];
                else now[id] = endOf(record);
              }
              return now;
            }, call),
          );
        } else {
          // The first end of each: a later message may make the child work again and answer anew.
          for (const id of ids) {
            if (Object.hasOwn(ended, id)) continue;
            const signal = await api.readSignal(ChildEnded, id, call);
            if (signal && "value" in signal) ended[id] = signal.value;
          }
        }
        const done = ids.filter((id) => Object.hasOwn(ended, id));
        const left = ids.filter((id) => !Object.hasOwn(ended, id));
        const over = left.length === 0 ? "all" : args.any === true && done.length > 0 ? "any" : api.wake?.reason === "expired" || api.wake?.reason === "time" ? "time" : undefined;
        if (over === undefined) {
          const waiting: Waiting = { ...(until === undefined ? {} : { until }), ended };
          return { sleep: { checkpoint: waiting, signals: left.map((id) => ChildEnded.key(id)), ...(until === undefined ? {} : { until }) } };
        }
        const results = await api.commit(async (tx) => {
          const state = await tx.doc(Children, ROOT_CONVERSATION_ID);
          const texts = await Promise.all(done.map(async (id) => `${describeChild(childInfo(state.children[id]!), api.now())}\n${await endText(tx, ended[id]!)}`));
          unwait(state, api.taskId);
          return texts;
        }, call);
        const works = left.length === 1 ? "still works" : "still work";
        const head =
          over === "all"
            ? `All of them ended: ${done.join(", ")}.`
            : over === "any"
              ? `${done.length === 1 ? "One of them ended" : "Some of them ended"}: ${done.join(", ")}; ${left.join(", ")} ${works}.`
              : `The time is up; ${left.join(", ")} ${works}.${done.length > 0 ? ` Ended: ${done.join(", ")}.` : ""}`;
        if (done.length === 0) return text(head);
        return text(await fitted(head, `\n${results.join("\n\n")}`, "wait", "Together, their final messages are"));
      }
      if (!args.child) return text(`${args.action} needs a child ID.`);
      const child = Object.hasOwn(state.children, args.child) && mine(state.children[args.child]!) ? state.children[args.child] : undefined;
      if (!child) return text(`No child ${args.child}${caller ? " of yours" : ""}.`);
      if (args.action === "stop") return text(await host.stop(child.id));
      if (args.action === "result") return text(await api.commit((tx) => resultText(tx, child, api.now()), call));
      if (child.stoppedAt !== undefined) return text(`${child.id} was stopped; start a new child.`);
      if (args.action === "interrupt") {
        if (child.since === undefined) return text(`${child.id} is in no tool call: it waits for a message.`);
        return text(await host.interrupt(childInfo(child)));
      }
      if (!args.message?.trim()) return text("send needs a message.");
      type Sent = { refused: string } | { full: ChildInfo[] } | { busy: boolean; info: ChildInfo };
      const sent = await api.commit(async (tx): Promise<Sent> => {
        const state = await tx.doc(Children, ROOT_CONVERSATION_ID);
        const record = state.children[child.id]!;
        // Again in the commit: a stop or other children may have come since the look above.
        if (record.stoppedAt !== undefined) return { refused: `${child.id} was stopped; start a new child.` };
        const busy = record.since !== undefined;
        if (!busy) {
          const full = atCap(state);
          if (full !== undefined) return { full };
        }
        await deliver(tx, state, record, `[message from ${from}]\n${args.message}`, api.now());
        return { busy, info: childInfo(record) };
      }, call);
      if ("refused" in sent) return text(sent.refused);
      if ("full" in sent) return text(await capText("Not sent", sent.full, api.now()));
      if (!sent.busy) return text(`Sent to ${child.id}.`);
      // A child takes a message only between steps. The message may not be in the child's queue yet, so the count of
      // waiting messages is left out here.
      const busy = await withActivity(sent.info);
      const activity = busy.activity && { ...busy.activity, waiting: 0 };
      const when = activity && activity.calls.length === 0 ? "when it answers, or when the tool calls of its next step end" : "when its current tool calls end";
      return text(`Sent to ${child.id}; it takes the message ${when}.\n${describeChild({ ...busy, ...(activity ? { activity } : {}) }, api.now())}`);
    },
  });

  return { extension: defineExtension({ name: "tasks", tasks: [Anchor, Reporter], tools: [task] }), start };
}

/** The wake ID of a reporter's failure wake, also its request ID in the main agent's queue, by which a stop finds it. */
export function failureRequestId(reporter: string | TaskId): string {
  return `child-end:${String(reporter)}`;
}
