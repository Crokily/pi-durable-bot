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
/** The seq of an event that is not a logged message: after the messages at its time. */
const LAST = Number.MAX_SAFE_INTEGER;

interface Entry {
  readonly at: number;
  /** The log's order of messages at the same time. */
  readonly seq: number;
  readonly person: string;
  readonly author: string;
  /** The message it answers, where the platform says so. */
  readonly replyTo: string | null;
  /** A message (not an edit, a reaction or another event): it answers something, and can be answered. */
  readonly isMessage: boolean;
  /** A later message can follow it: a message whose time is when it was written (not one the log has from an edit). */
  readonly canFollow: boolean;
  readonly isRoot: boolean;
  /** Among the place's last messages or the new events; else from before them, with messages between that are not shown. */
  readonly inWindow: boolean;
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
export function judgeInputFollows(events: readonly NewEvent[]): { thread: string; at: number; seq: number | undefined; person: string | null }[] {
  return events.flatMap((event) =>
    event.kind === "message" && event.thread && event.thread !== event.message?.address
      ? [{ thread: event.thread, at: event.at, seq: event.message?.seq, person: event.person }]
      : [],
  );
}

/** A message the log has only from an edit of it: its time is the edit's. */
const fromEdit = (m: LoggedMessage) => m.edited_at !== null && m.edited_at === m.at;
/** The seq of a new event: its message's, for a new message. */
const seqOf = (event: NewEvent) => (event.kind === "message" ? (event.message?.seq ?? LAST) : LAST);

/**
 * The judge's input. earlier: the place's last messages before the events, oldest first. known: other logged messages,
 * by address (from judgeInputNeeds and judgeInputFollows). The messages of a thread with new events that are older than
 * the earlier messages (its start, the message a new one follows) are shown with it. A message answers the message the
 * platform says it does; otherwise, in a thread, the last earlier message in the thread by someone else. What the log
 * does not have is unknown (null), not guessed. An earlier message gets none when messages of its thread before it are
 * not shown.
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
  // A Telegram reply's thread is the message it answers, whatever thread that message is in: that one is shown in each
  // thread it is in, also when it is among the earlier messages in another thread.
  const older = new Map<string, { thread: string; message: LoggedMessage }>();
  for (const event of events) {
    const thread = event.thread;
    if (!thread) continue;
    for (const m of [...known.values(), ...visible]) {
      const before = m.at < event.at || (m.at === event.at && m.seq < seqOf(event));
      const key = `${thread}\u0000${m.address}`;
      if ((m.address === thread || m.thread === thread) && before && !newMessages.has(m.address) && !older.has(key) && !(shown.has(m.address) && m.thread === thread)) {
        older.set(key, { thread, message: m });
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
      seq: m.seq,
      person: m.from_me ? ME : (m.person ?? authorOf(m)),
      author: authorOf(m),
      replyTo: m.reply_to,
      isMessage: true,
      canFollow: !fromEdit(m),
      isRoot: thread === m.address,
      inWindow: shown.has(m.address),
      shown: { ...(m.deleted_at ? { what: "message (since deleted)" } : {}), author: authorOf(m), time: new Date(m.at).toISOString(), text: m.text },
    });
  }
  events.forEach((event, index) => {
    const { what, author, time, text } = event.item;
    const message = event.kind === "message";
    add(event.thread ?? `event:${index}`, event.thread, {
      at: event.at,
      seq: seqOf(event),
      person: event.person ?? author,
      author,
      replyTo: message ? (event.message?.reply_to ?? null) : null,
      isMessage: message,
      canFollow: message,
      isRoot: message && event.thread !== null && event.thread === event.message?.address,
      inWindow: true,
      shown: { new: true, ...(what !== "new message" ? { what } : {}), author, time, ...(text !== undefined ? { text } : {}) },
      event: index,
    });
  });

  const threads: { startedBy?: string | null; hasNew: boolean; last: Entry; entries: Entry[] }[] = [];
  for (const group of groups.values()) {
    const entries = group.entries.sort(inOrder);
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
      // For a new message, the input has the one it follows (judgeInputFollows). An earlier one can follow a message
      // that is not shown: past the place's last messages, the thread's messages are not all shown. It gets none.
      for (let j = i - 1; j >= 0; j--) {
        const before = entries[j]!;
        if (entry.event === undefined && !before.inWindow) return;
        if (before.canFollow && before.person !== entry.person) return void (entry.replyingTo = before.author);
      }
      // No one else wrote in the thread before it, as far as the log goes. Without the thread's start, that is unknown.
      if (!root) entry.replyingTo = null;
    });
    threads.push({
      ...(startedBy !== undefined ? { startedBy } : {}),
      hasNew: entries.some((entry) => entry.event !== undefined),
      last: entries.at(-1)!,
      entries,
    });
  }
  threads.sort((a, b) => Number(a.hasNew) - Number(b.hasNew) || inOrder(a.last, b.last));

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

/** Entries in time order; at the same time, in the log's order. */
const inOrder = (a: Entry, b: Entry) => a.at - b.at || a.seq - b.seq;
