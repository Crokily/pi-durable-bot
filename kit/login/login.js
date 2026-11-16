// The login page of Pots: a person signs in to a model provider for the bot's computer, from any device. Pots serves
// this page for a login link (/g/<token>/) and runs pi's own login on its computer; this script shows what pi asks and
// shows (a choice, a field, a sign-in link, a device code), sends the answers, and follows pi while it waits, by asking
// Pots for news (state?after=<version>), which answers when something changed. Every request goes relative to the
// page's address, so a path that a proxy puts in front stays.

const facts = JSON.parse(document.getElementById("pots-facts").textContent);
const W = facts.words;
const $ = (id) => document.getElementById(id);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = new URL(".", location.href);

/** Pots' answer to a request under the link's address; status 0 when there was no connection. */
async function api(path, body) {
  try {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let value = {};
    try {
      value = await response.json();
    } catch {
      // not JSON
    }
    return { status: response.status, ...value };
  } catch {
    return { status: 0, ok: false };
  }
}

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === undefined || value === null) continue;
    if (name === "class") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

/** A link to a page of the provider, in a new tab, that tells it nothing of this page. */
const outLink = (url, text, className) => h("a", { href: url, target: "_blank", rel: "noreferrer noopener", class: className, text });
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---- The link ----

/** The last state from Pots. */
let link = null;
/** Pots' clock minus this device's. */
let offset = 0;
let over = false;
const localTime = (ms) => new Date(ms - offset).toLocaleTimeString(document.documentElement.lang || [], { hour: "2-digit", minute: "2-digit" });

function showEnded(state) {
  if (over) return;
  over = true;
  // Pots' own page for the ended link, as a reload shows it.
  location.reload();
}

/** The link's state, or undefined when Pots did not answer. missing: Pots does not know the link (now). */
/** Replace an element's children; empty places (null, false) are left out. */
const show = (element, ...children) => element.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));

async function refresh(after, { missing = () => showEnded("missing") } = {}) {
  const answer = await api(after === undefined ? "state" : `state?after=${after}`);
  if (answer.status === 404) return missing();
  if (!answer.state) return undefined;
  link = answer;
  offset = answer.now - Date.now();
  if (answer.state !== "open" && answer.state !== "started") showEnded(answer.state);
  return answer;
}

// ---- The start screen ----

const startButton = $("start-button");
const startMessage = (text) => ($("start-msg").textContent = text || "");

function showStart() {
  if (!link) return;
  $("start-meta").textContent = `${fill(W.linkUntil, { time: localTime(link.expires) })} · ${fill(W.afterStart, { n: facts.minutes })}`;
  if (link.state === "started" && !link.mine) {
    startButton.disabled = true;
    startMessage(W.elsewhere);
    return;
  }
  startButton.textContent = link.state === "started" ? W.continue : W.start;
  startButton.disabled = false;
}

async function start() {
  startButton.disabled = true;
  startMessage("");
  const answer = await api("start", {});
  if (!answer.ok) {
    if (answer.status === 0) startMessage(fill(W.network, { bot: facts.bot }));
    else if (answer.code === "elsewhere") startMessage(W.elsewhere);
    else if (answer.status === 404 || answer.status === 410) return refresh();
    else startMessage(answer.error || W.network);
    startButton.disabled = answer.code === "elsewhere";
    return;
  }
  $("start").hidden = true;
  $("session").hidden = false;
  follow();
}

// ---- The session ----

/** What the person is doing between pi's logins: choosing, confirming a replacement, or reading an outcome. */
const ui = { screen: "choose", tab: "oauth", filter: "", pending: null, seen: 0, question: null, message: "" };

