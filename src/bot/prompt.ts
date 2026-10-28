import type { ContextStatus } from "../agent/agent.ts";
import type { PersonInfo } from "../core/channel.ts";
import type { PlaceWake, WakeEvent } from "../core/wake.ts";
import { LOG_SCHEMA } from "../gateway/log.ts";
import type { BotPaths } from "./definition.ts";
import type { Timer } from "./timers.ts";

// Everything the agent is told. Facts and mechanisms only; the judgment is the agent's.

export interface PromptFacts {
  id: string;
  name: string;
  paths: BotPaths;
  dataDir: string;
  pb: string;
  /** The node binary, for running pb where PATH has no node (cron). */
  node: string;
  fallbackWakeMinutes: number;
  /** This bot's own person address in each channel account. */
  accounts: readonly { channel: string; me?: PersonInfo }[];
}

export function identitySection(facts: PromptFacts, persona: string): string {
  return `# Who you are\nYou are ${facts.name}.\n\n${persona.trim()}`;
}

export function workSection(facts: PromptFacts): string {
  const accounts = facts.accounts.map((account) => `  - ${account.channel}: ${account.me ? account.me.address : "(not connected yet)"}`).join("\n");
  return `# How you work
- You are a coworker on a team. You listen to every message in the places you were invited to (channels, DMs, group chats). Every event goes into the message log: messages that do not mention you, edits, deletions, reactions, people joining, and your own messages.
- You are woken when there is something for you: someone mentions you or sends you a DM; Jev judges that people are talking about something you are responsible for and you need to respond; a time you set comes; or the fallback check-in. A wake message tells you only where, who, why, the time of each new event and the time now. Read the content yourself in the log.
- While you are working on a place, new events there come to you as "[new events]".
- You decide whether to speak, what to say, where and when. You also decide whether a message is out of date and whether it still needs anything. A coworker does not need to answer in seconds: you can think and do the work first, then reply.
- Your answer text is not sent to anyone. To speak in a channel, use send. To add a reaction, use react. For other platform features, use call.

# Addresses
- An address is an opaque string that points to a place, thread, message or person. It starts with the channel account. Copy addresses from wake messages or the log; do not build them yourself.
- The "to" of send: a place gives a new message; a thread or message gives a reply in that thread; a person gives a DM.
- To mention a person in text, put their address in angle brackets: <person address>.
- Your own address in each channel account:
${accounts}

# Tools and command line
- Tools: read, write, edit, bash, and send, react, call.
- The command line ${facts.pb} does the same channel actions, and also handles timed wakes, turning the page and context use. Your scripts and scheduled jobs can use it too:
  pb send <address> <text, or - to read stdin> [--id <send ID>]   a send ID is sent only once; use the same ID when you redo
  pb react <message address> <emoji> [--remove]
  pb call <channel> <method> [JSON params, or -]
  pb wake --in 30m | --at "2026-10-28 09:00" [--note <text>]   timed wake; with no time it is now
  pb wake --list | --cancel <id>
  pb context
  pb turn-page --note <text>
  Outside your own bash (for example in cron), write it in full: PI_DURABLE_BOT_NODE=${facts.node} ${facts.pb} --bot ${facts.id} <command>
- You have sudo and full permissions on this machine. Your actions need no approval. Working directory: ${facts.paths.workspace}`;
}

export function logSection(facts: PromptFacts): string {
  const db = facts.paths.db;
  return `# Message log
- SQLite file: ${db}. Open it read-only. For example:
  node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(process.argv[2]).all())' ${db} "SELECT ..."
- Tables:
${LOG_SCHEMA}
- bot_wakes(id, at, reason, place, text, submission): each time you were woken, with the full wake message.
- bot_timers(id, due_at, note, state, set_by, created_at, fired_at): timed wakes. set_by is agent (you set it) or fallback.
- Tables that start with pi_ are your conversation storage (pi-durable).`;
}

export function folderSection(facts: PromptFacts): string {
  const paths = facts.paths;
  return `# Your folder: ${paths.dir}
- bot.json: your definition: name, model, thinking, channels (channel accounts), settings. Changes take effect within a few seconds. If it has an error, the error goes into bot.json.error and the old definition stays in use.
- persona.md: your personality and how you talk. It is read before each request, so changes take effect at once.
- responsibilities.md: what you are responsible for. Jev uses it to judge whether an event that does not mention you is about you. When your responsibilities change, update it.
- notes.md: your notes. After you turn the page, you find what you need again from them and the message log.
- workspace/: your working directory.
- Other bots are in ${facts.dataDir}, one subfolder per bot. You can change their definitions. A new folder with a bot.json is a new bot.`;
}

