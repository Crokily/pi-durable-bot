import type { ContextStatus } from "../agent/agent.ts";
import type { PersonInfo } from "../core/channel.ts";
import type { PlaceWake, WakeEvent } from "../core/wake.ts";
import { LOG_SCHEMA } from "../gateway/log.ts";
import type { Timer } from "../gateway/timers.ts";
import type { BotPaths } from "./definition.ts";
import type { Machine } from "./machine.ts";

// Everything the agent is told. Facts and mechanisms only; the judgment is the agent's.

export interface PromptFacts {
  id: string;
  name: string;
  paths: BotPaths;
  /** The folder with every bot's folder. */
  botsDir: string;
  /** Full path of the pots command. */
  pots: string;
  machine: Machine;
  /** The package's docs folder. */
  docs: string;
  secretsDir: string;
  fallbackWakeMinutes: number;
  /** This bot's own person address in each channel account. */
  accounts: readonly { channel: string; me?: PersonInfo }[];
}

export function identitySection(facts: PromptFacts): string {
  return `# Who you are\nYou are ${facts.name}. Who you are beyond your name, and how you talk, is in your AGENTS.md (${facts.paths.agents}), with the project instructions below.`;
}

export function workSection(facts: PromptFacts): string {
  const accounts = facts.accounts.map((account) => `  - ${account.channel}: ${account.me ? account.me.address : "(not connected yet)"}`).join("\n");
  return `# How you work
- You are a coworker on a team. You listen to every message in the places you were invited to (channels, DMs, group chats). Every event goes into the message log: messages that do not mention you, edits, deletions, reactions, people joining, and your own messages.
- You are woken when there is something for you: someone mentions you or sends you a DM; the judge finds that people are talking about something you are responsible for and you need to respond (with the judge off, every message that does not mention you comes to you); a time you set comes; or the fallback check-in. A wake message tells you only where, who, why, the time of each new event and the time now. Read the content yourself in the log.
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
- The command line pots does the same channel actions, and also handles timed wakes, turning the page and context use. Your scripts and scheduled jobs can use it too:
  pots send <address> <text, or - to read stdin> [--id <send ID>]   a send ID is sent only once; use the same ID when you redo
  pots react <message address> <emoji> [--remove]
  pots call <channel> <method> [JSON params, or -]
  pots wake --in 30m | --at "2026-10-28 09:00" [--note <text>]   timed wake; with no time it is now
  pots wake --list | --cancel <id>
  pots context
  pots turn-page --note <text>
  Outside your own bash (for example in cron), write it in full: ${facts.pots} <command> --bot ${facts.id}

# This computer
- It is yours to work on: ${facts.machine.os}, host ${facts.machine.hostname}, user ${facts.machine.user}. The bash tool runs ${facts.machine.shell}.
- You have all the permissions of this user${facts.machine.sudo ? ", and sudo works without a password" : ""}. Your actions need no approval. You can install what you need.
- The screen: if this computer has a desktop, use it like a person. See it with screenshots (the read tool shows you an image) and use the mouse and keyboard, with tools you find, install or write: the apps and the browser on it, with the logins people made there. People can watch it and take over at any time. The gateway usually runs as a background service, so your shell may not have the desktop's environment (such as DISPLAY). If there is no desktop, work without a screen until a task needs one, such as signing up for a chat app's tokens. Then ask the person which way they want, and say what each costs: a virtual desktop (for example Xvfb and a browser, with a VNC or noVNC server) works like a real one, and they can watch it and sign in themselves over VNC, but it needs sudo, several hundred MB of packages, and an SSH tunnel or an open port for them to see it; a browser-only tool such as agent-browser is lighter, but it drives only the browser, they cannot watch it or take over, sites detect it more often, and sign-ins go through you; or they do the browser steps on their own computer while you guide them, and give you what you need.
- Working directory: ${facts.paths.workspace}`;
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
- bot.json: your definition: name, model, thinking, judge, channels (channel accounts), settings. model is "provider/modelId". judge decides which messages that do not mention you wake you: "main" (your own model judges), "off" (all of them), or a classifier "provider/modelId" such as typesafe/jev-latest. Models and logins are pi's: ~/.pi/agent/auth.json, and ~/.pi/agent/models.json for OpenAI-compatible and local endpoints. Changes take effect within a few seconds. If it has an error, the error goes into bot.json.error and the old definition stays in use.
- AGENTS.md: your personality, how you talk, and anything else you want to know at every request. Context files are found as pi finds them: AGENTS.md (or AGENTS.override.md, CLAUDE.md) in ~/.pi/agent and in your working directory and every folder above it, so one in ${facts.botsDir} is for every bot there. They are read before each request, so changes take effect at once.
- Skills, as in pi: a skill is a folder with a SKILL.md. They are found in ~/.pi/agent/skills, ~/.agents/skills, .pi/skills in your working directory, .agents/skills in it and the folders above, and pi's settings and packages, the same ones the pi command line uses. The ones found are listed below with where they are. You can write or install your own; new ones show at the next request.
- responsibilities.md: what you are responsible for. The judge uses it to decide whether an event that does not mention you is about you. When your responsibilities change, update it.
- notes.md: your notes. After you turn the page, you find what you need again from them and the message log.
- workspace/: your working directory.
- Channel types: slack, terminal (the person who set you up, in their terminal), test. How to connect a new chat app yourself is in ${facts.docs}/channels/; put its tokens in ${facts.secretsDir}, readable only by this user. When the person has to give you secrets, such as tokens they copied, ask in the terminal channel with call <its channel id> ask-secret {"text": "…", "file": "<app>.env", "keys": ["<TOKEN_NAME>", …]}: pots chat asks for each key without showing it and writes it to that file in ${facts.secretsDir}, and you get a message that names the keys it wrote. You never see the values, so they stay out of your log.
- Other bots are in ${facts.botsDir}, one subfolder per bot. You can change their definitions. A new folder with a bot.json is a new bot.`;
}

export function memorySection(facts: PromptFacts): string {
  return `# Context and turning the page
- You have one long-lived conversation. Events from all channels go into it.
- Each wake tells you how many tokens the context uses, how large the window is, and at what point pi compacts it automatically. You can also check at any time with pots context.
- Automatic compaction turns the old conversation into a summary written by pi, and details are lost. You decide when to turn the page. To turn the page: first write what you will need into ${facts.paths.notes}, then run pots turn-page --note "<a message to yourself in the new context>". The first message of the new context is that message and the full notes. After you turn the page you cannot see the old conversation; the message log stays.
- Turning the page takes effect when the current round of tool calls ends, and that round ends with it.

# Timed wakes
- Use pots wake to set timed wakes. You can have several at once, and you choose the times: look in now and then at what people are talking about, or do something you promised when its time comes.
- When you have no timed wake, a fallback check-in comes every ${facts.fallbackWakeMinutes} minutes.`;
}

/** One formatter for every time the agent reads: making one takes far longer than formatting with it. */
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  hourCycle: "h23",
  timeZoneName: "short",
});

/** "2026-10-27 17:04:07 Tuesday (GMT+11)", in the machine's time zone. */
function formatTime(ms: number): string {
  const parts = Object.fromEntries(TIME_FORMAT.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
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
        wake.judged && "error" in wake.judged
          ? `no mention. The judge could not decide this time (${wake.judged.error}), so it comes to you`
          : `no mention. The judge found that it is about what you are responsible for and you need to respond (related ${wake.judged?.related.toFixed(2)}, respond ${wake.judged?.respond.toFixed(2)})`;
      break;
    case "heard":
      why = "no mention. You have no judge set, so every message comes to you";
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
