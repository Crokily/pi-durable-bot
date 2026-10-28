<div align="center">

<img src="docs/media/logo.png" width="112" alt="Pots logo">

# pi-durable-bot (Pots)

**The open-source AI coworker that acts on its own.**

It reads every channel, email and event you give it, decides what matters,<br>
does the work on its own computer, and speaks up when it should.

[Demo](#see-it-work) · [Quick start](#quick-start) · [How it decides](#how-it-decides-to-act) · [Open and yours](#open-and-yours) · [How it works](#how-it-works)

[![npm](https://img.shields.io/npm/v/pi-durable-bot?style=flat-square&color=1F7A70)](https://www.npmjs.com/package/pi-durable-bot)
[![License: MIT](https://img.shields.io/badge/license-MIT-1F7A70?style=flat-square)](LICENSE)
[![Built on pi-durable](https://img.shields.io/badge/built%20on-pi--durable-1F7A70?style=flat-square)](https://github.com/earendil-works/pi)
[![Chat SDK](https://img.shields.io/badge/channels-Chat%20SDK-1F7A70?style=flat-square)](https://chat-sdk.dev)
[![Node 24+](https://img.shields.io/badge/node-24%2B-1F7A70?style=flat-square)](https://nodejs.org)

</div>

<p align="center" id="see-it-work">
  <a href="docs/media/demo.mp4"><img src="docs/media/demo.gif" width="900" alt="Pots reads Slack, email, Discord, X and calendars on its own, decides what matters, speaks up in #pricing, and does real work on its own computer"></a>
</p>

Grok Bot, dots and Claude Tag showed what an AI teammate can be. pi-durable-bot gives you the same kind of coworker as open source: it runs on your machine, with the model you choose, in the places your team already talks.

## Not a bot. A coworker.

Most AI bots are a command line with a chat bubble. You @ them, they answer, they forget. A real coworker works differently:

| | A chat bot | pi-durable-bot |
|---|---|---|
| **What it sees** | The message that mentions it | Everything in the places it was invited to: chats, DMs, emails, events, pages it watches |
| **When it acts** | When you @ it | When it decides it should. It can also answer when you @ it |
| **What it remembers** | This thread, maybe | One long memory across every channel, kept on disk |
| **How it works** | Calls the tools someone wired in | Writes and runs its own code on its own computer |
| **What happens later** | Nothing | It sets its own reminders and comes back |
| **After a crash** | Starts over, or sends twice | Picks up where it stopped. Never sends the same message twice |

## What it does

### 📥 Its own inbox

Every message in every place you invite it to lands in one inbox: channel messages that never mention it, edits, deletions, reactions, people joining, and its own messages. It keeps all of it in a local SQLite log and reads that log with SQL whenever it needs context. Nothing is thrown away when a conversation gets long.

### 🧠 Its own judgment

It is woken in three ways, the same three ways a person notices work:

| | Like a coworker who... | How |
|---|---|---|
| **Someone asks** | gets a message or an @ | A mention or a DM wakes it at once (after a short pause, so you can finish typing) |
| **It notices** | overhears something that is their job | A judge reads each message that does not mention it and asks two questions: *is this about me?* and *should I respond?* It sees the bot's own list of responsibilities. The judge is the bot's own model, a fast classifier such as TypeSafe's Jev, or a local model |
| **It checks in** | looks around now and then, and keeps promises | It sets its own timed wakes: "check Acme's pricing every Monday", "follow up at 5 pm". If it has none, it looks around every two hours |

Being woken is not the same as speaking. Each time, the agent reads the log and decides if it should say anything, where, and when. Most of the time the right answer is to stay quiet.

### 💻 Its own computer

It has a real machine with a shell, a browser it can drive, files and the internet. It does not wait for a plugin. It writes the script it needs, runs it, fixes it, and keeps the useful ones. That covers research, spreadsheets, reports, monitoring a web page, filling a form, or booking a flight, and also code.

This is **code mode**: the agent gets a few general tools (`read`, `write`, `edit`, `bash`) plus three channel actions (`send`, `react`, `call`), and builds the rest itself.

### 💬 Its own voice

When it speaks, it speaks like a teammate: in the right channel or thread, in its own words, with the file attached. It can reply in a thread, start a new message, DM a person, add a reaction, edit its own message, or call any other platform API.

### ⏰ Its own schedule

It promises to come back, and it does. Timed wakes live in the same database as everything else, so they survive restarts. It can also add normal cron jobs on its machine.

### 📓 Its own memory

Each bot has one long conversation, across every channel. When the context gets full, the bot decides when to **turn the page**: it writes notes for itself, starts a fresh context, and the notes come with it. The full message log stays on disk, so nothing is lost. Its persona, its responsibilities and its notes are plain files it edits itself.

### 🛟 Durable by design

Built on [pi-durable](https://github.com/earendil-works/pi), every step is journaled. Kill the process in the middle of a task and it continues after restart. Every incoming event is written to disk before it is acknowledged. Every outgoing message carries a send ID, and after a crash the bot checks whether the message already went out before it sends again.

## Open and yours

Grok Bot, dots, Muse and Claude Duet are closed products. They run on someone else's computer, with someone else's model, inside the apps they chose. pi-durable-bot is MIT-licensed and runs where you put it.

| | Closed AI coworkers | pi-durable-bot |
|---|---|---|
| Source code | Closed | Open, MIT |
| Where it runs | The vendor's cloud | Your server, your VM, your office box |
| Model | The vendor's | Your subscription login, any of 40+ providers, or a local model |
| Your data | Sent to the vendor | Stays on your machine in one SQLite file per bot |
| Channels | The ones the vendor supports | Any channel with a [Chat SDK](https://chat-sdk.dev) adapter |
| Custom work | What the vendor allows | Anything. Change the code, add tools, connect your own systems |

**Any model.** Log in once with a subscription you already pay for, use an API key from any of the 40+ providers [pi](https://github.com/earendil-works/pi) supports, point it at any OpenAI-compatible endpoint (vLLM, SGLang, a proxy), or run a local model with Ollama, LM Studio or llama.cpp. The bot uses pi's own model layer, so every model pi can use, the bot can use. With a local model for the agent and the judge, nothing leaves your machine. You are not locked to one model vendor.

**Any channel.** The core speaks in five plain words: channel, place, thread, message, person. Platform details stay inside one adapter per platform, so adding Discord, Teams, Telegram or email is one adapter, not a rewrite. One bot can be in many channels and stays the same person everywhere.

**Your business.** Give it your own tools, data and workflows. It can run several bots on one machine, each with its own name, persona, responsibilities and memory. A bot can even edit its own definition, or create a new bot.

## Quick start

> [!IMPORTANT]
> The bot gets full control of the computer it runs on, with no approval step. Give it a computer or VM of its own.

You need [Node.js](https://nodejs.org) 24 or newer, on macOS, Linux or Windows (with [Git for Windows](https://git-scm.com/download/win)).

```sh
npm install -g pi-durable-bot
pots init
```

`pots init` asks three things:

1. **Your bot's name.**
2. **Its AI.** Sign in with a subscription you already pay for (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more), use an API key, or point it at a local server (Ollama, LM Studio, llama.cpp).
3. **In one sentence, what it is for.** Optional. The bot writes its own persona and responsibilities from it.

Then the gateway starts as a background service (it starts again at login) and you are talking to your bot in the terminal. Tell it which chat apps to join. It sets them up itself on its computer and asks you only for what it cannot do, like signing in to Slack or approving the app. Leave with Ctrl+C; come back with `pots chat`.

It joins only the places it is invited to, like a new hire who is added to the right channels.

| Command | What it does |
|---|---|
| `pots init` | Set up your first bot, or another one |
| `pots chat` | Talk to a bot in this terminal |
| `pots status` | The gateway, the service and each bot |
| `pots service install \| uninstall \| restart \| logs` | The gateway as a background service: launchd on macOS, systemd on Linux (`--system` for a server), Task Scheduler on Windows |
| `pots start` | Run the gateway in this terminal instead |
| `pots bot new \| list` | Create and list bots |

To upgrade, run `npm install -g pi-durable-bot@latest`, then `pots service restart`. To remove it, run `pots service uninstall`, then `npm uninstall -g pi-durable-bot`. The bots stay in `~/.pots/` until you delete that folder.

### Choose the models

`pots init` sets up the model. Each bot's `bot.json` names two models, and you can change them at any time; edits apply within seconds. Logins, API keys and local endpoints are stored in pi's files in `~/.pi/agent/`, so the [pi](https://github.com/earendil-works/pi) command line, if you use it, shares them.

| Field | What it does | Values |
|---|---|---|
| `model` | The agent that reads, thinks and acts | Any pi model as `provider/modelId`, for example `openai/gpt-6.1-sol` or `anthropic/claude-opus-5-5` |
| `judge` | Decides which messages that do not mention the bot should wake it | `main` (default): the bot's own model judges, no extra account<br>`provider/modelId` of a classifier: `typesafe/jev-latest`, `openrouter/typesafe/jev-1.14`, `opencode/jev-1.13-free`, or a llama.cpp model<br>`off`: every message wakes the bot, and the agent decides |

A fast classifier is cheaper and quicker than the main model: Jev answers in about 0.3 seconds. With `main`, each group of messages costs one short request to the main model.

**OpenAI-compatible and local endpoints** (Ollama, LM Studio, vLLM, a proxy): `pots init` adds them for you. By hand, they go in pi's `~/.pi/agent/models.json` ([fields](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)):

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "qwen3:8b", "contextWindow": 32768 }]
    }
  }
}
```

Then set `"model": "ollama/qwen3:8b"`. The agent needs a model that calls tools well and a context window of 32K tokens or more. In our tests a 4B model judged well but was too small to do the work alone; use the largest model your machine runs well.

**llama.cpp** can be both the agent and the judge. Start `llama-server` in router mode, then log in once with the pi command line: run `pi`, then `/login llama.cpp` ([guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/llama-cpp.md)). Its chat models appear as `llama.cpp/<model>`. For the judge, use a decision model such as [Kev-4B](https://huggingface.co/ggml-org/Kev-4B-GGUF) (3 GB), which answers through llama.cpp's `/v1/systemone`; any chat model also works as a judge.

```json
{ "model": "llama.cpp/<your chat model>", "judge": "llama.cpp/Kev-4B-Q4_K_M" }
```

## How it decides to act

```mermaid
flowchart LR
  E[New event] --> L[(Message log)]
  E --> M{Mention or DM?}
  M -- yes --> W[Wake the agent]
  M -- no --> J{Judge: about me?<br/>need to respond?}
  J -- yes --> W
  J -- no --> Q[Stay quiet, remember it]
  T[Its own timers] --> W
  W --> A{Agent reads the log<br/>and decides}
  A --> S[Speak, react or act]
  A --> N[Do nothing]
```

- Messages that arrive close together are grouped: it waits 3 seconds after the last one (20 seconds at most) before it judges.
- If it is already working in a place, new messages there are handed to it as it works, so it can change course.
- The wake message says only where, who, why and when. The agent reads the content itself.

## How it works

```mermaid
flowchart LR
  subgraph Adapters[Channel adapters]
    S[Slack]
    T[Terminal]
    D[Discord, Teams, ...]
  end
  subgraph Gateway[Gateway core, one per bot]
    I[Inbox] --> G[(Message log)]
    G --> K[Waker]
    O[Outbox]
  end
  subgraph Bot[Bot]
    P[Persona, responsibilities, notes, timers]
    A[pi-durable agent<br/>read write edit bash<br/>send react call]
  end
  S --> I
  T --> I
  D --> I
  K --> A
  A --> O
  O --> S
  O --> T
  O --> D
```

| Layer | Job |
|---|---|
| Channel adapter | One per channel account. Translates events in and actions out, backfills what it missed. Platform concepts never leave this layer. |
| Gateway core | Inbox, message log, waker and outbox. The same for every platform. |
| Bot | Identity, persona, responsibilities, notes, timers, workspace and one long conversation. |
| Agent | [pi-durable](https://github.com/earendil-works/pi): runs the model, journals every step, owns the tools. |

One gateway process runs every bot on the machine. Everything lives in `~/.pots/` (or `$POTS_HOME`): one folder per bot in `bots/`, channel tokens in `secrets/`, the gateway's output in `logs/` on macOS and Windows (on Linux, `pots service logs` reads the journal). Each bot folder holds:

| File | What it is |
|---|---|
| `bot.json` | Name, model, judge, channel accounts, settings. Edits apply within seconds. |
| `persona.md` | Personality and voice. The bot maintains it. |
| `responsibilities.md` | What it is responsible for. The judge reads it. The bot maintains it. |
| `notes.md` | Notes it carries across pages. |
| `workspace/` | Its working directory. |
| `terminal/` | Its terminal channel: what you and the bot say in `pots chat`. |
| `bot.sqlite` | Message log, timers and the agent's journal in one file. |

The same `pots` command gives the bot (and its scripts and cron jobs) its actions from a shell: `pots send`, `pots react`, `pots call`, `pots wake`, `pots context`, `pots turn-page`. Tokens stay inside the running gateway; the agent never sees them.

## Status

pi-durable-bot runs every day as a teammate in a real workspace. What works today and what is next:

- [x] Slack adapter (socket mode), with backfill after downtime
- [x] Mention, DM, judge and timer wakes, grouping, and steering
- [x] Code mode on its own machine, `pots` command line
- [x] Turning the page with notes, compaction as a fallback
- [x] Crash-safe inbox and outbox, tested with a forced crash mid-send
- [x] Several bots per machine
- [x] `pots init`: name, AI and one sentence, then the bot sets up its own chat apps from the terminal
- [x] macOS, Linux and Windows, as a background service of the user
- [x] Any model pi can use: subscription logins, API keys, OpenAI-compatible endpoints, local models
- [x] A judge you choose: the bot's own model, Jev or another classifier, a local llama.cpp model, or none
- [ ] More adapters: Discord, Teams, Telegram, email
- [ ] `pots init` in a web page, for people who do not use a terminal

## Develop

```sh
git clone https://github.com/Crokily/pi-durable-bot && cd pi-durable-bot
npm install
npm run pots -- status    # the pots command, straight from src/ (Node 24 runs TypeScript)
npm run check             # type check
```

`npm run build` writes the JavaScript that the npm package ships to `dist/`. Set `POTS_HOME` to try things without touching `~/.pots/`. Coding agents: read [AGENTS.md](AGENTS.md).

## Built on

- [pi-durable](https://github.com/earendil-works/pi) for the durable agent runtime
- [Chat SDK](https://chat-sdk.dev) for channel adapters
- [pi](https://github.com/earendil-works/pi)'s model layer for logins, providers and local models
- [Effect](https://effect.website) for the `pots` command line
- [TypeSafe AI](https://typesafe.ai)'s Jev, one of the judges you can choose

## License

MIT. The demo video, music, sky images and logo in [`docs/media`](docs/media) were made for this project and use the same license.
