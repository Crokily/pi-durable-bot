# Changelog

What changed in each version of pi-durable-bot (Pots). To upgrade, run `npm install -g pi-durable-bot@latest`, then `pots service restart`.

## Unreleased

### Changed
- **Windows: `pots service restart`, `install` and `uninstall` stop the gateway cleanly.** They used to end its processes at once, as a crash does. Now they ask the gateway to stop, as systemd and launchd do on Linux and macOS: it finishes the decision in progress, stops the commands of routines, and closes its channels and files. A gateway that has not ended after 30 seconds is ended as before. The scheduled task does not start it again.
- **The setup page for AI agents ([docs/for-agents.md](docs/for-agents.md)) follows what a test setup showed.** The agent runs `pots login --list` before it asks your person anything, and asks only what the list cannot answer. It takes the newest strong model of your provider and tells you which one, uses `--judge off` for a bot without group chats, and checks that the bot answers with `pots chat -m` before it hands over. It adds an MCP server only when you ask for one. The page also says that each Linux user has one Pots service, which runs all of that user's bots, and which file stays after an uninstall.

### Fixed
- **Linux: Pots no longer takes another user's system service for its own.** When `/etc/systemd/system/pots.service` runs the gateway as another user, `pots status`, `pots init` and `pots service` treated it as this user's: they said it was installed, and with sudo they restarted it, or stopped and removed it. Now it counts as not there, and this user gets a user service of their own. `pots service install --system` says that the other user has it, and changes nothing. Each Linux user has one Pots service, which runs all of that user's bots.
- **`pots mcp` in a bot's `workspace/` shows the servers the bot uses.** The bot always reads the `.pi/mcp.json` in its own `workspace/`, but `pots mcp list` there said the file was ignored because pi did not trust the folder. Now `pots mcp` treats that folder as trusted, as the bot does. In other folders it asks pi's trust as before.

## 0.6.0 (2026-11-08)

The bot gets apps and routines: MCP servers and command line tools that it calls, and repeating work on a schedule.

### Added
- **Routines: repeating work.** `pots routine add <name> (--every <duration> | --cron "<expr>") (--note "<text>" | --run "<command>") [--timeout <duration>]` adds one, or replaces the one with that name; `pots routine list` shows each one's schedule, its next time and its last run, and the fallback check-in; `pots routine remove <name>` takes one away. A `--note` routine wakes the bot with its note at each time. A `--run` routine makes Pots run its command at each time, in the bot's shell, with `POTS_FROM` set to the routine's name; the command decides itself whether to wake the bot. `--cron` is in the computer's time zone. A run is skipped while the last one still runs, and times missed while the gateway was stopped or the computer was off or asleep are not made up. A command stops after 10 minutes, or its `--timeout`, with the processes it started, and when the gateway stops. A failed run wakes the bot once, with the last lines of its output, until a run succeeds. Pots keeps each run for 7 days. Routines do not hold back the fallback check-in.
- **`pots wake --from <name>`** says where a wake comes from; without it, `pots wake` uses `$POTS_FROM`. `pots wake --list` shows it. **`pots wake --id <id>`** sets a wake once: a second `pots wake` with the same ID gives back the first, as `pots send --id` does.
- **MCP servers, through pi's own MCP support.** The bot uses the servers in pi's `~/.pi/agent/mcp.json`, which the pi command line shares, and in `.pi/mcp.json` in its `workspace/`. Its code mode scripts call their tools, and a section of its prompt lists the servers. A server added, removed or changed there applies from the bot's next wake, with no restart. Each bot runs one set of servers for itself and its children.
- **`codemode`, pi's code mode.** The bot and its children have one more tool: a JavaScript script that calls their other tools and the MCP servers' tools in a sandbox, so that only what the script returns comes back. They have it from the first request, also without an MCP server, so the tools the model is told about stay the same and the provider's prompt cache keeps serving. A memory pass cannot use it.
- **`pots mcp add | remove | list | login | logout`:** pi's `pi mcp`, with the same options, because npm links only `pots`. `pots mcp login <server>` signs you in in the browser, or takes the address the browser was sent to when it runs on another computer; sign-ins are stored in pi's `~/.pi/agent/mcp-auth.json`, and a bot uses a new one from its next request.

