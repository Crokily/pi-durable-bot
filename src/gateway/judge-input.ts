// The judge's view of a place: its earlier messages and the new events, by thread, with whom each message answers.
import type { JudgeInput, JudgeItem, JudgeMessage, JudgeThread } from "../core/judge.ts";
import type { LoggedMessage } from "./log.ts";

/** A new event, as describe() in the waker gives it, with where it is. */
export interface NewEvent {
  readonly item: Omit<JudgeItem, "threadStartedBy" | "replyingTo">;
  readonly kind: string;
  readonly person: string | null;
  readonly thread: string | null;
  readonly at: number;
  /** The logged message the event is, or is about. */
  readonly message?: LoggedMessage;
}

/** The bot's own messages, as one person. */
const ME = "\u0000me";

interface Entry {
  readonly at: number;
  readonly person: string;
  readonly author: string;
  /** The message it answers, where the platform says so. */
  readonly replyTo: string | null;
  /** Gets "replying to": a message, or a new message. */
  readonly answers: boolean;
  readonly isRoot: boolean;
  readonly shown: Omit<JudgeMessage, "replyingTo">;
  readonly event?: number;
  replyingTo?: string;
}

/** The addresses the input needs beyond the earlier messages: the start of each thread and each message answered. */
export function judgeInputNeeds(earlier: readonly LoggedMessage[], events: readonly NewEvent[]): string[] {
  const have = new Set(earlier.map((m) => m.address));
  const need = new Set<string>();
  for (const m of [...earlier, ...events.flatMap((event) => (event.message ? [event.message] : []))]) {
    if (m.reply_to) need.add(m.reply_to);
  }
  for (const thread of [...earlier.map((m) => m.thread), ...events.map((event) => event.thread)]) if (thread) need.add(thread);
  return [...need].filter((address) => !have.has(address));
}

/**
 * The judge's input. earlier: the place's last messages before the events, oldest first. known: other logged messages,
 * by address (from judgeInputNeeds). The start of a thread with new events is shown with it when it is older than the
 * earlier messages. A message answers the message the platform says it does; otherwise, in a thread, the last earlier
 * message in the thread by someone else.
 */
export function judgeInput(
  bot: { name: string; responsibilities: string; place: string },
  earlier: readonly LoggedMessage[],
  known: ReadonlyMap<string, LoggedMessage>,
  events: readonly NewEvent[],
): JudgeInput {
  const authorOf = (m: LoggedMessage) => (m.from_me ? `${bot.name} (me)` : (m.person_name ?? m.person ?? "unknown"));
  const shown = new Map(earlier.map((m) => [m.address, m]));
  const messageOf = (address: string) => shown.get(address) ?? known.get(address);
  const firstAt = events[0]?.at ?? Infinity;
  const eventAddresses = new Set(events.flatMap((event) => (event.message?.address ? [event.message.address] : [])));
  // The start of each thread with new events, when the earlier messages do not reach back to it.
  const starts: LoggedMessage[] = [];
  for (const event of events) {
    const root = event.thread ? known.get(event.thread) : undefined;
    if (root && !shown.has(root.address) && !eventAddresses.has(root.address) && root.at < firstAt && !starts.includes(root)) starts.push(root);
  }

  const groups = new Map<string, { thread: string | null; entries: Entry[] }>();
  const add = (key: string, thread: string | null, entry: Entry) => {
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { thread, entries: [] }));
    group.entries.push(entry);
  };
  for (const m of [...starts, ...earlier]) {
    add(m.thread ?? `message:${m.address}`, m.thread, {
      at: m.at,
      person: m.from_me ? ME : (m.person ?? authorOf(m)),
      author: authorOf(m),
      replyTo: m.reply_to,
      answers: true,
      isRoot: m.thread === m.address,
      shown: { ...(m.deleted_at ? { what: "message (since deleted)" } : {}), author: authorOf(m), time: new Date(m.at).toISOString(), text: m.text },
    });
  }
  events.forEach((event, index) => {
    const { what, author, time, text } = event.item;
    const message = event.kind === "message";
    add(event.thread ?? `event:${index}`, event.thread, {
      at: event.at,
      person: event.person ?? author,
      author,
      replyTo: message ? (event.message?.reply_to ?? null) : null,
      answers: message,
      isRoot: message && event.thread !== null && event.thread === event.message?.address,
      shown: { new: true, ...(what !== "new message" ? { what } : {}), author, time, ...(text !== undefined ? { text } : {}) },
      event: index,
    });
  });

  const threads: { startedBy?: string; hasNew: boolean; last: number; entries: Entry[] }[] = [];
  for (const group of groups.values()) {
    const entries = group.entries.sort((a, b) => a.at - b.at);
    let startedBy: string | undefined;
    if (group.thread) {
      const root = messageOf(group.thread);
      startedBy = root ? authorOf(root) : entries[0]!.author;
    }
    entries.forEach((entry, i) => {
      if (!entry.answers) return;
      const answered = entry.replyTo ? messageOf(entry.replyTo) : undefined;
      if (answered) return void (entry.replyingTo = authorOf(answered));
      if (!group.thread || entry.isRoot) return;
      for (let j = i - 1; j >= 0; j--) if (entries[j]!.person !== entry.person) return void (entry.replyingTo = entries[j]!.author);
    });
    threads.push({
      ...(startedBy !== undefined ? { startedBy } : {}),
      hasNew: entries.some((entry) => entry.event !== undefined),
      last: Math.max(...entries.map((entry) => entry.at)),
      entries,
    });
  }
  threads.sort((a, b) => Number(a.hasNew) - Number(b.hasNew) || a.last - b.last);

  const latest: JudgeItem[] = new Array(events.length);
  const conversation: JudgeThread[] = threads.map((thread) => ({
    ...(thread.startedBy !== undefined ? { startedBy: thread.startedBy } : {}),
    hasNew: thread.hasNew,
    messages: thread.entries.map((entry) => {
      if (entry.event !== undefined) {
        latest[entry.event] = {
          ...events[entry.event]!.item,
          ...(thread.startedBy !== undefined ? { threadStartedBy: thread.startedBy } : {}),
          ...(entry.replyingTo !== undefined ? { replyingTo: entry.replyingTo } : {}),
        };
      }
      const { new: isNew, what, author, time, text } = entry.shown;
      return {
        ...(isNew ? { new: true } : {}),
        ...(what !== undefined ? { what } : {}),
        author,
        ...(entry.replyingTo !== undefined ? { replyingTo: entry.replyingTo } : {}),
        time,
        ...(text !== undefined ? { text } : {}),
      };
    }),
  }));
  return { ...bot, conversation, latest };
}
