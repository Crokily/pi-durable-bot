---
name: pages
description: Web pages you write and send to people as a link. A display page shows what is too big for a chat message (a plan, a report, tables, charts); an answer page collects many answers at once (choices, text, comments on sections, approve or reject) and sends them back to you; the Pots password page takes a secret such as a token; the Pots login page signs this computer in to a model. Also how page links reach the internet (Cloudflare Quick Tunnel, Tailscale Funnel), website projects, and cleanup. Use when a chat message is too small for what you must show or ask, or when a person has to give you a secret.
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
| A step only a person can do on your screen: a sign-in, a CAPTCHA, an approval | The Pots desktop page (`pots page desktop`): the desktop-page skill | They see and control your screen from their phone or computer, and hand it back |
| A login to a model: a subscription or an API key, also TypeSafe's for Jev | The Pots login page (`pots page login`) | They sign in from any device; pi keeps the login, and you never see it |

Never ask for a secret in a chat message, and never write your own page for one. If someone pastes a secret into a chat, tell them that the chat keeps it, and suggest they replace it. In the terminal channel (`pots chat`), ask-secret works as before.

## Three kinds of pages

| Kind | Example | Who writes it |
|---|---|---|
| Display page | A report, a plan, tables, charts, a calculator. To read and explore | You, freely, in the best form for each piece of information. The kit saves time |
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

`pots page list` also lists your password links (`secretLinks`, IDs S1, S2, …), desktop links (`desktopLinks`, D1, D2, …) and login links (`loginLinks`, G1, G2, …), and `pots page unlink` takes those back too.

`pots page link` prints JSON: `{"link": "<link ID>", "url": "https://…/p/<token>/", "via": "public-url" or "quick-tunnel", "note": "…"}`. `note` comes with a Quick Tunnel and gives its facts (see below). Nobody can guess a link, but anyone who has it can open it, and a link can be forwarded.

- Make a link per person with `--for <person address>` when you want to know whose link an answer came through. Then say "someone used the link made for Alice", never "Alice answered": you know the link, not the person. To know for sure who answered, use a platform button: the platform names the account that clicked.
- Turn link previews off when you post a link (the channel skills say how). A platform's preview opens the link from its own servers.
- With a Quick Tunnel, the address changes each time the gateway starts, so links sent before stop working; `pots page link` again gives a new link to the same page.

## The kit

Pots serves a kit for pages, all optional:

- `pots.css`: a calm look for reading, light and dark, with Inter for Latin text (in `fonts/`). One column on a phone; on a computer, the contents at the side and blocks that use the width.
- `pots-ui.js`: charts from tables, tabs, sorting, filtering, and contents that follow the reader. Offline, and it works under the private-page CSP (see Content-Security-Policy).
- `pots.js`: sends a form's answers to Pots.

Link them relative to the page's link, not its folder on disk: from a page's `index.html`, also in `keep/`, use `../../__pots/kit/`, and add one `../` for each subfolder of the page. The source is in [../../kit/](../../kit/pots.css).

## Display pages

**The goal.** A display page exists to get information across better than plain text in a chat can. That is its only job. For each piece of information, ask what lets the reader take it in fastest. When a better form fits the information, use it: a chart for amounts, a timeline for dates, two options side by side, a table to sort and search, a calculator for "what if". When a sentence says it faster, write the sentence. Never put in a chart, a card or a widget for show: a special form that does not help the reader is noise. A page of clear text with one good chart is better than a page full of components.

All that follows serves this goal: plain words make the text fast to read, the right form makes the shape of the information visible, and the layout puts more of it in view at once.

**The text.** Always write in ASD-STE100 Simplified Technical <the reader's language>, and use the reader's ubiquitous language. Put the answer first.

**The form.** A guide, not a rule. Use a row only when the information has that shape:

