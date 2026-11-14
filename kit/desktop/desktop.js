// The desktop page of Pots: a person sees and controls the bot's screen, does one step, and hands it back. Pots serves
// this page for a desktop link (/d/<token>/) and carries its WebSocket (ws) to the VNC server of the bot's screen,
// signed in already; noVNC (novnc.js) draws the picture and sends the mouse and keys. This file adds what a person on a
// phone needs: the picture fills the screen and takes the phone's shape when the desktop can change size, pinch zooms
// the picture (not the page under it), a typing field sends each character as it is typed, and a few floating
// controls. On a computer, the keyboard types straight in. Every request goes relative to the page's address, so a
// path that a proxy puts in front stays.

const facts = JSON.parse(document.getElementById("pots-facts").textContent);
const W = facts.words;
const $ = (id) => document.getElementById(id);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A phone or a tablet: touch first, no keyboard to count on. */
const touch = matchMedia("(pointer: coarse)").matches;
const localApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "") || /Mac OS X/.test(navigator.userAgent);
/** On a Mac, ⌘ is what Ctrl is on the desktop of a Linux or Windows computer. */
const cmdIsCtrl = localApple && facts.remote !== "darwin";

/** The desktop is at least this wide when it takes a phone's shape: browsers such as Chrome are no narrower. */
const MIN_WIDTH = 500;
const MIN_HEIGHT = 300;
/** On a computer, the desktop takes the window's size up to this. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;
const MAX_ZOOM = 5;
/** In trackpad mode, the pointer moves this much faster than the finger. */
const PAD_SPEED = 1.5;

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

// ---- The link ----

/** The link's state from Pots: state, mine, now, expires, started, resizable, size. */
let link = null;
/** Pots' clock minus this device's. */
let offset = 0;
let over = false;

const serverNow = () => Date.now() + offset;
const localTime = (ms) => new Date(ms - offset).toLocaleTimeString(document.documentElement.lang || [], { hour: "2-digit", minute: "2-digit" });

async function refresh() {
  const answer = await api("state");
  // While Pots restarts, its page server may not know the link for a moment; a session waits for it to come back.
  if (answer.status === 404) return $("session") ? answer : showEnded("missing");
  if (!answer.state) return answer;
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
    if (answer.status === 0) startMessage(W.network);
    else if (answer.code === "elsewhere") startMessage(W.elsewhere);
    else if (answer.code === "busy") startMessage(W.busy);
    else if (answer.code === "unreachable") startMessage(W.unreachable);
    else if (answer.status === 404 || answer.status === 410) return refresh();
    else startMessage(answer.error || W.network);
    startButton.disabled = answer.code === "elsewhere";
    return;
  }
  offset = answer.now - Date.now();
  link = { ...link, state: "started", mine: true, expires: answer.expires, started: answer.started, resizable: answer.resizable, size: answer.size };
  await openSession();
}

// ---- The session ----

let novnc = null;
let rfb = null;
let connected = false;
let attempts = 0;
let reconnectTimer;
let closeCode = 0;
let everConnected = false;
/** match: the desktop takes this screen's shape; whole: its own size, fitted; actual: its own size, 1:1. */
const view = { mode: "match", zoom: 1, x: 0, y: 0 };
let resizeRefused = false;
let resizeTimer;
let trackpad = false;
let pointer = null;
let lastTap = null;
let keyboardOpen = false;
let warnedMinute = false;

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === undefined || value === null) continue;
    if (name === "class") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child !== null && child !== undefined) element.append(child);
  return element;
}

const SVG = "http://www.w3.org/2000/svg";
function icon(paths, extra = []) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  for (const [tag, attributes] of extra) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}
const keyboardIcon = () => icon(["M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M18 10h.01M8 14.2h8"], [["rect", { x: "2.5", y: "6", width: "19", height: "12", rx: "2.5" }]]);
const moreIcon = () => icon([], [["circle", { cx: "5.5", cy: "12", r: "1.2" }], ["circle", { cx: "12", cy: "12", r: "1.2" }], ["circle", { cx: "18.5", cy: "12", r: "1.2" }]]);
const checkIcon = () => icon(["M5 12.5l4.5 4.5L19 7.5"]);
const linesIcon = () => icon(["M5 7h14M5 12h14M5 17h9"]);
const closeIcon = () => icon(["M6.5 6.5l11 11M17.5 6.5l-11 11"]);
const fitIcon = () => icon(["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"]);

