# Development

How pi-durable-bot is tested and checked, and how to see what a running bot did. For what the bot is and how the layers fit together, read the [README](../README.md) first.

```sh
npm run check   # type check
npm test        # all tests, under a minute
npm run tla     # the TLA+ models, about 2.5 minutes; needs Java and tla2tools.jar
```

Run `npm run check` and `npm test` before every commit. Run `npm run tla` too when you change the inbox, the waker, the outbox or the timers.

## Tests

`npm test` runs [Vitest](https://vitest.dev) with [@effect/vitest](https://www.npmjs.com/package/@effect/vitest) on Node 24 or newer.

| File | What it checks |
|---|---|
| `test/gateway.behavior.test.ts` | The bot from outside. Each test starts a real `pots start` in a home folder of its own, with one bot on the test channel (`src/channels/test`) and a fake model. People write to the test platform file; the tests look only at the platform, the bot's SQLite log, the requests to the model and `pots trace`. These tests hold whatever the gateway looks like inside. They also check that the gateway deletes what is in `files/tmp/` 30 days after it was saved, and nothing outside it. |
| `test/cli.test.ts`, `test/definition.test.ts` | The same way, the `pots` commands (what each prints and does, and its errors) and `bot.json` while the gateway runs (a change applies, a wrong file is kept out and explained in `bot.json.error`, the thinking level `max` also for a model without it, bot folders that come and go, the bot's own prompt sections kept for the page). |
| `test/terminal.test.ts` | `pots init` and `pots chat` in a real terminal: keys typed into a pseudo-terminal from Python's `pty` module, a moment apart like a person types, and the screen read back. Skipped on Windows and without `python3`. |
| `test/waker.test.ts`, `test/timers.test.ts` | The waker (grouping, reasons, the judge and its retries, waiting for files at most 10 seconds past the wake's time, no download of a file over 10 MB) and the timers, on Effect's `TestClock`: every wake happens at an exact time, with no waiting. |
| `test/properties.test.ts` | Properties on many random cases with [fast-check](https://fast-check.dev): grouping against a plain model of the rule, one message per send ID when the process dies before or after the platform send, timers on time and in order, and the inbox dropping repeats. |
| `test/children.test.ts` | Children, from outside like the gateway tests: a child's final message reaches the main agent exactly once, also when the process dies just before or just after the report, and nothing comes back after a stop, from the task tool or `pots children`, also when the process dies in the middle of the stop. The child runs show in `pots trace`. A child has `read`, `write`, `edit`, `bash` and `screen`, and its prompt says nothing of `send`, `react`, `call` or ask-secret. A child sees the memory as it was when it started, and its requests keep that start when the memory changes. |
| `test/memory.test.ts` | The memory pass, from outside: its request starts as the main agent's last one, with the same provider session; it reaches neither the chat nor the main conversation; the memory section shows the new memory only on the next page; to forget, from `pots memory` or a pass, deletes the entry; the next pass starts as the main agent's last request, also after the first pass saved; and a pass is saved once when the process dies right after it saved. |
| `test/screen.test.ts` | The screen lease: one conversation at a time on a screen, and a lease frees when its holder gives it up, stops using the screen or its process is gone, also a process that is not the test's. The lease holds only for the `screen` tool: on Linux plain `bash` has no `DISPLAY` or `WAYLAND_DISPLAY`, so it cannot reach the screen, but on macOS and Windows it can, and there only the prompt keeps agents to the `screen` tool. |
| `test/inbox.test.ts`, `test/gateway.test.ts` | What adapters give the inbox, the `Gateway` class as the bot uses it, and the traces, also over OTLP. |
| `test/telemetry.test.ts` | pi-telemetry's own conformance suite for the bridge from pi's telemetry to the gateway's spans. |

**The fake model.** `test/support/fake-model.ts` is a small server that speaks the OpenAI chat completions API, so a real gateway uses it through pi's model layer like any OpenAI-compatible endpoint. Its judge says yes to events about pricing; its agent answers each wake with one `send` in the wake's place. It says the provider's cache served 80 of each request's 100 input tokens. Its answer to the memory pass's first look is no, so there is no pass, unless a test gives answers for the memory pass. It records each request's provider session (the `session_id` header, which the tests' models.json asks pi to send). The tests point pi at it with `PI_CODING_AGENT_DIR`, so your own `~/.pi/agent` is not used.

**Crash tests.** An empty file in a bot's folder makes the gateway kill itself at one point, once:

| File | The process dies |
|---|---|
| `crash-after-send` | right after the platform accepted a send, before the outbox recorded it |
| `crash-after-wake` | right after the bot took a wake, before the gateway recorded that |
| `crash-before-child-report`, `crash-after-child-report` | just before, or just after, a child's end was handed to the main agent, before its reporter task ended |
| `crash-after-child-stop` | right after a stop marked a child stopped, before the child's work ended |
| `crash-after-memory-pass` | right after a memory pass saved its answer, before the pass ended |

After the restart the bot must send once, be woken once, and save a memory pass once, and a stopped child must do nothing more.

## TLA+ models

`spec/` has small [TLA+](https://lamport.azurewebsites.net/tla/tla.html) models of the parts where a crash at the wrong moment could lose or repeat something. TLC, the model checker, tries every order of steps and every crash point within the limits in the `.cfg` files.

| Model | What TLC checks |
|---|---|
| `Outbox.tla` | No send ID reaches the platform twice, however often the process dies; every send goes out in the end. It assumes the platform finds a sent message by its send ID. |
| `Inbox.tla` | An event is on disk before the adapter acknowledges it; an event the platform delivers again is logged once; every acknowledged event is decided and reaches the agent; no event reaches the agent in two wakes. |
| `Debounce.tla` | A group of events is decided 3 seconds after its last event or 20 seconds after its first, whichever comes first; groups of a place follow each other; every event is in exactly one group. `Debounce.places.cfg` checks two places at once with shorter waits. |

To run TLC you need Java 11 or newer and `tla2tools.jar` from the [TLA+ releases](https://github.com/tlaplus/tlaplus/releases). Put the jar in `.tla/tla2tools.jar` (git ignores `.tla/`), or set `TLA2TOOLS` to its path:

```sh
TLA2TOOLS=~/opt/tla/tla2tools.jar npm run tla
npm run tla -- Inbox      # one model
```

Each configuration prints `ok` with the number of states, or `FAIL` with TLC's counterexample: the steps that lead to the broken property. When you change the code a model describes, change the model in the same commit.

## Traces

The gateway records what it does as spans, and so do [pi-durable](https://github.com/earendil-works/pi) (the agent's submissions, each model turn and each tool call) and pi's model layer (each model request, with its tokens and cost). They are one record: the events that woke the bot, the wake, the agent's run for it, and what it sent. Spans hold IDs, addresses, counts, times and error messages, never message text.

Every span goes to the `gw_spans` table in the bot's `bot.sqlite`, for 7 days. The agent can read it with SQL too.

```sh
pots trace                  # the last wakes: reason, place, events, sends, model tokens (with the children a wake's run started) and cache share, time; then the totals
pots trace <id>             # one wake as a tree; <id> is a trace ID (its first characters), a send ID or a wake ID
pots trace --bot <bot> -n 50
```

```text
trace e529afe0360c9247e140dc642d9f1ff5  2026-10-29 00:10:27
wake place=test:#general events=1 reason=mention wake=mention:test:#general:1 submission=8  +0 ms  18 ms
└─ wake.deliver wake=mention:test:#general:1  +1 ms  16 ms
agent run, trace 7693d587f87be73626bd7f50c457ee35  2026-10-29 00:10:27
submission 8 (placed)  +14 ms  3 ms
├─ generation prepare → next=request  +19 ms  3 ms
├─ generation request → waiting  +22 ms  68 ms
│  ├─ model fake/coworker, 100 in (80% cached), 10 out, toolUse  +23 ms  65 ms
│  └─ tool send call → done  +90 ms  5 ms
│     └─ send send=tool:12 to=test:#general result=sent message=test:#general/m-07f1...  +92 ms  1 ms
│        ├─ channel.send channel=test  +92 ms  1 ms
│        └─ inbox.receive channel=test event=sent:tool:12 repeat=false  +93 ms  0 ms
└─ generation tools → done  +95 ms  1 ms
   └─ ...
events:
  inbox.receive channel=test event=m-3b6b... repeat=false  -306 ms  1 ms
  └─ inbox.apply channel=test event=m-3b6b... happenings=1 events=1  -305 ms  3 ms
```

In a model request, `in` counts all input tokens, and `cached` is the share the provider read from its prompt cache. After the list of wakes, `pots trace` adds up their requests: input, cache share, cost, and how many requests read less than half from the cache, with what they cost. `pots context` gives the same for the current context. These numbers are for people; the wakes do not carry them.

A child's runs (`src/agent/children.ts`) start traces of their own, linked to the phase of the reporter task that gave the child its message. `pots trace` counts them with the wake whose run started or messaged the child, and `pots trace <id>` shows them as "child run". A child's end is a wake of its own, with reason `child`.

**OpenTelemetry.** Set the standard variable `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) for the gateway, and the same spans also go over OTLP (HTTP, JSON) to any tool that takes it: an OpenTelemetry Collector, Jaeger, Grafana Tempo, Honeycomb and others. The service is `pots`; the resource attribute `pots.bot` names the bot. `OTEL_EXPORTER_OTLP_HEADERS` sets headers, for example an API key; `OTEL_TRACES_EXPORTER=none` or `OTEL_SDK_DISABLED=true` turn the export off. A wrong value does not stop the bot: the gateway logs `trace export off` and runs without the export. The variables must be set for the gateway's process; for the background service, in its systemd unit, launchd plist or scheduled task.

## The system prompt and the prompt cache

The system prompt is made of sections (`src/bot/bot.ts`). pi-durable renders them before each request and sends only the ones that changed, at the end of the conversation; on a model that takes system text only at the start, a change rewrites the start of every request, and the cache misses. So:

- A section holds only facts that stay the same: no time, no context use, nothing that differs from one start of the gateway to the next (a channel that is still connecting, whether sudo has a password cached). Those go into the wake.
- The bot's own sections are pinned (`pin: true`): they keep the text they had when the page began, from pi-durable's `PromptInput.shown`, and show the new text when the page turns or pi compacts, and once after an upgrade (`bot_state.prompt_version`, written when the first main request with the new text goes out). A memory pass's fork keeps the pinned text it took from the main conversation. The name, AGENTS.md and skills are not pinned: people change them on purpose and expect the change at once.
- A new section goes at the end, and a section always has a text. A section in the middle that comes or goes makes pi-durable send every section again.
- The tool list stays the same.
- The memory pass (`src/agent/memory.ts`) runs after each run of the main conversation that ended with an answer, as a background task of it: a first look with the main model at its lowest thinking level, over the run's messages, answers `{"write_likely": true|false}`; on yes, a fork of the main conversation at the run's answer gets one more message, which asks what to save (`renderMemoryPass` in `src/bot/prompt.ts`). pi-durable gives a fork a provider session of its own; the pass gives it the main conversation's, and adds only an extension with a hook that blocks every tool, so the fork's request has the same sections, tools and session as the main agent's last one, and the provider's cache serves it. The first look's answer is a memo and the fork's answer has a request ID, so after a restart neither is asked again; the bot saves an answer once per pass (`*_applied` tables, kept for good; the shared memory's keys carry a random ID of the bot's database, `bot_state.database_id`, so a bot made again with the same ID is not taken for the old one). A pass that the last process did not start, the bot starts at the next start. Its requests are not in `pots trace`, which shows wakes.
- Children have sections of their own (`child`, then the log, the folder without how to ask for secrets, which needs `call`, AGENTS.md and skills), the same for every child, so their requests share a start too. Then comes the bot's memory, pinned: a child is a new conversation, not a fork, so its pinned section shows the memory of the child's first request, and keeps that text for the child's whole conversation, also after pi compacts it (then from the child's first system entry). The main agent selects the extensions `coding-tools`, `bot` and `tasks`; a child selects `coding-tools` and `child`.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pots start
```

## Releases

1. Add the new version's section to [CHANGELOG.md](../CHANGELOG.md): `## 0.3.0 (2026-10-29)`, then what was added, changed and fixed, in words a user understands.
2. `npm version 0.3.0` sets the version in `package.json` and `package-lock.json`, commits it and tags it `v0.3.0`.
3. Push the commit and the tag: `git push origin main v0.3.0`.

The tag starts `.github/workflows/release.yml`. It runs `npm run check` and `npm test`, and checks that the tag matches `package.json` and that CHANGELOG.md has a section for the version. It installs the packed package globally, without our lockfile, as a user gets it, and runs `pots`. Then it publishes to npm with trusted publishing and provenance, and makes a GitHub release whose notes are that section. A version with a hyphen, such as `0.4.0-beta.1`, goes to the `next` dist-tag.