| Information | A good form | With the kit |
|---|---|---|
| The answer, the conclusion | One sentence under the title, then 2 to 4 key numbers | `<header>`, `pots-stats` |
| How much each of a few things is | A sorted bar chart, with a line for the limit or the target | `<table data-pots-chart="bar" data-marks="10000 Budget">` |
| Parts of a whole | One bar in parts, with percentages | `data-pots-chart="stack"` |
| Change over time | A line chart | `data-pots-chart="line"` |
| Many records to look up | A table; past a dozen rows, sorting and a search box | `data-pots-sort`, `data-pots-filter` |
| Many items × many properties, on a phone | One property at a time, or one card per row | `data-pots-tabs`, `table.pots-stack` |
| A plan by day or week | A calendar: side by side on a computer, one day at a time on a phone | `pots-grid` or `pots-cols` with `data-pots-tabs="phone"` |
| Steps in order | Numbered steps; a timeline for things at the same time | `ol.pots-steps`, `ul.pots-steps` |
| A list to work through | A checklist that counts what is left | Your own script |
| "What if…" | A slider or a field, and the result changes at once | Your own script |
| A structure, a flow, how something works | An inline SVG drawing, with words on the arrows | Your own SVG |
| A choice between options | Side by side, the differences marked, then an answer form | `pots-cols`, an answer form |
| Details that only some readers need | Folded away | `<details>` |

**The layout.** Use the device. On a computer, put text next to its chart, cards in columns and calendars side by side; on a phone, one column. Text keeps a comfortable line length; `pots-wide` lets a block, also a table or a bar chart, use the full width. The page itself never scrolls sideways; a wide table scrolls inside itself.

**The look.** A page is an information page that the reader reads and answers, not a landing page. The kit draws it clean and calm: near-black text on a plain background, hairlines instead of boxes, and one accent colour for what the reader acts on or looks for: links, numbers, the chosen and the recommended choice, focus. You give it the structure it draws:

- **The header.** Start `<main>` with a `<header>`: `<p class="pots-eyebrow" data-icon="…">` with the kind of page (Proposal, Weekly report, Decision), the `<h1>`, one sentence with the answer, `<p class="pots-meta">` with a `<span>` for each fact about the page (date, who it is for, status; a status span takes `pots-good`, `pots-warn` or `pots-bad`), and last, if they help, key numbers (`pots-stats`) or key points (`pots-points`).
- **Sections.** Plain `<h2>` headings, with a number when the order matters (decisions to make, steps of a plan): `<h2><span class="pots-no">2</span>Costs</h2>`.
- **Icons.** `data-icon="name"` puts a small line icon before an element's text. Use it where the reader scans: the eyebrow, the meta facts, card headings, badges, a stat, a note. Headings and `<summary>` stay plain. Notes and questions get their icon from the kit. The names: check, x, info, warn, question, ban, arrow, up, down, clock, calendar, user, users, bot, chat, mail, link, lock, key, shield, eye, search, chart, file, code, terminal, settings, money, place, globe, star, bolt, flag, bell, list.
- **Colour.** Choose an accent for each page that fits its content, with one line in its CSS: `:root { --pots-accent: light-dark(#305a88, #8bb0db); }` (the light and the dark colour; this one is a muted slate blue). The kit's muted teal is only the fallback for a page that sets none. Choose a muted, darker, low-saturation colour; bright, common colours (bright blue, purple, violet) look cheap. `pots-good`, `pots-warn` and `pots-bad` mark a status.

Which part for which content:

| Content | Part |
|---|---|
| Options, places, people to compare; before and after | `pots-card` in `pots-grid` or `pots-cols`: a hairline over it, its first `<h3>` its title. `pots-good`, `pots-warn`, `pots-bad` mark its status; `pots-info` (a fine accent border and tint) marks the one you recommend. |
| Key numbers, with a change | `pots-stats`; in a `pots-stat`: `<small class="pots-delta pots-good" data-icon="up">12% on May</small>`; `data-icon` on the stat |
| What to take away | `ul.pots-points` (dots; `data-icon` on an item), `ol.pots-points` (numbers) |
| What the reader must not miss: a risk, a deadline, what changed | `pots-note`, one or two on a page; a `<b>` at its start is its title |
| How something works, a decision path | `pots-flow`: `pots-node` boxes joined by arrows; a fork in `pots-lanes`, one `pots-lane` per way |
| Steps, a timeline | `ol.pots-steps` (numbers), `ul.pots-steps` (dots); `<time>` first in an item shows a date over it |
| Words the reader must learn | `dl.pots-terms`, each `<div><dt>…</dt><dd>…</dd></div>` a term and its meaning |
| What someone said | `blockquote.pots-quote` with a `<footer>` for who said it |

