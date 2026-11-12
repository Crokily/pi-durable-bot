import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, type ModelThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type Extension,
  type InboxState,
  type JsonObject,
  type LiveState,
  type ModelRef,
  type TaskId,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";

// Children: agents the main agent starts for longer work, so it stays free to talk. A child is a conversation of its
// own that starts with only the brief, and has read, write, edit, bash, screen and codemode: not the channel actions
// send, react and call, and not the task tool. When it ends, its final message goes back to the main agent as a wake,
// once, also across restarts. Built as pi-durable's example of background subagents: an anchor task owns each child's
// conversation, and a reporter task delivers each message to the child and reports its answer.

/** A child, as the main conversation's children document keeps it. */
export type ChildRecord = {
  id: string;
  title: string;
  conversationId: ConversationId;
  /** The place the child works for, when there is one. */
  place?: string;
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
  /** Every reporter made for it, to find its reports that still wait in the main agent's inbox when it is stopped. */
  reporters: string[];
  /** Answers already reported: several messages can end in one answer, which is reported once. */
  reported: EntryId[];
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
  thinking: ModelThinkingLevel;
  startedAt: number;
  /** Since when it works, while it works. */
  since?: number;
  endedAt?: number;
  stoppedAt?: number;
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
    thinking: record.thinking,
    startedAt: record.startedAt,
    ...(record.since === undefined ? {} : { since: record.since }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
  };
}

/** What a child ended with, for the main agent's wake. */
export interface ChildEnd {
  /** The reporter's task ID: one report per reporter, also when its phase runs again after a restart. */
  reporter: string;
  child: ChildInfo;
  /** "answered": its final message; "failed": why it could not answer, and no message. */
  status: "answered" | "failed";
  text: string;
}

export interface ChildrenHost {
  /** The model of children now, and the thinking level of a new child when the main agent does not choose one. */
  agent(): { model: ModelRef; thinkingLevel: ModelThinkingLevel };
  /** How many children may work at once. */
  max(): number;
  /** The place the main agent works on now, when it works on one. */
  place(): string | undefined;
  /** The main agent's extensions that a child does not get, and the child's own. */
  extensions(): { child: readonly Extension[] };
  /** Hand a child's end to the main agent as a wake. The same reporter is one wake. Returns its submission ID. */
  ended(end: ChildEnd, context: Context): Promise<string>;
  /** Withdraw the main agent's queued submission, for a report of a child stopped in the meantime. */
  withdraw(submission: string): Promise<void>;
  /** Stop a child: no result comes back from it. Returns what happened, for the model. */
  stop(id: string): Promise<string>;
  /** What a working child does now, read from its conversation; undefined when it cannot be read. */
  activity(conversationId: ConversationId): Promise<ChildActivity | undefined>;
  /** End the tool calls a working child is in; the child goes on. Returns what happened, for the model. */
  interrupt(child: ChildInfo): Promise<string>;
  /** A child's work ended: it holds nothing any more, such as the screen. */
  settled(conversationId: string): void;
  /** Crash tests: just before and just after a report is handed to the main agent. */
  beforeReport?(reporter: string): void;
  afterReport?(reporter: string): void;
}

/** How long, in words: "12 s", "4 min", "2.5 h". */
export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
}

/**
 * A child, for the task tool, wakes and pots children: one line, with its thinking level for the lists, and for a child
 * that works and whose activity was read, indented lines on what it does now.
 */
