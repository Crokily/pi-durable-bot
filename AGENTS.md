# Rules for coding agents

1. Read `README.md` first. It explains what the bot is and how the layers fit together.
2. Keep the layers apart. Platform concepts (Slack `ts`, channel types, subtypes) stay inside `src/channels/<platform>/`. The other layers speak only in channel, place, thread, message and person, and addresses are opaque strings.
3. Code gives mechanisms: receive, log, wake, send, schedule. Judgment belongs to the agent: whether to speak, where, when, and when to turn the page. Do not add a rule you would not tell a human coworker.
4. Prefer code mode over new tools. The agent has `read`, `write`, `edit`, `bash`, `send`, `react` and `call`, and writes the rest itself.
5. Never commit tokens, keys, personal data or runtime data. Runtime data lives in `~/.pots/`: bots in `bots/`, secrets in `secrets/`.
6. Run `npm run check` before you commit.