function buildSession() {
  const session = h("div", { id: "session", class: touch ? "" : "desktop" });
  // One group of controls that floats on the picture: the task button (the connection's dot and the time left; a tap
  // shows the bot's words), keyboard, more and Done.
  const dock = h(
    "div",
    { id: "dock", class: "glass" },
    h(
      "button",
      { type: "button", class: "chip", id: "chip", "aria-label": W.task, title: W.task, "aria-expanded": "false", "aria-controls": "hint", onclick: () => toggleHint() },
      h("i", { class: "dot", id: "dot" }),
      h("span", { class: "time", id: "time" }),
      linesIcon(),
    ),
    h("button", { type: "button", class: "zoomed", id: "zoom", hidden: true, onclick: () => setMode(view.mode === "actual" ? "whole" : view.mode, true) }),
    touch ? h("button", { type: "button", class: "ib", id: "keyboard-button", "aria-label": W.keyboard, title: W.keyboard, onclick: () => openKeyboard() }, keyboardIcon()) : null,
    h("button", { type: "button", class: "ib", id: "more-button", "aria-label": W.more, title: W.more, onclick: () => (touch ? openSheet("more") : toggleMenu()) }, moreIcon()),
    h("button", { type: "button", class: "done", title: W.done, onclick: () => openSheet("hand-back") }, checkIcon(), h("span", { text: W.done })),
  );
  dragDock(dock);

  // The bot's words in full, as the start screen showed them, and how to use the page.
  const words = h("div", { class: "hint-text words", id: "hint-text" });
  for (const node of $("ask").childNodes) words.append(node.cloneNode(true));
  const inputHint = facts.input === "password" ? W.hintPassword : facts.input === "code" ? W.hintCode : facts.input === "text" ? W.hintText : null;
  const tips = touch ? [W.gestures, inputHint] : [cmdIsCtrl ? W.keysHintMac : W.keysHint];
  const hint = h(
    "div",
    { id: "hint", class: "glass away", role: "dialog", "aria-label": W.task, hidden: true },
    h("div", { class: "hint-top" }, h("span", { text: W.asks }), h("button", { type: "button", class: "x", "aria-label": W.fold, title: W.fold, onclick: () => closeHint() }, closeIcon())),
    words,
    h("div", { class: "hint-tips" }, ...tips.filter(Boolean).map((tip) => h("p", { text: tip }))),
    h("div", { class: "hint-meta", id: "hint-meta" }),
  );
  // Read in its own time: a touch, a scroll or the mouse on it keeps it open.
  for (const type of ["pointerdown", "wheel"]) hint.addEventListener(type, holdHint, { passive: true });
  words.addEventListener("scroll", () => (holdHint(), markOverflow()), { passive: true });

  const typed = h("input", { id: "typed", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "send", "aria-label": fill(W.typeInto, {}) });
  const strip = h(
    "div",
    { id: "strip", hidden: true },
    h("button", { type: "button", class: "k", id: "lock", title: W.hideTyped, "aria-label": W.hideTyped, text: "🔒", onpointerdown: keepFocus, onclick: toggleLock }),
    h("label", {}, h("span", { text: W.typeInto }), typed),
    h("button", { type: "button", class: "k", title: W.enter, "aria-label": W.enter, text: "⏎", onpointerdown: keepFocus, onclick: () => (sendKey("Return"), clearTyped()) }),
    h("button", { type: "button", class: "k", title: W.closeKeyboard, "aria-label": W.closeKeyboard, text: "⌄", onpointerdown: keepFocus, onclick: closeKeyboard }),
  );

  const tile = (glyph, label, action) =>
    h(
      "button",
      {
        type: "button",
        class: "tile",
        onclick: () => {
          closeSheets();
          action();
        },
      },
      h("i", { text: glyph }),
      label,
    );
  const arrows = h(
    "div",
    { class: "tiles", id: "arrows", hidden: true },
    tile("←", "", () => sendKey("Left")),
    tile("→", "", () => sendKey("Right")),
    tile("↑", "", () => sendKey("Up")),
    tile("↓", "", () => sendKey("Down")),
  );
  const picture = pictureControl("sheet-picture");
  const more = h(
    "div",
    { id: "more", class: "sheet", hidden: true },
    h("div", { class: "grab" }),
    h(
      "div",
      { class: "tiles" },
      tile("⎋", W.esc, () => sendKey("Escape")),
      tile("⇥", W.tab, () => sendKey("Tab")),
      tile("⏎", W.enter, () => sendKey("Return")),
      tile("⌫", W.backspace, () => sendKey("BackSpace")),
      h("button", { type: "button", class: "tile", onclick: () => ($("arrows").hidden = !$("arrows").hidden) }, h("i", { text: "←→" }), "↑↓"),
      tile("⌃A", W.selectAll, () => combo("Control_L", "a")),
      tile("📋", W.paste, () => typeClipboard()),
      tile("⟳", W.reconnect, () => reconnect(true)),
    ),
    arrows,
    h(
      "div",
      { class: "list" },
      h(
        "button",
        {
          type: "button",
          class: "li",
          onclick: () => {
            trackpad = !trackpad;
            $("pad-toggle").classList.toggle("on", trackpad);
            if (trackpad && rfb) showPointer(rfb);
          },
        },
        h("span", {}, W.trackpad, h("small", { text: W.trackpadNote })),
        h("span", { class: "tog", id: "pad-toggle" }),
      ),
      h("div", { class: "li" }, h("span", { text: W.picture }), picture),
      h("button", { type: "button", class: "li red", onclick: () => openSheet("hand-back") }, h("span", { text: W.cannotRow }), h("span", { text: "›" })),
    ),
  );
  const note = h("textarea", { id: "note", maxlength: "1000", rows: "2", placeholder: W.notePlaceholder });
  const handBack = h(
    "div",
    { id: "hand-back", class: "sheet", hidden: true, role: "dialog", "aria-labelledby": "hand-back-title" },
    h("div", { class: "grab" }),
    h("h2", { id: "hand-back-title", text: W.handBackTitle }),
    h("p", { text: W.handBackNote }),
    note,
    h("p", { class: "msg", id: "hand-back-msg", role: "alert" }),
    h("button", { type: "button", class: "pri", id: "hand-done", text: W.handBackDone, onclick: () => handBackNow("done") }),
    h("button", { type: "button", class: "sec", id: "hand-cannot", text: W.handBackCannot, onclick: () => handBackNow("cannot") }),
    h("button", { type: "button", class: "sec", text: W.keepGoing, onclick: closeSheets }),
  );
  const keyButton = (label, ...keys) => h("button", { type: "button", text: label, onclick: () => (combo(...keys), closeMenu()) });
  const menu = h(
    "div",
    { id: "menu", hidden: true },
    h("button", { type: "button", class: "li", onclick: () => (fullscreen(), closeMenu()) }, h("span", { text: W.fullscreen }), h("kbd", { text: "F" })),
    h("button", { type: "button", class: "li", onclick: () => (typeClipboard(), closeMenu()) }, h("span", { text: W.typeClipboard }), h("kbd", { text: cmdIsCtrl ? "⌘⇧V" : "" })),
    h("div", { class: "li" }, h("span", { text: W.keys })),
    h(
      "div",
      { class: "keys" },
      keyButton("Ctrl+Alt+Del", "Control_L", "Alt_L", "Delete"),
      keyButton("Alt+Tab", "Alt_L", "Tab"),
      keyButton("Alt+F4", "Alt_L", "F4"),
      keyButton("Ctrl+Esc", "Control_L", "Escape"),
      keyButton("Super", "Super_L"),
    ),
    h("div", { class: "li" }, h("span", { text: W.picture }), pictureControl("menu-picture")),
    h("button", { type: "button", class: "li", onclick: () => (reconnect(true), closeMenu()) }, h("span", { text: W.reconnect })),
    h("button", { type: "button", class: "li red", onclick: () => (closeMenu(), openSheet("hand-back")) }, h("span", { text: W.cannotRow })),
  );
  session.append(
    h("div", { id: "screen" }),
    h("div", { id: "dim", hidden: true, onclick: () => !connected && reconnect(true) }, h("p", { id: "dim-text" })),
    h("div", { id: "safe", "aria-hidden": "true" }),
    dock,
    hint,
    h("div", { id: "toast", class: "glass", hidden: true }),
    strip,
    h("div", { id: "scrim", hidden: true, onclick: closeSheets }),
    more,
    handBack,
    menu,
  );
  document.body.append(session);

  typed.addEventListener("compositionstart", () => (composing = true));
  typed.addEventListener("compositionend", () => {
    composing = false;
    syncTyped();
  });
  typed.addEventListener("input", (event) => {
    if (!event.isComposing && !composing) syncTyped();
  });
  typed.addEventListener("keydown", onTypedKey);
  applyInputKind();

  if (window.visualViewport) {
    visualViewport.addEventListener("resize", placeForKeyboard);
    visualViewport.addEventListener("scroll", placeForKeyboard);
  }
  window.addEventListener("resize", () => (placeForKeyboard(), placeDock()));
  // The dock keeps its edge when it changes size, as when the zoom shows or the time loses a digit.
  new ResizeObserver(() => placeDock()).observe(dock);
  // A press anywhere else folds the task panel and the menu; on the picture, the press goes on to the desktop too.
  document.addEventListener("pointerdown", onPressAnywhere, true);
  if (!touch) {
    // Captured before noVNC, which keeps the keyboard's events to itself.
    window.addEventListener("keydown", onDesktopKey, true);
  }
  dockPlace = loadDockPlace();
  tick();
  placeDock();
  setInterval(tick, 1000);
  setInterval(() => {
    if (!over) refresh();
  }, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || over) return;
    refresh();
    if (!connected) reconnect(false);
  });
}