/** Ask Pots for news again and again while the link is started, and show each state. */
async function follow() {
  let failures = 0;
  let version;
  while (!over) {
    const asked = Date.now();
    // While Pots restarts, its page server may not know the link for a moment.
    const answer = await refresh(version, { missing: () => (failures > 20 ? showEnded("missing") : undefined) });
    if (over) return;
    if (!answer) {
      failures += 1;
      ui.message = fill(W.network, { bot: facts.bot });
      if (link) render();
      await sleep(Math.min(5_000, 500 * failures));
      continue;
    }
    if (failures > 0) ui.message = "";
    failures = 0;
    render();
    if (answer.state === "started" && !answer.mine) return;
    // An answer with no news that came at once, as from a Pots that does not wait: ask again a moment later.
    if (answer.version === version && Date.now() - asked < 500) await sleep(1_000);
    version = answer.version;
  }
}

function render() {
  if (!link || over) return;
  const session = $("session");
  if (link.state === "started" && !link.mine) {
    show(session, h("p", { class: "msg", text: W.elsewhere }));
    return;
  }
  const outcomes = link.outcomes || [];
  if (link.login) {
    renderLogin(session, link.login);
    return;
  }
  ui.question = null;
  if (outcomes.length > ui.seen && ui.screen !== "outcome") ui.screen = "outcome";
  if (ui.screen === "outcome" && outcomes.length > 0) return renderOutcome(session, outcomes[outcomes.length - 1]);
  if (ui.screen === "confirm" && ui.pending) return renderConfirm(session, ui.pending);
  renderChoose(session);
}

function header(title) {
  const left = link.expires - (Date.now() + offset);
  const meta = left < 60_000 ? W.oneMinute : fill(W.linkUntil, { time: localTime(link.expires) });
  return [h("h1", { text: title }), h("p", { class: "meta", text: meta }), ui.message ? h("p", { class: "msg", role: "alert", text: ui.message }) : null];
}

/** The choices of the link: a subscription or an API key, and the provider. */
function choices() {
  const all = link.choices || { oauth: [], api_key: [] };
  if (!facts.provider) return all;
  return { oauth: all.oauth.filter((item) => item.id === facts.provider), api_key: all.api_key.filter((item) => item.id === facts.provider) };
}

function renderChoose(session) {
  const all = choices();
  const ways = ["oauth", "api_key"].filter((way) => all[way].length > 0);
  if (!ways.includes(ui.tab)) ui.tab = ways[0] || "oauth";
  const title = facts.provider ? fill(W.signingIn, { provider: (all.oauth[0] || all.api_key[0] || { name: facts.provider }).name }) : document.title;
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    ways.map((way) =>
      h(
        "button",
        { type: "button", role: "tab", class: ui.tab === way ? "tab on" : "tab", "aria-selected": ui.tab === way ? "true" : "false", onclick: () => ((ui.tab = way), render()) },
        h("strong", { text: way === "oauth" ? W.subscription : W.apiKey }),
        facts.provider ? null : h("span", { text: way === "oauth" ? W.subscriptionNote : W.apiKeyNote }),
      ),
    ),
  );
  const items = all[ui.tab].filter((item) => !ui.filter || `${item.name} ${item.id}`.toLowerCase().includes(ui.filter.toLowerCase()));
  const list = h(
    "div",
    { class: "list" },
    items.length === 0
      ? h("p", { class: "meta", text: W.noMatch })
      : items.map((item) =>
          h(
            "button",
            { type: "button", class: "item", onclick: () => choose(item, ui.tab) },
            h("span", { class: "name", text: item.name }),
            h("span", { class: "id", text: item.id }),
            item.replaces ? h("span", { class: "badge", text: W.there }) : null,
          ),
        ),
  );
  const search =
    !facts.provider && all[ui.tab].length > 8
      ? h("input", {
          type: "search",
          class: "search",
          placeholder: W.search,
          value: ui.filter,
          oninput: (event) => {
            ui.filter = event.target.value;
            const at = event.target.selectionStart;
            render();
            const again = document.querySelector("input.search");
            again.focus();
            again.setSelectionRange(at, at);
          },
        })
      : null;
  show(session, ...header(title), ways.length > 1 ? tabs : null, search, list, footer());
}

function footer() {
  return h("div", { class: "foot" }, h("p", { class: "fine", text: W.doneNote }), h("button", { type: "button", class: "plain", onclick: done, text: W.done }));
}

