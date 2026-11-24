# Changelog

What changed in each version of pi-durable-bot (Pots). To upgrade, run `npm install -g pi-durable-bot@latest`, then `pots service restart`.

## Unreleased

The bot looks around on its own. A few times a day a child looks for what its people would want to know or have done, and wakes the bot only when it finds something. This look replaces the fallback check-in. Known secrets in tool output become `[secret]` before the model and the log get them.

### Added
- **Known secrets are masked in tool output.** When a value Pots knows to be secret shows up in a tool's result, the model, the log (`bot.sqlite`) and a `codemode` script get `[secret]` in its place: in `bash`, `screen` and `codemode` output also while the command still runs, and also when a secret comes split across two pieces of output; in `read`, `grep`, MCP tools and every other tool's result. Known secrets are the values in the secrets folder (`KEY=value` files, raw files and JSON), pi's logins and keys in `auth.json`, `models.json`, `mcp.json` and `mcp-auth.json`, and the files `bot.json` names (its channels' `secrets`, `vnc.passwordFile`). Values under 8 characters, values with fewer than 4 different characters, `KEY=value` lines whose key names a thing (`*_NAME`, `*_USER`, `*_EMAIL`, `*_URL`, `*_HOST`, `*_PORT`, `*_ID`, …), and pi's references to an environment variable or a command are not masked. The files are looked at at most once a second and read again when one changes; a tool call costs one regular expression over its output (under 5 ms for 50 secrets over 50 KB). The files and the programs that read them keep the real values. Every agent's prompt says in one line what `[secret]` means.
- **The look.** At its first start, Pots gives each bot a routine `look`, which starts a child at 8:00, 11:00, 14:00, 17:00 and 20:00 in the computer's time zone (`--cron "0 8-22/3 * * *"`). The child looks, unasked, for what the people the bot works for would want to know or have done, with what the bot has: its memory, the message log, its tools and the logins on its computer. The log shows it what was said before and how people took it. When it finds something worth their attention, it wakes the bot with it and where it found it (`pots wake`); otherwise it ends quietly and nothing goes into the bot's conversation. The bot decides whether and when to tell people. There are no caps on messages: the model judges. It is a routine like any other, so `pots routine list` shows it and the bot changes or removes it when people ask. Pots adds it only once per bot, so a removed or changed `look` stays as it was, also across restarts and upgrades. The main agent's prompt calls it a default that Pots added once and that may since have been changed or removed, and points to `pots routine list` for what runs.

### Removed
- **The fallback check-in.** Before, while no wake set with `pots wake` was pending, Pots woke the bot every 120 minutes (`settings.fallbackWakeMinutes`) in its main conversation. In practice the bot only checked for new messages: on four bots in 12 days, 52 check-ins led to no message; it was also expensive, because two hours is longer than the main conversation's prompt cache lasts, and it stopped for good once the bot set one wake far ahead. The look does its job. `pots routine list` no longer shows it.

### Changed
- **A child that fails wakes the bot once.** Since 0.8.9 a child's end wakes no one, so the bot did not learn that a child had stopped for good, such as when its model failed after its retries, had no model, or hit a limit. Now such a failure wakes the main agent once, also across restarts, for the place the child works for: the wake says which child, why, and what it did last. An answer, a stop, an interrupt and a retry still wake no one. A routine's child that fails wakes the bot each time; the bot decides what to do, such as remove the routine. The `task` tool's description says so.
- **At the upgrade**, each bot gets the `look` routine at its next start. The section about the computer in every agent's prompt gains a line about `[secret]`. A pending fallback check-in is dropped, not fired; `bot_timers` keeps the old ones with `set_by = 'fallback'`. `settings.fallbackWakeMinutes` in `bot.json` is ignored. The main agent's prompt changes, so each bot's prompt cache is written once more after the upgrade.

### Fixed
- **Cron routines on the mornings the clocks change.** A `--cron` routine counted its times in the computer's offset from UTC, not in its time zone, so on the morning of a daylight-saving change it came an hour late, or twice. Now it counts in the computer's time zone, also when `pots routine add` checks the expression. At each start the gateway counts each cron routine's next time again, so a computer moved to another time zone gets its routines at the new local times.

## 0.8.9 (2026-11-23)

The bot spends less context and fewer tokens. A child's end no longer wakes it, and a routine can start a child at its time without waking it. The main conversation keeps its prompt cache for an hour where the model has that. The bot hands children the work that runs commands and keeps the discussion itself.

### Changed
- **A child wakes the bot itself.** Before, every end of a child became a wake of the main agent, also when the child had found nothing worth telling. Now the end wakes no one: the child's final message is kept, also across restarts, and the `task` tool's new `result` action gives it, or why the child could not answer; a result too long for a tool's output is saved whole to a file in `workspace/child-results/`. A child wakes the main agent with `pots wake`, which comes as a wake from that child, for the place the child works for: Pots sets `POTS_CHILD` to the child's ID in its commands, so a script's `--from` never makes a wake look like a child's. When the main agent hands work to a child, its prompt says to write in the brief that this is delegated work, so the child must tell it when it is done; a routine's child decides for itself. A child's brief now starts with its ID. A child's answer is kept also when a stop comes right after it. The prompts of the main agent and of children say so.
- **What goes to a child, and what stays with the bot.** Before, the prompt said that children think deeper than the main agent, so it should hand them as much of the work as it can, also questions that need careful thought. Now it says: work that runs commands, looks things up, or takes more than a minute or two goes to a child, so the bot stays free to answer people quickly; discussion and judgment that depend on the conversation stay with the bot; and the bot checks what a child reports before it tells people.
- **The main conversation keeps its prompt cache for an hour.** The main agent is often woken minutes to an hour apart, and a provider's default cache entry lasts about 5 minutes, so each such wake wrote its whole context to the cache again. Now the main agent's requests ask for the provider's long entry (1 hour at Anthropic) on models that pi knows one for, today Anthropic's Claude models; other models keep the provider's default, as before. A long entry costs more to write (at Anthropic, twice the input price instead of 1.25 times), so children, which rarely pause, and memory passes and the judge, which run once, ask for the short one, also with pi's `PI_CACHE_RETENTION=long`. Prompt cache warming times its warms by the long entry's lifetime. On four bots' requests of seven days, the long entry would have made the main conversations 19 to 47% cheaper, and children 14 to 29% dearer. A model in pi's `models.json` with `promptCache.long` gets the long entry too.
- **The bot looks in on long child work about every 10 minutes.** Before, its prompt said only that it can set itself a wake to look in on a child. Now it says that while a child does long work for a person, the bot sets itself a wake about every 10 minutes to see how it is going, tell the person briefly, and set the next one until the child has ended.
- **Bare URLs next to other text.** The prompt's facts about chat apps now say that a bare URL touching other text, such as Chinese characters or punctuation, often does not become a link or takes that text in, and to leave a space on both sides or write `[text](url)`.
- **At the upgrade**, a child that still works keeps working and ends quietly. An end that 0.8.8 had already handed to the main agent still arrives as before; an end it had decided but not handed over yet is kept, not handed over. The prompts of the main agent and of children change, so each bot's prompt cache is written once more after the upgrade. The crash-test files `crash-before-child-report` and `crash-after-child-report` are gone.