function pictureControl(id) {
  const button = (mode, label) => h("button", { type: "button", "data-mode": mode, text: label, onclick: () => setMode(mode, true) });
  return h("span", { class: "seg", id }, button("match", touch ? W.fitPhone : W.fitWindow), button("whole", W.whole), button("actual", W.actual));
}

function updatePictureControls() {
  for (const seg of document.querySelectorAll(".seg")) {
    for (const button of seg.querySelectorAll("button")) {
      button.classList.toggle("on", button.dataset.mode === view.mode);
      if (button.dataset.mode === "match") button.disabled = !canResize();
    }
  }
}

const canResize = () => !!rfb && rfb._supportsSetDesktopSize && !resizeRefused;

async function openSession() {
  try {
    novnc ??= await import("./novnc.js");
  } catch {
    startMessage(W.network);
    startButton.disabled = false;
    return;
  }
  if (!$("session")) buildSession();
  $("start").hidden = true;
  $("session").hidden = false;
  document.documentElement.style.overflow = "hidden";
  view.mode = link.resizable ? "match" : "whole";
  connect();
}

function connect() {
  if (over) return;
  clearTimeout(reconnectTimer);
  dropConnection();
  dim(everConnected ? W.reconnecting : W.connecting);
  setDot("wait");
  const url = new URL("ws", base);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let r;
  try {
    r = new novnc.RFB($("screen"), url.href, { shared: true });
  } catch {
    return dropped();
  }
  rfb = r;
  closeCode = 0;
  r.scaleViewport = false;
  r.clipViewport = false;
  r.resizeSession = false;
  r.showDotCursor = touch;
  r.qualityLevel = 6;
  r.compressionLevel = 2;
  r.focusOnClick = !touch;
  r.background = "#000";
  r._screen.style.overflow = "hidden";
  r._sock._websocket?.addEventListener("close", (event) => (closeCode = event.code));
  hookView(r);
  hookGestures(r);
  hookKeyboard(r);
  r.addEventListener("connect", () => {
    if (rfb !== r) return;
    connected = true;
    attempts = 0;
    dim(null);
    setDot("on");
    if (!everConnected) {
      everConnected = true;
      firstConnect();
    }
    if (!touch) r.focus();
    applyView();
    // A desktop that keeps its own size starts zoomed in on the area the bot named.
    if (view.mode !== "match" && view.zoom === 1) focusArea();
  });
  r.addEventListener("disconnect", () => {
    if (rfb !== r) return;
    rfb = null;
    connected = false;
    dropped();
  });
  r.addEventListener("clipboard", (event) => {
    // On a computer, what is copied on the desktop is copied here too, when this page has the focus.
    if (!touch && document.hasFocus()) navigator.clipboard?.writeText(event.detail.text).catch(() => {});
  });
}

function dropConnection() {
  const old = rfb;
  rfb = null;
  connected = false;
  if (old) {
    try {
      old.disconnect();
    } catch {
      // already gone
    }
  }
}

function reconnect(now) {
  if (over) return;
  attempts = now ? 0 : attempts;
  connect();
}

async function dropped() {
  if (over) return;
  // noVNC tells of the disconnect from the socket's own close handler, before this page's handler has the close code.
  await sleep(0);
  if (over) return;
  setDot("off");
  dim(W.reconnecting);
  if (closeCode === 4001) {
    // The link was opened again in another tab or window of this browser; that one has it now.
    dim(W.elsewhere);
    return;
  }
  const state = await refresh();
  if (over) return;
  if (state.state && state.state !== "started" && state.status !== 404) return;
  if (state.state === "started" && !state.mine) {
    // This browser no longer has the link's cookie: back to the start screen, which says so.
    $("session").hidden = true;
    $("start").hidden = false;
    document.documentElement.style.overflow = "";
    showStart();
    return;
  }
  clearTimeout(reconnectTimer);
  const wait = Math.min(10_000, 1_000 * 2 ** attempts);
  attempts++;
  reconnectTimer = setTimeout(() => {
    if (!document.hidden) connect();
  }, wait);
}

function firstConnect() {
  // The bot's words and the tips show for a while, then fold into the task button.
  openHint(true);
}

// ---- The picture: size, zoom and pan ----

function screenRect() {
  return $("screen").getBoundingClientRect();
}

function scaleOf(r) {
  return r._display.scale || 1;
}

/** The size the desktop should have now, or null to leave it. */
function wantedSize() {
  if (view.mode === "match") {
    if (!canResize()) return null;
    const box = screenRect();
    if (box.width < 50 || box.height < 50) return null;
    if (touch) {
      const width = Math.max(MIN_WIDTH, Math.round(box.width));
      const scale = box.width / width;
      return { width, height: Math.max(MIN_HEIGHT, Math.round(box.height / scale)) };
    }
    return { width: clamp(Math.round(box.width), MIN_WIDTH, MAX_WIDTH), height: clamp(Math.round(box.height), MIN_HEIGHT, MAX_HEIGHT) };
  }
  // The desktop's own size, as it was at Start.
  return rfb && rfb._supportsSetDesktopSize && link?.size ? { width: link.size.width, height: link.size.height } : null;
}

