import { basename } from "node:path";
import type { CacheUse, ContextStatus } from "../agent/agent.ts";
import { age, type ChildEnd, type ChildInfo, describeChild } from "../agent/children.ts";
import type { MemoryFolders, MemoryNote, MemoryProgress } from "../agent/memory.ts";
import type { PersonInfo } from "../core/channel.ts";
import { formatTime } from "../core/time.ts";
import type { PlaceWake, WakeEvent, WakeFile } from "../core/wake.ts";
import { FILE_DAYS, MAX_FILE_BYTES } from "../gateway/files.ts";
import { LOG_SCHEMA } from "../gateway/log.ts";
import { describeSchedule, describeWork, formatDuration } from "../gateway/routines.ts";
import type { DueTimer } from "../gateway/timers.ts";
import type { BotPaths } from "./definition.ts";
import type { Machine } from "./machine.ts";

// Everything the agent is told. Facts and mechanisms only; the judgment is the agent's. The sections are the start of
// every request, so they hold only facts that stay the same; what changes is in the wake.

export interface PromptFacts {
  id: string;
  name: string;
  paths: BotPaths;
  /** The folder with every bot's folder. */
  botsDir: string;
  /** Full path of the pots command. */
  pots: string;
  machine: Machine;
  secretsDir: string;
  fallbackWakeMinutes: number;
  /** The memory all bots of this computer share. */
  sharedMemory: string;
}

export function identitySection(facts: PromptFacts): string {
  return `# Who you are\nYou are ${facts.name}. Who you are beyond your name, and how you talk, is in your AGENTS.md (${facts.paths.agents}), with the project instructions below.`;
}

export function workSection(facts: PromptFacts): string {
  return `# How you work
- You are a coworker on a team. You listen to every message in the places you were invited to (channels, DMs, group chats). Every event goes into the message log: messages that do not mention you, edits, deletions, reactions, people joining, and your own messages.
- You are woken when there is something for you: someone mentions you or sends you a DM; the judge finds that people are talking about something you are responsible for and you need to respond (with the judge off, every message that does not mention you comes to you); a wake set with pots wake or a routine comes; or the fallback check-in. A wake message tells you where, who, why and the time now, and gives the new events: the text of each message, the start of its thread when it is a reply, and its files, saved on this computer. Earlier messages and other details are in the message log.
- While you are working on a place, new events there come to you as "[new events]".
- You decide whether to speak, what to say, where and when. You also decide whether a message is out of date and whether it still needs anything.
- Your answer text is not sent to anyone. To speak in a channel, use send. To add a reaction, use react. For other platform features, use call.

# Children
- With the task tool you start children: agents that work in the background, with read, write, edit, bash, screen and codemode. A child starts with an empty conversation and the brief you give it. When it ends (done, failed, or with a question for a person), its final message comes back to you as a wake; to answer its question or give it more, send it a message.
- Before you hand work to a child, reply to the person first. Longer work goes to children, so you stay free to talk.
- A brief gives the child what it cannot find itself, such as the person's words and the place. Not the method or the steps: the child is usually the stronger model.
- You choose each child's thinking level when you start it: high, xhigh (the default) or max; harder work gets more.
- Only one agent can use a screen at a time, so give screen work to one child at a time.
- While a child works for a place, new events there come to you as "[new events]". Timed and fallback wakes list the children that work.

# Addresses
- An address is an opaque string that points to a place, thread, message or person. It starts with the channel account. Copy addresses from wake messages or the log; do not build them yourself.
- The "to" of send: a place gives a new message; a thread or message gives a reply in that thread; a person gives a DM.
- To mention a person in text, put their address in angle brackets: <person address>.
- A wake from a place gives your own address in its channel account.

# Tools and command line
- Tools: read, write, edit, bash, screen, send, react, call, task, and codemode.
- The command line pots does the same channel actions, and also handles timed wakes, routines, page links, forms, turning the page and context use. Your scripts and scheduled jobs can use it too:
  pots send <address> <text, or - to read stdin> [--id <send ID>]   a send ID is sent only once; use the same ID when you redo
  pots react <message address> <emoji> [--remove]
  pots call <channel> <method> [JSON params, or -]
  pots wake --in 30m | --at "2026-10-28 09:00" [--note <text>] [--from <name>] [--id <ID>]   timed wake; with no time it is now
  pots wake --list | --cancel <id>
  pots routine add <name> (--every 30m | --cron "0 9 * * 1-5") (--note <text> | --run <command>) [--timeout 10m]   repeating work; add with a name in use replaces that routine
  pots routine list | remove <name>
  pots page link <name> [--for <person address>]   a link to your page pages/<name>/ for people; the pages skill says more
  pots page unlink <link ID or URL> | list
  pots page secret --file <name>.env --keys A,B [--text <text>] [--for <person address>]   a one-time Pots page where a person writes secrets into that file
  pots form add <name> <JSON, or -> | remove <name> | list   a Slack or Discord form that a button with the ID form:<name> opens
  pots context
  pots turn-page --note <text>
  Outside your own bash (for example in cron), write it in full: ${facts.pots} <command> --bot ${facts.id}

${computerSection(facts)}`;
}

