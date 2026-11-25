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
  /** A message (not an edit, a reaction or another event): it answers something, and can be answered. */
  readonly isMessage: boolean;
  readonly isRoot: boolean;
  readonly shown: Omit<JudgeMessage, "replyingTo">;
  readonly event?: number;
  /** null: it answers a message that is not in the log. */
  replyingTo?: string | null;
}

/**
 * The addresses the input needs beyond the earlier messages and those known already: the start of each thread and each
 * message answered.
 */
export function judgeInputNeeds(earlier: readonly LoggedMessage[], events: readonly NewEvent[], known: readonly LoggedMessage[] = []): string[] {
  const have = new Set([...earlier, ...known].map((m) => m.address));
  const need = new Set<string>();
  for (const m of [...earlier, ...known, ...events.flatMap((event) => (event.message ? [event.message] : []))]) {
    if (m.reply_to) need.add(m.reply_to);
  }
  for (const thread of [...earlier.map((m) => m.thread), ...events.map((event) => event.thread)]) if (thread) need.add(thread);
  return [...need].filter((address) => !have.has(address));
}

/**
 * For each new message in a thread: the thread, its time and author. The input needs the last message in the thread
 * before it by someone else, which can be older than the earlier messages when someone takes up an old thread.
 */
export function judgeInputFollows(events: readonly NewEvent[]): { thread: string; at: number; person: string | null }[] {
  return events.flatMap((event) =>
    event.kind === "message" && event.thread && event.thread !== event.message?.address ? [{ thread: event.thread, at: event.at, person: event.person }] : [],
  );
}

/**
 * The judge's input. earlier: the place's last messages before the events, oldest first. known: other logged messages,
 * by address (from judgeInputNeeds and judgeInputFollows). The messages of a thread with new events that are older than
 * the earlier messages (its start, the message a new one follows) are shown with it. A message answers the message the
 * platform says it does; otherwise, in a thread, the last earlier message in the thread by someone else. What the log
 * does not have is unknown (null), not guessed.
 */
export function judgeInput(
  bot: { name: string; responsibilities: string; place: string },
  earlier: readonly LoggedMessage[],
  known: ReadonlyMap<string, LoggedMessage>,
  events: readonly NewEvent[],
): JudgeInput {
  const authorOf = (m: LoggedMessage) => (m.from_me ? `${bot.name} (me)` : (m.person_name ?? m.person ?? "unknown"));
  // A new message is shown once, as new, also when the log had it before the events (a backfill).
  const newMessages = new Set(events.flatMap((event) => (event.kind === "message" && event.message ? [event.message.address] : [])));
  const visible = earlier.filter((m) => !newMessages.has(m.address));
  const shown = new Map(visible.map((m) => [m.address, m]));
  const ofEvents = new Map(events.flatMap((event) => (event.message ? [[event.message.address, event.message] as const] : [])));
  const messageOf = (address: string) => shown.get(address) ?? known.get(address) ?? ofEvents.get(address);
  // The messages of each thread with new events that the earlier messages do not reach back to, in the events' thread.
  // A Telegram reply's thread is the message it answers, whatever thread that message is in.
  const older = new Map<string, { thread: string; message: LoggedMessage }>();
  for (const event of events) {
    const thread = event.thread;
    if (!thread) continue;
    for (const m of known.values()) {
      if ((m.address === thread || m.thread === thread) && m.at < event.at && !shown.has(m.address) && !newMessages.has(m.address) && !older.has(m.address)) {
        older.set(m.address, { thread, message: m });
      }
    }
  }

  const groups = new Map<string, { thread: string | null; entries: Entry[] }>();
  const add = (key: string, thread: string | null, entry: Entry) => {
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { thread, entries: [] }));
    group.entries.push(entry);
  };
  for (const { thread, message: m } of [...older.values(), ...visible.map((m) => ({ thread: m.thread, message: m }))]) {
    add(thread ?? `message:${m.address}`, thread, {
      at: m.at,
      person: m.from_me ? ME : (m.person ?? authorOf(m)),
      author: authorOf(m),
      replyTo: m.reply_to,
      isMessage: true,
      isRoot: thread === m.address,
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
      isMessage: message,
      isRoot: message && event.thread !== null && event.thread === event.message?.address,
      shown: { new: true, ...(what !== "new message" ? { what } : {}), author, time, ...(text !== undefined ? { text } : {}) },
      event: index,
    });
  });

  const threads: { startedBy?: string | null; hasNew: boolean; last: number; entries: Entry[] }[] = [];
  for (const group of groups.values()) {
    const entries = group.entries.sort((a, b) => a.at - b.at);
    const root = group.thread ? messageOf(group.thread) : undefined;
    // null: a thread whose start the log does not have.
    const startedBy = group.thread ? (root ? authorOf(root) : null) : undefined;
    entries.forEach((entry, i) => {
      if (!entry.isMessage) return;
      if (entry.replyTo) {
        const answered = messageOf(entry.replyTo);
        return void (entry.replyingTo = answered ? authorOf(answered) : null);
      }
      if (!group.thread || entry.isRoot) return;
      for (let j = i - 1; j >= 0; j--) {
        const before = entries[j]!;
        if (before.isMessage && before.person !== entry.person) return void (entry.replyingTo = before.author);
      }
      // No one else wrote in the thread before it, as far as the log goes. Without the thread's start, that is unknown.
      if (!root) entry.replyingTo = null;
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