Boxes work by contrast. Most of the page stays text on the plain background; the kit boxes only notes, questions and the recommended card. In your own CSS, use the kit's parts so yours match: `--pots-line`, `--pots-soft` (a quiet surface), `--pots-accent-soft` (a light accent tint), `--pots-radius`.

### What the kit gives

- Plain HTML already looks right: headings, lists, tables, code, quotes, images, `<details>`.
- Layout: `pots-cols` (side by side on a computer, one under the other on a phone), `pots-grid` (cards in as many columns as fit), `pots-row` (boxes that wrap), `pots-wide`. `<nav class="pots-toc">` after the header: links to the sections, at the side on a computer and a row at the top on a phone.
- The opening: `<header>` first in `<main>`, with `pots-eyebrow`, `<h1>`, one sentence, and `pots-meta` (a row of chips).
- Blocks: `pots-stats` with `pots-stat` (`<div class="pots-stat"><b>€8,400</b><span>total</span></div>`) and `pots-delta`, `pots-points` (key points), `pots-card`, `pots-note`, `pots-steps`, `pots-flow` with `pots-node`, `pots-lanes` and `pots-lane`, `pots-terms`, `pots-kv` (a `<dl>` of names and values), `blockquote.pots-quote`, `pots-badge`, `pots-no` (a section number in a heading).
- Icons: `data-icon="name"` on any element; `<i data-icon="name"></i>` is the icon alone. They are CSS masks from `data:` URLs, so a page's CSP must allow `img-src data:`, as the one under Content-Security-Policy does. In your own CSS, `var(--pots-i-lock)` is the lock as a mask image.
- Colours with a meaning: `pots-good`, `pots-warn`, `pots-bad` on a note, a badge, a stat or a chart row; `pots-info` on a badge. Text: `pots-muted`, `pots-num` (a right-aligned number cell). `pots-hl` highlights anything your script points at.
- In your own CSS, use the kit's colours so dark mode works: `--pots-bg`, `--pots-soft`, `--pots-text`, `--pots-muted`, `--pots-faint`, `--pots-line`, `--pots-accent`, `--pots-accent-soft`, `--pots-accent-line`, `--pots-good`, `--pots-warn`, `--pots-bad` (each also `-soft`), and the chart colours `--pots-c1` (the accent) to `--pots-c7`; and its shapes: `--pots-radius-s`, `--pots-radius`, `--pots-radius-l`.
- With `pots-ui.js`:
  - `<table data-pots-chart="bar|stack|line">` becomes a chart. Bar and stack: the first column names the rows, the second gives the values. Line: each row is a point on the x axis, each number column a line. `data-marks="380 You; 300 Her"` draws reference lines on bars, `data-max` or `data-min` fixes the scale (a line chart starts at zero unless its values sit far from zero; `data-min="0"` keeps zero), a `<caption>` becomes the title, and `data-pots-show="…"` names the button that shows the numbers. The table stays on the page, folded, so the numbers are one tap away.
  - `<div data-pots-tabs>` with `<section data-tab="Name">` children shows one at a time; `data-pots-tabs="phone"` does so only on a phone and shows all of them on a computer. `data-current` on a section opens it first; `box.potsSelect(i)` opens one from your script, and the box sends a `pots-tab` event.
  - Every table goes in a `<div class="pots-scroll">`, so it can take the full width and a wide one scrolls inside it.
  - Numbers in charts and sorting: a cell is read as a number only when all of it is one, written as in the page's `lang` (`€1,234.50` in English, `1.234,50 €` in German, `−3`), with at most a short unit. Give a cell `data-value="1234.5"` when its text is not a plain number, such as "about two weeks" or "high"; that value is used first. Other columns sort as text.
  - `<table data-pots-sort>`: a click on a column header sorts it. `<input type="search" data-pots-filter="#list">` hides the rows of that table, or its `[data-pots-item]` elements, that do not contain the text, and sends a `pots-filter` event.