/** What every agent of the bot knows about the computer it runs on. */
function computerSection(facts: PromptFacts): string {
  return `# This computer
- It is yours to work on: ${facts.machine.os}, host ${facts.machine.hostname}, user ${facts.machine.user}. The bash tool runs ${facts.machine.shell}.
- You have all the permissions of this user${facts.machine.os.startsWith("Windows") ? "" : "; sudo -n true tells you whether sudo works without a password"}. Your actions need no approval. You can install what you need.
- MCP servers are pi's, set in ~/.pi/agent/mcp.json and in .pi/mcp.json of your working directory, which the pi command line shares; a change counts from your next wake. Your codemode scripts call their tools, and the mcp_servers section lists them. pots mcp list shows the servers and whether they connect. A person signs in to a server with pots mcp login <server>, in their own terminal.
- The screen: before you use it for a job, look on this computer for a CLI, an API or an MCP server that does the job; they are usually faster and surer than the screen. If this computer has a desktop, use it like a person. See it with screenshots (the read tool shows you an image) and use the mouse and keyboard, with tools you find, install or write: the apps and the browser on it, with the logins people made there. People can watch it and take over at any time.
- The screen tool is for anything on the screen. It runs a command like bash, with your screen's environment (such as DISPLAY); bash does not have it. Only one agent can use a screen at a time, and the screen tool tells you who has it. Your screen is the screen setting in bot.json; without it, the gateway's own environment. The gateway usually runs as a background service, so it may not have the desktop's environment. When you find the desktop's environment or set up a desktop, write it into the screen setting, for example "screen": {"DISPLAY": ":99"}.
- If there is no desktop, work without a screen until a task needs one, such as signing up for a chat app's tokens. Then ask the person which way they want, and say what each costs: a virtual desktop (for example Xvfb and a browser, with a VNC or noVNC server) works like a real one, and they can watch it and sign in themselves over VNC, but it needs sudo, several hundred MB of packages, and an SSH tunnel or an open port for them to see it; a browser-only tool such as agent-browser is lighter, but it drives only the browser, they cannot watch it or take over, sites detect it more often, and sign-ins go through you; or they do the browser steps on their own computer while you guide them, and give you what you need.
- Working directory: ${facts.paths.workspace}`;
}

/**
 * The start of a child's prompt. Only facts it needs and two lines about how its work comes back; nothing else that
 * limits how it works. The same for every child, so children share the start of their requests.
 */
export function childSection(facts: PromptFacts): string {
  return `# Who you are
You are a child agent of ${facts.name}, the bot whose folder is ${facts.paths.dir}. ${facts.name}'s main agent talks with people and started you for a piece of work: your first message is its brief, and more messages from it may follow. You start with only the brief; what people said is in the message log.
- Your final message goes to the main agent, not to people.
- When a person must decide, end with one short question. The answer comes back to you.

# Tools
- Tools: read, write, edit, bash, screen and codemode.

${computerSection(facts)}`;
}

