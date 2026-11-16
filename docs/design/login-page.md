# Design: the login page

Status: built, with the owner's decisions of 2026-11-16: D1 A, D2 A, D3 A, D4 A, D5 B, D6 A, D7 A, D8 A; open questions: no owner concept in code (1), per Linux user (2), no local servers on the page (3), the way that works from another device marked (4), ways for the computer itself left out (5), no sign-out (6). Written 2026-11-16 against Pots 0.8.2 and pi 1.5.0 (`@earendil-works/pi-ai`, `pi-coding-agent`).

## The problem

A person who talks to their bot only in Slack, Discord or Telegram cannot sign in to a model. `pots login` (subscriptions, API keys, local servers, the TypeSafe key for Jev) runs only in a terminal on the bot's computer. Logins and keys must never pass through the agent, so the bot cannot take them in a message either.

The idea: a one-time **login page**, a sibling of the password page (`pots page secret`) and the desktop page (`pots page desktop`). The bot sends the link; the person signs in there from their phone or another computer; pi stores the login as `pots login` does; the bot is told only which provider was signed in and which models it can now use.

## What pi does today

`pots login` (`src/cli/ai.ts`) does not have its own login code. It calls pi's `models.login(provider, "oauth" | "api_key", interaction)` and answers pi's questions in the terminal. `interaction` is pi's `AuthInteraction`, which has only two calls:

- `prompt(...)`: pi asks for something. The kinds are `select` (choose one), `text`, `secret` (hidden) and `manual_code` (paste a code or the redirected URL; pi can withdraw it when its callback wins).
- `notify(...)`: pi shows something. The kinds are `auth_url` (open this sign-in link), `device_code` (go to this address and type this code), `info` and `progress`.

pi writes the result to `~/.pi/agent/auth.json`, with a file lock. Every bot of this user and the pi command line share it. The gateway's own `Models` sees a login made through it at once.

The subscriptions in pi 1.5.0, and the way each one works from a phone:

| Provider | Ways pi offers | From a phone |
|---|---|---|
| `anthropic` (Claude Pro/Max) | Browser: callback to `localhost:53692/callback` (a free port when that one is taken), or paste the redirected URL. Copy code: the redirect goes to `platform.claude.com`, which shows a `code#state` to paste. | **Copy code** |
| `openai-codex` (ChatGPT Plus/Pro) | Browser: callback to `localhost:1455/auth/callback`, or paste. Device code at `auth.openai.com/codex/device`, 15 minutes. | **Device code** |
| `openai` (Sign in with ChatGPT) | Browser only: callback to `127.0.0.1:1455`, or paste the redirected URL. It fails when port 1455 is in use. It needs pi's device ID. | **Paste the redirected URL** |
| `github-copilot` | Asks for an Enterprise domain (text, empty for github.com), then a device code. | **Device code** |
| `xai` (SuperGrok, X Premium) | Device code. | **Device code** |
| `kimi-coding` | Device code. | **Device code** |
| `meta` | Device code. pi then gets an API key that lasts a day and renews itself. | **Device code** |
| `radius` | Browser: callback to `127.0.0.1:1456`; or a device code. | **Device code** |
| `openrouter` | Callback to a random free port and a random path, or paste the redirected URL. | **Paste the redirected URL** |

There is no Google subscription login in pi 1.5.0. Google is available only with API keys: Gemini, or Vertex.

API keys: most providers ask for one `secret`. A few ask for more. Cloudflare asks for an account ID and a gateway ID (`text`). Vertex and Bedrock ask for a `select` and then project, region, profile or file path; Bedrock's "credential chain" says "configure AWS credentials, then press Enter", which works only on the computer itself. TypeSafe (Jev) is a plain API key.

**What this means:** a callback to `localhost` cannot work from a phone, because the redirect goes to the phone's own localhost. But every provider has a way that does work. Seven of the nine have a device code or a copy code. With the other two, `openai` and `openrouter`, the person copies the address of the "can't connect" page that the browser shows and pastes it. That is what `pots login` already asks over SSH. A pasted code is useless without the PKCE verifier, and the verifier never leaves the bot's computer.

## The design in one picture

```
bot:     pots page login [--provider anthropic] [--text "…"] [--for <person>]
         → {"id": "G1", "url": "https://…/g/<token>/", "via": "quick-tunnel"}
bot:     sends the link in the chat
person:  opens it → presses Start (the link is now bound to this browser)
page:    choose: subscription | API key → provider
gateway: models.login(provider, way, webInteraction)
           pi's prompts → fields and buttons on the page
           pi's auth_url / device_code → a link to open, a code to copy
           person pastes the code or URL, or signs in on the provider's site
         pi writes ~/.pi/agent/auth.json
gateway: tries pi's default model of that provider (as pots login does)
page:    "Signed in to Anthropic. Ready: anthropic/claude-opus-5-5"
bot:     woken: "login page: link G1 (made for …) signed in to anthropic
         (subscription). Usable now: anthropic/claude-opus-5-5, …"
```