function requestSize() {
  const r = rfb;
  if (!r || r._rfbConnectionState !== "connected" || !r._supportsSetDesktopSize || r._pendingRemoteResize) return;
  // With the keyboard open, the phone's screen looks shorter; the desktop keeps its shape.
  if (keyboardOpen) return;
  const want = wantedSize();
  if (!want || (want.width === r._fbWidth && want.height === r._fbHeight)) return;
  const since = Date.now() - r._lastResize;
  if (since < 250) {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(requestSize, 250 - since);
    return;
  }
  r._pendingRemoteResize = true;
  r._lastResize = Date.now();
  novnc.RFB.messages.setDesktopSize(r._sock, want.width, want.height, r._screenID, r._screenFlags);
}

/** Lay the picture out: fitted to the screen, times the zoom, scrolled to the pan. */
function applyView() {
  const r = rfb;
  if (!r) return;
  const width = r._fbWidth;
  const height = r._fbHeight;
  if (!width || !height) return;
  const box = screenRect();
  const fit = Math.min(box.width / width, box.height / height);
  if (view.mode === "actual") view.zoom = Math.max(1, 1 / fit);
  const scale = fit * view.zoom;
  r._display.scale = scale;
  view.x = clamp(view.x, 0, Math.max(0, width * scale - box.width));
  view.y = clamp(view.y, 0, Math.max(0, height * scale - box.height));
  r._screen.scrollLeft = view.x;
  r._screen.scrollTop = view.y;
  const zoom = $("zoom");
  if (zoom) {
    const n = Math.round(view.zoom * 10) / 10;
    zoom.hidden = !touch || view.zoom < 1.05 || view.mode === "actual";
    if (zoom.dataset.n !== String(n)) {
      zoom.dataset.n = String(n);
      zoom.replaceChildren(`${n}×`, fitIcon());
      zoom.title = fill(W.zoom, { n });
      zoom.setAttribute("aria-label", zoom.title);
    }
  }
  if (trackpad && pointer) showPointer(r);
  updatePictureControls();
}

function setMode(mode, chosen) {
  if (mode === "match" && !canResize()) mode = "whole";
  view.mode = mode;
  if (mode !== "actual") view.zoom = 1;
  view.x = view.y = 0;
  applyView();
  requestSize();
  if (chosen) closeSheets(), closeMenu();
}

/** Zoom to the area the bot named, when the desktop keeps its own size. */
function focusArea() {
  const r = rfb;
  if (!r || !facts.area || view.mode === "match") return;
  const [x, y, w, h] = facts.area;
  const box = screenRect();
  const fit = Math.min(box.width / r._fbWidth, box.height / r._fbHeight);
  view.zoom = clamp(Math.min(box.width / (w * fit), box.height / (h * fit)) * 0.9, 1, MAX_ZOOM);
  const scale = fit * view.zoom;
  view.x = (x + w / 2) * scale - box.width / 2;
  view.y = (y + h / 2) * scale - box.height / 2;
  applyView();
}

function hookView(r) {
  // noVNC calls these when the window or the desktop changes size; the page decides instead.
  r._updateScale = () => applyView();
  r._requestRemoteResize = () => requestSize();
  const handle = r._handleExtendedDesktopSize;
  let first = true;
  r._handleExtendedDesktopSize = function () {
    const reason = this._FBU.x;
    const status = this._FBU.y;
    const done = handle.call(this);
    if (done && reason === 1 && status !== 0 && view.mode === "match") {
      // The desktop cannot take this shape; show it whole, zoomed in on the bot's area.
      resizeRefused = true;
      setMode("whole", false);
      focusArea();
      toast(W.noResize, 4000);
    }
    if (done && first) {
      first = false;
      updatePictureControls();
    }
    return done;
  };
}

// ---- Touch: pinch zooms the picture, two fingers pan it when zoomed, and the trackpad mode ----

let pinch = null;
let pan = null;
let pad = null;

function hookGestures(r) {
  const canvas = r._canvas;
  const original = r._eventHandlers.handleGesture;
  for (const type of ["gesturestart", "gesturemove", "gestureend"]) {
    canvas.removeEventListener(type, original);
    canvas.addEventListener(type, (event) => onGesture(r, event));
  }
}

function onGesture(r, event) {
  const detail = event.detail;
  if (event.type === "gesturestart" && (detail.type === "onetap" || detail.type === "drag" || detail.type === "longpress")) {
    lastTap = { x: detail.clientX, y: detail.clientY };
    // A tap on the desktop may go to another field: the typing field starts empty for it.
    if (keyboardOpen) clearTyped();
  }
  if (detail.type === "pinch") return pinchGesture(r, event);
  if (detail.type === "twodrag" && view.zoom > 1.01) return panGesture(event);
  if (trackpad && ["onetap", "twotap", "drag", "longpress"].includes(detail.type)) return padGesture(r, event);
  r._handleGesture(event);
}

function pinchGesture(r, event) {
  const detail = event.detail;
  const distance = Math.hypot(detail.magnitudeX, detail.magnitudeY);
  if (event.type === "gesturestart") {
    const rect = r._canvas.getBoundingClientRect();
    const scale = scaleOf(r);
    if (view.mode === "actual") view.mode = "whole";
    pinch = { distance: Math.max(distance, 1), zoom: view.zoom, rx: (detail.clientX - rect.left) / scale, ry: (detail.clientY - rect.top) / scale, cx: detail.clientX, cy: detail.clientY };
    return;
  }
  if (!pinch) return;
  if (event.type === "gesturemove") {
    const box = screenRect();
    const fit = Math.min(box.width / r._fbWidth, box.height / r._fbHeight);
    view.zoom = clamp((pinch.zoom * distance) / pinch.distance, 1, MAX_ZOOM);
    const scale = fit * view.zoom;
    view.x = pinch.rx * scale - (pinch.cx - box.left);
    view.y = pinch.ry * scale - (pinch.cy - box.top);
    applyView();
  } else pinch = null;
}

function panGesture(event) {
  const detail = event.detail;
  if (event.type === "gesturestart") pan = { x: view.x, y: view.y };
  else if (event.type === "gesturemove" && pan) {
    view.x = pan.x - detail.magnitudeX;
    view.y = pan.y - detail.magnitudeY;
    applyView();
  } else pan = null;
}

function sendPointer(r, mask) {
  novnc.RFB.messages.pointerEvent(r._sock, Math.round(pointer.x), Math.round(pointer.y), mask);
  showPointer(r);
}