export function logSection(facts: PromptFacts): string {
  const db = facts.paths.db;
  return `# Message log
- SQLite file: ${db}. Open it read-only. For example:
  node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(process.argv[2]).all())' ${db} "SELECT ..."
- Tables:
${LOG_SCHEMA}
- bot_wakes(id, at, reason, place, text, submission): each time you were woken, with the full wake message.
- bot_timers(id, due_at, note, state, set_by, source, request_id, run_id, created_at, fired_at): timed wakes. set_by: agent (set with pots wake, by you, a script or a person), routine (a routine's note, or its failed run run_id) or fallback. source: pots wake --from, or the routine's name. request_id: pots wake --id.
- bot_routines(name, every_ms, cron, note, run, timeout_ms, created_at, next_at, failing): your routines. failing = 1: a failed run woke you, and the next failures do not until a run succeeds.
- bot_routine_runs(id, routine, started_at, ended_at, result, exit_code, output): the runs of the last 7 days. result: running, exit (with exit_code), timeout, error (the command could not start), stopped (the gateway stopped it) or woke (a --note routine woke you). output: the last lines of the command's output.
- Tables that start with pi_ are your conversation storage (pi-durable).`;
}

/** child: for a child, which has no call tool, so not how to ask people for secrets. */
export function folderSection(facts: PromptFacts, child = false): string {
  const paths = facts.paths;
  const secrets = child
    ? ""
    : ` When the person has to give you secrets, such as tokens they copied, ask in the terminal channel with call <its channel id> ask-secret {"text": "…", "file": "<app>.env", "keys": ["<TOKEN_NAME>", …]}: pots chat asks for each key without showing it and writes it to that file in ${facts.secretsDir}, and you get a message that names the keys it wrote. You never see the values, so they stay out of your log. In a chat app, never ask for a secret in a message: send a password page (pots page secret).`;
  return `# Your folder: ${paths.dir}
- bot.json: your definition: name, model, thinking, childModel (the model of children; unset, your model), childThinking (the thinking level of a child you start without one; xhigh by default), judge, channels (channel accounts), screen (the environment of your screen, which the screen tool runs with), settings (settings.maxChildren: how many children may work at once; settings.autoMemory: false turns your memory off). model is "provider/modelId". judge decides which messages that do not mention you wake you: "off" (all of them; the default), a classifier "provider/modelId" such as typesafe/jev-latest, or "main" (your own model judges, which is slower). Models and logins are pi's: ~/.pi/agent/auth.json, and ~/.pi/agent/models.json for OpenAI-compatible and local endpoints. Changes take effect within a few seconds. If it has an error, the error goes into bot.json.error and the old definition stays in use.
- AGENTS.md: your personality, how you talk, and anything else you want to know at every request. Context files are found as pi finds them: AGENTS.md (or AGENTS.override.md, CLAUDE.md) in ~/.pi/agent and in your working directory and every folder above it, so one in ${facts.botsDir} is for every bot there. They are read before each request, so changes take effect at once.
- Skills, as in pi: a skill is a folder with a SKILL.md. They are found in ~/.pi/agent/skills, ~/.agents/skills, .pi/skills in your working directory, .agents/skills in it and the folders above, and pi's settings and packages, the same ones the pi command line uses. The ones found are listed below with where they are. You can write or install your own; new ones show at the next request.
- A CLI on this computer is managed when it has a skill. When you find a CLI that has no skill, suggest to the person that you bring it under management: collect its docs and write one skill for it in ~/.agents/skills/<name>/SKILL.md, which says when to use the CLI, how to use it, and how to check its sign-in. pi finds skills in that folder, so every bot and every pi terminal sees them. When a CLI is removed, remove its skill too.
- responsibilities.md: what you are responsible for. The judge uses it to decide whether an event that does not mention you is about you. When your responsibilities change, update it.
- notes.md: your handoff to the next page: what you are doing, what you promised, how far you got. After you turn the page, you find what you need again from them and the message log. What you want to know beyond that goes into your memory.
- memory/: your memory, one file per memory and MEMORY.md, its index.
- workspace/: your working directory.
- files/: the files of messages people send. They are saved under files/tmp/, one folder per message, when the message comes, and the wake gives each file's path. Pots deletes them ${FILE_DAYS} days after they are saved; to keep one, move or copy it out of files/tmp/. Files over ${MAX_FILE_BYTES / 1024 / 1024} MB, and files not saved in time, are not saved: the wake gives their URL, and you download them yourself if you need them. The message log keeps each file's name, type, size and URL (gw_messages.files), so you can download a file again later from the platform. A file URL may need the channel account's token.
- pages/: web pages you write for people, one folder each (pages/<name>/index.html); pages/keep/ holds those to keep. For long content, many questions at once, or a secret, the pages skill says how to write a page, give a link and get the answers back.
- Channel types: slack, discord, telegram, terminal (the person who set you up, in their terminal), test. A message can have at most 12000 characters on Slack, 2000 on Discord and 32768 on Telegram; send longer text in parts. How to connect a chat app yourself, and to send buttons, menus, forms and tables on it, is in its skill: slack-channel, discord-channel, telegram-channel. Put its tokens in ${facts.secretsDir}, readable only by this user.${secrets}
- Other bots are in ${facts.botsDir}, one subfolder per bot. You can change their definitions. A new folder with a bot.json is a new bot.`;
}