### Your own components

When a form in the table above has no kit part, write it: a calendar, a checklist, a calculator, a diagram. Do it when it lets the reader see or try something that text cannot show; else write the sentence.

- Write the full content in the HTML first, so the page reads well without your script, for example in a phone's reader mode or when the script fails. The script adds the interaction.
- Put the script in a file of the page, such as `cost.js`, loaded with `defer`. Then the page works under the private-page CSP.
- A library (maps, formulas, diagrams, a chart library) loads under the private-page CSP only from the page itself: download it into the page's folder and load it from there.
- Set text with `textContent`, never `innerHTML`, and keep nothing in `localStorage` (see One browser origin).
- Use the kit's colour variables, and test it with the mouse, a finger and the keyboard.

### An example

A page that compares three cities for a team trip, in `pages/offsite/`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'">
  <title>Team offsite: where and what it costs</title>
  <link rel="stylesheet" href="../../__pots/kit/pots.css">
  <script src="../../__pots/kit/pots-ui.js" defer></script>
  <script src="cost.js" defer></script>
</head>
<body>
<main>
  <header>
    <p class="pots-eyebrow" data-icon="place">Team offsite · Proposal</p>
    <h1>Team offsite: where and what it costs</h1>
    <p>Lisbon is the best choice. It costs €8,400 for 12 people, €1,600 under the budget.</p>
    <p class="pots-meta"><span data-icon="calendar">Prices from 16 November</span><span data-icon="users">For the team leads</span><span class="pots-warn" data-icon="warn">Flight prices change each day</span></p>
    <div class="pots-stats">
      <div class="pots-stat" data-icon="money"><b>€8,400</b><span>total</span><small class="pots-delta pots-good" data-icon="down">€900 on 2025</small></div>
      <div class="pots-stat pots-good" data-icon="check"><b>€1,600</b><span>under the budget</span></div>
      <div class="pots-stat" data-icon="users"><b>12</b><span>people</span></div>
    </div>
  </header>
  <nav class="pots-toc"><a href="#cities">Cities</a> <a href="#days">The three days</a> <a href="#size">Group size</a></nav>

  <h2 id="cities" data-icon="place">Three cities compared</h2>
  <div class="pots-cols pots-wide">
    <table data-pots-chart="bar" data-marks="10000 Budget">
      <caption>Total cost for 12 people</caption>
      <thead><tr><th>City</th><th class="pots-num">Cost</th></tr></thead>
      <tbody>
        <tr><td>Lisbon</td><td class="pots-num">€8,400</td></tr>
        <tr><td>Porto</td><td class="pots-num">€7,900</td></tr>
        <tr class="pots-bad"><td>Berlin</td><td class="pots-num">€11,200</td></tr>
      </tbody>
    </table>
    <ul class="pots-points">
      <li><b>Lisbon:</b> direct flights from all three offices.</li>
      <li><b>Porto</b> costs less. But two of our offices have no direct flights to Porto.</li>
      <li><b>Berlin</b> is over the budget. Hotels in Berlin cost more in March.</li>
    </ul>
  </div>

  <h2 id="days" data-icon="calendar">The three days</h2>
  <div class="pots-grid pots-wide" data-pots-tabs="phone">
    <section class="pots-card" data-tab="Thursday"><h3 data-icon="calendar">Thursday</h3>
      <ul class="pots-steps"><li><time>by 14:00</time>Flights arrive</li><li><time>19:30</time>Dinner together</li></ul></section>
    <section class="pots-card pots-info" data-tab="Friday"><h3 data-icon="star">Friday</h3>
      <ul class="pots-steps"><li><time>9:00–12:30</time>Planning for next year</li><li><time>afternoon</time>Free</li></ul></section>
    <section class="pots-card" data-tab="Saturday"><h3 data-icon="calendar">Saturday</h3>
      <ul class="pots-steps"><li><time>by 11:00</time>Check out</li><li><time>from 13:00</time>Flights leave</li></ul></section>
  </div>
  <p class="pots-note pots-warn"><b>Book by 30 November</b> The hotel holds the 12 rooms until then.</p>

  <h2 id="size" data-icon="users">If more people come</h2>
  <p id="cost-text">Each extra person adds about €700. With 14 people, the total is €9,800. This is still under the budget.</p>
  <div id="cost" hidden>
    <label>People <input type="range" id="people" min="8" max="16" value="12"></label>
    <p class="pots-note" id="cost-result" aria-live="polite"></p>
  </div>