function showPointer(r) {
  pointer ??= { x: r._fbWidth / 2, y: r._fbHeight / 2 };
  const rect = r._canvas.getBoundingClientRect();
  const scale = scaleOf(r);
  r._cursor.move(rect.left + pointer.x * scale, rect.top + pointer.y * scale);
}

/** Trackpad mode: a finger moves the pointer; a tap clicks where it is, two fingers right-click, a long press drags. */
function padGesture(r, event) {
  const detail = event.detail;
  pointer ??= { x: r._fbWidth / 2, y: r._fbHeight / 2 };
  const click = (mask) => {
    sendPointer(r, mask);
    sendPointer(r, 0);
  };
  if (detail.type === "onetap" || detail.type === "twotap") {
    if (event.type === "gesturestart") click(detail.type === "onetap" ? 1 : 4);
    return;
  }
  if (event.type === "gesturestart") {
    pad = { x: pointer.x, y: pointer.y, cx: detail.clientX, cy: detail.clientY, buttons: detail.type === "longpress" ? 1 : 0 };
    if (pad.buttons) sendPointer(r, pad.buttons);
  } else if (event.type === "gesturemove" && pad) {
    const scale = scaleOf(r);
    pointer.x = clamp(pad.x + ((detail.clientX - pad.cx) * PAD_SPEED) / scale, 0, r._fbWidth - 1);
    pointer.y = clamp(pad.y + ((detail.clientY - pad.cy) * PAD_SPEED) / scale, 0, r._fbHeight - 1);
    sendPointer(r, pad.buttons);
  } else if (event.type === "gestureend" && pad) {
    if (pad.buttons) sendPointer(r, 0);
    pad = null;
  }
}

// ---- Keys and typing ----

function keysym(name) {
  if (name.length === 1) return novnc.keysyms.lookup(name.codePointAt(0));
  return novnc.KeyTable[`XK_${name}`];
}

function sendKey(name) {
  rfb?.sendKey(keysym(name), null);
}

/** Press keys together, as Ctrl+Alt+Del: down in order, up in reverse. */
function combo(...names) {
  if (!rfb) return;
  for (const name of names) rfb.sendKey(keysym(name), null, true);
  for (const name of [...names].reverse()) rfb.sendKey(keysym(name), null, false);
}

let typing = Promise.resolve();

/**
 * Type text as key presses, in order. A capital letter is sent with Shift held, which some VNC servers need (x0vncserver
 * types it in lower case without). A character outside ASCII waits a moment, while the server maps it to a key.
 */
function typeText(text) {
  const chars = Array.from(text);
  typing = typing.then(async () => {
    for (const char of chars) {
      const r = rfb;
      if (!r) return;
      if (char === "\n" || char === "\r") r.sendKey(novnc.KeyTable.XK_Return, "Enter");
      else if (char === "\t") r.sendKey(novnc.KeyTable.XK_Tab, "Tab");
      else {
        const capital = char !== char.toLowerCase() && char === char.toUpperCase();
        if (capital) r.sendKey(novnc.KeyTable.XK_Shift_L, "ShiftLeft", true);
        r.sendKey(novnc.keysyms.lookup(char.codePointAt(0)), null);
        if (capital) r.sendKey(novnc.KeyTable.XK_Shift_L, "ShiftLeft", false);
        if (char.codePointAt(0) > 0x7e) await sleep(25);
      }
    }
  });
  return typing;
}

async function typeClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return toast(W.clipboardDenied, 3500);
  }
  if (!text) return toast(W.clipboardEmpty, 3000);
  await typeText(text);
  toast(fill(W.typed, { n: Array.from(text).length }), 2500);
}

function hookKeyboard(r) {
  if (!cmdIsCtrl) return;
  // ⌘ on a Mac becomes Ctrl on the desktop, so ⌘C copies and ⌘V pastes there.
  const forward = r._keyboard.onkeyevent;
  r._keyboard.onkeyevent = (sym, code, down, numlock, capslock) => {
    if (sym === novnc.KeyTable.XK_Super_L || sym === novnc.KeyTable.XK_Super_R) {
      sym = sym === novnc.KeyTable.XK_Super_L ? novnc.KeyTable.XK_Control_L : novnc.KeyTable.XK_Control_R;
      code = sym === novnc.KeyTable.XK_Control_L ? "ControlLeft" : "ControlRight";
    }
    return forward(sym, code, down, numlock, capslock);
  };
}

function onDesktopKey(event) {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  const hint = $("hint");
  if (event.key === "Escape" && !hint.hidden && !hint.classList.contains("away")) {
    // Esc folds the task panel first; the next one goes to the desktop.
    event.preventDefault();
    event.stopPropagation();
    return closeHint();
  }
  if (!$("menu").hidden) {
    // With the menu open, these keys are the menu's, not the desktop's.
    if (event.key === "Escape" || event.key === "f" || event.key === "F") {
      event.preventDefault();
      event.stopPropagation();
      if (event.key !== "Escape") fullscreen();
      return closeMenu();
    }
  }
  if (cmdIsCtrl && event.metaKey && event.shiftKey && event.code === "KeyV") {
    event.preventDefault();
    event.stopPropagation();
    typeClipboard();
  }
}

// The typing field: what is typed there goes to the desktop as it is typed. An input method's characters go when they
// are chosen. An edit in the middle moves the desktop's cursor there and back.
let composing = false;
let sent = "";
let locked = false;

function applyInputKind() {
  const typed = $("typed");
  if (facts.input === "password") {
    typed.setAttribute("autocomplete", "current-password");
    locked = true;
  } else if (facts.input === "code") {
    typed.setAttribute("autocomplete", "one-time-code");
    typed.setAttribute("inputmode", "numeric");
  }
  setLock(locked);
}

function setLock(on) {
  locked = on;
  $("typed").type = on ? "password" : "text";
  $("lock").classList.toggle("on", on);
}

function toggleLock() {
  setLock(!locked);
  $("typed").focus();
}

function keepFocus(event) {
  // A button next to the field must not take the focus: that would close the phone's keyboard.
  event.preventDefault();
}

function clearTyped() {
  $("typed").value = "";
  sent = "";
}