export function contextSection(facts: PromptFacts): string {
  return `# Context and turning the page
- You have one long-lived conversation. Events from all channels go into it.
- Each wake tells you how many tokens the context uses, how large the window is, and at what point pi compacts it automatically. You can also check at any time with pots context.
- Automatic compaction turns the old conversation into a summary written by pi, and details are lost. You decide when to turn the page. To turn the page: first write what you will need into ${facts.paths.notes}, then run pots turn-page --note "<a message to yourself in the new context>". The first message of the new context is that message and the full notes. After you turn the page you cannot see the old conversation; the message log stays.
- Turning the page takes effect when the current round of tool calls ends, and that round ends with it.

# Timed wakes and routines
- Use pots wake to set timed wakes. You can have several at once, and you choose the times: look in now and then at what people are talking about, or do something you promised when its time comes.
- Scripts you write that call pots wake give --from <a short name>. Their wakes then say that they come from that command on this computer, not from a person, and that the note is what the command wrote. A second pots wake with the --id of an earlier one gives back the earlier wake and sets none.
- Use pots routine for repeating work. --note wakes you with its note at each time. --run runs a command in your shell at each time, with POTS_FROM set to the routine's name, so a pots wake in it comes from the routine; the command decides whether to wake you. A run is skipped while the last one still runs, and times missed while the gateway was stopped or the computer slept are not made up. A failed run (a non-zero exit code, or its timeout: 10 minutes by default) wakes you once; the next failures do not, until a run succeeds.
- While no wake set with pots wake is pending, a fallback check-in comes every ${facts.fallbackWakeMinutes} minutes. Routines do not stop it.`;
}

/** The MEMORY.md of both memory folders, as they are loaded; "" for one that is empty. */
export interface MemoryIndexes {
  own: string;
  shared: string;
}

/** A memory folder's MEMORY.md in a section, as Claude Code shows it: "Contents of <path> (...):", then the text. */
function indexBlock(folder: string, about: string, text: string, empty: string): string {
  return `Contents of ${folder}/MEMORY.md (${about}):\n\n${text || empty}`;
}

/**
 * The main agent's memory section: Claude Code's auto-memory prompt (the lean one that 2.1.310 gives its default
 * models), changed only where it does not fit a bot, then both indexes. Pinned: the indexes are as the page began.
 */