### Added
- **`pots routine add <name> ... --child "<brief>"`** starts a child at each time with the brief, for no place, with the bot's model and thinking `xhigh`, without waking the bot; the child decides itself whether to wake it. The routine's time is skipped while a child it started still works, also when a message made that child work again just before the time; the child keeps the routine's name, so this holds also after a crash and after the run is dropped. A child that cannot start, for example at `settings.maxChildren`, counts as a failed run: it wakes the bot once, until one starts. `pots routine list` shows which child each run started. Existing routines do not change.

## 0.8.8 (2026-11-21)

Pots runs on pi 1.6.0: GPT-6.2 Astra and GPT-6.2 Sol, with GPT-6.2 Sol as the default model. Images that any tool gives the bot are fitted to the model's limits, as in the pi command line, and each MCP server is a namespace of its own in code mode. After this upgrade, a bot's database cannot go back to 0.8.7.

### Added
- **GPT-6.2 Astra and GPT-6.2 Sol**, on `openai`, `azure` and `openai-codex` (the ChatGPT login). With the ChatGPT login, Sol has a 500K context window and Astra 272K; Azure gives both 1.05M. Neither has thinking `off` or `minimal`; a level a model does not have becomes the nearest one it has.
- **Images from every tool are fitted to the model.** Before, only `read` shrank its images, so a large image from an MCP tool or from a script's `image()` could make the provider refuse the request. Now pi's image fitting fits every image a tool returns to the limits of the conversation's model before it is stored, for the main agent and its children, as the pi command line does. An image that cannot be prepared is left out with a note.

### Changed
- **After the upgrade, a bot's database cannot go back to 0.8.7.** pi 1.6.0 stores the bot's tool calls and model requests in a newer format, which 0.8.7 and older do not read correctly. If you may want to go back, stop Pots and copy each bot's `bot.sqlite` before you upgrade.
- **pi 1.6.0** (was 1.5.2). What the bot gains:
  - **Models.** A request that fails with `Connection closed.` or a socket error such as `ECONNRESET`, `EPIPE` or `ETIMEDOUT` is tried again. With the ChatGPT login, a request that reaches the connection's 60-minute limit during the answer, for example during long thinking, is tried again on a new connection; GPT-6.2 now gets prompt cache hits on the system prompt; a change of thinking level no longer loses the prompt cache on GPT-6 models; and a model's `maxTokens` is used. OpenAI no longer refuses a request whose tool schema has a part without a `type`; such a tool is sent as not strict. Mistral Large 4 tool calls no longer stall for minutes. OpenAI-compatible providers other than OpenAI get system messages with the `system` role, so Groq's Qwen models no longer fail with `400 Unexpected message role`. The Qwen Token Plan providers have new models and use the current gateways.
  - **llama.cpp.** pi's llama.cpp provider connects to `http://127.0.0.1:9931` by default, the current default port of llama-server, instead of 8080. A llama.cpp classifier that takes images, such as Clef with its `mmproj`, now gets the images of `models.classify()`.
  - **Tools.** `read` no longer keeps a note that the model takes no images, which stayed in the conversation after a change to a model that takes them. `bash` shows the end of its output when the output ends in one very long line (over about 100KB, such as a `grep` match in a minified file); before, it showed nothing.
  - **undici 8.12.4** (was 8.12.3), for six security advisories.
- **`find` path patterns start at the folder searched** (pi 1.6.0). A pattern with `/` now matches from the folder `find` searches, as the `glob` of `grep` does: searching `src`, `slack/*.ts` no longer finds `src/channels/slack/sdk.ts`, and `**/slack/*.ts` finds it at any depth. A pattern without `/` still matches file names at any depth, and a pattern that starts with `./` now works.
- **Each MCP server is a namespace of its own in code mode.** The `codemode` section lists each server as `mcp__<server>`, with pi's one-line summary of it (the first line of its `description` in `mcp.json`, or else of the instructions the server sends, at most 250 characters), also before it connects. `describeNamespace("mcp__<server>")` gives the whole description, the instructions and the server's tools, and `searchTools()` searches them. A server whose every tool is `hidden` is not named. For a bot with MCP servers, the `codemode` section changes, so its prompt cache is written once more after the upgrade.
- **Children follow the bot's MCP servers.** A child has the main agent's tools without the channel actions and `task`, and keeps them as that difference, so a server added to `mcp.json` while a child works reaches the child too, and a server removed there goes from it. Children that 0.8.7 started are changed this way when the bot starts. The order of their tools changes, so each such child's prompt cache is written once more.
- **The default model is `openai/gpt-6.2-sol`** (was `openai/gpt-6.1-sol`), as pi's default for `openai`. A bot whose `bot.json` has no `model` uses it after the restart.

