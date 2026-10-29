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
| `test/gateway.behavior.test.ts` | The bot from outside. Each test starts a real `pots start` in a home folder of its own, with one bot on the test channel (`src/channels/test`) and a fake model. People write to the test platform file; the tests look only at the platform, the bot's SQLite log, the requests to the model and `pots trace`. These tests hold whatever the gateway looks like inside. |
| `test/cli.test.ts`, `test/definition.test.ts` | The same way, the `pots` commands (what each prints and does, and its errors) and `bot.json` while the gateway runs (a change applies, a wrong file is kept out and explained in `bot.json.error`, bot folders that come and go). |
| `test/terminal.test.ts` | `pots init` and `pots chat` in a real terminal: keys typed into a pseudo-terminal from Python's `pty` module, a moment apart like a person types, and the screen read back. Skipped on Windows and without `python3`. |
| `test/waker.test.ts`, `test/timers.test.ts` | The waker (grouping, reasons, the judge and its retries) and the timers, on Effect's `TestClock`: every wake happens at an exact time, with no waiting. |
| `test/properties.test.ts` | Properties on many random cases with [fast-check](https://fast-check.dev): grouping against a plain model of the rule, one message per send ID when the process dies before or after the platform send, timers on time and in order, and the inbox dropping repeats. |
| `test/inbox.test.ts`, `test/gateway.test.ts` | What adapters give the inbox, the `Gateway` class as the bot uses it, and the traces, also over OTLP. |
| `test/telemetry.test.ts` | pi-telemetry's own conformance suite for the bridge from pi's telemetry to the gateway's spans. |

**The fake model.** `test/support/fake-model.ts` is a small server that speaks the OpenAI chat completions API, so a real gateway uses it through pi's model layer like any OpenAI-compatible endpoint. Its judge says yes to events about pricing; its agent answers each wake with one `send` in the wake's place. The tests point pi at it with `PI_CODING_AGENT_DIR`, so your own `~/.pi/agent` is not used.

**Crash tests.** An empty file in a bot's folder makes the gateway kill itself at one point, once:

| File | The process dies |
|---|---|
| `crash-after-send` | right after the platform accepted a send, before the outbox recorded it |
| `crash-after-wake` | right after the bot took a wake, before the gateway recorded that |

After the restart the bot must send once and be woken once.

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
pots trace                  # the last wakes: reason, place, events, sends, model tokens, time
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
│  ├─ model fake/coworker, 100 in, 10 out, toolUse  +23 ms  65 ms
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

**OpenTelemetry.** Set the standard variable `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) for the gateway, and the same spans also go over OTLP (HTTP, JSON) to any tool that takes it: an OpenTelemetry Collector, Jaeger, Grafana Tempo, Honeycomb and others. The service is `pots`; the resource attribute `pots.bot` names the bot. `OTEL_EXPORTER_OTLP_HEADERS` sets headers, for example an API key; `OTEL_TRACES_EXPORTER=none` or `OTEL_SDK_DISABLED=true` turn the export off. A wrong value does not stop the bot: the gateway logs `trace export off` and runs without the export. The variables must be set for the gateway's process; for the background service, in its systemd unit, launchd plist or scheduled task.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pots start
```

## Releases

1. Add the new version's section to [CHANGELOG.md](../CHANGELOG.md): `## 0.3.0 (2026-10-29)`, then what was added, changed and fixed, in words a user understands.
2. `npm version 0.3.0` sets the version in `package.json` and `package-lock.json`, commits it and tags it `v0.3.0`.
3. Push the commit and the tag: `git push origin main v0.3.0`.

The tag starts `.github/workflows/release.yml`. It runs `npm run check` and `npm test`, and checks that the tag matches `package.json` and that CHANGELOG.md has a section for the version. Then it publishes to npm with trusted publishing and provenance, and makes a GitHub release whose notes are that section. A version with a hyphen, such as `0.4.0-beta.1`, goes to the `next` dist-tag.