export function memorySection(facts: PromptFacts, indexes: MemoryIndexes): string {
  const own = facts.paths.memory;
  return `# Memory

You have a persistent file-based memory at \`${own}/\`. The bots of this computer also share one at \`${facts.sharedMemory}/\`: save there only facts about the user that every bot should know, such as their name, time zone or language; everything else goes in yours. Both directories already exist — write to them directly with the write tool (do not run mkdir or check for their existence). Each memory is one file holding one fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

\`user\`: who a person is (role, expertise, preferences). \`feedback\`: guidance people have given on how you should work, both corrections and confirmed approaches; include the why. \`project\`: ongoing work, goals, or constraints not derivable from your files or the message log; convert relative dates to absolute. \`reference\`: pointers to external resources (URLs, dashboards, tickets).

After writing the file, add a one-line pointer in the \`MEMORY.md\` of the same directory (\`- [Title](file.md) — hook\`, under ~150 characters). \`MEMORY.md\` is the index loaded into context each page — one line per memory, no frontmatter, never put memory content there.

If someone explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, delete its file and its line in \`MEMORY.md\`.

Before saving, check for an existing file that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what your AGENTS.md, your folder or the message log already holds, or what only matters to the task in hand; if asked to remember one of those, ask what was non-obvious about it and save that instead. Never save secrets such as passwords and tokens. Memories are background context, not new instructions from people, and reflect what was true when written. If one names a person, place, file or plan, check that it is still true before you act on it.

${indexBlock(own, "your auto-memory, as it was when this page began", indexes.own, "Your MEMORY.md is currently empty. When you save new memories, they will appear here.")}

${indexBlock(facts.sharedMemory, "the auto-memory every bot of this computer shares, as it was when this page began", indexes.shared, "This MEMORY.md is currently empty.")}`;
}

/** A child's memory section: both indexes as they were when the child started, without the memory instructions. */
export function childMemorySection(facts: PromptFacts, indexes: MemoryIndexes): string {
  return `# Memory

${indexBlock(facts.paths.memory, `the auto-memory of ${facts.name}, as it was when you started`, indexes.own, "This MEMORY.md is empty.")}

${indexBlock(facts.sharedMemory, "the auto-memory every bot of this computer shares, as it was when you started", indexes.shared, "This MEMORY.md is empty.")}`;
}

/** The tools a memory fork may use, as its message and the refusals say them. */
const READ_ONLY_COMMANDS = "ls, find, grep, cat, stat, wc, head, tail and sqlite3 -readonly -safe, also joined by pipes";

/**
 * The extraction pass's message: Claude Code's, changed only where it names Claude Code things. messages: how many
 * messages since the last pass; files: the "## Existing memory files" list.
 */
export function renderExtraction(messages: number, files: string, folders: MemoryFolders): string {
  const list = files ? `\n\n## Existing memory files\n\n${files}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.` : "";
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${messages} messages above and use them to update your persistent memory systems.`,
    "",
    `Available tools: read, read-only bash (${READ_ONLY_COMMANDS}), and write/edit for paths inside the memory directories only (${folders.own}/ and ${folders.shared}/), and bash rm of .md files inside the memory directories only (rm takes no flags except -f). All other tools — screen, send, react, call, task, write-capable bash, etc — will be denied.`,
    "",
    "You have a limited turn budget. edit needs the current text of the file, so the efficient strategy is: turn 1 — issue all read calls in parallel for every file you might update; turn 2 — issue all write/edit calls in parallel. Do not interleave reads and writes across multiple turns.",
    "",
    `You MUST only use content from the last ~${messages} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no searching your files or the message log, no reading files to confirm a fact, no other commands.${list}`,
    "",
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    "",
    "If someone explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    "Apply the memory types, scope guidance, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt — it is already in your context above.",
  ].join("\n");
}

/** The dream's message: Claude Code's "# Dream: Memory Consolidation", for both memory folders and the bot's log. */
export function renderDream(facts: PromptFacts, progress: MemoryProgress): string {
  const own = `${facts.paths.memory}/`;
  const shared = `${facts.sharedMemory}/`;
  const db = facts.paths.db;
  const last = progress.dreamAt === undefined ? "none before" : new Date(progress.dreamAt).toISOString();
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future pages can orient quickly.

Memory directories: \`${own}\` (yours) and \`${shared}\` (shared by every bot of this computer)
Both directories already exist — write to them directly with the write tool (do not run mkdir or check for their existence).

Message log and conversation: \`${db}\` (a large SQLite file — query it narrowly with sqlite3 -readonly -safe, don't read whole tables)

## Shared memory (\`${shared}\`)

The shared directory holds memories every bot of this computer uses. Other bots write here too — treat it differently from your own files:

- **Phase 1:** \`ls\` the shared directory and skim it alongside your own files. Another bot may have already captured something you'd otherwise duplicate.
- **Phase 3:** Merge near-duplicates *within* the shared directory the same way you would your own memories. If one of your memories restates a shared memory, delete yours.
- **Phase 4 — be conservative pruning the shared directory:**
  - DO delete or fix a shared memory that is clearly contradicted by what you see now, or that a newer shared memory marks as superseded.
  - DO NOT delete a shared memory just because you don't recognize it or it isn't relevant to *your* recent work — another bot may rely on it.
  - When unsure, leave it. A stale shared memory costs little; deleting another bot's load-bearing note costs a lot.

Do not move your own memories into the shared directory during a dream — that's a deliberate choice made when the fact comes up, not something to do reflexively.

---

## Phase 1 — Orient

- \`ls\` the memory directories to see what already exists
- Read each \`MEMORY.md\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in your folder or the message log now
2. **Log search** — if you need specific context (e.g., "what did Alice say about the deadline yesterday?"), query the message log for narrow terms:
   \`sqlite3 -readonly -safe ${db} "SELECT at, person, text FROM gw_messages WHERE text LIKE '%<narrow term>%' ORDER BY at DESC LIMIT 50"\`

Don't exhaustively read the log. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory it belongs in. Use the memory file format and type conventions from your system prompt's Memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update each \`MEMORY.md\` so it stays under 200 lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

### Reconcile memories against AGENTS.md

Your AGENTS.md and the other context files are loaded in your system prompt. For each memory that captures feedback or project conventions (the \`feedback\`/\`project\` types, where tagged), check whether it contradicts an AGENTS.md instruction on the same topic:

- **Memory is stale** — AGENTS.md and the memory describe different procedures for the same task: AGENTS.md is the maintained source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **AGENTS.md may be stale** — the memory is clearly dated after AGENTS.md and explicitly corrects it: do NOT edit AGENTS.md during a dream. Annotate the memory with "contradicts AGENTS.md — verify which is current" and list it in your summary.
- **Not a conflict** — the memory adds detail AGENTS.md doesn't cover, or narrows an AGENTS.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than AGENTS.md — AGENTS.md may have been updated since.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.

## Additional context

**Tool constraints for this run:** Shell access is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\` and \`sqlite3 -readonly -safe\`, also joined by pipes) plus deleting \`.md\` files inside the memory directories (\`rm\` takes no flags except \`-f\`). Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind.

Memory changes since the last consolidation (${last}): ${progress.changes}`;
}

