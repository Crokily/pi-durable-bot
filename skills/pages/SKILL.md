---
name: pages
description: Web pages you write and send to people as a link. A display page shows what is too big for a chat message (a plan, a report, tables, charts); an answer page collects many answers at once (choices, text, comments on sections, approve or reject) and sends them back to you; the Pots password page takes a secret such as a token. Also how page links reach the internet (Cloudflare Quick Tunnel, Tailscale Funnel), website projects, and cleanup. Use when a chat message is too small for what you must show or ask, or when a person has to give you a secret.
---

# Pages

A page is a web page you write: full HTML, with your own layout and scripts. Pots serves it on this computer and gives you a link that people open in their phone's or computer's browser. What they answer on it comes back to you as a wake.

## Choose how to ask

A guide, not a rule; you decide.

| What you need | Use | Why |
|---|---|---|
| A simple question | Plain text in the chat | Works the same on every platform |
| One question with a few options, and the platform has a fitting element | Native buttons or menus: the slack-channel, discord-channel and telegram-channel skills | One tap answers it; the click names the person's account |
| Show something large: a plan, a report, a table, a chart | A display page | Long content does not fit a chat window |
| Many inputs at once: choices, text, a comment on each step, approve or reject | An answer page | One page, one submit |
| A secret: a password, a token, a key | The Pots password page (`pots page secret`) | The value goes straight to a file in the secrets folder, never into the chat, the log or your conversation |

Never ask for a secret in a chat message, and never write your own page for one. If someone pastes a secret into a chat, tell them that the chat keeps it, and suggest they replace it. In the terminal channel (`pots chat`), ask-secret works as before.

## Three kinds of pages

| Kind | Example | Who writes it |
|---|---|---|
| Display page | A report, a plan, tables, charts. Only to read | You, freely. The kit's style saves time |
| Answer page | Feedback, choices, text, a comment on a section, approve or reject | You, with the kit's components, or fully your own. Change the style and layout as you like: the components are a start, not a limit |
| Password page | A token for an app | Pots. You choose only the text on it, the keys and the file |

## Where pages live

Each page is a folder in your bot folder: `pages/<name>/`, with `index.html` and any other files it uses (images, scripts, data). Its name is the folder's name, such as `deploy-plan`. A page in `pages/keep/<name>/` is a kept page, named `keep/<name>`: cleanup never deletes it (see Cleanup).

Change the files at any time, in place. The link stays the same: people reload and see the new version. Do not replace the folder with a new one of the same name (for example by deleting and writing it again, or by moving another folder there): Pots then sees a different page, and every link of the old one stops working for good. To take a page off the internet, delete its folder, or unlink its links.

## Links

```sh
pots page link deploy-plan                        # one link that anyone who has it can use
pots page link deploy-plan --for slack:@U123      # a link made for one person
pots page unlink <link ID or URL>                 # the link stops working at once
pots page list                                    # your pages, their links, when each was last opened and changed
```

`pots page link` prints JSON: `{"link": "<link ID>", "url": "https://…/p/<token>/", "via": "public-url" or "quick-tunnel", "note": "…"}`. `note` comes with a Quick Tunnel and gives its facts (see below). Nobody can guess a link, but anyone who has it can open it, and a link can be forwarded.

- Make a link per person with `--for <person address>` when you want to know whose link an answer came through. Then say "someone used the link made for Alice", never "Alice answered": you know the link, not the person. To know for sure who answered, use a platform button: the platform names the account that clicked.
- Turn link previews off when you post a link (the channel skills say how). A platform's preview opens the link from its own servers.
- With a Quick Tunnel, the address changes each time the gateway starts, so links sent before stop working; `pots page link` again gives a new link to the same page.

## Write a page quickly with the kit

Pots serves a kit for pages: `pots.css`, a clean look for phones and computers, light and dark, and `pots.js`, which sends a form's answers to Pots. Link them relative to the page's link, not its folder on disk: from a page's `index.html`, also in `keep/`, use `../../__pots/kit/`, and add one `../` for each subfolder of the page. A complete answer page:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deploy plan 4.2</title>
  <link rel="stylesheet" href="../../__pots/kit/pots.css">
  <script src="../../__pots/kit/pots.js" defer></script>
