---
name: information-sources
description: "Watching what a person wants kept an eye on that is not one of your chat channels: their mail, an issue tracker or analytics, a chat app they use in the browser or on the desktop (Slack, WeChat), a broker, a game store, social media. The ways to see that something is new, from an API to a screenshot, what each costs and how soon it sees things, how they fit routines, a cheap model that reads screenshots from a script, and methods that worked on a Pots computer: Slack through the browser's sign-in, and desktop notifications on Linux. Use when someone asks you to watch, check or keep up with something for them, or when a watch costs too much or tells them too late."
---

# Information sources

Your channels are where people talk to you: Pots receives their messages and wakes you. People also have things they want you to watch for them: their mail, Sentry, PostHog, a Slack workspace they use in the browser, WeChat on their computer, their broker, a game store ("update my games when there is an update"), social media ("is anyone talking about this actor"). These are information sources. Pots has nothing special for them: you watch them with routines and what you already have. What a watch costs, and how late it sees things, depends mostly on how it sees that something is new.

## A cheap check first

A watch has three steps:

1. **See that something is new.** A script, with no model. It compares with what it saw last time (the newest ID or time, a count, a hash of a page) and ends when nothing changed. Most runs end here.
2. **Decide if it matters.** Only for what is new, with the cheapest model that can tell: a classifier or a small model for "is there something for them?", one call to a strong model with low thinking for a decision that needs context.
3. **Act.** Wake yourself with what was found, to tell the person or to do the work.

What each step cost on one Pots computer (2026-11; dollars at API list prices, which a subscription takes from its quota instead):

| What | Time | Cost |
|---|---|---|
| Script check: new messages in 32 Slack conversations through the API | about 10 s | nothing |
| Classifier on a screenshot (typesafe/jev-latest) | 0.2–0.7 s, plus about 2 s to load pi in a script | nothing listed |
| Small chat model on a screenshot, through `pi -p` (Claude Haiku 5.5 / GPT-6 Luna) | about 2 s / 4.5 s | about $0.0002 |
| One call to a strong model with low thinking, on the new Slack messages as text (Claude Opus 5.5) | 15–25 s | about $0.03 |
| One run of a `--child` routine whose child reads new mail and decides | | about $0.50 |
| One wake of the main agent | | $0.30–0.90, the most when its prompt cache has expired |

## Ways to watch a source

From the cheapest and surest to the most expensive:

