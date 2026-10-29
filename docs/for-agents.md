# Pots, for AI agents

You are probably an AI agent, such as Claude Code, Codex or Cursor, and a person asked you about Pots or asked you to set it up. This page is for you. It says what Pots is, so you can explain it to them well, and how to set it up the way it is meant to be set up. Read it before you act.

If you are here to change Pots' own code, read [AGENTS.md](../AGENTS.md) instead.

## What Pots is

Pots (the npm package `pi-durable-bot`, the command `pots`) is an open-source AI coworker. It lives on a computer of its own and works in the chat apps a team already uses. It is not a chat bot that answers when someone @s it:

- **It sees everything in the places it is invited to.** That covers channel messages that never mention it, DMs, edits, reactions and people joining. All of it goes into one local SQLite log, and the bot reads that log with SQL when it needs context.
- **It decides when to act.** A mention or a DM wakes it at once. For every other message, a judge asks "is this about me, and should I respond?", using the bot's own list of responsibilities. The bot also sets its own timed wakes, such as "check Acme's pricing every Monday", and keeps them. Being woken does not mean speaking: most of the time the right answer is to stay quiet.
- **It works on its own computer.** It has a shell, files, the internet and, when there is one, the screen, mouse and keyboard. It writes and runs the code it needs instead of waiting for someone to add a plugin. That covers research, reports, watching a web page, filling forms, and code.
- **It remembers.** One long conversation runs across every channel. When the context gets full, the bot writes notes for itself and "turns the page". Its persona, responsibilities and notes are plain files it edits itself.
- **It survives crashes.** Every step is journaled ([pi-durable](https://github.com/earendil-works/pi)). Every incoming event is on disk before it is acknowledged. Every outgoing message has a send ID, so the bot never sends the same message twice.
- **It is open and yours.** It is MIT-licensed and runs on the person's own machine. It can use a subscription they already pay for (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more), an API key from any of 40+ providers, or a local model (Ollama, LM Studio, llama.cpp). The data stays in one SQLite file per bot. One machine can run several bots, each with its own name, persona and memory.

Slack works today, and so does the person's own terminal (`pots chat`). Discord, Teams, Telegram and email are next. The [README](../README.md) has the full picture, a demo video and diagrams.

## The one thing to get right: the bot sets itself up

Once `pots init` is done, **the bot connects its chat apps itself**. For each app, it creates what that platform needs (on Slack, a Slack app), gets the tokens, writes its own `bot.json` and asks the person only for what it cannot do, such as signing in or approving an install.

So do not create the chat app (such as a Slack app), write a manifest, collect tokens or edit `~/.pots/` by hand for your person, and do not tell them to do any of that first. Your job is to get Pots installed and `pots init` done. After that, hand the person over to their bot: they say "join our Slack" in `pots chat`, and the bot does the rest.

On a computer without a desktop, such as a cloud server reached over SSH, the bot still does this. It explains the choices and lets the person pick:

- a virtual desktop they can watch and sign in to over VNC;
- a browser-only tool, which is lighter but cannot be watched;
- the person clicks through a few browser steps on their own computer while the bot guides them.

When it needs tokens the person copied, it asks for them in `pots chat` with hidden input, and they go straight to the secrets folder.

## Before you start

- **The bot gets full control of the computer it runs on**, as the user who runs `pots init`. It runs commands, installs software and uses the screen, with no approval step. Tell your person this, and recommend a computer or VM of its own. `pots init` asks them to confirm it too.
- **Set it up on the computer where the bot will live.** If your person reaches a server over SSH, the commands run there, not on their laptop.
- **Requirements:** Node.js 24 or newer, on macOS, Linux or Windows. Windows also needs [Git for Windows](https://git-scm.com/download/win).

## Set it up

```sh
npm install -g pi-durable-bot
pots init
```

`pots init` asks three things: the bot's name, how it gets its AI, and one optional sentence about what it is for. Then it starts the gateway as a background service (launchd on macOS, a systemd user service on Linux, Task Scheduler on Windows), and the person is talking to their bot in the terminal.

`pots init` is interactive and needs a real terminal, and your own shell is probably not one. There are two ways to handle that:

1. **Ask your person to run `pots init` in their own terminal. Prefer this.** Signing in with a subscription opens a browser, or on a server, prints a link and asks for a code (choose "Copy code login (headless)" when it is offered). Only the person can do that. The steps take about a minute.
2. **Run it without questions** if pi already has a login or key for a model on this computer (in `~/.pi/agent/`; `pi --list-models` lists them when the pi command line is installed):
   ```sh
   pots init --yes --name "Ada" --model anthropic/claude-opus-5-5 --about "our team's research and ops assistant" --no-chat
   ```
   Then tell your person to run `pots chat` to meet the bot.

On Linux, `pots init` turns on lingering for the user (with `sudo` when the system asks for it), so the bot keeps running after your person logs out of SSH; there is no need to run `loginctl enable-linger` yourself. `pots init --system` installs a system service instead (it needs sudo).

## After setup

Tell your person:

- **Talk to the bot:** `pots chat`. Leave with Ctrl+C; the bot keeps working.
- **Tell it where to work.** For example, "join our Slack". It sets the app up itself. Then invite it to the right channels (`/invite @its-name`). Like a new hire, it joins only the places it is invited to.
- **Change it by talking to it.** Its persona, responsibilities, model and judge live in its folder, `~/.pots/bots/<id>/`, and the bot edits them itself. People can edit them too; changes apply within seconds.

| Command | What it does |
|---|---|
| `pots status` | The gateway, the service and each bot |
| `pots service logs` | The gateway's output |
| `pots trace` | What a bot did: its last wakes, or one wake from its events to the messages it sent |
| `pots bot new` / `pots bot list` | More bots on the same computer |
| `npm install -g pi-durable-bot@latest`, then `pots service restart` | Upgrade |
| `pots service uninstall`, then `npm uninstall -g pi-durable-bot` | Remove it. The bots stay in `~/.pots/` until that folder is deleted |

## When something goes wrong

- `pots status` shows whether the gateway runs and each bot's state. `pots chat` shows "could not work: …" when the bot's last run failed, which is usually a model login.
- If a bot's `bot.json` has an error, the reason is in `bot.json.error` next to it, and the old definition stays in use.
- `pots service logs` and `pots trace` show what happened.
- Report bugs at https://github.com/Crokily/pi-durable-bot/issues.
