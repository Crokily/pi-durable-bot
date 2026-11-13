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

function buildSession() {
  const session = h("div", { id: "session", class: touch ? "" : "desktop" });
  const pill = h(
    "div",
    { id: "pill", class: "glass", role: "button", tabindex: "0" },
    h("i", { class: "dot", id: "dot" }),
    h("span", { class: "time", id: "time" }),
    h("span", { class: "txt", text: facts.text }),
    h("span", { class: "more-text", id: "pill-more" }),
    h(
      "span",
      { class: "actions" },
      h("button", { type: "button", class: "done", id: "pill-done", onclick: (event) => (event.stopPropagation(), openSheet("hand-back")) }, checkIcon(), h("span", { text: W.done })),
      h("button", { type: "button", class: "ib", "aria-label": W.more, title: W.more, onclick: (event) => (event.stopPropagation(), toggleMenu()) }, moreIcon()),
    ),
  );
  pill.addEventListener("click", () => {
    if (!touch) return expandPill();
    pill.classList.remove("short");
    pill.classList.toggle("open");
  });
  const dock = h(
    "div",
    { id: "dock", class: "glass" },
    h("button", { type: "button", class: "ib", id: "keyboard-button", "aria-label": W.keyboard, title: W.keyboard, onclick: () => openKeyboard() }, keyboardIcon()),
    h("button", { type: "button", class: "ib", "aria-label": W.more, title: W.more, onclick: () => openSheet("more") }, moreIcon()),
    h("button", { type: "button", class: "done", onclick: () => openSheet("hand-back") }, checkIcon(), h("span", { text: W.done })),
  );
  makeDraggable(dock);

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
    pill,
    h("button", { type: "button", id: "zoom", class: "glass", hidden: true, onclick: () => setMode(view.mode === "actual" ? "whole" : view.mode, true) }),
    h("div", { id: "toast", class: "glass", hidden: true }),
    dock,
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
  window.addEventListener("resize", () => placeForKeyboard());
  if (!touch) {
    // Captured before noVNC, which keeps the mouse's events to itself.
    document.addEventListener("mousemove", onDesktopMouse, true);
    window.addEventListener("keydown", onDesktopKey, true);
  }
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
  pillShort(3500);
  if (touch) toast(W.gestures, 4500);
  else toast(cmdIsCtrl ? W.keysHintMac : W.keysHint, 5000);
  const hint = facts.input === "password" ? W.hintPassword : facts.input === "code" ? W.hintCode : facts.input === "text" ? W.hintText : null;
  if (hint && touch) setTimeout(() => toast(hint, 5000), 4800);
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
    zoom.hidden = !touch || view.zoom < 1.05 || view.mode === "actual";
    zoom.textContent = fill(W.zoom, { n: Math.round(view.zoom * 10) / 10 });
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
  for (let index = 0; index < end; index++) sendKey("Left");
  for (let index = 0; index < removed; index++) sendKey("BackSpace");
  typeText(added);
  if (end > 0) typing = typing.then(() => {
    for (let index = 0; index < end; index++) sendKey("Right");
  });
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
  pillShort(0);
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
}

// ---- The floating controls ----

let pillTimer;
/** Fold the task strip after a while: on a phone to its dot and time, on a computer to a tab at the top edge. */
function pillShort(after) {
  const pill = $("pill");
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => {
    if (touch) {
      if (!pill.classList.contains("open")) pill.classList.add("short");
    } else if (!$("menu").hidden || pill.matches(":hover") || !$("scrim").hidden) pillShort(3000);
    else pill.classList.add("tab");
  }, after);
}

function expandPill() {
  $("pill").classList.remove("tab");
  pillShort(3000);
}

function onDesktopMouse(event) {
  // The mouse at the top edge brings the strip back.
  if (event.clientY < 14 && $("pill").classList.contains("tab")) expandPill();
}

function toggleMenu() {
  const menu = $("menu");
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  clearTimeout(pillTimer);
  $("pill").classList.remove("tab");
  updatePictureControls();
}

function closeMenu() {
  const menu = $("menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  pillShort(3000);
  if (rfb && !touch) rfb.focus();
}

function openSheet(id) {
  closeMenu();
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
  toastTimer = setTimeout(() => {
    element.style.opacity = "0";
    toastTimer = setTimeout(() => (element.hidden = true), 700);
  }, ms);
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
  $("pill-more").textContent = fill(W.pillMore, { time: localTime(link.expires) });
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

function makeDraggable(element) {
  let start = null;
  element.addEventListener("pointerdown", (event) => {
    start = { x: event.clientX, y: event.clientY, rect: element.getBoundingClientRect(), moved: false, id: event.pointerId };
  });
  element.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 12) return;
    if (!start.moved) element.setPointerCapture(event.pointerId);
    start.moved = true;
    element.style.left = `${clamp(start.rect.left + dx, 4, window.innerWidth - start.rect.width - 4)}px`;
    element.style.top = `${clamp(start.rect.top + dy, 4, window.innerHeight - start.rect.height - 4)}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.transform = "none";
  });
  const end = (event) => {
    if (start?.moved) {
      // A drag is not a tap on the button under the finger.
      element.addEventListener("click", (click) => (click.stopPropagation(), click.preventDefault()), { capture: true, once: true });
    }
    if (start && event.pointerId === start.id) start = null;
  };
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
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