## 0.8.7 (2026-11-19)

A bot can make and edit images with the ChatGPT subscription signed in to pi, as the Codex CLI does, without an OpenRouter key.

### Added
- **Images with the ChatGPT subscription.** With ChatGPT signed in to pi (`openai-codex`), a bot's `codemode` scripts make and edit images with `models.generateImages()`: `models.getAvailableOfType("image")` lists `openai-codex/gpt-image-2`, and the request goes to the endpoint the Codex CLI's own image tool uses, on the subscription's Codex usage. Before, the image models pi knows needed an OpenRouter key. To edit, give up to 5 images with the prompt. pi keeps the login and refreshes it; Pots stores no token. ChatGPT decides which accounts may make images: when it answers 403, the Codex CLI's image tool is refused too.

## 0.8.6 (2026-11-19)

Pages get information across better: the bot picks the best form for each piece of information (a chart, a calendar, a table to sort and search, a calculator), uses the width of a computer and one column on a phone, and looks at the page before it sends it. Pages have a new, calmer look and a light and dark switch. The bot hands more of its work to children and asks less of people, and long-term rules come only from people's own words. From pi: prompt cache warming, the `grep` and `find` tools, proxy settings, and the notice after a Claude subscription login.

### Added
- **`pots-ui.js` in the page kit**, optional and offline. A table with `data-pots-chart="bar"`, `"stack"` or `"line"` becomes a bar chart (with reference lines from `data-marks`), one bar in parts with percentages, or a line chart, and the table stays one tap away. `data-pots-tabs` shows one panel at a time (`"phone"`: only on a phone), `data-pots-sort` sorts a table by a click on a column header, `data-pots-filter` hides rows that do not match a search box, and `<nav class="pots-toc">` marks the section on screen. It sets only text, never HTML, and works under the private-page CSP.
- **A light and dark switch on pages.** `pots-ui.js` and `pots.js` put a small sun or moon button at the page's top corner. The page follows the system until the reader chooses; the choice is kept for every page of the host, and choosing the system's own mode again forgets it. Every colour of `pots.css` is now a `light-dark()` pair, so the switch changes all of them, and the form fields too.
- **Prompt cache warming, as in pi.** A provider keeps the start of a request cached for about 5 minutes, and the bot often waits longer, for a person's answer or a child's work; the next request then writes the whole conversation to the cache again. Now Pots does what the pi command line does by default since pi 1.5.1: shortly before the cache entry of the main agent's or a child's last request expires, it sends the same request again with a one-token answer, but only when pi's numbers say the warm costs less than the miss it saves. During a run for up to an hour after the request, after it for up to 30 minutes. pi's setting `cacheWarming` (`idle` by default, `streaming`, `off`) in `~/.pi/agent/settings.json` is the switch for Pots and pi alike, read again within seconds. Memory passes, compaction and the judge are not warmed, nor a stopped child. A warm is a model request in `pots trace`, beside the request it repeats. On three bots' requests of 12 to 18 November, pi's rules would have saved about 17% of their model cost.
- **`grep` and `find`, pi's search tools, for the main agent and its children.** They search file contents and file names with ripgrep and fd, skip what `.gitignore` lists and cap their output; when the computer has neither program, pi downloads it to `~/.pi/agent/bin` on first use. A child that ran `grep -r` in `bash` on a 6 GB folder had not finished after 17 minutes; ripgrep took a second. They run in the gateway's process, not in a systemd scope of their own. The tool list changes, so each bot's prompt cache is written once after the upgrade.
- **Pi's notice after a Claude subscription login.** `pots init`, `pots login` and the login page show what the pi command line says when Claude is signed in with a subscription: a third-party program draws from extra usage, billed per token, not from the plan's limits. pi's setting `warnings.anthropicExtraUsage` turns it off in both.