</head>
<body>
<main>
  <h1>Deploy plan 4.2</h1>
  <p class="pots-muted">Please answer by Friday.</p>
  <form data-pots data-pots-done="Thanks, I have your answers.">
    <fieldset data-pots-question="target">
      <legend>Where should I deploy first?</legend>
      <label><input type="radio" name="target" value="test" required> Test</label>
      <label><input type="radio" name="target" value="prod"> Production</label>
    </fieldset>

    <fieldset data-pots-question="notify">
      <legend>Who should I tell?</legend>
      <label><input type="checkbox" value="support"> Support</label>
      <label><input type="checkbox" value="sales"> Sales</label>
    </fieldset>

    <section data-pots-question="step-3">
      <h2>3. Migrate the data</h2>
      <p>Runs on the live database, with about 10 minutes of read-only mode.</p>
      <div class="pots-approve">
        <label><input type="radio" name="step-3" value="approve" required> Approve</label>
        <label><input type="radio" name="step-3" value="reject"> Needs changes</label>
      </div>
      <details class="pots-comment"><summary>Comment</summary>
        <textarea name="step-3-comment" data-pots-comment></textarea>
      </details>
    </section>

    <label data-pots-question="window">When is a good time?
      <input type="text" name="window" placeholder="Tuesday after 18:00">
    </label>

    <label data-pots-question="notes">Anything else?
      <textarea name="notes"></textarea>
    </label>

    <button type="submit">Send answers</button>
  </form>
</main>
</body>
</html>
```

### The components

All are normal form elements inside `<form data-pots>`; `pots.js` reads them when the form is submitted. Mark each question with `data-pots-question="<id>"` on the element around its fields: a `fieldset`, a `section`, a `label`, a `div`. IDs are yours; keep them short and unique on the page.

| Component | HTML | Its answer |
|---|---|---|
| Single choice | radio inputs with one `name` | `{"value": "test", "label": "Test"}`, or `null` when none is chosen |
| Multiple choice | checkbox inputs | `[{"value": "support", "label": "Support"}, …]`, maybe `[]` |
| Text, one line | `<input type="text">` (or `email`, `number`, `date` …) | the text |
| Text, several lines | `<textarea>` | the text |
| A comment on a section | a `<section>` with your content and a `<textarea data-pots-comment>`, best inside `<details class="pots-comment">` so it opens only when wanted | `"comment": "…"` next to the section's answer, only when written |
| Approve or reject | radio inputs with values `approve` and `reject` in `<div class="pots-approve">` | like a single choice; add a comment field for the reason |

- A `<select>` works too: like a single choice, and with `multiple` like a multiple choice. Fields of different kinds, or several text fields, in one question give an object with one value per field `name`. A field outside every question is a question of its own, named by its `name`.
- The question's text, which comes back with the answer, is `data-pots-text="…"` when you set it, else its first `data-pots-label` element, `legend` or heading, else the label's own text. A choice's label is the text of its `<label>`.
- `required` works as in any form: the browser asks for the field before it sends. Do not put a required field in a closed `<details>`.
- `data-pots-done="…"` on the form is the text shown after the answers are sent. `<p data-pots-status></p>` places the status line; without it, it goes after the submit button.
- After a successful send the form is disabled and says so; reloading the page gives an empty form, and sending again is a new answer.

How pots.js sends: on load it reads the page's version from `__pots/info` of the link, once; if that fails, it never sends the answers with a version read later, which could be a newer page's, but asks the person to reload the page, with their answers still on screen. On submit it posts `{"submission": "<ID>", "version": "<the version the person saw>", "answers": {…}}` to `__pots/submit`, with one submission ID for every try of the same submit. If the network fails, or Pots answers with a server error, it shows "trying again" and tries again, with longer waits up to 30 seconds, and at once when the phone is back online. Pots wakes you once per submission ID, also when only its reply got lost. A revoked link gets "This link no longer works". Answers are at most 64 KB.

### Other classes and attributes

- Plain HTML already looks right: headings, lists, tables (they scroll sideways on a phone), code, quotes, images. Classes: `pots-card` (a box), `pots-note` (a highlighted note; with `pots-warn`, a warning), `pots-row` (boxes side by side that wrap on a phone), `pots-badge` (with `pots-good` or `pots-bad`), `pots-muted`, `pots-num` (a right-aligned table cell for numbers), `pots-secondary` (a quieter button).
- `<body data-pots-refresh="5">`: every 5 seconds the page asks Pots whether any of its files changed, and reloads when one did; when the person has started to fill a form, it shows "This page has changed" with a Reload button instead. Use it for progress pages. A Quick Tunnel cannot push to the browser (no Server-Sent Events), so pages poll.
- Text that other people wrote (comments, names, messages) must never become HTML: someone's `<script>` would run on the page. Write it into a JSON file next to the page and let the kit show it as text:
  ```html
  <div data-pots-source="comments.json">
    <p>Updated <span data-pots-fill="updated"></span></p>
    <ul data-pots-list="items"><li><b data-pots-fill="who"></b>: <span data-pots-fill="text"></span></li></ul>
  </div>
  ```
  With `comments.json` = `{"updated": "10:02", "items": [{"who": "Alice", "text": "Looks good"}]}`, the first child of a `data-pots-list` repeats for each item. pots.js sets only `textContent`, never `innerHTML`. If you write such text into HTML yourself, escape `&`, `<`, `>` and `"`.
