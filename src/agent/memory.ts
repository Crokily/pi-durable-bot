import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ContextView,
  type Conversation,
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  type EntryId,
  type Extension,
  hook,
  type ModelRef,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  type Task,
  type TaskId,
  type TaskRuntime,
  ToolTask,
  type Tx,
} from "@earendil-works/pi-durable";

// The memory pass, as in Claude Code: after each run of the main conversation, a short first look asks whether the run
// holds something worth keeping. If so, a fork of the main conversation at the run's answer, with the main
// conversation's provider session, gets one more message: what to save. Its request starts as the main agent's last
// one did, so the provider's prompt cache serves it. Nothing it does reaches the chat or the main conversation; the
// bot applies its answer to the memory. A background task of the main conversation, so it never holds up the work,
// and it goes on after a restart.

/** What the bot gives the memory pass: the texts, and where its answer goes. */
export interface MemoryHost {
  /** The model of the main agent now. */
  model(): ModelRef;
  /** The first look's system prompt. */
  firstLook: string;
  /** The message to the fork: the memory now and what to answer. messages: how many messages the run added. */
  instruction(messages: number): Promise<string>;
  /** Apply the pass's answer. The same key is applied once, also when the pass runs again after a restart. */
  apply(key: string, answer: string): Promise<void>;
  log(message: string, data?: Record<string, unknown>): void;
  /** Crash tests: called right after the answer was applied, before the pass ended. */
  afterApply?(key: string): void;
}

/** The main conversation's memory passes: up to where they reach, the one that runs, and the next one. */
type MemoryState = {
  /** The answer entry the last pass started for. */
  covered?: number;
  running?: string;
  /** An answer that came while a pass ran: the next pass starts for it. */
  waiting?: number;
};