function syncTyped() {
  const before = Array.from(sent);
  const now = Array.from($("typed").value);
  let start = 0;
  while (start < before.length && start < now.length && before[start] === now[start]) start++;
  let end = 0;
  while (end < before.length - start && end < now.length - start && before[before.length - 1 - end] === now[now.length - 1 - end]) end++;
  const removed = before.length - start - end;
  const added = now.slice(start, now.length - end).join("");
  sent = now.join("");
  if (removed === 0 && !added) return;
  // In order with the characters still on their way: moves and deletions wait for them too.
  typing = typing.then(() => {
    for (let index = 0; index < end; index++) sendKey("Left");
    for (let index = 0; index < removed; index++) sendKey("BackSpace");
  });
  typeText(added);
  if (end > 0) {
    typing = typing.then(() => {
      for (let index = 0; index < end; index++) sendKey("Right");
    });
  }
}

function onTypedKey(event) {
  if (event.isComposing || composing) return;
  const empty = $("typed").value === "";
  if (event.key === "Enter") {
    event.preventDefault();
    sendKey("Return");
    clearTyped();
  } else if (event.key === "Tab") {
    event.preventDefault();
    sendKey("Tab");
  } else if (event.key === "Escape") {
    sendKey("Escape");
  } else if (empty && event.key === "Backspace") {
    event.preventDefault();
    sendKey("BackSpace");
  } else if (empty && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    sendKey(event.key.slice(5));
  }
}

function openKeyboard() {
  closeSheets();
  const strip = $("strip");
  strip.hidden = false;
  $("dock").hidden = true;
  keyboardOpen = true;
  $("typed").focus();
  closeHint();
  if (matchMedia("(orientation: landscape)").matches && !sessionStorage.getItem("pots-upright")) {
    sessionStorage.setItem("pots-upright", "1");
    toast(W.upright, 3000);
  }
  placeForKeyboard();
}

function closeKeyboard() {
  $("typed").blur();
  $("strip").hidden = true;
  $("dock").hidden = false;
  keyboardOpen = false;
  clearTyped();
  placeForKeyboard();
  placeDock();
  requestSize();
}

/**
 * Keep the typing field and the open sheet above the phone's keyboard, and move the picture up so the point last
 * tapped, as a field on the desktop, stays in sight above them.
 */
function placeForKeyboard() {
  const viewport = window.visualViewport;
  const top = viewport ? viewport.offsetTop : 0;
  const height = viewport ? viewport.height : window.innerHeight;
  const covered = Math.max(0, window.innerHeight - (top + height));
  const strip = $("strip");
  if (!strip) return;
  if (!strip.hidden) {
    strip.style.top = `${top + height - strip.offsetHeight}px`;
    strip.style.bottom = "auto";
  }
  for (const sheet of document.querySelectorAll(".sheet")) sheet.style.transform = touch && covered > 0 ? `translateY(${-covered}px)` : "";
  let shift = 0;
  if (keyboardOpen && lastTap && covered > 40) {
    const visibleBottom = top + height - strip.offsetHeight - 16;
    shift = Math.max(0, lastTap.y - visibleBottom);
  }
  $("screen").style.transform = shift > 0 ? `translateY(${-shift}px)` : "";
  placeToast();
}

// ---- The floating controls ----

/** The size of the page, where the controls float. */
function area() {
  const session = $("session");
  return { width: session.clientWidth, height: session.clientHeight };
}

/** How far the controls keep from each edge: a little, and more where a phone's notch or rounded corners are. */
function margins() {
  const safe = getComputedStyle($("safe"));
  const gap = 12;
  return {
    top: gap + (parseFloat(safe.paddingTop) || 0),
    right: gap + (parseFloat(safe.paddingRight) || 0),
    bottom: gap + (parseFloat(safe.paddingBottom) || 0),
    left: gap + (parseFloat(safe.paddingLeft) || 0),
  };
}

const DOCK_KEY = "pots-desktop-dock";
const EDGES = ["top", "right", "bottom", "left"];
/** The edge the dock is on, and where along it its middle is, from 0 to 1. Null: where it starts. */
let dockPlace = null;
/** Where the dock is, or is going: the panel, the menu and messages go next to it. */
let dockBox = null;
let dragging = false;

function loadDockPlace() {
  try {
    const place = JSON.parse(localStorage.getItem(DOCK_KEY) || "null");
    if (place && EDGES.includes(place.edge) && place.at >= 0 && place.at <= 1) return place;
  } catch {
    // no storage, or not ours
  }
  return null;
}

function saveDockPlace() {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(dockPlace));
  } catch {
    // the browser keeps nothing; the dock starts where it starts next time
  }
}

/** At the bottom; upright on the right on a phone held sideways, where the screen is short. Until it is moved. */
function startPlace() {
  const { width, height } = area();
  return touch && width > height && height <= 520 ? { edge: "right", at: 0.5 } : { edge: "bottom", at: 0.5 };
}

const upright = (edge) => edge === "left" || edge === "right";

/** Put the dock on its edge, and what goes with it next to it. */
function placeDock() {
  const dock = $("dock");
  if (!dock || dragging || dock.hidden) return;
  const place = dockPlace ?? startPlace();
  dock.classList.toggle("side", upright(place.edge));
  const { width, height } = area();
  const m = margins();
  // On a narrow screen the dock leaves out what it can do without, first the small icons, then Done's word.
  dock.classList.remove("tight", "tighter");
  const room = upright(place.edge) ? height - m.top - m.bottom : width - m.left - m.right;
  const length = () => (upright(place.edge) ? dock.offsetHeight : dock.offsetWidth);
  if (length() > room) dock.classList.add("tight");
  if (length() > room) dock.classList.add("tighter");
  const w = dock.offsetWidth;
  const h = dock.offsetHeight;
  let left;
  let top;
  if (upright(place.edge)) {
    left = place.edge === "left" ? m.left : width - w - m.right;
    top = clamp(place.at * height - h / 2, m.top, height - h - m.bottom);
  } else {
    top = place.edge === "top" ? m.top : height - h - m.bottom;
    left = clamp(place.at * width - w / 2, m.left, width - w - m.right);
  }
  dock.style.left = `${Math.round(left)}px`;
  dock.style.top = `${Math.round(top)}px`;
  dockBox = { left, top, right: left + w, bottom: top + h, width: w, height: h };
  placeHint();
  placeMenu();
  placeToast();
}

/** The edge nearest to a point, for the screen's shape: a point a fifth of the way across is as near as one a fifth of the way down. */
function nearestEdge(x, y) {
  const { width, height } = area();
  const distance = { left: x / width, right: (width - x) / width, top: y / height, bottom: (height - y) / height };
  return EDGES.reduce((best, edge) => (distance[edge] < distance[best] ? edge : best));
}