/**
 * Claude Code's note after a memory pass or a dream changed files, in the main agent's next wake. inContext: the
 * changed files whose copy the main agent has, MEMORY.md in its memory section and files it read.
 */
export function renderMemoryNote(note: MemoryNote, inContext: readonly string[]): string {
  const changed = [...note.written, ...note.deleted];
  const memories = (paths: readonly string[]) => paths.filter((path) => basename(path) !== "MEMORY.md").length;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  let summary: string;
  if (note.source === "dream") summary = `consolidated ${count(changed.length, "memory file", "memory files")}`;
  else {
    const parts = [
      ...(memories(note.written) > 0 ? [`saved ${count(memories(note.written), "memory", "memories")}`] : []),
      ...(memories(note.deleted) > 0 ? [`deleted ${count(memories(note.deleted), "memory", "memories")}`] : []),
    ];
    summary = parts.length > 0 ? parts.join(", ") : "updated the memory index";
  }
  const lines = [`${note.source === "dream" ? "Background memory consolidation" : "Background memory extraction"} updated your memory: ${summary}`];
  if (changed.length > 0) lines.push(`Files changed: ${changed.join(", ")}`);
  if (inContext.length > 0) lines.push(`Your loaded copy of ${inContext.join(", ")} is now stale relative to disk — read it again if you need current contents.`);
  lines.push("This is ambient context — do not narrate it to people unless they ask or it is directly relevant to their request.");
  return lines.join("\n");
}

export function renderContext(status: ContextStatus): string {
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  return `Context: about ${k(status.used)} tokens used, window ${k(status.window)}; pi compacts automatically at about ${k(status.compactAt)}.`;
}