</main>
</body>
</html>
```

`cost.js`, a small calculator. Without it, the sentence above it says the same:

```js
const people = document.getElementById("people");
const result = document.getElementById("cost-result");
function show() {
  const total = 8400 + (people.value - 12) * 700;
  const left = 10000 - total;
  result.textContent = `${people.value} people: €${total.toLocaleString("en")}. ` +
    (left >= 0 ? `€${left.toLocaleString("en")} under the budget.` : `€${(-left).toLocaleString("en")} over the budget.`);
  result.classList.toggle("pots-warn", left < 0);
}
people.addEventListener("input", show);
show();
document.getElementById("cost-text").hidden = true;
document.getElementById("cost").hidden = false;
```

### Look at it before you send it

Take screenshots of the page as a phone, as a computer and in dark mode, and look at them. Check that nothing overflows or overlaps, the page does not scroll sideways, the charts and your components drew, and the text is easy to read. Fix what is wrong, then send the link.

A headless browser needs no screen, so use `bash`. Open the page through Pots on this computer, at `http://127.0.0.1:<pagePort>` (`pagePort` in `~/.pots/settings.json`) plus the path of its link (`/p/<token>/`), so the kit loads. [shot.mjs](shot.mjs), next to this file, takes a shot with Chrome or Chromium (`google-chrome`, `chromium`; install one if neither is there, or name it in `$CHROME`), in a new temporary profile each time:

```sh
url="http://127.0.0.1:<pagePort>/p/<token>/"
node <this skill's folder>/shot.mjs "$url" 390 /tmp/page-phone.png
node <this skill's folder>/shot.mjs "$url" 1440 /tmp/page-computer.png
node <this skill's folder>/shot.mjs "$url" 390 /tmp/page-dark.png dark
```

It sets the page's width as a phone does (`--window-size` can not make a window narrower than about 500 pixels, so it would crop a wider layout), takes the whole page, and prints what it measured: `innerWidth`, `scrollsSideways`, and the script errors. It fails when `innerWidth` is not the width you asked for, for example when the page has no viewport tag. A page taller than 16000 pixels goes in several files that join up, `/tmp/page-phone.png`, `/tmp/page-phone-2.png` and so on, and the output names them all in `files`. Then read every image. If the page is long, look at it in parts.

## Answer pages

The kit's components make an answer page quickly. A complete one:

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
  <header>
    <p class="pots-eyebrow">Needs your answer</p>
    <h1>Deploy plan 4.2</h1>
    <p>Five questions. I start the deploy when I have your answers.</p>
    <p class="pots-meta"><span class="pots-warn">Answer by Friday</span><span>About 2 minutes</span></p>
  </header>
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

How pots.js sends: it takes the page's version that Pots sent with the HTML file, in the response header `Server-Timing: pots-version;desc="<version>"`. When the browser does not give it, it reads the version from `__pots/info` of the link, once, on load; if that fails, it never sends the answers with a version read later, which could be a newer page's, but asks the person to reload the page, with their answers still on screen. On submit it posts `{"submission": "<ID>", "version": "<the version the person saw>", "answers": {…}}` to `__pots/submit`, with one submission ID for every try of the same submit. If the network fails, or Pots answers with a server error, it shows "trying again" and tries again, with longer waits up to 30 seconds, and at once when the phone is back online. Pots wakes you once per submission ID, also when only its reply got lost. A revoked link gets "This link no longer works". Answers are at most 64 KB.