/**
 * The dock moves with a finger or the mouse, from anywhere on it, and stays on the edge it is let go nearest to:
 * upright on the left or right, lying on the top or bottom. A drag is not a press of the button it started on.
 */
function dragDock(dock) {
  let start = null;
  const move = (event) => {
    if (!start || event.pointerId !== start.id) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) return;
    if (!start.moved) {
      start.moved = true;
      dragging = true;
      // From here the dock has the pointer, also off its edge; a mouse that left the dock before this still drags it.
      try {
        dock.setPointerCapture(event.pointerId);
      } catch {
        // the pointer is gone already
      }
      dock.classList.add("dragging");
      closeHint();
      closeMenu();
    }
    start.edge = nearestEdge(event.clientX, event.clientY);
    dock.classList.toggle("side", upright(start.edge));
    const { width, height } = area();
    const w = dock.offsetWidth;
    const h = dock.offsetHeight;
    const left = upright(start.edge) ? event.clientX - w / 2 : event.clientX - start.along * w;
    const top = upright(start.edge) ? event.clientY - start.along * h : event.clientY - h / 2;
    dock.style.left = `${clamp(left, 4, width - w - 4)}px`;
    dock.style.top = `${clamp(top, 4, height - h - 4)}px`;
  };
  const listen = (on) => {
    for (const [type, handler] of [["pointermove", move], ["pointerup", end], ["pointercancel", end]]) {
      if (on) window.addEventListener(type, handler, true);
      else window.removeEventListener(type, handler, true);
    }
  };
  const end = (event) => {
    if (!start || event.pointerId !== start.id) return;
    listen(false);
    if (start.moved) {
      const swallow = (click) => (click.stopPropagation(), click.preventDefault());
      dock.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => dock.removeEventListener("click", swallow, true), 300);
      const rect = dock.getBoundingClientRect();
      const { width, height } = area();
      const at = upright(start.edge) ? (rect.top + rect.height / 2) / height : (rect.left + rect.width / 2) / width;
      dockPlace = { edge: start.edge, at: clamp(Math.round(at * 1000) / 1000, 0, 1) };
      saveDockPlace();
      dragging = false;
      dock.classList.remove("dragging");
      placeDock();
    }
    start = null;
  };
  dock.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    if (start) {
      // The last press never ended here, as when it was let go outside the window: this one starts anew.
      listen(false);
      dragging = false;
      dock.classList.remove("dragging");
    }
    const rect = dock.getBoundingClientRect();
    const side = dock.classList.contains("side");
    // Where along the dock it was taken, kept when it turns, so the finger stays on the same button.
    const along = side ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false, along, edge: null };
    listen(true);
  });
  // A drag let go at speed is no fling for the browser, which would let the next tap only stop that fling.
  dock.addEventListener("touchmove", (event) => start?.moved && event.preventDefault(), { passive: false });
}

/**
 * Put a floating element next to the dock: beside it when the dock stands upright on a side, else above it when the
 * dock is in the lower half, below it when in the upper half. It gets no larger than the room there.
 */
function placeNear(element, anchor, beside, tallest = Infinity) {
  const { width, height } = area();
  const m = margins();
  const gap = 10;
  element.style.maxWidth = "";
  element.style.maxHeight = "";
  let left;
  let top;
  if (beside) {
    const toLeft = anchor.left + anchor.width / 2 > width / 2;
    element.style.maxWidth = `${Math.max(120, toLeft ? anchor.left - gap - m.left : width - anchor.right - gap - m.right)}px`;
    element.style.maxHeight = `${Math.min(tallest, height - m.top - m.bottom)}px`;
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    left = toLeft ? anchor.left - gap - w : anchor.right + gap;
    top = clamp(anchor.top + anchor.height / 2 - h / 2, m.top, height - m.bottom - h);
  } else {
    const above = anchor.top + anchor.height / 2 > height / 2;
    element.style.maxHeight = `${Math.min(tallest, Math.max(80, above ? anchor.top - gap - m.top : height - anchor.bottom - gap - m.bottom))}px`;
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    top = above ? anchor.top - gap - h : anchor.bottom + gap;
    left = clamp(anchor.left + anchor.width / 2 - w / 2, m.left, width - m.right - w);
  }
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight, width: element.offsetWidth, height: element.offsetHeight };
}

// The task panel: the bot's words in full. It opens by itself at the start for a while, and with the task button.

let hintTimer;
let hintBox = null;
let hintFolding;

/** How long the panel stays open by itself at the start: longer for more words, from 5 to 10 seconds. */
const hintMs = () => clamp(3500 + 45 * Array.from(facts.text).length, 5000, 10_000);

function placeHint() {
  const hint = $("hint");
  if (!hint || hint.hidden || !dockBox) return;
  // Open by itself, it leaves at least half of a phone's screen to the picture; opened with the button, it may be taller.
  const side = $("dock").classList.contains("side");
  hintBox = placeNear(hint, dockBox, side, hint.classList.contains("auto") && !side ? Math.max(200, area().height / 2) : Infinity);
  markOverflow();
  // It grows out of the task button, and folds back into it.
  const chip = $("chip");
  const x = dockBox.left + chip.offsetLeft + chip.offsetWidth / 2 - hintBox.left;
  const y = dockBox.top + chip.offsetTop + chip.offsetHeight / 2 - hintBox.top;
  hint.style.setProperty("--from-x", `${Math.round(x)}px`);
  hint.style.setProperty("--from-y", `${Math.round(y)}px`);
}

/** Long words fade at the edge where there is more to scroll to. */
function markOverflow() {
  const words = $("hint-text");
  words.classList.toggle("more-above", words.scrollTop > 2);
  words.classList.toggle("more-below", words.scrollTop + words.clientHeight < words.scrollHeight - 2);
}

function openHint(byItself) {
  const hint = $("hint");
  if (!hint || over) return;
  closeMenu();
  clearTimeout(hintTimer);
  clearTimeout(hintFolding);
  hint.hidden = false;
  hint.classList.toggle("auto", !!byItself);
  $("chip").classList.add("on");
  $("chip").classList.remove("pulse");
  $("chip").setAttribute("aria-expanded", "true");
  placeHint();
  hint.getBoundingClientRect();
  hint.classList.remove("away");
  placeToast();
  if (byItself) hintTimer = setTimeout(() => closeHint(true), hintMs());
  if (rfb && !touch) rfb.focus();
}