/** For people (pots context), not for wakes: the agent cannot steer the provider's cache. */
export function renderCacheUse(use: CacheUse): string {
  if (use.requests === 0) return "Prompt cache: no model requests in this context yet.";
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  const share = (part: number, all: number) => `${all > 0 ? Math.round((100 * part) / all) : 0}%`;
  const usd = (cost: number) => `$${cost.toFixed(4)}`;
  const requests = (count: number) => `${count} request${count === 1 ? "" : "s"}`;
  return (
    `Prompt cache in this context: ${requests(use.requests)}, ${k(use.input)} input tokens, ${share(use.cacheRead, use.input)} read from the cache, ${usd(use.cost)}. ` +
    `${requests(use.missed)} read less than half from the cache: ${usd(use.missedCost)}${use.cost > 0 ? ` (${share(use.missedCost, use.cost)} of the cost)` : ""}.`
  );
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
  system: "system message",
};

const PLACE_KINDS = { channel: "channel", dm: "DM", group: "group chat" } as const;

/** A labelled text under an event: later lines indented, so the text cannot look like the next line of the wake. */
function block(label: string, text: string): string {
  return `  ${label}: ${text.replace(/\r?\n/g, "\n    ")}`;
}

/** A size in words: "512 bytes", "40 KB", "12.5 MB". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((10 * bytes) / 1024 / 1024) / 10} MB`;
}

function renderFile(file: WakeFile): string {
  const about = [file.type, file.size === undefined ? undefined : formatSize(file.size)].filter((part) => part !== undefined);
  const name = `${file.name ?? "(no name)"}${about.length ? ` (${about.join(", ")})` : ""}`;
  if (file.path) return `  File: ${name}, saved at ${file.path}`;
  return `  File: ${name}, not saved: ${file.error ?? "unknown"}${file.url ? `. URL: ${file.url}` : ""}`;
}

function renderEvent(event: WakeEvent): string {
  const parts = [`${formatTime(event.at)} ${KINDS[event.kind] ?? event.kind}`];
  if (event.person) parts.push(`${event.person.name ?? "?"} (${event.person.address})`);
  if (event.message) parts.push(`message ${event.message}`);
  if (event.thread && event.thread !== event.message) parts.push(`thread ${event.thread}`);
  if (event.mentionsMe) parts.push("mentions you");
  if (event.edited) parts.push("edited since");
  if (event.deleted) parts.push("deleted since");
  const lines = [`- ${parts.join(", ")}`];
  const start = event.threadStart;
  if (start) {
    const author = start.fromMe ? "you" : `${start.person?.name ?? "?"}${start.person ? ` (${start.person.address})` : ""}`;
    lines.push(block(`Thread started by ${author}${start.deleted ? ", deleted since" : ""}`, start.text));
  }
  if (event.text !== undefined) lines.push(block("Text", event.text));
  for (const file of event.files ?? []) lines.push(renderFile(file));
  return lines.join("\n");
}

/** The children that work now, with how long each has run. */
function renderChildren(children: readonly ChildInfo[], label: string, now = Date.now()): string[] {
  const working = children.filter((child) => child.since !== undefined && child.stoppedAt === undefined);
  return working.length === 0 ? [] : [`${label} (${working.length}):`, ...working.map((child) => `- ${describeChild(child, now)}`)];
}

/** me: the bot's own person in the place's channel account, once it is connected. children: those that work for the place. */
export function renderPlaceWake(wake: PlaceWake, status: ContextStatus, me?: PersonInfo, children: readonly ChildInfo[] = []): string {
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
    case "interaction":
      why = "someone used a button, a menu, a command or a form of yours";
      break;
  }
  const place = wake.place;
  const lines = [
    `${wake.reason === "steer" ? "[new events]" : "[wake]"} ${why}`,
    `Now: ${formatTime(Date.now())}`,
    `Place: ${place.name ?? "?"} (${place.address}, ${PLACE_KINDS[place.kind]})`,
    ...(me ? [`You here: ${me.address}`] : []),
    `New events (${wake.events.length}):`,
    ...wake.events.map(renderEvent),
    ...renderChildren(children, "Your children working for this place"),
    renderContext(status),
  ];
  return lines.join("\n");
}

/**
 * A timed wake, a routine's wake or the fallback check-in. A wake set with pots wake makes no claim about who set it:
 * a script's note can hold outside text, such as an email's subject.
 */