1. **An official API, CLI or MCP server** (Gmail, Slack, GitHub, Sentry, PostHog, a broker's API). Exact data, often with a "since" filter. It needs a sign-in or a key; look at what the key can do.
2. **The source's own data, without an official API**: the JSON that a site's web page loads (the browser's developer tools show the requests; many work with the browser's sign-in cookies), RSS or Atom feeds, files that a desktop app or a game launcher writes on this computer. Nearly as cheap as 1, but it can change without notice, and some sites' terms forbid it.
3. **What the system shows**: desktop notifications, unread counts on an icon or in a tab's title, window titles. Free and immediate, but only what the app shows (often a name and the first line), and only while the app runs and may notify. For closed apps such as WeChat on the desktop, this and 4 are often all there is.
4. **A screenshot, read by a cheap model that reads images.** Anything the screen shows. The app must be open and not covered by another window, and the model sees only what is in the picture.
5. **A strong model on the screen**: it looks, scrolls and clicks. The slowest and most expensive way, and other agents cannot use the screen while it works. It fits acting (replying, updating, buying) after 1–4 found something to do.

They mix: a notification or an unread count (3) says when to look, a cheap model on a screenshot (4) says whether it matters, and a strong model (5) acts.

## Routines

- `pots routine add <name> --every 2m --run "<command>"`: the command does steps 1 and 2, and runs `pots wake --note "<what, where>"` only when something needs you. A run that finds nothing costs nothing, so a short interval is fine; on the computer above, one `--run` routine runs every 2 minutes.
- A run is skipped while the last one still runs. A failed run (an exit code that is not 0, or its `--timeout`, 10 minutes by default) wakes you once. When the source is down for a moment, the command can exit with 0 and try at the next time, and wake you when it stays broken, as when a sign-in expired.
- Keep the last state in a file next to the script, and move it on only after a check that worked, so nothing is lost between runs.
- `pots wake --id <item ID>` sets no second wake with the same ID, so one item wakes you once.
- Give the model of step 2 a file with what it needs to know: who matters to the person, what they care about, what you already told them. Keep it current, or it repeats old news.
- `--child` starts a child at each time, for a check that needs tools and judgment each time (reading mail and deciding). `--note` wakes the main agent, which reads its whole conversation again: the most expensive, for what has to come to you every time.
- From the cheapest: `--run` with no model, `--run` with a cheap model, `--run` with one call to a strong model, `--child`, `--note`.

## Sooner than a routine

A routine sees things as late as its interval. Closer to real time:

- Free checks every minute or two.
- A listener: a script that runs all the time, gets each event when it happens (such as the desktop notifications below) and wakes you. Start it so it outlives your command (`nohup`, `systemd-run --user`), or as a systemd user service, which starts again when the computer starts. Stopping Pots' service stops what your commands started; a `--run` routine every few minutes that starts the listener when it does not run covers both.
- A burst of events can wake you many times: the listener can collect them for a few seconds, or skip what comes soon after its last wake.

## A cheap model from a script

In `codemode`, `models.classify` takes images, and `models.getAvailableOfType("classifier")` lists the classifiers. A routine's `--run` command has no codemode. From a script:

- [classify.mjs](classify.mjs), next to this file, asks a classifier one yes-or-no question about images and text, with this computer's pi logins: `node <this folder>/classify.mjs --image shot.png "Does …?"` prints `{"yes":0.96,"model":"typesafe/jev-latest","ms":410}`. `--text` gives text, `--model` a classifier. It exits with 3 when this computer has no classifier.
- A small chat model that reads images, through pi (`pi --list-models` shows which models read images):
  `pi -p --no-session --no-tools --no-context-files --no-skills --no-extensions --no-mcp --no-prompt-templates --model anthropic/claude-haiku-5-5 --thinking off @shot.png "… Answer one line: YES <who asks> or NO."`

Tried with 8 mock screenshots of Slack and WeChat (a quiet channel, chatter, a direct message, only an unread badge, a request to someone else, a mention among 13 messages, a request in Chinese, a family group's chatter):

- typesafe/jev-latest, Claude Haiku 5.5 and GPT-6 Luna each got all 8 right. Jev gave the same numbers again (±0.03), and about 0.35 for every case without the image, so it uses the image.
- Jev takes at most 1568 pixels a side; a larger image fails with "Invalid image dimensions". At 960×600 it missed a small @mention that it saw at 1536×960. Shrink screenshots to about 1568 pixels, not much smaller, or crop them to the app's window. An image of 1536×960 is about 4,400 input tokens.
- Say in the question what counts and what does not: who the person is, the names people call them, and that requests to others, bot posts and greetings do not count. On a screenshot of channel chatter, "does something need their attention?" got 0.67; the question with those details got 0.15.

## Methods that worked on a Pots computer

Written from real watches, without the people's details. When you get a way to watch another source working, keep it where other bots on this computer find it: a skill in `~/.agents/skills/` with the method, and the person's details in your own files.

### Slack in the browser, through the person's sign-in

For a workspace the person uses in the browser on this computer, watched as they see it (all their channels and DMs), when you are not in that workspace with an app of your own (the slack-channel skill). Tried on Linux with Google Chrome:

1. Read the cookies `d` and `d-s` of `.slack.com` from the Chrome profile's `Cookies` file, a SQLite database (copy it first: Chrome keeps it open). Their values are encrypted. On Linux the key comes from the secret "Chrome Safe Storage" in the keyring (Secret Service, for example Python's `secretstorage`; the keyring is unlocked after a desktop login): PBKDF2 with SHA-1, salt `saltysalt`, 1 iteration, 16 bytes. A value that starts with `v11` is AES-128-CBC with that key and an IV of 16 spaces, after the 3 bytes of the prefix; `v10` uses the password `peanuts` instead of the secret. Newer Chrome puts the SHA-256 of the host before the value: drop those 32 bytes. macOS and Windows keep the key elsewhere (the Keychain; on Windows, app-bound encryption since Chrome 127); not tried.
2. Load `https://<workspace>.slack.com/ssb/redirect` with a plain GET and the header `Cookie: d=<d, URL-encoded>; d-s=<d-s>`. The page has `"api_token":"xoxc-…"`. `auth.test` checks it.
3. Call the Web API at `https://<workspace>.slack.com/api/<method>` with `token=xoxc-…` in a form body and the same Cookie header: `users.conversations` with `types=public_channel,private_channel,mpim,im`, `conversations.history` with `oldest=<last check>`, `conversations.replies` for each message whose `latest_reply` is after the last check, and `users.list` for names (keep it for a day). On HTTP 429, wait for `Retry-After`.
4. `invalid_auth`, `not_authed`, `token_revoked` or `account_inactive` mean that the session ended: do steps 1 and 2 again. No `d` cookie means that the person is signed out of Slack in that profile: they, or you on the screen, sign in again.

- **Read state.** These calls and the page load mark nothing as read; `conversations.mark` would, and a message posted as the person moves their own read mark in that channel. The Slack web client marks what it shows as read. To sign in for them without it: after the sign-in, the browser lands on "Launching…" and offers to open the desktop app; cancel, and do not choose to use Slack in the browser. The cookie is set by then. (Blocking `app.slack.com` in `/etc/hosts` during the sign-in made sure the client did not load.) A sign-in with an email code in a headless browser met reCAPTCHA; in the browser on the screen it worked.
- **What it cost.** Every 2 hours, 14 channels and 18 DMs, about 10 s a check; one Opus call with low thinking on the new messages only when someone else posted: 3 calls in a day, about $0.10 together.
- **What the token can do.** Tell the person before you use it. The xoxc token with the `d` cookie is their signed-in session: it reads all they can read, and posts, reacts and changes settings as them, until that session ends. "Read only" is only what your script allows itself. Anyone who can read the file you keep them in can do the same; where several bots run as one system user, each of them can. It is not a way Slack offers for automation.
- **The other choice.** A Slack app of the person's own (https://api.slack.com/apps) with read scopes only, as user scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`. Installed by the person, it gives a user token (`xoxp-…`) that reads their conversations through the same methods, cannot post, and can be revoked alone. Installing it needs the right to install apps in the workspace: admins have it; in some workspaces others need an admin's approval. The person chooses.

### Desktop notifications on Linux

Apps and sites show notifications through the desktop session's D-Bus (`org.freedesktop.Notifications`). A script of the same user sees each one as it comes:

```sh
busctl --user monitor --json=short \
  --match "type='method_call',interface='org.freedesktop.Notifications',member='Notify'" \
| jq -c --unbuffered '.payload.data | {app: .[0], title: .[3], body: .[4]}'
```

(`dbus-monitor --session "interface='org.freedesktop.Notifications'"` shows the same as text, but does not escape the quotes in it.)

- Chrome's web notifications come with app `""`, the notification's title, and a body of `<site>\n\n<text>`. A site needs Chrome's notification permission for it. Tried with a page open in Chrome that had the permission.
- Chrome's notifications have buttons (actions). notify-osd, a notification server that cannot show buttons, showed them as windows in the middle of the screen that stayed until closed. `gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.GetCapabilities` lists what the server can do: look for `actions`. xfce4-notifyd, dunst, mako and GNOME Shell have it (not tried here).
- The listener sees every notification of the session, private messages too: keep only those of the apps and sites the watch is for.
- macOS and Windows: not tried.

A listener that asks a classifier about each Slack notification and wakes you only for those that matter:

```sh
busctl --user monitor --json=short --match "type='method_call',interface='org.freedesktop.Notifications',member='Notify'" \
| jq -c --unbuffered '.payload.data | {app: .[0], title: .[3], body: .[4]}' \
| while read -r n; do
    case "$n" in *slack.com*) ;; *) continue ;; esac
    node <this folder>/classify.mjs --text "$n" "This is a desktop notification of Ann's Slack. Does it ask Ann herself for something? Chatter, bot posts and greetings do not count." \
    | jq -e '.yes > 0.5' >/dev/null && pots wake --bot <your bot ID> --from slack-notify --note "Slack notification: $n"
  done
```

In a test with notifications shaped like Chrome's, Jev gave 0.91 to a direct message that asked Ann for a confirmation by 3 pm, 0.28 to chatter about lunch, 0.07 to a request to someone else and 0.09 to a bot's post.