The page is a **general renderer of pi's `AuthInteraction`**, like `terminalInteraction` in `src/cli/ai.ts` is for the terminal. It contains no code for each provider. A provider that pi adds or changes works without a change to Pots.

## How it fits what exists

Everything below already exists for the password and desktop pages. The login page reuses it:

- **Page server and address.** The same server, route `/g/<token>/` next to `/s/` and `/d/`, and the same public address: `publicUrl`, or a Quick Tunnel that starts with the first link.
- **Link rows in the bot's `bot.sqlite`**, as `bot_desktop_links`: IDs `G1`, `G2`, … The token has 144 bits. `--for`. The link can be taken back with `pots page unlink`, and `pots page list` shows it. Rows are kept for 7 days.
- **Start and a cookie**, as on the desktop page. Nothing happens before Start. The first browser that presses Start keeps the link. The link works for 1 hour unopened, then for 15 minutes after Start; the 15 minutes match OpenAI's device code.
- **The wake**, as the password page does it. It is written in the row before it is sent, sent once for each request ID, and sent again after a failure or a restart.
- **The page's headers**: as on the desktop page, a CSP that allows only this address, and a small script from `kit/`. The page must update by itself while pi polls a device code.
- **The Quick Tunnel note** in the command's JSON, as `QUICK_TUNNEL_SECRET_NOTE`.

New things:

- `pots page login` and its route. A `WebInteraction` that keeps pi's open prompt for each link in memory. The page asks for its state and posts answers.
- The login itself runs **in the gateway process**. The PKCE verifier and the callback servers stay there, as the VNC password does for the desktop page. If the gateway restarts during a login, the login is lost. The row then ends as "Pots restarted", and the bot is woken so it can send a new link.

## What the bot sees, and what it is told

The bot sees: the link ID, the provider and way (subscription or API key), the models it can use now, and any judges (TypeSafe). On a failure it sees a short reason from Pots, never pi's raw error text, because some token-exchange errors include response bodies. The page shows the full error to the person.

The bot never sees: a key, a code, a redirected URL, the sign-in URL (it contains the PKCE challenge and state), or the account name.

Line for the system prompt (`src/bot/prompt.ts`, next to `pots page secret`):

```
pots page login [--provider <id>] [--text <text>] [--for <person address>]   a one-time Pots page where a person signs in to a model provider with a subscription or adds an API key (also TypeSafe's, for Jev), from any device. Logins are for every bot and pi on this computer, and a new one replaces the provider's old one. You are told which provider and which models are now usable, never the login.
```

And one line of context, not a rule: logins belong to whoever pays for them and are shared by every bot on the computer, so send this link to the person who runs you, or to someone they named, as a coworker would hand the company card only to its owner.

`docs/for-agents.md`, step 4 and "After setup": a person who will not use a terminal on that computer can sign in later from a link. They ask the bot, "sign me in to Claude", or the setting-up agent runs `pots login --link` (D5). The README's "Its own pages" gets one bullet.

## Security

- **Who can open it:** anyone who has the link, until Start; after Start, only that browser. This is the same as the desktop page. The link goes to one person (`--for`). The wake says which link was used, never who used it.
- **What is new compared with the password page:** a login changes which account **every bot on the computer** uses. A person with the link could sign the bot in to *their own* account, for example an OpenRouter account that logs prompts, and then read the bots' conversations from it. The protections are: the link is for one person and one use, it is bound to one browser, the page says plainly "this replaces the current login for X on this computer", and the bot's wake says what was replaced. Who may ask for a link is the bot's judgment (see above). There is no owner concept in code (open question 1).
- **Quick Tunnel and Tailscale Funnel.** Cloudflare terminates TLS on a Quick Tunnel and can see what is typed. Tailscale Funnel terminates TLS on the bot's computer. What crosses the tunnel depends on the way:
  - Device code: nothing secret. The person types the code on the provider's own site.
  - Pasted code or redirected URL: one authorization code, used once. It is useless without the PKCE verifier, which stays on the bot's computer.
  - API key: the key itself. This is the same risk as the password page, and the page carries the same warning.
- **Phishing:** the page shows only the URLs that pi gives (pi checks the device-code addresses that providers send with `trustedHttpUrl`), as links with `rel="noreferrer"`. The bot cannot give its own sign-in URL.
- **Not by the desktop page:** the bot could open the sign-in in its own browser, and the person could sign in there through a desktop page. The localhost callback would then work. But the password would be typed on a screen that the agent can screenshot. So this design does not use it, except as the last resort it already is.

## Decisions for the owner