export function renderTimerWake(timer: DueTimer, status: ContextStatus, fallbackMinutes: number, children: readonly ChildInfo[] = []): string {
  const now = Date.now();
  const lines: string[] = [];
  if (timer.set_by === "routine" && timer.run_id !== null) lines.push(...renderRoutineFailure(timer, now));
  else {
    let why: string;
    if (timer.set_by === "fallback") why = `fallback check-in: no wake set with pots wake is pending, so one comes every ${fallbackMinutes} minutes`;
    else if (timer.set_by === "routine")
      why = `routine ${timer.source ?? "?"}${timer.routine ? `, ${describeSchedule(timer.routine)}` : " (removed since)"}: its time came. Its note was given with pots routine add`;
    else if (timer.source === "pages") why = "an answer came from one of your pages: Pots set this wake when it arrived. The note says which link and page";
    else if (timer.source)
      why = `timed wake from ${timer.source}: a command on this computer, not a person in a channel, set it with pots wake at ${formatTime(timer.created_at)}. Its note is what that command wrote`;
    else why = `timed wake, set with pots wake at ${formatTime(timer.created_at)}`;
    lines.push(`[wake] ${why}`, `Now: ${formatTime(now)}`, `Due: ${formatTime(timer.due_at)}`);
    if (timer.note) lines.push(`Note: ${timer.note.replace(/\r?\n/g, "\n  ")}`);
  }
  lines.push(...renderChildren(children, "Your children working now"));
  lines.push(renderContext(status));
  return lines.join("\n");
}

/** A routine's run failed: how, and the last lines of its output, indented so they cannot look like the wake's lines. */
function renderRoutineFailure(timer: DueTimer, now: number): string[] {
  const { routine, run } = timer;
  const name = timer.source ?? "?";
  const how =
    run?.result === "timeout"
      ? `it ran past its timeout${routine ? ` of ${formatDuration(routine.timeout_ms)}` : ""}, so Pots stopped it and the processes it started`
      : run?.result === "error"
        ? "its command could not start"
        : `its command ended with exit code ${run?.exit_code ?? "?"}`;
  const lines = [`[wake] routine ${name} failed: ${how}`, `Now: ${formatTime(now)}`];
  lines.push(routine ? `Routine: ${name}, ${describeSchedule(routine)}, ${describeWork(routine)}` : `Routine: ${name} (removed since)`);
  if (run) lines.push(`Run: started ${formatTime(run.started_at)}${run.ended_at === null ? "" : `, ended ${formatTime(run.ended_at)}`}`);
  if (run?.result === "error") lines.push(block("Why", run.output).trimStart());
  else if (run?.output) lines.push("Last lines of its output:", ...run.output.split("\n").map((line) => `  ${line}`));
  else lines.push("Output: (none)");
  lines.push("Later failures of this routine do not wake you until one of its runs succeeds.");
  return lines;
}

/** A child ended: its final message, or why it failed. */
export function renderChildWake(end: ChildEnd, status: ContextStatus, now = Date.now()): string {
  const child = end.child;
  const ran = child.since === undefined ? "" : `, ran ${age(now - child.since)}`;
  const lines = [
    end.status === "answered" ? `[wake] your child ${child.id} ended` : `[wake] your child ${child.id} failed: ${end.text}`,
    `Now: ${formatTime(now)}`,
    `Child: ${child.id} "${child.title}"${child.place ? `, for ${child.place}` : ""}, started ${formatTime(child.startedAt)}${ran}`,
  ];
  if (end.status === "answered") lines.push(block("Its final message", end.text.trim() || "(empty)").trimStart());
  lines.push(renderContext(status));
  return lines.join("\n");
}

export function renderHandoff(note: string, notes: string, notesPath: string, children: readonly ChildInfo[] = []): string {
  const working = renderChildren(children, "Your children working now");
  return `[turned the page] A new context starts here. You ended the previous context yourself.
Now: ${formatTime(Date.now())}
${working.length > 0 ? `${working.join("\n")}\n` : ""}
## What you wrote to yourself when you turned the page
${note.trim() || "(empty)"}

## Full notes (${notesPath})
${notes.trim() || "(the notes are empty)"}`;
}