function choose(item, way) {
  ui.pending = { ...item, way };
  if (item.replaces) {
    ui.screen = "confirm";
    return render();
  }
  begin();
}

function renderConfirm(session, item) {
  show(
    session,
    ...header(fill(W.replaceTitle, { provider: item.name })),
    h("p", { text: fill(W.replaceText, { provider: item.name }) }),
    h("button", { type: "button", class: "big", onclick: begin, text: W.replaceGo }),
    h("button", { type: "button", class: "plain", onclick: () => ((ui.screen = "choose"), render()), text: W.back }),
  );
}

async function begin() {
  const item = ui.pending;
  if (!item) return;
  ui.screen = "choose";
  ui.message = "";
  ui.seen = (link.outcomes || []).length;
  const answer = await api("login", { provider: item.id, way: item.way });
  if (!answer.ok) {
    ui.message = answer.status === 0 ? fill(W.network, { bot: facts.bot }) : answer.error || W.network;
    render();
  }
  // The news of the login comes with the next state.
}

/** pi's sign-in that runs: its events, and its open question. The question's field stays while events come. */
function renderLogin(session, login) {
  let box = $("login-box");
  if (!box || box.dataset.provider !== `${login.way}:${login.provider}`) {
    box = h("div", { id: "login-box", "data-provider": `${login.way}:${login.provider}` });
    show(
      session,
      h("h1", { text: fill(W.signingIn, { provider: login.name }) }),
      h("p", { class: "meta", id: "login-meta" }),
      h("p", { class: "msg", id: "login-msg", role: "alert" }),
      box,
      h("div", { id: "events" }),
      h("div", { id: "question" }),
      h("button", { type: "button", class: "plain", onclick: cancel, text: W.cancel }),
    );
    ui.question = null;
  }
  const left = link.expires - (Date.now() + offset);
  $("login-meta").textContent = left < 60_000 ? W.oneMinute : fill(W.linkUntil, { time: localTime(link.expires) });
  $("login-msg").textContent = ui.message;
  show($("events"), ...login.events.map(renderEvent));
  const question = login.question || null;
  if ((question && question.id) !== (ui.question && ui.question.id)) {
    ui.question = question;
    show($("question"), question ? renderQuestion(question) : "");
    const field = $("question").querySelector("input");
    if (field && !matchMedia("(pointer: coarse)").matches) field.focus();
  }
}

function renderEvent(event) {
  if (event.type === "auth_url") {
    return h("div", { class: "event" }, event.instructions ? h("p", { text: event.instructions }) : null, outLink(event.url, W.openSignIn, "big link"));
  }
  if (event.type === "device_code") {
    const copy = h("button", {
      type: "button",
      class: "plain small",
      text: W.copy,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(event.userCode);
          copy.textContent = W.copied;
        } catch {
          const range = document.createRange();
          range.selectNodeContents(code);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }
      },
    });
    const code = h("span", { class: "code", text: event.userCode });
    return h(
      "div",
      { class: "event device" },
      h("p", { text: fill(W.deviceCode, { host: hostOf(event.verificationUri) }) }),
      h("div", { class: "coderow" }, code, copy),
      outLink(event.verificationUri, fill(W.openSite, { host: hostOf(event.verificationUri) }), "big link"),
      event.expiresAt ? h("p", { class: "fine", text: fill(W.codeUntil, { time: localTime(event.expiresAt) }) }) : null,
    );
  }
  if (event.type === "info") {
    return h("div", { class: "event" }, h("p", { text: event.message }), (event.links || []).map((item) => h("p", {}, outLink(item.url, item.label || hostOf(item.url)))));
  }
  return h("p", { class: "progress" }, h("span", { class: "spin", "aria-hidden": "true" }), event.message);
}

