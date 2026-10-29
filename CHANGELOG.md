# Changelog

What changed in each version of pi-durable-bot (Pots). To upgrade, run `npm install -g pi-durable-bot@latest`, then `pots service restart`.

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