### Changed
- **A wake that a script set no longer reads as the bot's own plan.** A wake set with `pots wake` said "you set it", also when a script set it with outside text in its note, such as an email's subject. Now it says that it was set with `pots wake`, and when. With `--from`, it says that it comes from that command on this computer, not from a person, and that its note is what the command wrote.
- **The bot looks for a command line tool, an API or an MCP server before it uses the screen.** When it finds a command line tool without a skill, it offers to write one in `~/.agents/skills/<name>/SKILL.md`: when to use the tool, how, and how to check its sign-in. Every bot and pi find skills there. When the tool is removed, the bot removes its skill.
- **The first request after the upgrade is not served from the provider's prompt cache,** because it adds `codemode` and two sections to the prompt. Later requests are, as before.

## 0.5.1 (2026-11-07)

Pots runs on pi 1.5.0.

### Changed
- **pi 1.5.0.** Pots uses pi 1.5.0: its model layer, tools and durable journal. **This upgrade is one way:** a bot that ran 0.5.1 cannot go back to 0.5.0, because pi writes its journal in a newer form. To be able to go back, copy each bot's `bot.sqlite` (in `~/.pots/bots/<id>/`) before you upgrade, while the gateway is stopped.
- **A model request cut off by a crash is tried again after a pause,** as a failed attempt, up to 4 times, and is no longer sent again at once at every start.
- **The first request after the upgrade is not served from the provider's prompt cache,** because the tools are described a little differently. Later requests are, as before.
- **A crash can lose up to a second of an answer that was still being written.** What the bot sent, its wakes and its children's reports are not touched.

## 0.5.0 (2026-11-07)

Pots works in Discord and Telegram too, and an AI agent can set it up for you: you only sign in to your model.