const MemoryDoc = defineDoc<MemoryState>({
  checkpointWhen: () => false,
  kind: "bot.memory",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

type PassInput = { at: number; since?: number };
type PassState = { phase: "look" } | { phase: "fork" } | { phase: "answer"; fork: number };
type Runtime = TaskRuntime<PassInput, PassState, null, object>;

/** The first look's answer is cut to this many characters of the run, the newest. */
const FIRST_LOOK_CHARS = 20_000;
const background = { ownership: { kind: "conversation" }, background: true } as const;

/** The message to the fork starts with this, so a reader of the requests knows it. */
export const MEMORY_PASS_MARK = "[memory pass]";

export function memoryExtensions(host: MemoryHost): {
  /** The pass's task, for the main agent's registry. */
  tasks: Extension;
  /** Selected in the fork only: no tool runs there. */
  fork: Extension;
  /** A run of the main conversation answered with entry `at`: a pass for it, now or after the one that runs. */
  queue(root: Conversation, at: EntryId, context: Context): Promise<void>;
} {
  const fork = defineExtension({
    name: "memory-pass",
    hooks: [hook(ToolTask, { beforeTool: () => ({ block: "No tool runs in the memory pass: answer with the JSON only, or with Nothing to save." }) })],
  });

  const start = async (tx: Tx, state: MemoryState, at: number) => {
    const id = await tx.createTask(Pass, { at, ...(state.covered === undefined ? {} : { since: state.covered }) }, background);
    state.running = String(id);
    state.covered = at;
    delete state.waiting;
  };

  /** End the pass, and start the one that waits. */
  const end = (id: TaskId, runtime: Runtime, context: Context, aborted = false) =>
    runtime.commit(async (tx) => {
      const state = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      if (state.running === String(id)) {
        delete state.running;
        if (state.waiting !== undefined) await start(tx, state, state.waiting);
      }
      return { status: "terminal", outcome: aborted ? { status: "aborted" } : { status: "completed", result: null } };
    }, context);

  /** A phase that throws would leave the pass running for good, and no pass after it would start: it ends instead. */
  const guarded = async (id: TaskId, runtime: Runtime, context: Context, phase: () => Promise<void>) => {
    try {
      await phase();
    } catch (error) {
      // The gateway stops: the phase runs again at the next start.
      if (runtime.signal.aborted) throw error;
      host.log("memory pass could not finish", { error: String(error) });
      await end(id, runtime, context);
    }
  };

  const Pass: Task<PassInput, PassState, null, object> = defineTask<PassInput, PassState, null>({
    name: "bot.memory-pass",
    version: 1,
    initial: () => ({ phase: "look" }),
    phases: {
      look: (pass, runtime, context) =>
        guarded(pass.id, runtime, context, async () => {
          // A first look that ran before a restart counts: the model is not asked again, and it may answer otherwise.
          const verdict = (await runtime.memo<string>("look", context)) ?? (await runtime.memo("look", await firstLook(runtime, pass.input, context), context));
          if (verdict === "no") return end(pass.id, runtime, context);
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fork" } }), context);
        }),
      fork: (pass, runtime, context) =>
        guarded(pass.id, runtime, context, () =>
          runtime.commit(async (tx) => {
            const conversation = await tx.forkConversation(ROOT_CONVERSATION_ID, pass.input.at as EntryId, { ownership: { kind: "task", taskId: pass.id } });
            // pi-durable gives a fork a session of its own; with the main conversation's, the provider finds its cache.
            (await tx.doc(ProviderDoc, conversation.id)).sessionId = (await tx.doc(ProviderDoc, ROOT_CONVERSATION_ID)).sessionId;
            // Only a hook: the sections and tools stay those of the main conversation, so the start of the request does.
            await configure(tx, conversation.id, { extensions: { add: [fork] } });
            return { status: "running", checkpoint: { phase: "answer", fork: Number(conversation.id) } };
          }, context),
        ),
      answer: (pass, runtime, context) =>
        guarded(pass.id, runtime, context, async () => {
          const checkpoint = pass.state.checkpoint as Extract<PassState, { phase: "answer" }>;
          const conversation = await runtime.conversation(checkpoint.fork as ConversationId, context);
          if (!conversation) return end(pass.id, runtime, context);
          const view = await runtime.context(ROOT_CONVERSATION_ID, context, { at: pass.input.at as EntryId });
          const content = `${MEMORY_PASS_MARK} ${await host.instruction(since(view, pass.input.since).length)}`;
          // The same request ID after a restart: the fork's first answer, not a second request.
          const submission = await conversation.submit(
            { type: "input", content, requestId: `memory:${String(pass.id)}`, whenBusy: "followUp", entry: { kind: "bot.memory-pass" } },
            context,
          );
          const settled = await submission.wait(context);
          if (settled.status === "done" && settled.type === "input") {
            const id = settled.answer;
            let answer = "";
            await runtime.commit(async (tx) => {
              answer = textOf((await tx.entry(AssistantEntry, id))?.model?.[0] as AssistantMessage | undefined);
              return undefined;
            }, context);
            await host.apply(String(pass.id), answer);
            host.afterApply?.(String(pass.id));
          } else {
            host.log("memory pass got no answer", { reason: settled.status === "unanswered" ? settled.reason : "no text" });
          }
          await end(pass.id, runtime, context);
        }),
    },
    abort: (pass, runtime, context) => end(pass.id, runtime, context, true),
  });

  /** Whether the run since the last pass holds something worth keeping: "yes", or "no" to skip the pass. */
  async function firstLook(
    runtime: Runtime,
    input: PassInput,
    context: Context,
  ): Promise<"yes" | "no"> {
    const messages = since(await runtime.context(ROOT_CONVERSATION_ID, context, { at: input.at as EntryId }), input.since);
    const excerpt = describe(messages).slice(-FIRST_LOOK_CHARS);
    if (!excerpt.trim()) return "no";
    const ref = host.model();
    const model = runtime.models.getModel(ref.provider, ref.modelId);
    // Without an answer, the pass is not skipped.
    if (!model) return "yes";
    try {
      // A short question: the lowest thinking level the model has.
      const levels = getSupportedThinkingLevels(model);
      const reasoning = (["minimal", "low"] as const).find((level) => levels.includes(level));
      const reply = await runtime.models.completeSimple(
        model,
        {
          systemPrompt: host.firstLook,
          messages: [{ role: "user", content: `<exchanges>\n${excerpt}\n</exchanges>\nAnswer with JSON only: {"write_likely": true} or {"write_likely": false}.`, timestamp: Date.now() }],
        },
        { ...(reasoning ? { reasoning } : {}), telemetry: context.telemetry, signal: runtime.signal },
      );
      const json = /\{[\s\S]*\}/.exec(textOf(reply))?.[0];
      const value = json ? (JSON.parse(json) as { write_likely?: unknown }).write_likely : undefined;
      if (typeof value === "boolean") return value ? "yes" : "no";
      host.log("memory pass: the first look gave no yes or no", { stopReason: reply.stopReason });
      return "yes";
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      host.log("memory pass: the first look could not answer", { error: String(error) });
      return "yes";
    }
  }

  return {
    tasks: defineExtension({ name: "memory", tasks: [Pass] }),
    fork,
    queue: (root, at, context) =>
      root.commit(async (tx) => {
        const state = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
        if (at <= Math.max(state.covered ?? 0, state.waiting ?? 0)) return;
        if (state.running !== undefined) {
          const running = await tx.task(Number(state.running) as TaskId);
          if (running && running.state.status !== "terminal" && running.state.status !== "completing") {
            state.waiting = at;
            return;
          }
        }
        await start(tx, state, at);
      }, context),
  };
}

/** The model messages of the context after entry `after`; all of them without it. */
function since(view: ContextView, after: number | undefined): Message[] {
  return view.entries.flatMap((entry, index) => (after === undefined || entry.id > after ? [...(view.contributions[index] ?? [])] : []));
}

/** The run as lines for the first look: what came in, what the agent said, and its tool calls; not the tool results. */
function describe(messages: readonly Message[]): string {
  const lines: string[] = [];
  const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}…` : text);
  for (const message of messages) {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text.trim()) lines.push(`Input: ${text.trim()}`);
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) lines.push(`You: ${part.text.trim()}`);
        if (part.type === "toolCall") lines.push(`You called ${part.name}: ${cut(JSON.stringify(part.arguments), 2_000)}`);
      }
    }
  }
  return lines.join("\n");
}

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The newest answer of the main conversation that ended a run, for a pass that the last process did not start. */
export async function lastAnswer(root: Conversation, context: Context): Promise<EntryId | undefined> {
  const page = await root.entries({}, 50, undefined, context);
  for (const entry of page.items) {
    if (!AssistantEntry.is(entry)) continue;
    const stop = (entry.model?.[0] as AssistantMessage | undefined)?.stopReason;
    if (stop === "stop" || stop === "length") return entry.id;
    if (stop === "toolUse") return undefined;
  }
  return undefined;
}