/** Fold the panel into the task button. byItself: its time at the start is up, unless the person is reading it. */
function closeHint(byItself) {
  const hint = $("hint");
  if (!hint || hint.hidden || hint.classList.contains("away")) return;
  clearTimeout(hintTimer);
  if (byItself && !touch && hint.matches(":hover")) {
    hintTimer = setTimeout(() => closeHint(true), 2000);
    return;
  }
  hint.classList.add("away");
  const chip = $("chip");
  chip.classList.remove("on");
  chip.setAttribute("aria-expanded", "false");
  if (byItself) {
    // Where the words went: the task button glows twice.
    chip.classList.remove("pulse");
    chip.getBoundingClientRect();
    chip.classList.add("pulse");
  }
  hintFolding = setTimeout(() => {
    hint.hidden = true;
    hintBox = null;
    placeToast();
  }, 230);
  if (rfb && !touch) rfb.focus();
}

function toggleHint() {
  const hint = $("hint");
  if (hint.hidden || hint.classList.contains("away")) openHint(false);
  else closeHint();
}

/** The person reads the panel: it stays open until they fold it or press somewhere else. */
function holdHint() {
  clearTimeout(hintTimer);
}

function onPressAnywhere(event) {
  const target = event.target;
  const hint = $("hint");
  if (hint && !hint.hidden && !hint.contains(target) && !$("chip").contains(target)) closeHint();
  const menu = $("menu");
  if (menu && !menu.hidden && !menu.contains(target) && !$("more-button").contains(target)) closeMenu();
}

function placeMenu() {
  const menu = $("menu");
  if (!menu || menu.hidden || !dockBox) return;
  placeNear(menu, dockBox, $("dock").classList.contains("side"));
}

function toggleMenu() {
  const menu = $("menu");
  if (!menu.hidden) return closeMenu();
  closeHint();
  menu.hidden = false;
  updatePictureControls();
  placeMenu();
}

function closeMenu() {
  const menu = $("menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (rfb && !touch) rfb.focus();
}

function openSheet(id) {
  closeMenu();
  closeHint();
  if (id !== "more" && keyboardOpen) closeKeyboard();
  for (const sheet of document.querySelectorAll(".sheet")) sheet.hidden = sheet.id !== id;
  $("scrim").hidden = false;
  if (id === "hand-back") $("hand-back-msg").textContent = "";
  updatePictureControls();
  placeForKeyboard();
}

function closeSheets() {
  for (const sheet of document.querySelectorAll(".sheet")) sheet.hidden = true;
  $("scrim").hidden = true;
  $("arrows").hidden = true;
  if (rfb && !touch) rfb.focus();
}

let toastTimer;
function toast(text, ms) {
  const element = $("toast");
  if (!element) return;
  clearTimeout(toastTimer);
  element.textContent = text;
  element.hidden = false;
  element.style.opacity = "1";
  placeToast();
  toastTimer = setTimeout(() => {
    element.style.opacity = "0";
    toastTimer = setTimeout(() => (element.hidden = true), 700);
  }, ms);
}

/** A message goes next to the controls, past the panel when it is open: above the typing strip while the keyboard is up. */
function placeToast() {
  const element = $("toast");
  if (!element || element.hidden) return;
  const strip = $("strip");
  let anchor = !strip.hidden ? strip.getBoundingClientRect() : dockBox;
  if (!anchor) return;
  if (strip.hidden && hintBox) {
    const left = Math.min(anchor.left, hintBox.left);
    const top = Math.min(anchor.top, hintBox.top);
    const right = Math.max(anchor.right, hintBox.right);
    const bottom = Math.max(anchor.bottom, hintBox.bottom);
    anchor = { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  placeNear(element, anchor, false);
}

function dim(text) {
  const element = $("dim");
  if (!element) return;
  element.hidden = !text;
  $("dim-text").textContent = text || "";
}

function setDot(state) {
  const dot = $("dot");
  if (!dot) return;
  dot.classList.toggle("on", state === "on");
  dot.classList.toggle("off", state === "off");
}

function tick() {
  if (!link || over || !$("time")) return;
  const left = link.expires - serverNow();
  if (left <= 0) {
    $("time").textContent = "0:00";
    refresh();
    return;
  }
  const seconds = Math.ceil(left / 1000);
  $("time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  $("time").classList.toggle("low", left < 120_000);
  $("hint-meta").textContent = fill(W.hintMeta, { time: localTime(link.expires) });
  if (left < 60_000 && !warnedMinute) {
    warnedMinute = true;
    toast(W.oneMinute, 4000);
  }
}

function fullscreen() {
  const element = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else element.requestFullscreen?.().catch(() => {});
}

// ---- Handing back, and the end ----

async function handBackNow(how) {
  const buttons = [$("hand-done"), $("hand-cannot")];
  for (const button of buttons) button.disabled = true;
  const answer = await api("end", { how, note: $("note").value });
  for (const button of buttons) button.disabled = false;
  if (answer.ok) return showEnded(how, answer.restored);
  if (answer.status === 410 || answer.status === 404) {
    await refresh();
    return;
  }
  $("hand-back-msg").textContent = answer.status === 0 ? W.network : fill(W.failed, { reason: answer.error || answer.status });
}

function showEnded(state, restored) {
  if (over) return;
  over = true;
  clearTimeout(reconnectTimer);
  dropConnection();
  document.documentElement.style.overflow = "";
  $("session")?.remove();
  $("start").hidden = true;
  const words =
    state === "done"
      ? [W.endedDone, W.endedDoneText]
      : state === "cannot"
        ? [W.endedCannot, W.endedCannotText]
        : state === "expired"
          ? [W.endedExpired, W.endedExpiredText]
          : state === "revoked"
            ? [W.endedRevoked, W.endedRevokedText]
            : [W.notFound, W.notFoundText];
  const good = state === "done" || state === "cannot";
  document.body.append(
    h(
      "main",
      { class: "page ended" },
      h("div", { class: `check ${good ? "good" : "gone"}`, "aria-hidden": "true" }),
      h("h1", { text: words[0] }),
      h("p", { class: "meta", text: restored ? `${words[1]} ${W.restored}` : words[1] }),
    ),
  );
}

// ---- Begin ----

startButton.addEventListener("click", start);
refresh().then(() => {
  if (over || !link) return startMessage(link ? "" : W.network);
  showStart();
  // The browser that pressed Start goes on where it was, as after a reload; any other only sees the start screen.
  if (link.state === "started" && link.mine) start();
});