### Other classes and attributes

- Everything in "What the kit gives" works on an answer page too. A choice can have an explanation on a line of its own: `<label><input type="radio" name="target" value="test"> Test <small>Nobody outside the team sees it</small></label>`. `pots-secondary` is a quieter button.
- `<body data-pots-refresh="5">`: every 5 seconds the page asks Pots whether any of its files changed, and reloads when one did; when the person has started to fill a form, it shows "This page has changed" with a Reload button instead. Use it for progress pages. A Quick Tunnel cannot push to the browser (no Server-Sent Events), so pages poll.
- Text that other people wrote (comments, names, messages) must never become HTML: someone's `<script>` would run on the page. Write it into a JSON file next to the page and let the kit show it as text:
  ```html
  <div data-pots-source="comments.json">
    <p>Updated <span data-pots-fill="updated"></span></p>
    <ul data-pots-list="items"><li><b data-pots-fill="who"></b>: <span data-pots-fill="text"></span></li></ul>
  </div>
  ```
  With `comments.json` = `{"updated": "10:02", "items": [{"who": "Alice", "text": "Looks good"}]}`, the first child of a `data-pots-list` repeats for each item. pots.js sets only `textContent`, never `innerHTML`. If you write such text into HTML yourself, escape `&`, `<`, `>` and `"`.
- `window.PotsKit.submit(answers)` sends answers your own script built, with the same version, submission ID and retries; it resolves `{ok: true}` or `{ok: false, status, message}`. `PotsKit.collect(form)` gives a kit form's answers without sending them. The kit's source is [../../kit/pots.js](../../kit/pots.js), [../../kit/pots-ui.js](../../kit/pots-ui.js) and [../../kit/pots.css](../../kit/pots.css).

### Fully custom pages

Write any HTML, CSS and JavaScript, with any libraries. To send answers without pots.js, post JSON to `__pots/submit` under the link's base (`/p/<token>/__pots/submit`): `{"submission": "<a random ID you make once and send again on every retry>", "version": "<the version of the page on screen: the pots-version Server-Timing entry of the page's load, in performance.getEntriesByType(\"navigation\")[0].serverTiming, or else GET __pots/info as soon as the page loads>", "answers": {…}}`, at most 64 KB. Pots answers `200 {"ok": true}`, also for a repeat of a submission ID, which does not wake you again; `400` for a bad body; `404` for a revoked or unknown link. Give each answer its question's text, as the kit does, so that you can judge an answer to an older version.

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
pots page secret --file slack-ada.env --keys SLACK_APP_TOKEN,SLACK_BOT_TOKEN --text "Paste the two Slack tokens from step 5" --for slack:@U123
```

Name the file for yourself, as here for the bot `ada`: other bots on this computer keep their secrets in the same folder.

It prints JSON: `{"link": "<link ID>", "url": "https://…/s/<token>", "expires": "<time>", "via": …, "note": …}`. The page is Pots' own; you choose only the text, the keys and the file. One person submits it once: the values go straight into that file in the secrets folder (`~/.pots/secrets/`), and the link stops working. A link that nobody submits stops working after 1 hour. Opening the page does not use it up, so a platform's link preview cannot either; still turn previews off.

You are woken with:

```
secret page: someone used link <link ID> (made for <person address | anyone>) and wrote <KEY1>, <KEY2> to <file> in the secrets folder
```

You never see the values; they are not in the log, the wake or a trace. Then use the file as after ask-secret, for example as `secrets` of a channel in bot.json. The file has the values exactly as they were typed, one `KEY=value` line each, so never `source` it or `.` it in a shell: a value can hold `$(…)`. To use one value in a command, read just that line, for example `"$(grep '^SLACK_BOT_TOKEN=' ~/.pots/secrets/slack-ada.env | cut -d= -f2-)"`, and never print it. Send the link in a DM to that person when you can. With a Quick Tunnel, tell them every time that Cloudflare can see what they type into the page (see below), and offer Tailscale Funnel.