### Added
- **Discord.** The bot connects a Discord app itself, by [docs/channels/discord.md](docs/channels/discord.md). It receives over Discord's Gateway, so the computer needs no public address, stores every event before it is acknowledged, and reads what came while it was down, also in threads. A reply quotes the message in its channel or thread. With `call` it opens threads, posts files and uses any other part of Discord's API, and it answers slash commands and buttons.
- **Telegram.** The bot connects a Telegram bot itself, by [docs/channels/telegram.md](docs/channels/telegram.md), with long polling, so the computer needs no public address. It sends rich messages with headings, lists and tables, and plainer ones where a chat does not take those. A topic is a thread, and a reply to the bot counts as a mention. Telegram keeps what came while the bot was down for 24 hours; it cannot read older history.
- **`pots login`** signs in with a subscription, or adds an API key (also TypeSafe's, for the Jev judge) or a local model server, for every bot on the computer. `pots login --list` shows the models and judges that can be used now, and never a secret.
- **Text limits.** A text over a platform's limit fails at once with the limit and the length, and the bot sends it in parts: 12,000 characters on Slack, 2,000 on Discord and 32,768 on Telegram. Nothing is cut.
- **System messages.** A platform's notices, such as a pin, a new channel name, a thread that started or a Telegram group that became a supergroup, are `system` events in the log, with what happened in words, and the wake shows them. They used to be logged as messages of the person who caused them.

### Changed
- **An AI agent sets Pots up itself.** By [docs/for-agents.md](docs/for-agents.md), the agent installs Pots, asks you what it needs in its chat, and makes the bot. You run `pots login` in your terminal only when your model is not set up yet, so your login and keys never pass through the agent. `pots init` alone works as before.
- **A chat app that cannot connect no longer holds up the start.** The bot starts after at most 30 seconds; that app goes on connecting, and its events wait for it.
- **Slack messages are in the log as Markdown,** as on Discord and Telegram: a link keeps its URL, and lists, code and emphasis stay. They were plain text. Messages already in the log stay as they are.
- **Newer Chat SDK (4.44.0) and Effect (4.1.2).** A list written in Slack's composer is now read as a list.

### Fixed
- **Slack:** a bare @name stays as written; the reading after a downtime starts where it should and keeps the order of more than 200 new messages; a person who joins is one join, at the time they joined, not also a message; a reaction given as the emoji itself (👀) works.
- **Discord:** a reaction by a name without colons (`eyes`) works; a person who joins is a join, not an empty message.
- **Telegram:** photos and files the bot sends with `call` are in its log; a file given as a Windows path (`C:\…`) is uploaded; a send to a group that became a supergroup says the new address.
- **`bot.json.error` is written whole,** so it is never read empty.

## 0.4.1 (2026-11-05)

### Added
- **`pots init` asks who decides on group messages that do not mention the bot:** the bot itself (the default: every such message wakes it), Jev from TypeSafe with your TypeSafe API key, or a judge model you already set up in pi. Pots tries the judge with one message before it makes the bot. `--judge` gives the answer without the question.

### Changed
- **A mention or a DM wakes the bot at once.** The bot used to wait 3 seconds after the last message of a place, also when someone was waiting for it. Now a mention or a DM wakes it when it comes, with the messages of that place that were waiting; what comes after reaches it while it works there. In our test on Slack, a DM "ping" got its reply in about 10 seconds instead of about 33. Other messages are grouped as before.

## 0.4.0 (2026-11-04)

A bot that works like a coworker: it hands longer work to helpers in the background, remembers by itself as Claude Code does, sees each new message in its wake, and keeps the start of its requests the same, so the provider's prompt cache serves most of them.

### Added
- **Children: helpers for longer work.** With its new `task` tool the bot starts children: agents that work in the background with `read`, `write`, `edit`, `bash` and `screen`, on a brief the bot writes. The bot answers the person first and stays free to talk. A child's final message comes back to the bot once, also across crashes and restarts. The bot chooses each child's thinking level: `high`, `xhigh` or `max`. New in `bot.json`: `childModel`, `childThinking` (`xhigh` by default) and `settings.maxChildren` (50 by default). `pots children` lists the children and stops them, and `pots status` shows how many work.
- **Automatic memory, as in Claude Code.** Each bot has a `memory/` folder of markdown files with a `MEMORY.md` index, and the bots of one computer share `~/.pots/memory/`. The bot sees the indexes at the start of every page and saves what is worth keeping. After each piece of work, a pass in the background, continuing the same conversation, saves what it missed; once a day, after 5 changes, a dream tidies the memory up. Code lets these passes change nothing but the memory files. `"settings": {"autoMemory": false}` in `bot.json` turns the memory off.
- **The `screen` tool.** `screen` runs commands as `bash` does, with the screen's environment, and holds the screen for one agent at a time; another agent learns who has it and since when. On Linux, plain `bash` no longer gets `DISPLAY`, `XAUTHORITY` or `WAYLAND_DISPLAY`. On macOS and Windows the screen does not need those variables, so there only the prompt keeps agents to `screen`. A bot that sets up its own desktop writes it into `screen` in its `bot.json`.
- **Wakes carry the messages.** Each wake has the text of each new message (and whether it was edited or deleted), the start of its thread, and its files. Pots downloads a message's files when the message comes, up to 10 MB each, into `files/tmp/` in the bot's folder, and deletes them there 30 days later. A larger file, or one not saved within 10 seconds, is given by its URL. The message log keeps the URL of every file, so the bot can download it again.
- **`pots trace` and `pots context` show the prompt cache:** how much of the input the provider's cache served, and what the requests that missed it cost.
- `thinking` in `bot.json` also takes `max`. A level the model does not have becomes the nearest one it has, as in pi.

### Changed
- **The judge is `off` by default.** A bot whose `bot.json` has no `judge` now gets every message that does not mention it, and decides itself. It used to be `main`. To keep that, set `"judge": "main"`, or use a fast classifier such as `typesafe/jev-latest`.
- **The start of each request stays the same.** The bot's own prompt sections keep their text for the whole page: a change, such as a new `settings` value, shows after the page turns, after pi compacts, or once after an upgrade. The bot's address in each channel is now in the wake, and the bot runs `sudo -n true` itself to learn whether sudo needs a password.
- **The messages of one place reach the bot in the order they came,** also when an earlier one waits for its files.

### Fixed
- **A sign-in opens the page with `$BROWSER` when it is set, on macOS and Windows too.** On macOS it is read as xdg-open reads it, a list of commands split by `:`; on Windows as one program; on Linux xdg-open reads it, as before. The tests set it, so they no longer open real browser tabs on a Mac.
- **`pots init` ends when it is done, also after a browser sign-in.** It printed "Start the gateway with pots start" and then did not end for minutes: pi's sign-in server left open a connection the browser had opened ahead of time. Now a `pots` command ends when its work is done and its output is written. `pots start`, `pots chat` and `pots service logs --follow` run as before.

## 0.3.3 (2026-11-03)

A bot whose model fails says so in the chat, and the local server step of `pots init` writes where pi reads.

### Fixed
- **The local server step of `pots init` writes where pi reads.** It wrote to `~/.pi/agent/models.json` even when `PI_CODING_AGENT_DIR` names another folder. It now also tries the model, as for a login, and asks whether to try again, for example once the server runs. It used to make a bot even when the server was not running.
- **`pots status` and `pots chat` show a failed run that was followed right away by the next one.** They saw only runs that ended with the bot idle.

### Changed
- **A bot that cannot use its model says so in the chat.** When its model fails, for example because a login expired, the bot says "I could not work on this" in each place that woke it, once until the model works again or the gateway restarts. It used to stay silent. The reason stays on the bot's computer, in `pots status` and `pots chat`: it can name the model's configuration, and a chat can be shared.
- **Pots uses pi's model layer, settings and skill loader through pi's public entry**, not pi's internal files, so a pi upgrade is less likely to break them. The gateway starts about 0.3 seconds later.

## 0.3.2 (2026-10-29)

Found by running `pots init` from npm on a fresh Ubuntu server without a desktop, from the first command to a reply in Slack.

### Fixed
- **Sign in with ChatGPT works.** It stopped with "requires a device ID (UUID)". `pots init` now passes pi's own ID for this installation, as the pi command line does, and keeps it in pi's settings.
- **A sign-in that finishes in the browser no longer leaves "paste the redirect URL" waiting** in the terminal, in the way of the next question.
- **The bots keep running after you log out of SSH.** Where Linux does not let a user turn on lingering, `pots init` now does it with `sudo` (without a password), and otherwise says the command to run.
- **`pots init --model` checks that pi can use the model**, and tries it, before it makes the bot. It used to make a bot that failed on its first wake when the model had no login or key, did not answer with that login, or its name was wrong.
- **No SQLite warning in the middle of the first question** on Node releases that still call `node:sqlite` experimental, such as 24.13.

### Changed
- **`pots init` tries the model you choose before it makes the bot.** A login does not unlock every model of its provider: a ChatGPT account cannot use every OpenAI model. When the model does not answer, init says why and asks again. After a sign-in, pi's default model for the provider comes first, marked "(recommended)", when it answers with that login.

## 0.3.1 (2026-10-29)

### Fixed
- **`pots` starts again after `npm install -g`.** A dependency of ours newly allowed `@effect/platform-node-shared` 4.1.0, which needs a newer `effect` than Pots uses, so every new install of 0.3.0 or 0.2.1 stopped with `ERR_MODULE_NOT_FOUND`. Pots now pins it to the tested version. Each release is now installed and run the way a user gets it before it is published.

## 0.3.0 (2026-10-29)

Setting Pots up on a server without a desktop, or through someone else's AI agent, and a bot that works like a pi session.

### Added
- **Secrets in `pots chat`.** The bot can ask the person for tokens with `call <terminal> ask-secret {text, file, keys}`. `pots chat` asks for each one without showing it and writes it to that file in `~/.pots/secrets/`. The bot only learns which keys came, so the values reach neither its log nor the model.
- **Without a desktop, the bot offers three ways.** When a task needs a screen, such as getting a chat app's tokens, the bot asks the person how to go about it and says what each way costs:
  - a virtual desktop they can watch and sign in to over VNC;
  - a browser-only tool such as agent-browser;
  - browser steps on their own computer while the bot guides them.
- **`docs/for-agents.md`**, for the AI agent (Claude Code, Codex, Cursor) that sets Pots up for someone. It explains what Pots is, how to install it, and that the bot connects its chat apps itself. The README and AGENTS.md point to it, and it ships in the npm package.
- **The bot works like a pi session.** pi's own loader reads `AGENTS.md` and [Agent Skills](https://agentskills.io) from the same places pi does, again before each request. The skills you give pi, the bot can use too.
- `read` shrinks large images to fit the model, as pi does.

### Changed
- **A bot's `persona.md` is now its `AGENTS.md`.** An existing bot's `persona.md` is renamed on its first start after the upgrade.
- **The Slack app manifest asks for no user scopes.** The bot never used them. An app made from the old manifest keeps working.

### Fixed
- **`pots init`: the arrow keys work in the login prompts**, such as "Select Anthropic login method". They used to print `^[[B`, and the choice could not change.

## 0.2.1 (2026-10-29)

The same behavior, faster and with more tests.

### Changed
- **Each `pots` command loads only what it uses**, and Node keeps the compiled code between runs, so commands start much faster.
- **The gateway does less work for each event and each wake**: fewer SQL statements, and one formatter for wake times.
- **`pots trace` reads the spans that link to a wake in one pass.**
- Tests cover every `pots` command, and `bot.json` while the gateway runs.

### Fixed
- **A bot that stops always stops its channels and closes its database**, even when an earlier step fails.

## 0.2.0 (2026-10-29)

### Added
- **The bot uses its computer's screen like a person.** It works with the browser and the apps on screen, with the mouse and keyboard, and people can watch and take over. On a server without a screen, it works without one.
- **`pots trace`** shows what a bot did: its last wakes, or one wake from its events to its run and the messages it sent. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, traces also go to any OpenTelemetry tool.
- Releases are published from GitHub Actions with npm trusted publishing and provenance.

### Changed
- **The gateway core (inbox, waker, outbox, timers) runs on Effect 4.** It is checked by tests on Effect's TestClock, property tests with fast-check, and TLA+ models (`npm run tla`).

### Fixed
- A crash right after a wake no longer wakes the bot a second time for the same events.
- Stopping the gateway stops the agent first, so a stop never loses the agent's work.

## 0.1.0 (2026-10-28)

The first release.

- **One inbox for everything** in the places the bot is invited to, kept in a local SQLite log it reads with SQL.
- **The bot decides when to act.** A mention or DM wakes it at once. A judge decides about every other message. The bot also sets its own timed wakes.
- **Code mode on its own computer**, with the tools `read`, `write`, `edit` and `bash`, plus the channel actions `send`, `react` and `call`.
- **One long memory** across channels, with turning the page and notes.
- **A crash-safe inbox and outbox**, so the same message is never sent twice.
- **A Slack adapter** (socket mode, backfill after downtime), and a terminal channel for `pots chat`.
- **`pots init`** sets up a first bot, its AI and one sentence about what it is for. The gateway runs as a background service on macOS, Linux and Windows.
- **Any model pi can use** (subscription logins, API keys, OpenAI-compatible and local endpoints), and a judge you choose.