- `window.PotsKit.submit(answers)` sends answers your own script built, with the same version, submission ID and retries; it resolves `{ok: true}` or `{ok: false, status, message}`. `PotsKit.collect(form)` gives a kit form's answers without sending them. The kit's source is [../../kit/pots.js](../../kit/pots.js) and [../../kit/pots.css](../../kit/pots.css).

### Fully custom pages

Write any HTML, CSS and JavaScript, with any libraries. To send answers without pots.js, post JSON to `__pots/submit` under the link's base (`/p/<token>/__pots/submit`): `{"submission": "<a random ID you make once and send again on every retry>", "version": "<from GET __pots/info>", "answers": {…}}`, at most 64 KB. Pots answers `200 {"ok": true}`, also for a repeat of a submission ID, which does not wake you again; `400` for a bad body; `404` for a revoked or unknown link. Give each answer its question's text, as the kit does, so that you can judge an answer to an older version.

## How answers come back

A submission wakes you at once, as a timed wake with this note:

```
page answer: someone used link <link ID> (made for <person address | anyone>) on page <name> (version <version>): <answers as JSON>
```

The answers of the example page look like this:

```json
{"target": {"question": "Where should I deploy first?", "answer": {"value": "test", "label": "Test"}},
 "notify": {"question": "Who should I tell?", "answer": [{"value": "support", "label": "Support"}]},
 "step-3": {"question": "3. Migrate the data", "answer": {"value": "reject", "label": "Needs changes"}, "comment": "Try it on test first."},
 "window": {"question": "When is a good time?", "answer": "Tuesday after 18:00"},
 "notes": {"question": "Anything else?", "answer": ""}}
```

- The version is the page as the person saw it. The version changes whenever any file of the page changes; `curl -s <link URL>__pots/info` gives the version now. When they differ, the person answered an older page: the question texts show what they saw, and you judge whether the answer still counts.
- An answer through a link made for Alice was sent by someone who had that link. Usually that is Alice; when it matters, ask her.
- Answers are in your log like other wakes. Tell the people what you did with them, in the chat where you sent the link.

## The password page

```sh
pots page secret --file slack.env --keys SLACK_APP_TOKEN,SLACK_BOT_TOKEN --text "Paste the two Slack tokens from step 5" --for slack:@U123
```

It prints JSON: `{"link": "<link ID>", "url": "https://…/s/<token>", "expires": "<time>", "via": …, "note": …}`. The page is Pots' own; you choose only the text, the keys and the file. One person submits it once: the values go straight into that file in the secrets folder (`~/.pots/secrets/`), and the link stops working. A link that nobody submits stops working after 1 hour. Opening the page does not use it up, so a platform's link preview cannot either; still turn previews off.

You are woken with:

```
secret page: someone used link <link ID> (made for <person address | anyone>) and wrote <KEY1>, <KEY2> to <file> in the secrets folder
```

You never see the values; they are not in the log, the wake or a trace. Then use the file as after ask-secret, for example as `secrets` of a channel in bot.json. The file has the values exactly as they were typed, one `KEY=value` line each, so never `source` it or `.` it in a shell: a value can hold `$(…)`. To use one value in a command, read just that line, for example `"$(grep '^SLACK_BOT_TOKEN=' ~/.pots/secrets/slack.env | cut -d= -f2-)"`, and never print it. Send the link in a DM to that person when you can. With a Quick Tunnel, tell them every time that Cloudflare can see what they type into the page (see below), and offer Tailscale Funnel.

## Where links point: a Quick Tunnel or your own address

Pots serves pages on this computer only (127.0.0.1, at `pagePort` in `~/.pots/settings.json`). The internet reaches them in one of two ways:

- `publicUrl` in `~/.pots/settings.json` is set (a Tailscale Funnel address, a domain, a reverse proxy): links use it, and no Quick Tunnel starts. `via` is `public-url`.
- `publicUrl` is not set: Pots starts a Cloudflare [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) at the first `pots page link` or `pots page secret`, and keeps it until the gateway stops. `via` is `quick-tunnel`. All bots of this computer share it.

What a Quick Tunnel means, from Cloudflare's docs and how it works:

- No account and no setup.
- The address (`https://<random words>.trycloudflare.com`) changes every time the gateway starts, so links sent before stop working.
- Cloudflare ends the HTTPS connection on its servers, so Cloudflare can see the pages and what people type into them.
- Cloudflare says Quick Tunnels are for testing and development, with no uptime guarantee; at most 200 requests at a time, and no Server-Sent Events.