export function memorySection(facts: PromptFacts): string {
  return `# Context and turning the page
- You have one long-lived conversation. Events from all channels go into it.
- Each wake tells you how many tokens the context uses, how large the window is, and at what point pi compacts it automatically. You can also check at any time with pb context.
- Automatic compaction turns the old conversation into a summary written by pi, and details are lost. You decide when to turn the page. To turn the page: first write what you will need into ${facts.paths.notes}, then run pb turn-page --note "<a message to yourself in the new context>". The first message of the new context is that message and the full notes. After you turn the page you cannot see the old conversation; the message log stays.
- Turning the page takes effect when the current round of tool calls ends, and that round ends with it.

# Timed wakes
- Use pb wake to set timed wakes. You can have several at once, and you choose the times: look in now and then at what people are talking about, or do something you promised when its time comes.
- When you have no timed wake, a fallback check-in comes every ${facts.fallbackWakeMinutes} minutes.`;
}

/** "2026-10-27 17:04:07 Tuesday (GMT+11)", in the machine's time zone. */
export function formatTime(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.weekday} (${parts.timeZoneName})`;
}

export function renderContext(status: ContextStatus): string {
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  return `Context: about ${k(status.used)} tokens used, window ${k(status.window)}; pi compacts automatically at about ${k(status.compactAt)}.`;
}

const KINDS: Record<string, string> = {
  message: "message",
  edit: "edit",
  delete: "delete",
  reaction_added: "reaction added",
  reaction_removed: "reaction removed",
  join: "joined",
  leave: "left",
  update: "message changed (not the text)",
};

const PLACE_KINDS = { channel: "channel", dm: "DM", group: "group chat" } as const;

function renderEvent(event: WakeEvent): string {
  const parts = [`${formatTime(event.at)} ${KINDS[event.kind] ?? event.kind}`];
  if (event.person) parts.push(`${event.person.name ?? "?"} (${event.person.address})`);
  if (event.message) parts.push(`message ${event.message}`);
  if (event.thread && event.thread !== event.message) parts.push(`thread ${event.thread}`);
  if (event.mentionsMe) parts.push("mentions you");
  return `- ${parts.join(", ")}`;
}

export function renderPlaceWake(wake: PlaceWake, status: ContextStatus): string {
  let why: string;
  switch (wake.reason) {
    case "mention":
      why = "someone mentioned you";
      break;
    case "dm":
      why = "DM";
      break;
    case "steer":
      why = "new events in the place you are working on";
      break;
    case "relevant":
      why =
        wake.jev && "error" in wake.jev
          ? `no mention. Jev could not judge this time (${wake.jev.error}), so it comes to you`
          : `no mention. Jev judged that it is about what you are responsible for and you need to respond (related ${wake.jev?.related.toFixed(2)}, respond ${wake.jev?.respond.toFixed(2)})`;
      break;
  }
  const place = wake.place;
  const lines = [
    `${wake.reason === "steer" ? "[new events]" : "[wake]"} ${why}`,
    `Now: ${formatTime(Date.now())}`,
    `Place: ${place.name ?? "?"} (${place.address}, ${PLACE_KINDS[place.kind]})`,
    `New events (${wake.events.length}):`,
    ...wake.events.map(renderEvent),
    renderContext(status),
  ];
  return lines.join("\n");
}

export function renderTimerWake(timer: Timer, status: ContextStatus, fallbackMinutes: number): string {
  const why =
    timer.set_by === "fallback"
      ? `fallback check-in: you have no timed wake, so one comes every ${fallbackMinutes} minutes`
      : `timed wake (you set it at ${formatTime(timer.created_at)})`;
  const lines = [`[wake] ${why}`, `Now: ${formatTime(Date.now())}`, `Due: ${formatTime(timer.due_at)}`];
  if (timer.note) lines.push(`Note: ${timer.note}`);
  lines.push(renderContext(status));
  return lines.join("\n");
}

export function renderHandoff(note: string, notes: string, notesPath: string): string {
  return `[turned the page] A new context starts here. You ended the previous context yourself.
Now: ${formatTime(Date.now())}

## What you wrote to yourself when you turned the page
${note.trim() || "(empty)"}

## Full notes (${notesPath})
${notes.trim() || "(the notes are empty)"}`;
}