## The login page

When you need a model or a judge that is not signed in on this computer, or a login has expired, and the person who pays for it is not at a terminal here, send them a login link:

```sh
pots page login --provider openai-codex --text "Sign in with your ChatGPT account, so I can use GPT for the reports" --for slack:@U123
```

`--provider` is optional: without it, they choose. pi's provider IDs are in `pots login --list` (those signed in) and in the error of a wrong `--provider`. It prints JSON: `{"link": "G1", "url": "https://…/g/<token>/", "expires": "<time>", "via": …, "note": …}`.

The page is Pots' own. It runs pi's own login on this computer, as `pots login` does in a terminal: the person chooses a subscription (ChatGPT, Claude, GitHub Copilot, Grok, Kimi and more) or an API key (any of pi's providers, also TypeSafe for Jev), and the page shows what pi asks and shows. A sign-in that needs a browser on this computer works from their phone too: where pi offers a device code or a copy code, the page puts it first; otherwise they copy the address of the page that cannot load at the end and paste it. Ways that need setting up on this computer itself (an AWS credential chain or profile, Google's Application Default Credentials or a service account file) are not offered there; the page tells them to ask you, and you set those up in your shell.

- Nothing happens before they press Start, and only the browser that pressed Start first can use the link. It works for an hour unopened, then 15 minutes after Start, for one login or several, until they press Done.
- A login is for every bot and pi program of this user on this computer, and a new one replaces the provider's old one. The page says so before they sign in.
- Logins belong to whoever pays for them. Send the link to the person who runs you, or to someone they named, in a DM.
- When Pots restarts during a sign-in, that sign-in is lost and the link ends; you are told, and a new link lets them try again.
- A local or OpenAI-compatible server is not on the page. Add it to pi's `~/.pi/agent/models.json` yourself. When it needs a key, take the key with the password page, and give `apiKey` as a command that reads it, as pi allows (`"apiKey": "!grep '^LOCAL_KEY=' ~/.pots/secrets/local-ada.env | cut -d= -f2-"`).

You are woken once for each login:

```
login page: someone used link G1 (made for slack:@U123) and signed in to OpenAI (ChatGPT Plus/Pro) (provider openai-codex, subscription), for every bot and pi on this computer. Usable now: openai-codex/…, …. openai-codex/gpt-… answered when Pots tried it.
```

It says when the login replaced one, and lists the judges for a provider that has them. You never see a key, a code, a sign-in address or the account. The page tried pi's default model of the provider, as `pots login` does, but chose nothing for you: the model you think with is `model` in your bot.json, and which models do which work is the person's to say, so ask them, or follow what your AGENTS.md says. When nobody signed in by the end of the link, you are woken once more with that, and with how many sign-ins failed; the page showed them why.

When you cannot think at all, because your only login has expired, you cannot make the link. The person, or an agent in a terminal on this computer, then runs `pots login --link`: it serves the same page without a bot, prints the link, and prints each login.

## Where links point: a Quick Tunnel or your own address

Pots serves pages on this computer only (127.0.0.1, at `pagePort` in `~/.pots/settings.json`). The internet reaches them in one of two ways:

- `publicUrl` in `~/.pots/settings.json` is set (a Tailscale Funnel address, a domain, a reverse proxy): links use it, and no Quick Tunnel starts. `via` is `public-url`.
- `publicUrl` is not set: Pots starts a Cloudflare [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) at the first `pots page link`, `pots page secret`, `pots page desktop` or `pots page login`, and keeps it until the gateway stops. `via` is `quick-tunnel`. All bots of this computer share it.

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
- A password page link expires 1 hour after you made it, unless it was used before. A desktop page link ends as the desktop-page skill says.
- Deleting a bot deletes its pages and links.
- `pages/keep/` grows until you tidy it. Look through it now and then and ask the people whether old pages can go; a routine helps, for example `pots routine add tidy-pages --cron "0 10 1 * *" --note "Look through pages/keep/"`.