**When to tell the person.** The first time you send a page link over a Quick Tunnel, tell the people you work with these facts in a sentence or two, and save in your memory that you did. For example: "This link goes through Cloudflare's free Quick Tunnel, which needs no account. Three things to know: the link changes when Pots restarts, Cloudflare can see the page, and Cloudflare says the service is for testing. For a fixed address that Cloudflare cannot read, I can set up Tailscale Funnel; you would sign in once." And every time you send a password page over a Quick Tunnel, say that Cloudflare can see what is typed into it.

## Set up Tailscale Funnel with the person

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) gives this computer a fixed address, `https://<machine>.<tailnet>.ts.net`. Its relays do not decrypt the traffic: HTTPS ends on this computer. People who open a link need nothing installed. You do the work; the person signs in once.

1. Ask the person first. Look at `~/.pots/settings.json`: if `publicUrl` is already set, links use it; change it only with the steps below.
2. Install Tailscale if `tailscale version` fails: https://tailscale.com/download (on Linux: `curl -fsSL https://tailscale.com/install.sh | sh`). It needs administrator rights; when `sudo -n true` fails, give the person the command to run. On Linux, `tailscale` commands that change settings need `sudo`.
3. If `tailscale status` says this computer is not signed in, run `tailscale up`. It prints a link: send it to the person, who opens it and signs in (Google, GitHub, Apple, Microsoft and others).
4. See what is mapped already: `tailscale funnel status` and `tailscale serve status`. Tailscale is one per computer, shared by every user and every Pots on it, and Funnel listens only on ports 443, 8443 and 10000. On a computer that others use, take a port that is free, or a path under a port (`--set-path /<path>`), and never change, replace or `reset` a mapping you did not make.
5. Map the page port (`pagePort` in `~/.pots/settings.json`): `tailscale funnel --bg <pagePort>` for port 443, or `tailscale funnel --bg --https=8443 <pagePort>`, or add `--set-path /<path>`. `--bg` keeps it after restarts. The first time, Tailscale prints a link to a page where the person approves Funnel for their tailnet: send it to them.
6. The address can take up to 10 minutes to work the first time (DNS). Check it: `curl -sS https://<machine>.<tailnet>.ts.net[:<port>][/<path>]/__pots/kit/pots.css` must print the stylesheet. If it does not after 10 minutes, the mapping is wrong; do not use it.
7. Ask the person before you set or change `publicUrl`: every link that any bot of this computer sent before stops working, because it points at the old address. Then write `"publicUrl": "https://<machine>.<tailnet>.ts.net[:<port>][/<path>]"` into `~/.pots/settings.json`, keeping `pagePort`. The next `pots page link` should say `"via": "public-url"`. Note the change and the date in the memory all bots share (`~/.pots/memory/`), so the other bots know why their old links stopped.
8. Tell the person about [key expiry](https://tailscale.com/docs/features/access-control/key-expiry): Tailscale signs a computer out after 180 days by default, and then the links stop working until someone signs in again. They can turn it off for this computer in the Tailscale admin console (Machines, the menu of this machine, Disable key expiry). Key expiry is a security feature: with it off, a lost or stolen computer stays in their tailnet until they remove it. Let them choose.

Also tell them: the address shows the machine's name and the tailnet's name to everyone who gets a link; Funnel is in beta and has bandwidth limits.

## Content-Security-Policy

Pots puts no browser restrictions on your pages, so they can use any outside script, font, image or service. For a page with private content that needs nothing from outside, add this to its `<head>`; then the page cannot load from or send to other hosts, also if text someone wrote slips into it as HTML. Keep scripts in files: it blocks inline `<script>`.

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'">
```

## One browser origin

All pages of this computer, of every bot, are under one address, so the browser treats them as one site. A script on one page can read what another page keeps in the browser. So never keep private data in `localStorage`, `sessionStorage`, IndexedDB or cookies; the kit keeps nothing there.

## Website projects

- A static site (pages, images, scripts, no server of its own) is a page.
- A site with a backend (a database, sign-in, its own API) is not a page: run its server on this computer like any project, and give it its own tunnel (`cloudflared tunnel --url http://localhost:<port>`; after Pots started a Quick Tunnel, `cloudflared` is on this computer, maybe in `~/.pots/bin/`) or a Funnel port or path of its own. Pots does not route to it.
- A site that should stay up needs a fixed address (Funnel or a domain) and belongs in `pages/keep/`.

## Cleanup

- Pots deletes a page, with its links, when nobody opened it, you made no link to it and you did not change it for 30 days. Pages in `pages/keep/` are never deleted that way.
- A password page link expires 1 hour after you made it, unless it was used before.
- Deleting a bot deletes its pages and links.
- `pages/keep/` grows until you tidy it. Look through it now and then and ask the people whether old pages can go; a routine helps, for example `pots routine add tidy-pages --cron "0 10 1 * *" --note "Look through pages/keep/"`.