**D1. Where the login runs.**
- A. In the gateway, through the shared `Models`. One process, the new login is seen at once, and the desktop page works the same way. A login is lost if the gateway restarts during it. *Recommended.*
- B. A `pots login` child process for each link, with the page as its terminal. It is isolated, but it adds a process protocol and still loses the login when it restarts.

**D2. The command.**
- A. A new `pots page login`, a sibling of `secret` and `desktop`. *Recommended.*
- B. A `--login <provider>` flag on `pots page secret`. That page is one plain form with no script, which by design does not fit a sign-in with several steps and waiting.

**D3. What the page offers.**
- A. What `pots login` offers, except local servers: subscriptions and API keys (also TypeSafe). The bot can already add a keyless local server to `models.json` itself. *Recommended.*
- B. Subscriptions only. API keys stay with `pots login`. This is less to build, but the TypeSafe key for Jev, a common case, would still need a terminal.
- C. Also local servers that need a key. Open question 3.

**D4. The model after the login.**
- A. The page tries pi's default model of the provider and reports it. The wake lists the usable models. The bot chooses or asks, and changes `bot.json` itself. This keeps the judgment with the agent. *Recommended.*
- B. The page also asks the person which model the bot should use, and writes `bot.json`. This means one step less, but the page makes a choice that belongs to the bot and the person's conversation.

**D5. When the bot cannot think.** The login page needs a bot that runs, but the most common need is an expired or missing login, and then the bot cannot run.
- A. Only the bot makes links. This does not help when its only login is broken.
- B. A plus `pots login --link`. The CLI runs a page server for a short time (and a Quick Tunnel when there is no `publicUrl`), prints a link, waits, then prints what was signed in. It needs no terminal. A setting-up agent over SSH, or a cron job, can give the link to the person. The same code runs without a bot. *Recommended.*
- C. B plus: when the bot's model fails with a login error, Pots's own "I could not work on this" reply, only in a DM or `pots chat`, has a login link. This covers the expired-login case with no agent at all. But code would send a link that no one asked for, and to whoever wrote in that DM. Owner's call.

**D6. One or several logins per link.**
- A. Several, until Done or the 15 minutes end, as in the `pots login` menu, for example ChatGPT and then the TypeSafe key. Each login wakes the bot once. *Recommended.*
- B. One login per link. This is simpler, but needs two links for the common "model plus Jev" setup.

**D7. A login that already exists.**
- A. Replace it, and say so on the page before the person signs in and in the wake. *Recommended.* It is the person's account, and an expired login must be replaceable.
- B. Refuse unless the bot made the link with `--replace`. This is safer against a wrong person, but adds a flag that the bot sets after a guess about the account.

**D8. API keys over a Quick Tunnel.**
- A. Allow them with the password page's warning. This is the same as the password page. *Recommended.*
- B. Refuse keys over a Quick Tunnel and allow only subscriptions. This is safer, but for API keys it makes Tailscale Funnel a must.

## Open questions

1. **Owner.** Pots has no concept of an owner. Should a login link be the bot's judgment only (as proposed), or should code limit `pots page login` to people that `bot.json` names?
2. **Several Linux users.** `auth.json` belongs to each user, so a login applies to the bots of the user that runs the gateway. Is that what people expect from a link that a bot sends?
3. **Local servers with a key.** Should the page take the key and URL of an OpenAI-compatible server, or should the bot write `models.json` and the key go through the password page? The key would then have to be read from the secrets folder, for example with pi's `!command` key form. This needs checking.
4. **Which way to suggest.** When pi offers both a browser way and a device-code or copy-code way, should the page mark the second one as "recommended on this device"? It can match pi's option IDs (`device_code`, `device-code`, `copy_code`), which are pi internals, or it can show pi's labels as they are.
5. **Bedrock credential chain and Vertex ADC** need files on the computer. Should the page hide them, or show them with "the bot has to set this up on its computer"?
6. **Signing out.** `pots login` cannot sign out today. Should the page be able to?

## Summary

A login page is a third Pots page. It is pi's own login, `models.login`, run in the gateway, with a web page that answers pi's prompts instead of a terminal. Every subscription in pi 1.5.0 can be completed from a phone: with a device code (Codex, Copilot, xAI, Kimi, Meta, Radius), a copy code (Anthropic), or a pasted redirect URL (Sign in with ChatGPT, OpenRouter). It reuses the page server, the one-time links, Start and its cookie, the expiry and the wake that is sent once. The bot learns only the provider and the usable models.

Decisions for the owner: **D1** where the login runs (gateway), **D2** a new `pots page login`, **D3** what it offers (subscriptions and keys, no local servers), **D4** the bot picks the model, not the page, **D5** `pots login --link` for when no bot can think, and whether a failed bot replies with a link itself, **D6** several logins per link, **D7** replace existing logins, with notice, **D8** keys over a Quick Tunnel, with a warning. Open questions: an owner concept, several users, local-server keys, which way to suggest, Bedrock and Vertex, and sign-out.