export function describeChild(child: ChildInfo, now = Date.now(), options: { thinking?: boolean } = {}): string {
  const state =
    child.stoppedAt !== undefined
      ? `stopped ${age(now - child.stoppedAt)} ago`
      : child.since !== undefined
        ? `working, for ${age(now - child.since)}`
        : `ended ${age(now - (child.endedAt ?? child.startedAt))} ago, waits for a message`;
  const line = `${child.id} "${child.title}": ${state}${child.place ? `, for ${child.place}` : ""}${options.thinking ? `, thinking ${child.thinking}` : ""}`;
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

/**
 * The task extension of the main agent: the task tool and the tasks behind it. Installed once per bot, so pending
 * reporters go on after a restart.
 */
export function childrenExtension(host: ChildrenHost): Extension {
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

  type ReporterInput = { child: string; conversationId: ConversationId; message: string };
  type ReporterState = { phase: "deliver" } | { phase: "report"; end?: { status: "answered" | "failed"; text: string } };

  /** The reporter ends: it is no longer live, and its child waits for a message once no other reporter is live. */
  const finish = (state: ChildrenState, reporter: string, now: number) => {
    const id = state.live[reporter];
    delete state.live[reporter];
    const child = id === undefined ? undefined : state.children[id];
    if (!child || Object.values(state.live).includes(child.id)) return;
    if (child.since !== undefined && child.stoppedAt === undefined) child.endedAt = now;
    delete child.since;
  };

  // Delivers one message to a child, waits for its answer and reports it to the main agent. A background task of the
  // main conversation; each phase ends with a checkpoint, and request IDs make a phase that runs again after a restart
  // find the first submission, so the child gets the message once and the main agent the report once.
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "bot.child-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { conversationId, message } = reporter.input;
        // Stopped before its message reached the child: the child does not get it.
        const state = await runtime.snapshot(Children, runtime.conversationId, context);
        if (state?.children[reporter.input.child]?.stoppedAt !== undefined) {
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
        // One commit decides the report and records the answer as reported, so a restart does not decide again.
        await runtime.commit(async (tx) => {
          const next = (end?: { status: "answered" | "failed"; text: string }) => ({
            status: "running" as const,
            checkpoint: end ? { phase: "report" as const, end } : { phase: "report" as const },
          });
          const state = await tx.doc(Children, runtime.conversationId);
          const record = state.children[reporter.input.child];
          // Stopped, or withdrawn while queued: nothing to report.
          if (!record || record.stoppedAt !== undefined) return next();
          if (settled.status === "unanswered") {
            if (settled.reason === "aborted") return next();
            const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
            return next({ status: "failed", text: `${settled.reason}${detail}` });
          }
          if (settled.type !== "input" || record.reported.includes(settled.answer)) return next();
          record.reported.push(settled.answer);
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
          return next({ status: "answered", text: textOf(answer) });
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const end = reporter.state.checkpoint.end;
        const record = () => runtime.snapshot(Children, runtime.conversationId, context).then((state) => state?.children[reporter.input.child]);
        const before = await record();
        if (end && before && before.stoppedAt === undefined) {
          host.beforeReport?.(String(reporter.id));
          const submission = await host.ended({ reporter: String(reporter.id), child: childInfo(before), ...end }, context);
          host.afterReport?.(String(reporter.id));
          // A stop that came in the meantime did not find this report yet; it must not reach the main agent.
          if ((await record())?.stoppedAt !== undefined) await host.withdraw(submission);
        }
        await runtime.commit(async (tx) => {
          finish(await tx.doc(Children, runtime.conversationId), String(reporter.id), runtime.now());
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (reporter, runtime, context) =>
      runtime.commit(async (tx) => {
        finish(await tx.doc(Children, runtime.conversationId), String(reporter.id), runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
  const isWorking = (child: Readonly<ChildRecord> | ChildInfo) => child.since !== undefined && child.stoppedAt === undefined;
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
  const background = { ownership: { kind: "conversation" }, background: true } as const;

  const task = defineTool({
    name: "task",
    description:
      "Children: agents that work in the background, so you stay free to talk. action start: a new child with a short title and a brief " +
      "(place: the address of the place it works for, by default the place you work on; thinking: its thinking level, high, xhigh or max, " +
      "by default childThinking in bot.json); it starts with an empty conversation and the brief, and keeps its thinking level. " +
      "list: your children, and what each one that works does now. send: a message to a child (child: its ID); a child that waits starts on it " +
      "at once, and one that works takes it when its current tool calls end. interrupt: ends the tool calls a child is in, such as a command " +
      "that hangs; the child goes on, sees that they were aborted, and takes the messages that wait for it. " +
      "stop: stops a child and what it runs; nothing comes back from it then. A child's final message comes back to you as a wake.",
    parameters: obj(
      {
        action: StringEnum(["start", "list", "send", "interrupt", "stop"] as const),
        title: opt(str()),
        brief: opt(str()),
        place: opt(str()),
        thinking: opt(StringEnum(["high", "xhigh", "max"] as const)),
        child: opt(str()),
        message: opt(str()),
      },
      { open: true },
    ),
    // A call cut off by a crash is not run again: a repeated start would start a second child. The model sees that the
    // call was interrupted and can look with list.
    replay: "unsafe",
    execute: async (args, api, call) => {
      const state = (await api.snapshot(Children, api.conversationId, call)) ?? { next: 1, children: {}, live: {} };
      const all = Object.values(state.children).map(childInfo);
      const working = all.filter(isWorking);
      if (args.action === "list") {
        if (all.length === 0) return text("No children.");
        const others = all.filter((child) => !working.includes(child)).slice(-20);
        const described = [...(await Promise.all(working.map(withActivity))), ...others];
        return text(described.map((child) => describeChild(child, api.now(), { thinking: true })).join("\n"));
      }
      if (args.action === "start") {
        if (!args.title?.trim() || !args.brief?.trim()) return text("start needs a title and a brief.");
        const place = args.place?.trim() || host.place();
        const { model, thinkingLevel: fallback } = host.agent();
        // As pi does, a level the model does not have becomes the nearest one it has, at each request (pi-ai).
        const thinkingLevel = args.thinking ?? fallback;
        const started = await api.commit(async (tx) => {
          const state = await tx.doc(Children, api.conversationId);
          const full = atCap(state);
          if (full !== undefined) return { full, id: undefined };
          const id = `c${state.next++}`;
          const anchor = await tx.createTask(Anchor, null, background);
          const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          // The child's tools and prompt, and the model for children.
          await configure(tx, conversation.id, { extensions: [...host.extensions().child], model, thinkingLevel });
          const now = api.now();
          const reporter = await tx.createTask(Reporter, { child: id, conversationId: conversation.id, message: `[brief from the main agent]\n${args.brief}` }, background);
          state.children[id] = {
            id,
            title: args.title!.trim(),
            conversationId: conversation.id,
            ...(place ? { place } : {}),
            thinking: thinkingLevel,
            startedAt: now,
            since: now,
            reporters: [String(reporter)],
            reported: [],
          };
          state.live[String(reporter)] = id;
          return { id, full: undefined };
        }, call);
        if (started.id === undefined) return text(await capText("Not started", started.full, api.now()));
        return text(
          `Started ${started.id} ("${args.title!.trim()}")${place ? ` for ${place}` : ""}, thinking ${thinkingLevel}. Its final message comes back to you as a wake.`,
        );
      }
      if (!args.child) return text(`${args.action} needs a child ID.`);
      const child = Object.hasOwn(state.children, args.child) ? state.children[args.child] : undefined;
      if (!child) return text(`No child ${args.child}.`);
      if (args.action === "stop") return text(await host.stop(child.id));
      if (child.stoppedAt !== undefined) return text(`${child.id} was stopped; start a new child.`);
      if (args.action === "interrupt") {
        if (child.since === undefined) return text(`${child.id} is in no tool call: it waits for a message.`);
        return text(await host.interrupt(childInfo(child)));
      }
      if (!args.message?.trim()) return text("send needs a message.");
      type Sent = { refused: string } | { full: ChildInfo[] } | { busy: boolean; info: ChildInfo };
      const sent = await api.commit(async (tx): Promise<Sent> => {
        const state = await tx.doc(Children, api.conversationId);
        const record = state.children[child.id]!;
        // Again in the commit: a stop or other children may have come since the look above.
        if (record.stoppedAt !== undefined) return { refused: `${child.id} was stopped; start a new child.` };
        const busy = record.since !== undefined;
        if (!busy) {
          const full = atCap(state);
          if (full !== undefined) return { full };
        }
        const reporter = await tx.createTask(
          Reporter,
          { child: child.id, conversationId: record.conversationId, message: `[message from the main agent]\n${args.message}` },
          background,
        );
        record.reporters.push(String(reporter));
        record.since ??= api.now();
        state.live[String(reporter)] = child.id;
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

  return defineExtension({ name: "tasks", tasks: [Anchor, Reporter], tools: [task] });
}

/** The wake ID of a reporter's report to the main agent, also its request ID there, by which a stop finds it. */
export function reportRequestId(reporter: string | TaskId): string {
  return `child-end:${String(reporter)}`;
}
