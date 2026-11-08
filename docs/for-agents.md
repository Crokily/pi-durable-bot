# Pots, for AI agents

You are probably an AI agent, such as Claude Code, Codex or Cursor, and a person asked you about Pots or asked you to set it up. This page is for you. It says what Pots is, so you can explain it to them well, and how to set it up the way it is meant to be set up. Read it before you act.

If you are here to change Pots' own code, read [AGENTS.md](../AGENTS.md) instead.

## What Pots is

Pots (the npm package `pi-durable-bot`, the command `pots`) is an open-source AI coworker. It lives on a computer of its own and works in the chat apps a team already uses. It is not a chat bot that answers when someone @s it:

- **It sees everything in the places it is invited to.** That covers channel messages that never mention it, DMs, edits, reactions and people joining. All of it goes into one local SQLite log, and the bot reads that log with SQL when it needs context.
- **It decides when to act.** A mention or a DM wakes it at once. Every other message comes to it too, and it decides whether it is about its work; a judge can read those first and ask "is this about me, and should I respond?", using the bot's own list of responsibilities. The bot also sets its own timed wakes, such as "check Acme's pricing every Monday", and keeps them. Being woken does not mean speaking: most of the time the right answer is to stay quiet.
- **It works on its own computer.** It has a shell, files, the internet and, when there is one, the screen, mouse and keyboard. It writes and runs the code it needs instead of waiting for someone to add a plugin. That covers research, reports, watching a web page, filling forms, and code.
- **It remembers.** One long conversation runs across every channel. The bot saves what is worth keeping (preferences, rules, facts about people and the work, decisions) to its memory by itself, as Claude Code's automatic memory does: plain markdown files with an index, in its folder, and one more memory that the bots of the computer share about the person. People change that memory by talking to it. When the context gets full, the bot writes notes for itself and "turns the page"; its memory comes along. Its persona and responsibilities are plain files it edits itself.
- **It survives crashes.** Every step is journaled ([pi-durable](https://github.com/earendil-works/pi)). Every incoming event is on disk before it is acknowledged. Every outgoing message has a send ID, so the bot never sends the same message twice (on Telegram, a crash at the moment of a send can repeat it).
- **It is open and yours.** It is MIT-licensed and runs on the person's own machine. It can use a subscription they already pay for (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more), an API key from any of 40+ providers, or a local model (Ollama, LM Studio, llama.cpp). The data stays on their machine, in each bot's folder. One machine can run several bots, each with its own name, persona and memory.

Slack, Discord and Telegram work today, and so does the person's own terminal (`pots chat`). Teams and email are next. The [README](../README.md) has the full picture, a demo video and diagrams.

## The one thing to get right: the bot sets itself up

Once the bot is made, **it connects its chat apps itself**. For each app, it creates what that platform needs (on Slack, a Slack app), gets the tokens, writes its own `bot.json` and asks the person only for what it cannot do, such as signing in or approving an install.

So do not create the chat app (such as a Slack app), write a manifest, collect tokens or edit `~/.pots/` by hand for your person, and do not tell them to do any of that first. Your job is to install Pots and make the bot, as below. After that, hand the person over to their bot: they say "join our Slack" in `pots chat`, and the bot does the rest.

The same goes for its other tools: the bot adds its own routines, and skills for the command line tools it uses. Run `pots mcp add` only when your person asks for an MCP server; they sign in to it with `pots mcp login <server>` in their own terminal.

On a computer without a desktop, such as a cloud server reached over SSH, the bot still does this. It explains the choices and lets the person pick:

- a virtual desktop they can watch and sign in to over VNC;
- a browser-only tool, which is lighter but cannot be watched;
- the person clicks through a few browser steps on their own computer while the bot guides them.

When it needs tokens the person copied, it asks for them in `pots chat` with hidden input, and they go straight to the secrets folder.

## Before you start

- **The bot gets full control of the computer it runs on**, as the user who runs `pots init`. It runs commands, installs software and uses the screen, with no approval step. Tell your person this, recommend a computer or VM of its own, and go on only when they agree: `pots init --yes` accepts it for them.
- **Set it up on the computer where the bot will live.** If your person reaches a server over SSH, the commands run there, not on their laptop.
- **Requirements:** Node.js 24 or newer, on macOS, Linux or Windows. Windows also needs [Git for Windows](https://git-scm.com/download/win).

## Set it up

Do the setup yourself, in your own shell. Only one step is your person's: signing in to a model. A subscription sign-in opens their browser, and an API key must not pass through your conversation, so they do it in their own terminal with `pots login`.

1. **Install:** `npm install -g pi-durable-bot`.
2. **See what pi can use already:** `pots login --list`. It lists the models (for `--model`) and judges (for `--judge`) that have a login, a key or a local server on this computer, and never shows a secret.
3. **Ask your person**, in your chat, only what `--list` cannot answer:
   - the bot's name;
   - in one sentence, what it is for (optional; the bot asks them later if they skip it);
   - how it should get its AI, when the list has nothing they want: a subscription they already pay for (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more), an API key from a provider, or a local model server (Ollama, LM Studio, llama.cpp, vLLM);
   - who decides whether a group message that does not mention the bot wakes it: the bot itself (the default: every such message wakes it), or Jev, a fast judge from TypeSafe that wakes it only for messages about its work, with their TypeSafe API key. Do not ask when the bot will not be in group chats: use `--judge off`.
4. **If what they chose is not listed, ask them to run `pots login` in their own terminal.** It asks how to get the AI, signs in or takes the key with hidden input, tries a model, and ends with a line such as `Ready: openai/gpt-6.1-sol`. On a computer without a browser, such as a server over SSH, it prints a link and asks for the code the page shows (choose "Copy code login (headless)" when it is offered). For Jev, they run it once more and choose "Use an API key", then TypeSafe. Then run `pots login --list` again.
5. **Make the bot:**
   ```sh
   pots init --yes --name "Ada" --model openai/gpt-6.1-sol --about "our team's research and ops assistant" --no-chat
   ```
   For `--model`, take the newest strong model of your person's provider from `pots login --list`, and tell them which one you chose. Use `--judge off` when the bot will not be in group chats, and `--judge typesafe/jev-latest` for Jev. `pots init` tries the model and the judge before it makes the bot, then starts the gateway as a background service (launchd on macOS, a systemd user service on Linux, Task Scheduler on Windows). On Linux it turns on lingering for the user (with `sudo` when the system asks for it), so the bot keeps running after your person logs out of SSH; `pots init --system` installs a system service instead (it needs sudo). One Pots runs per Linux user: on a computer that several people use, each user runs their own, with a user service of their own.
6. **Check, then hand over:** `pots chat --bot <id> -m "hi" --timeout 60` must print the bot's answer; `<id>` is the folder name in the `Created …/bots/<id>` line of `pots init`. If no answer comes, see `pots status` and `pots service logs`. Then tell your person to run `pots chat` to meet the bot. It says hello, checks the screen and asks which chat apps to join.

A person without an AI agent runs `pots init` alone instead: it asks the same things in the terminal, signs in, and opens the chat at the end.

## After setup

Tell your person:

- **Talk to the bot:** `pots chat`. Leave with Ctrl+C; the bot keeps working.
- **Tell it where to work.** For example, "join our Slack". It sets the app up itself. Then invite it to the right channels (`/invite @its-name`). Like a new hire, it joins only the places it is invited to.
- **Change it by talking to it.** Its persona, responsibilities, model and judge live in its folder, `~/.pots/bots/<id>/`, and the bot edits them itself. People can edit them too; changes apply within seconds.

| Command | What it does |
|---|---|
| `pots login` | Sign in to a model, or add an API key or a local server (in a terminal); `--list` shows what can be used |
| `pots mcp add` / `list` / `remove` | MCP servers for every bot and pi on this computer, in pi's `~/.pi/agent/mcp.json`, with the options of `pi mcp` (`pots mcp --help`); the bot calls their tools from code mode scripts: short JavaScript programs it writes to call its tools |
| `pots mcp login <server>` | Sign in to an MCP server in the browser (in a terminal) |
| `pots status` | The gateway, the service and each bot |
| `pots service logs` | The gateway's output |
| `pots trace` | What a bot did: its last wakes, or one wake from its events to the messages it sent |
| `pots routine list` | The work a bot repeats on a schedule, with each routine's next time and last run |
| `pots bot new` / `pots bot list` | More bots on the same computer |
| `npm install -g pi-durable-bot@latest`, then `pots service restart` | Upgrade |
| `pots service uninstall`, then `npm uninstall -g pi-durable-bot` | Remove it. The bots stay in `~/.pots/` until that folder is deleted. So does the screen lease file, `/tmp/pots-screens-<uid>.sqlite` (on Windows, `pots-screens.sqlite` in the temporary folder) |

## When something goes wrong

- `pots status` shows whether the gateway runs and each bot's state. When the bot cannot use its model, which is usually a model login, it says "I could not work on this" in the place that woke it; `pots status` and `pots chat` show why.
- `pots children` lists the children a bot started for longer work in the background, and `pots children --stop <id>` or `--stop-all` stops them; a stopped child reports nothing.
- If a bot's `bot.json` has an error, the reason is in `bot.json.error` next to it, and the old definition stays in use.
- `pots service logs` and `pots trace` show what happened.
- Report bugs at https://github.com/Crokily/pi-durable-bot/issues.