### Changed
- **A new stylesheet for pages (`pots.css`).** Calm and plain, made for reading: Inter (in the package, under the SIL Open Font License) for Latin text and the system's font for Chinese, Japanese and Korean, near-black greys, hairlines instead of boxes, and one muted teal accent for links, key numbers, the chosen and the recommended choice, and focus. A page can set its own accent with one line. On a computer, contents at the side and blocks that use the width; on a phone, one column, and a wide table scrolls inside itself, never the page. New parts: an opening with a line above the title and a line of facts (`pots-eyebrow`, `pots-meta`), columns and grids (`pots-cols`, `pots-grid`, `pots-wide`), key numbers and their change (`pots-stats`, `pots-delta`), key points (`pots-points`), steps (`pots-steps`), name and value rows (`pots-kv`), flows with forks (`pots-flow`, `pots-lanes`), terms (`pots-terms`), pull quotes (`pots-quote`), 35 line icons with `data-icon`, a contents list (`pots-toc`), tables that become one card per row on a phone (`table.pots-stack`), and chart colours `--pots-c1` to `--pots-c7`. Notes and questions get an icon; tables take the width inside a scroll box (`pots-scroll`, added by `pots-ui.js`) with numbers right-aligned; buttons, tabs, choices and fields have hover and focus states. Every class and colour variable of the first stylesheet still works, so pages need no change.
- **The `pages` skill on display pages.** It starts from the goal: a page gets information across better than plain text can, so use a better form where it fits, text where text fits, and never a component for show. A table that pairs kinds of information with their best form, when and how to write a small component of the page's own (the content complete in the HTML, the script in a file), a layout that adapts to the device, an example page, and how to take screenshots as a phone, as a computer and in dark mode before sending, with the skill's script `shot.mjs`. Each page chooses a muted accent colour that fits its content; the kit's teal is only the fallback. Page text is in plain words, in the style of ASD-STE100 Simplified Technical English in the reader's language, with the reader's own terms.
- **The bot hands most of its work to children.** Its prompt said only that longer work goes to children, so the main agent, which thinks less deeply, still did much of the work and answered questions that needed thought itself. Now it hands children as much of the work as it can, also questions that need careful thought.
- **The bot asks less of people.** The more it takes on, the less it asks of the person: it does what it can itself and hands the person only what really needs them. Taking over its screen is the last step.
- **What the bot writes for an agent gives the task, not rules on how to do it.** The prompt said this only of a child's brief. Now it holds for whatever the bot writes for an agent to act on: detailed rules cannot cover every case, and they limit what the agent can do.
- **Long-term rules come only from people's own words.** The memory format, taken from Claude Code, asked for a "How to apply" line under each correction, so a bot wrote one mistake down as a method of its own and read it at every request; the daily consolidation deleted only memories that were stale, wrong or repeated, so such methods stayed and grew. Now a feedback memory holds what happened, the person's own words with the date, and why. The consolidation also rewrites a method that no person gave back into the fact behind it. AGENTS.md is said to hold facts, and what people asked of the bot in their own words.
- **Shorter guidance, without set steps or set words.** Three places gave set steps or a text to say, which a strong model works out itself and which can fit the case badly. The prompt's line on coding agents' command lines now says only that, unlike a child, one tells the bot nothing while it runs or when it ends, so the bot looks in on it now and then. The pages skill's Quick Tunnel note says what to tell the person, without a text to say or a memory to save. Step 4 of `docs/for-agents.md` says what the person signs in to and why, and names the menu's choices, without a text to paste.
- **The network as pi sets it up.** The gateway, `pots init` and `pots login` now use a proxy from `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, or from `httpProxy` in pi's settings, and pi's `httpIdleTimeoutMs`, and give each address of a host 2 seconds to connect, as pi does. Before, Node ignored the proxy variables, so on a network that needs a proxy the pi command line worked and Pots did not reach its model. Model requests, MCP servers over HTTP and the chat apps that use fetch go through the proxy; Slack's Socket Mode and Discord's gateway connection do not.
- **Requests name Pots, not pi.** OpenRouter, NVIDIA NIM and OpenCode now see Pots (https://pots.sh) as the app; OpenRouter lists apps by this name. Subscription logins send no such name.

### Fixed
- **A choice with an explanation on an answer page.** A label with a title and a line under it, such as `<label><input type="radio"> Test <small>Nobody sees it</small></label>`, was squeezed into columns; the explanation now goes under the title.

## 0.8.5 (2026-11-17)

Teams channel replies could be dropped: two replies in different threads of a channel with the same message ID were taken as one, and the second was lost. This affects bots that use the Teams preview from 0.8.4; other channels are not changed.

### Fixed
- **Teams: a reply could be lost when a reply in another thread of the channel had the same ID.** Microsoft Graph keeps a message ID unique only in its chat, channel or thread ([chatMessage](https://learn.microsoft.com/graph/api/resources/chatmessage)), but the inbox's event ID of a Teams message had only the conversation and the message ID, so the second reply (live, or from backfill with the same change time) was taken as a repeat and dropped. A reply's event ID now has its thread's root too, as its address does, live, from backfill and when posted with `call`. A root message, or one outside a thread, keeps the event ID it had; a reply that Teams sends again across the upgrade is stored again, and the log keeps it once, as one message.

### Changed
- **The README says Pots has no coin.** Any token or coin under the Pots name, such as one promoted by @potsdotsh, is not ours; GitHub Sponsors is the only official way to support Pots.

## 0.8.4 (2026-11-16)

A Microsoft Teams channel, as a preview: a bot sets up its own Teams app with Microsoft's Teams CLI while the person signs in on their phone, and then reads and answers in channels, threads, group chats and DMs, with mentions, reactions, Adaptive Card buttons, files in DMs and backfill from Microsoft Graph. It is tested with fakes of Microsoft's services and with Microsoft 365 Agents Playground, not yet in a real Microsoft 365 organisation; what has not been tried is listed below. ws 8.23.0 fixes a memory exhaustion attack over WebSocket.

### Added
- **Microsoft Teams, as a preview.** A bot connects Teams itself with the `teams-channel` skill: it runs Microsoft's Teams CLI, gives the person a device code to sign in with their work account on their phone or computer, makes the app, its bot and its secret in one command (the CLI writes the secret straight to `~/.pots/secrets/teams-<bot>.env`, so the bot never sees it), asks for the permissions it reads with (resource-specific consent: all messages of the teams and chats it is added to, not only @mentions), sends the install link, and signs the person out of the CLI again (`teams logout`). For a person who is not an admin, it writes a note for their admin to allow custom apps. The bot.json entry is `{ "id": "teams", "type": "teams", "secrets": "~/.pots/secrets/teams-<bot>.env" }`.
- **How Teams reaches the bot.** By default over a socket the bot opens (Socket Mode, Microsoft's Teams SDK), so the computer needs no public address. Microsoft calls Socket Mode a preview; `"mode": "http"` instead takes Teams' requests on Pots' page server at `<publicUrl>/channel/<bot>/<channel>`, with Microsoft's signature checked on each. Every activity is stored before Teams gets its answer.
- **What the bot gets and does on Teams.** Messages in channels (with their threads), group chats and DMs, edits, deletes, reactions on its own messages, people joining and leaving, the app added or removed, and changes to a team's channels. It sends Markdown (through Chat SDK's Teams converter) with real mentions, replies in threads, opens DMs, reacts with the reactions Teams lets a bot use, and calls Teams' API and Microsoft Graph with `call`. Buttons and forms are Adaptive Cards: a click is answered at once and wakes the bot. Files sent in a DM and pasted images are saved; a file in a channel or group chat is a SharePoint link, which needs an admin's permission to read; the bot sends files as page links. After a restart or a dropped socket, Pots reads what it missed in channels and group chats from Microsoft Graph; DMs are not read again.
- **Not yet tested in a real organisation.** The Teams channel was tested with fakes of Microsoft's services and with Microsoft 365 Agents Playground. The live socket, the permissions people grant at install, the backfill against Microsoft Graph, files, admins' policies and Teams' rate limits have not been tried in a real Microsoft 365 organisation; the skill and the README say so. As on Telegram, a crash at the moment of a send can send a message twice.

### Changed
- **An older edit no longer replaces a newer one in the log.** An edit that a backfill read before a later edit came live (on any channel) adds nothing; edits with the same time still apply in the order they come.
- **ws 8.23.0** (was 8.22.2). It fixes a denial of service: a peer that sent many Pings and stopped reading could make ws buffer Pongs until memory ran out.

## 0.8.3 (2026-11-16)

Sign in to a model from a chat app: the bot sends a login link, and the person signs the bot's computer in to a model provider from a phone or any computer, with no terminal (`pots page login`, or `pots login --link`). Pots runs on pi 1.5.2 (was 1.5.0), Effect 4.1.4 and ws 8.22.2; MCP servers work better: a script no longer fails because of one server's schema, and large or unusual server replies no longer hang or slow down.

### Added
- **A login page: `pots page login`.** It gives the bot a one-time link to a page of Pots' own, where one person signs in to a model provider with a subscription (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more) or adds an API key (any of pi's providers, also TypeSafe's for the Jev judge). The login is pi's own, as in `pots login`, run in the gateway, and pi keeps it in `~/.pi/agent/auth.json`, for every bot and pi program of that user on the computer. The page shows what pi asks and shows: a choice, a field, a sign-in link, a device code with a copy button, and pi's progress, which it follows while pi waits for the person. Where pi offers a browser way and a device-code or copy-code way, the second works from another device, so the page puts it first and marks it; ways that need setting up on the computer itself (an AWS credential chain or profile, Google's Application Default Credentials or a service account file) are left out, and the page says the bot can set them up. For a sign-in whose browser ends on a `localhost` address, the page says to paste that address. `--provider` makes the link for one provider; `--text` is what the page says; `--for` names the person.
- **Several logins per link.** The link works for an hour unopened, then 15 minutes after Start, until the person presses Done. Nothing happens before Start, and only the browser that pressed Start first can use it (a cookie), as on the desktop page. A login that exists is replaced; the page says so before the person signs in.
- **The bot is woken once for each login**, with the provider, whether it replaced a login, the models and judges it can use now, and whether pi's default model of the provider answered when Pots tried it. It never sees a key, a code, a sign-in address, the account, or pi's own error text, which the page shows the person. It is woken once more when the link ends with no login, and when Pots restarted during a sign-in, which loses that sign-in. Wakes are written before they are sent and sent again after a failure or a restart. The bot chooses its model itself: the page does not change `bot.json`. The prompt gives the command, with the fact that logins belong to whoever pays for them and every bot on the computer shares them.
- **`pots login --link`**, for when no bot can make the link, for example when its only login has expired, or for an agent that sets Pots up for a person who will not use a terminal on that computer. It serves the login page itself for as long as the link works, at `publicUrl` on its `pagePort`, or else on a free port with a Quick Tunnel of its own, prints the link, each login, and then what pi can use.
- **The `pages` skill has the login page**: when to send it, what the person sees, what the bot is told, and that a local server's key can go through the password page and pi's `"!command"` form of `apiKey` in `models.json`. `pots page list` lists login links (`G1`, `G2`, …), and `pots page unlink` takes one back, which stops its sign-in with no wake. With a Quick Tunnel, the command's note says that Cloudflare can see what is typed on the page: a device code or a copy code is safe there, an API key is as on the password page.

### Changed
- **pi 1.5.2.** What the bot gains:
  - **Code mode and MCP tools.** Every code mode script failed with `URI malformed` when any MCP tool had a `$ref` with a bad percent escape in its schema, even a script that did not call that tool; now that parameter shows as `unknown`. `console.*` output shows `NaN` and `Infinity` instead of `null`.
  - **MCP servers.** Large stdio replies are no longer slow, a Streamable HTTP reply with CR-only line endings no longer fails, a reply over the size limit is rejected and its connection closed, and a stdio server whose main process had ended no longer stays running after it disconnects. `pots mcp list` sends the pi login's token to servers that sign in with one (`"auth": { "provider": … }`, such as Radius), instead of saying they need a sign-in; when that login is missing, `pots mcp` tells you to sign in with `pots login`.
  - **Models.** Claude Fable 5.2 (`claude-fable-5-2`) is in the `anthropic` provider. A stream cut short after the reply had begun is tried again. Claude Sonnet 5 no longer gets a temperature it rejects. Anthropic and Bedrock no longer send tools as strict again on every turn after Claude rejected that, which cost a failed request each turn. An OpenAI-compatible server such as vLLM 0.20+ no longer gets `"tools": []` (a 400 error) when the bot has no tools for a request. A connection error says its cause, such as a refused connection or a bad certificate. pi's default model for each provider is newer (for `anthropic`, Claude Opus 5.5), which `pots login` and `pots init` recommend after a sign-in.
  - **Agent runs.** A task no longer stays waiting when the last of its parallel tool calls ends at the wrong moment.
- **Effect 4.1.4 and ws 8.22.2**, patch releases. ws now decodes a user name and password in a WebSocket URL.
- **The bot watches a coding agent's command line as it would a child.** When it hands work to Claude Code, Codex or a similar command line running in the background, its prompt now says that such a run shows nothing while it works and says nothing when it ends: the bot has the command wake it at the end (`pots wake --from`) and sets itself wakes to look at its output, report progress, and notice a run that died.

## 0.8.2 (2026-11-16)

Upgrade if your computer runs systemd 258 or later (Ubuntu 26.04, Fedora 43 and 44, Debian testing, Arch): there, Pots 0.8.0 and 0.8.1 could rewrite `${…}` in the bot's commands, so a command ran changed or not at all. 0.8.2 fixes that. A Slack call with a file ID no longer hangs, and Slack requests give up within about 2 minutes.

### Fixed
- **On systemd 258 and later, a command in a scope could run changed, or not at all.** Since 258, `systemd-run --scope` expands variables in the command it runs by default (`--expand-environment`): in each bash, screen and routine command, `${…}` became the value of an environment variable or nothing (`${f%.txt}`, `${i}` in a loop), `$$` became `$`, and a command that began with `$`, such as `$HOME/bin/tool`, was left out, so nothing ran and the command succeeded with no output. Ubuntu 26.04, Fedora 43 and 44, Debian testing and Arch ship such a systemd. The command now goes through systemd-run in the environment, which systemd-run passes on as it is, so it reaches bash as the bot wrote it with every systemd version; no new option, so older systemd works as before.
- **`call slack files.delete` (or `files.info`) with a file ID hung for half an hour.** Pots read every `file` param as the path of a file to upload, so the ID became a body that never ended; Slack answered 408, and the Slack SDK tried again for about 30 minutes. Now only a `file` that is a local path (`/…` or `~/…`), also in `file_uploads`, is read, before the call, so a file that is not there fails at once; any other `file` goes to Slack as it is.
- **A Slack call, send or reaction that Slack does not answer fails within about 2 minutes.** A request that has no answer from Slack 30 seconds after it began fails; one that sends a file gets a minute more for each 5 MB, so a large upload on a slow link still goes through (down to about 0.7 Mbit/s). One that fails before Slack answers (no answer, an HTTP error, too many requests) is tried again until a try fails a minute or more after the first began. The Slack SDK's default tried for about 30 minutes, and held the bot's turn that long. The error says how long Pots tried, for example `An HTTP protocol error occurred: statusCode = 408; tried for 62 s, then gave up`. Discord and Telegram calls stay as they were, since they had limits already: Discord's client gives up a try after 15 seconds and tries a failed request at most 3 more times, besides the waits Discord asks for when it limits the rate; Telegram's calls try again only when Telegram asks for a wait of up to a minute, at most twice.
- **"Pots's desktop" on the desktop page.** The page and the password page write the bot's name with the possessive as English does: "Coly's desktop", "Pots' desktop".
- **The `desktop-page` skill said that a maximized window follows the phone's shape.** It does only when the window can be that narrow: Chrome is at least 500 pixels wide times its scale, 625 at 1.25, more than the 500 of a phone-shaped desktop. Then openbox makes the window as narrow as it can, so it reaches past the edge, and XFCE's xfwm4 leaves it at its old size and stops changing its size until it is maximized again. The skill now says so, and tells the bot to keep its browser at scale 1, zoom sites in instead, and maximize a window again after the link if it needs to.
- **`test/scopes.test.ts` read a command's file before the command wrote it.** The shell makes the file empty before `cat` writes it, so the test could read an empty file; it now waits for the written line.

## 0.8.1 (2026-11-15)

The Slack and Discord skills send the person to a desktop page link to sign in, and a test passes when it runs from a bot's shell.

### Changed
- **The `slack-channel` and `discord-channel` skills point to the desktop page for sign-ins.** When the person is not at the computer, the bot gives them a desktop page link (`pots page desktop`) to sign in on its screen; on a computer without a screen, the virtual desktop choice says they sign in from such a link, as the prompt does, not that they watch it over VNC.

### Fixed
- **`test/scopes.test.ts` passes when it runs from a bot's shell.** The test for commands without a systemd user manager compared the command's cgroup with `app-pots`, which failed whenever the test itself ran in a Pots scope; it now checks that the command stays in the test's own cgroup.

## 0.8.0 (2026-11-15)

A person can take over the bot's screen from a link, on a phone or a computer, do one step, and hand it back. A second or third bot sets itself up as the first one does, and offers to set up a screen of its own. On Linux each command runs in a systemd scope of its own, so a command that runs out of memory no longer takes the gateway and every bot down with it, and what commands leave running stays across a restart.

### Added
- **A desktop page: `pots page desktop`.** It gives the bot a one-time link to a page of Pots' own, where one person sees the bot's whole screen and controls it, through the VNC server that shows that screen on its computer. Pots signs in to that server itself, so its password never reaches the browser, a link or a log. Nothing of the desktop shows before the person presses Start, so a link preview cannot open it, and only the browser that pressed Start first can use the link; that browser can open it again, after a reload or a switch to another app, until the link ends. An unopened link stops working after an hour, a started one after 15 minutes (`--minutes`, up to 60). It goes through the page server's public address, a Quick Tunnel or your own; with a Quick Tunnel the page and the command's note say that Cloudflare can see the screen and every key typed.
- **Made for phones.** The picture fills the screen, and nothing else takes room from it. One group of buttons floats on it: the time left, keyboard, more, and Done; it can be dragged to any edge, stands upright on the left or right, and stays where it was put. The bot's words show in full when the picture comes, next to the buttons, for a few seconds, then fold into the first button; a tap on it shows them again, and a tap anywhere else folds them. The start screen shows long words in a calmer type with Start always in sight, and keeps the bot's line breaks: a line that starts with a number or a bullet reads as a list. When the VNC server can change its size, the bot's desktop takes the phone's shape while the person uses it (at least 500 pixels wide), and gets its own size back when the link ends, when the person's browser has been away for 20 seconds, and when Pots stops; after a crash, when the link ends. Pinching zooms the picture, not the page under it. The typing field sends each character as it is typed, also from an input method; with `--input password` it is a password field that password managers fill, and with `--input code` phones offer the code from a text message. `--area` starts a desktop that cannot change size zoomed in on the part that matters. More has Esc, Tab, Enter, arrows, select all, paste, a trackpad mode and the picture's size. On a computer the desktop takes the window's size, the keyboard types straight in, and ⌘ on a Mac becomes Ctrl. The page is in English, or in Chinese for a browser that asks for it.
- **The bot is woken once when the link ends**: when the person presses Done or "I can't do it", with their note, and when the link expires, unopened or after Start. It is also woken once when Pots cannot reach the VNC server for the person, at Start or later, while their page tries again by itself. While the link is started, the person holds the bot's screen: the screen commands of every agent on that screen do not run, and say why. `pots page list` lists desktop links, and `pots page unlink` ends one at once, with no wake.
- **`vnc` in bot.json**: the port of the VNC server on this computer and the file with its password, in the secrets folder: `VNC_PASSWORD=` as the password page writes it, or a password file as `vncpasswd` writes it. A new `desktop-page` skill says when to use the page, what the person sees, and how to set up a VNC server on Linux (X11, Wayland, or none), macOS and Windows. It also says how a bot sets up a screen of its own on a Linux computer whose desktop other bots use (a virtual desktop with its own D-Bus session bus and browser profile, as systemd user units, so it comes back after a restart), what to know when driving a Linux desktop (an input method can garble typed text; `gnome-screenshot` can give an old picture), and that a link goes to the person where they will open it.
- **`pots bot new` gives the new bot a first start, as `pots init` does.** The bot says hello, checks the screen, connects the chat apps the person wants, as an app of its own, and asks which models to use for which work. Its first wake says who made it and where that person is. When a bot made it, from its own shell, the new bot learns that this bot passes messages both ways with `pots chat` until it joins a chat app, and that it can wake that bot with `pots wake --bot` when something cannot wait. When other bots already work on the computer, it learns that bots on one screen wait for each other. Where another bot already uses the screen, it asks the person whether to set up a screen of its own, and recommends it: on Linux a virtual desktop such as TigerVNC's Xvnc, which takes about 0.5–1 GB of memory with its own browser, and a one-time package install with sudo when none is installed yet; on macOS and Windows a second screen is not practical, so it tells them that the bots take turns. `pots init` says the same when it makes another bot.
- **`pots bot new` waits until the running gateway has started the new bot**, so a `pots chat --bot <id>` right after finds it running.
- **"Add another bot" in the setup page for AI agents ([docs/for-agents.md](docs/for-agents.md))**: the person asks a bot they have to make one, or their agent runs `pots bot new`; the new bot then sets itself up.

### Changed
- **The `pages` skill and the prompt point to the desktop page**, and the prompt's choices for a computer without a desktop say that the person signs in to a virtual desktop from a desktop page link, with no SSH tunnel or open port.
- **A wake from a page link says that the link was used or ended**, since not every such wake is an answer now.
- **`ws` is a dependency of Pots**, for the desktop page's WebSocket. It was installed with Pots before, through other packages.
- **Linux: each command runs in a systemd scope of its own.** Where a systemd user manager runs (a desktop, or a server with lingering), every command of `bash`, `screen` and a routine runs in its own scope, in `app-pots-<id>.slice`, about 25 ms more per command. When memory runs out, systemd-oomd or the kernel stops the command that uses it, not the gateway with every bot in it: before, a heavy command, or the tabs of a browser a bot started, counted against the service, and systemd-oomd could kill the whole service with all its bots. What a command leaves running when it returns, such as a browser or a dev server, now keeps running when Pots restarts after an upgrade or a crash, and the bot's next wake lists it with its processes, so the bot decides when to stop it; a command Pots still waits on is stopped, with what it started. Stopping the service on purpose (`systemctl --user stop pots`, `pots service uninstall`) stops all of it. The prompt tells the bot these facts and the scopes' names. Elsewhere commands run as before.
- **Linux: the service has `OOMPolicy=continue`.** When the kernel kills one process of the service for memory, such as an MCP server, the gateway goes on instead of restarting. `pots service restart` adds the line to a unit an older version wrote.
- **The prompt tells the bot how to make another bot**: `pots bot new --about …`, then pass messages between it and the person until it has a chat app of its own, starting with who asked for it and where. It used to say only that a new folder with a bot.json is a new bot, so a bot made the folder itself, and the new bot got no first start. The screen facts now also say that bots that share a screen wait for each other, and that a screen per bot works best.
- **The bot confirms before an action that may cost money.** Its actions still need no approval, with one exception that the prompt now gives: before an action, it makes sure whether the action may cost money, and if it may, it confirms with the person before it does it.
- **A token file for each bot.** The Slack, Discord and Telegram skills, the pages skill and the prompt name the file for the bot, such as `slack-<bot ID>.env`, instead of one fixed `slack.env`, which another bot on the computer may already use: a second bot that followed the old text could write over the first one's tokens. Files that bots use now stay as they are. The Slack skill also says how to give the app an icon, which a manifest cannot do.
- **`pots chat -m` prints first what the bot sent since the last time**, such as a new bot's hello, or what the bot sent after the last `pots chat -m` ended. Before, it printed only the answers to its own message.
- **A mistyped command gets the command it most likely means**, for example `pots bot new Ada` for `pots bots new Ada`, instead of the whole help.
- **The bot knows that plain text is only one way to reply.** Its prompt says that pages, and the channel's own buttons, menus, forms and tables, often read and answer better, so it chooses what fits each time, and that a reply that runs to several messages goes out one message after another, since messages sent at the same time can arrive out of order.

## 0.7.2 (2026-11-13)

The bot sees what its children are doing and can free a stuck one, chooses each child's model, and `pots login` sets up everything in one run.

### Added
- **The bot sees what a working child is doing now.** Wherever a working child is described (the `task` tool's `list`, the answer to `send`, the children lines in wakes, `pots children`), indented lines say which tool it is in and for how long, the start of its command, its last output line and how old it is, and whether a message to it is still waiting: a child takes messages only between its steps.
- **`task interrupt` ends only a child's current command.** The child sees that its tool call was aborted, takes the messages that waited, and goes on. `stop` still ends the child.

### Changed
- **`pots login` adds all you need in one run.** After each sign-in, key or local server it says what is ready, or why not, and comes back to its menu; "Done" leaves and lists the models and judges pi can use, as `pots login --list` does. A judge's key, such as TypeSafe's for Jev, is tried at once, as `pots init` tries it.
- **`pots init` asks again when getting the AI fails.** A failed sign-in, a model or local server that does not answer, or Ctrl+C in one of its prompts takes you back to "How should your bot get its AI?" instead of ending `pots init`.
- **The setup page for AI agents ([docs/for-agents.md](docs/for-agents.md)) has the agent explain what you sign in to, and why, before it gives you `pots login`:** the model the bot thinks with, usually the subscription you already use, and a judge such as Jev, which decides which group messages wake the bot. You add both in one run.
- **The bot chooses each child's model.** When it starts a child, the `task` tool takes a `model` (`provider/modelId`) and any of pi's thinking levels, from `off` to `max`. A child it starts without them has the bot's model, also after a change in `bot.json`, and thinking `xhigh`. A child keeps the model chosen for it across changes of `bot.json` and restarts. A model that is unknown or not signed in on this computer is refused at once, with the reason, instead of failing at the child's first request. The prompt tells the bot that a code mode script lists the signed-in models, that it talks at `medium` thinking while children work at `xhigh` or `max`, and that which model does which work is the person's to say, kept in its AGENTS.md. A new bot asks about that at its first start.
- **`childModel` and `childThinking` in `bot.json` are no longer used.** A `bot.json` that still has them loads as before, and the gateway's output says that they are ignored. Children started before the upgrade have the bot's model.
- **Children report only when they end, and the bot knows it.** Its prompt says that for long work it can set itself a wake (`pots wake`) to look in on a child now and then and tell the person briefly how it is going.

### Fixed
- **An empty API key is no longer saved.** Enter at an empty key prompt in `pots login` or `pots init` saved an empty key over the one pi had, and pi then counted the provider as not signed in: `pots login` ended with "signed in, but pi lists no model or judge for this login". Now the prompt asks again, and Ctrl+C goes back without changing the key.
- **For contributors: `npm test` no longer depends on the environment it runs in.** `POTS_*` variables, a desktop (`DISPLAY`) and your home folder no longer leak into the tests, and the sign-in tests can no longer open a real browser. A test of memory passes that sometimes failed under load is fixed in the code: the log line "memory pass got no answer" is written after the pass has saved its progress.

## 0.7.1 (2026-11-10)

Pots is also a pi package, so a pi user's agent can set Pots up. Nothing changed for bots: a running bot does not need this version.

### Added
- **A setup skill for pi users.** The package has the `pi-package` keyword, so pi's package gallery can list it. A pi user who installs it (`pi install npm:pi-durable-bot`) gets one skill, `pots-setup`, which has their agent set up Pots by [docs/for-agents.md](docs/for-agents.md). Pots' own channel and page skills stay out of plain pi sessions.

## 0.7.0 (2026-11-10)

The bot can show people web pages, ask with buttons and forms, and take secrets on a page, also when its computer has no public address.

### Added
- **Pages.** The bot writes web pages in `pages/<name>/` of its folder and gives people links to them (`pots page link`). A link is long and random, can be made for one person (`--for`), and works until the bot unlinks it or the page is deleted. Answers from a page (the kit has choices, text, comments and approve or reject) wake the bot once per submission, with the version of the page the person saw. A page that nobody opened, linked or changed for 30 days is deleted; pages in `pages/keep/` stay.
- **A password page.** `pots page secret` gives a link, for one person, to a page of Pots' own where they type secrets once. The values go into a file in the secrets folder, never into the log, a wake or a trace. The link stops working after the submission, or after an hour. Link previews do not use it up.
- **A public address with no setup.** The page server listens on this computer only. With no `publicUrl` in `~/.pots/settings.json`, the first page link starts a Cloudflare Quick Tunnel, and Pots downloads a pinned, checksum-checked `cloudflared` when none is installed. Its address changes when Pots restarts, and the bot tells people what that means. With a `publicUrl`, for example a Tailscale Funnel address that the bot set up with you, links use that address.
- **Forms from buttons on Slack and Discord.** `pots form add` stores a form. A button with `form:<name>` opens it at once, within the platform's 3 seconds, and the submitted values wake the bot.
- **Skills come with Pots.** The Slack, Discord and Telegram guides are now skills (`slack-channel`, `discord-channel`, `telegram-channel`), each with a new section on buttons, forms, tables and clicks, and there is a new `pages` skill. Every bot sees them. A skill of yours with the same name is used instead.

### Changed
- **Clicks wake the bot at once.** A click on one of the bot's buttons or menus, a command of the bot, or a submitted form wakes it straight away, not through the judge and without waiting for more messages. This also holds on a message the log does not have, such as a Slack ephemeral message.
- **Pots answers Telegram button presses**, so the button stops spinning at once. The bot no longer calls `answerCallbackQuery` itself.
- **Platform errors say what was wrong.** When Slack, Discord or Telegram refuses a call, the bot sees the platform's details, for example which block of a Slack message is invalid. They never hold a token.
- **`pots status` has a `pages:` line** with the page server's port and the public address.
- **`ask-secret` writes its file atomically.**

## 0.6.1 (2026-11-08)

Pots is safer on a Linux computer that more than one user shares, and stops cleanly on Windows.

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
- **Discord.** The bot connects a Discord app itself, by [the guide that is now its skill](skills/discord-channel/SKILL.md). It receives over Discord's Gateway, so the computer needs no public address, stores every event before it is acknowledged, and reads what came while it was down, also in threads. A reply quotes the message in its channel or thread. With `call` it opens threads, posts files and uses any other part of Discord's API, and it answers slash commands and buttons.
- **Telegram.** The bot connects a Telegram bot itself, by [the guide that is now its skill](skills/telegram-channel/SKILL.md), with long polling, so the computer needs no public address. It sends rich messages with headings, lists and tables, and plainer ones where a chat does not take those. A topic is a thread, and a reply to the bot counts as a mention. Telegram keeps what came while the bot was down for 24 hours; it cannot read older history.
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