function renderQuestion(question) {
  if (question.type === "select") {
    return h(
      "div",
      { class: "question" },
      h("p", { class: "q", text: question.message }),
      h(
        "div",
        { class: "list" },
        question.options.map((option) =>
          h(
            "button",
            { type: "button", class: option.recommended ? "item best" : "item", onclick: () => answer(question, option.id) },
            h("span", { class: "name", text: option.label }),
            option.description ? h("span", { class: "id", text: option.description }) : null,
            option.recommended ? h("span", { class: "badge", text: W.recommended }) : null,
          ),
        ),
      ),
      question.hidden.length > 0 ? h("p", { class: "fine", text: fill(W.hidden, { ways: question.hidden.join(", ") }) }) : null,
    );
  }
  const secret = question.type === "secret";
  const input = h("input", {
    type: secret ? "password" : "text",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    placeholder: question.placeholder || "",
    "aria-label": question.message,
  });
  const form = h(
    "form",
    {
      class: "question",
      onsubmit: (event) => {
        event.preventDefault();
        if (question.type !== "text" && !input.value.trim()) {
          ui.message = W.empty;
          $("login-msg").textContent = W.empty;
          return;
        }
        answer(question, input.value);
      },
    },
    h("label", { class: "q", text: question.message }),
    input,
    question.type === "manual_code" ? h("p", { class: "fine", text: W.pasteHint }) : null,
    secret && facts.quickTunnel ? h("p", { class: "warn", text: W.secretWarn }) : null,
    h("button", { type: "submit", class: "big", text: W.send }),
  );
  return form;
}

async function answer(question, value) {
  for (const button of $("question").querySelectorAll("button")) button.disabled = true;
  ui.message = "";
  const result = await api("answer", { question: question.id, value });
  if (result.ok) return;
  for (const button of $("question").querySelectorAll("button")) button.disabled = false;
  ui.message = result.status === 0 ? fill(W.network, { bot: facts.bot }) : result.code === "gone" ? W.gone : result.error || W.network;
  $("login-msg").textContent = ui.message;
}

async function cancel() {
  ui.message = "";
  await api("cancel", {});
}

function renderOutcome(session, outcome) {
  const lines = [];
  if (outcome.ok) {
    if (outcome.replaced) lines.push(W.replaced);
    if (outcome.model) lines.push(outcome.modelProblem ? fill(W.notAnswer, { model: outcome.model, reason: outcome.modelProblem }) : fill(W.ready, { model: outcome.model }));
    if (outcome.judge) lines.push(outcome.judgeProblem ? fill(W.notAnswer, { model: outcome.judge, reason: outcome.judgeProblem }) : fill(W.judgeReady, { model: outcome.judge }));
    if (!outcome.model && !outcome.judge) lines.push(W.noModels);
  } else lines.push(outcome.cancelled ? W.cancelled : outcome.error);
  show(
    session,
    h("div", { class: `check ${outcome.ok ? "good" : "gone"}`, "aria-hidden": "true" }),
    ...header(fill(outcome.ok ? W.signedIn : W.failed, { provider: outcome.name })),
    ...lines.map((line) => h("p", { class: "result", text: line })),
    h(
      "button",
      {
        type: "button",
        class: "big",
        onclick: () => {
          ui.seen = (link.outcomes || []).length;
          ui.screen = "choose";
          if (!outcome.ok && !facts.provider) ui.pending = null;
          render();
        },
        text: outcome.ok ? W.another : W.tryAgain,
      },
    ),
    h("button", { type: "button", class: "plain", onclick: done, text: W.done }),
  );
}

async function done() {
  const answer = await api("done", {});
  if (answer.ok || answer.status === 410 || answer.status === 404) return showEnded("done");
  ui.message = answer.status === 0 ? fill(W.network, { bot: facts.bot }) : answer.error || W.network;
  render();
}

// ---- Begin ----

startButton.addEventListener("click", start);
(async () => {
  const answer = await refresh();
  if (!answer) {
    startMessage(fill(W.network, { bot: facts.bot }));
    startButton.disabled = false;
    return;
  }
  if (answer.state === "started" && answer.mine) {
    $("start").hidden = true;
    $("session").hidden = false;
    follow();
    return;
  }
  showStart();
})();
