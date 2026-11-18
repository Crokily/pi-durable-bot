/*
 * Pots page kit: pots-ui.js. Optional moving parts for pages, offline, no libraries. Link it from a page as
 * <script src="../../__pots/kit/pots-ui.js" defer></script>, with pots.css.
 * Every part starts from plain HTML that reads well without this script:
 *   <table data-pots-chart="bar|stack|line">   a chart drawn from the table; the table stays one tap away
 *       bar: first column = labels, second = values; data-marks="380 You; 300 Her" draws reference lines;
 *            a row's class (pots-good, pots-warn, pots-bad, pots-muted) colours its bar.
 *       stack: parts of a whole in one bar with a legend.   line: rows are the x axis, each number column a line.
 *       data-max (bar) and data-min (line) fix the scale; data-pots-show="…" names the button that shows the numbers.
 *   <div data-pots-tabs> with children <section data-tab="Name">   tabs; data-pots-tabs="phone": tabs on phones only.
 *       A panel with data-current starts open. box.potsSelect(i) opens one from your own script.
 *   <table data-pots-sort>                     click a column header to sort.
 *       A cell's data-value, when it has one, is the value to sort and chart by; else the cell's text, read as a number
 *       when the whole cell is one (in the page's language: "1,234.5" in English, "1.234,5" in German), or as text.
 *   <input data-pots-filter="#list">           hides rows, or [data-pots-item] elements, that do not contain the text.
 *   <nav class="pots-toc">                     marks the section on screen.
 *   every <table>                              goes in a <div class="pots-scroll">, so a wide one scrolls inside it.
 *   the page                                   gets a light / dark switch at its top corner; window.PotsTheme.set("light").
 * It sets only textContent and CSS custom properties, never HTML from text, so it works under the private-page CSP.
 * Loaded twice, or a part called twice on one element, it does the work once. A part that fails leaves its plain HTML.
 */
(function () {
  "use strict";
  if (window.PotsUI) return;
  // The page's language, when the browser knows it; numbers and sorting follow it.
  const lang = (() => {
    try {
      return Intl.getCanonicalLocales(document.documentElement.lang || [])[0];
    } catch {
      return undefined;
    }
  })();
  const T = { data: /^zh/i.test(lang || "") ? "看数据" : "Show the numbers" };
  const SVG = "http://www.w3.org/2000/svg";

  // A cell is a number when all of it is one: a sign, a currency or "about", the digits with the page's separators,
  // and a short unit ("€1,234.50", "−3.5 kg", "约 380 克", "12,50 €" in French). "Zebra 1" and "1,50" on an English page are text.
  const NUM = (() => {
    let group = ",", decimal = ".";
    try {
      for (const p of new Intl.NumberFormat(lang).formatToParts(12345.6)) {
        if (p.type === "group") group = p.value;
        if (p.type === "decimal") decimal = p.value;
      }
    } catch {}
    const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const g = /\s/.test(group) ? "[\\s\\u00a0\\u202f]" : group === "," ? "[,，]" : /['’]/.test(group) ? "['’]" : esc(group);
    return new RegExp("^([-+−]?)(?:\\p{Sc}|[~≈约])?\\s?([-+−]?)(\\d{1,3}(?:" + g + "\\d{3})+|\\d+)(?:" + esc(decimal) + "(\\d+))?\\s?(?:%|‰|\\p{Sc}|[\\p{L}°µ/²³]{1,4})?$", "u");
  })();
  function num(text) {
    const m = String(text).trim().match(NUM);
    if (!m) return NaN;
    const v = parseFloat(m[3].replace(/\D/g, "") + (m[4] ? "." + m[4] : ""));
    return /[-−]/.test(m[1] + m[2]) ? -v : v;
  }
  // A cell's value: its data-value when it has one, else its text read as a number (NaN when it is not one).
  function cellValue(c) {
    const d = c.getAttribute("data-value");
    if (d == null) return num(c.textContent);
    return d.trim() === "" ? NaN : Number(d);
  }
  function extent(values) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values)
      if (!isNaN(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    return [lo, hi];
  }
  // Each part runs once on an element, also when this file is loaded twice; the mark is shared through the symbol.
  const DONE = Symbol.for("pots-ui.done");
  function once(e, part) {
    const done = e[DONE] || (e[DONE] = new Set());
    if (done.has(part)) return false;
    done.add(part);
    return true;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs, text) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function pct(v, max) {
    return max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)).toFixed(2) + "%" : "0%";
  }
  function fmt(v) {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(v);
  }

  /* ---- Tabs ---- */
  let tabSeq = 0;
  const FOCUSABLE = "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  function tabs(box) {
    const panels = [...box.children].filter((c) => c.hasAttribute("data-tab"));
    if (panels.length < 2 || !once(box, "tabs")) return;
    const id = "pots-tab-" + ++tabSeq;
    const bar = el("div", "pots-tabbar");
    bar.setAttribute("role", "tablist");
    const buttons = panels.map((p, i) => {
      const b = el("button", null, p.getAttribute("data-tab"));
      b.type = "button";
      b.setAttribute("role", "tab");
      if (!p.id) p.id = id + "-" + i;
      b.id = p.id + "-tab";
      b.setAttribute("aria-controls", p.id);
      p.setAttribute("role", "tabpanel");
      p.setAttribute("aria-labelledby", b.id);
      b.addEventListener("click", () => select(i, true));
      bar.append(b);
      return b;
    });
    // A panel with nothing to focus in it is a stop for the keyboard itself, while it is a tab.
    const plain = panels.filter((p) => !p.querySelector(FOCUSABLE));
    const phone = box.getAttribute("data-pots-tabs") === "phone" && window.matchMedia ? matchMedia("(max-width: 719.98px)") : null;
    function stops() {
      plain.forEach((p) => (!phone || phone.matches ? (p.tabIndex = 0) : p.removeAttribute("tabindex")));
    }
    stops();
    if (phone) phone.addEventListener("change", stops);
    bar.addEventListener("keydown", (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      // The arrow keys go the way the tabs read: right to left, the next tab is on the left.
      const next = getComputedStyle(bar).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
      const prev = next === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
      const j = e.key === next ? i + 1 : e.key === prev ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -2;
      if (j === -2) return;
      e.preventDefault();
      const k = (j + buttons.length) % buttons.length;
      select(k, true);
      buttons[k].focus();
    });
    function select(i, byUser) {
      panels.forEach((p, k) => {
        p.classList.toggle("pots-off", k !== i);
        buttons[k].setAttribute("aria-selected", String(k === i));
        buttons[k].tabIndex = k === i ? 0 : -1;
      });
      if (byUser) buttons[i].scrollIntoView({ block: "nearest", inline: "nearest" });
      box.dispatchEvent(new CustomEvent("pots-tab", { detail: { index: i, panel: panels[i] } }));
    }
    box.insertBefore(bar, panels[0]);
    const start = panels.findIndex((p) => p.hasAttribute("data-current"));
    select(start < 0 ? 0 : start, false);
    box.potsSelect = (i) => select(i, false);
  }
  // A form that is sent with a field to fill in a closed tab: the browser can not show a hidden field, so it would
  // stop without a word. The first such field of a check opens its tab, and the browser then shows it.
  let checking = false;
  function opener(e) {
    if (checking || !(e.target instanceof Element)) return;
    checking = true;
    setTimeout(() => (checking = false));
    for (let p = e.target.closest(".pots-off"); p; p = p.parentElement && p.parentElement.closest(".pots-off")) {
      const box = p.parentElement;
      if (box && box.potsSelect) box.potsSelect([...box.children].filter((c) => c.hasAttribute("data-tab")).indexOf(p));
    }
  }

  /* ---- Charts ---- */
  function chart(table) {
    if (!once(table, "chart")) return;
    const type = table.getAttribute("data-pots-chart") || "bar";
    const head = table.tHead && table.tHead.rows[0] ? [...table.tHead.rows[0].cells].map((c) => c.textContent.trim()) : [];
    const body = table.tBodies[0] || table;
    const rows = [...body.rows].filter((r) => r.cells.length > 1 && r.parentElement !== table.tHead);
    const data = rows.map((r) => ({
      label: r.cells[0].textContent.trim(),
      cls: r.className,
      cells: [...r.cells].slice(1).map((c) => ({ text: c.textContent.trim(), v: cellValue(c) })),
    }));
    const fig = el("figure", "pots-chart pots-" + type + (table.classList.contains("pots-wide") ? " pots-wide" : ""));
    if (table.caption) fig.append(el("figcaption", null, table.caption.textContent.trim()));
    table.before(fig);
    // The table goes in first, folded, so a long one is not laid out while the chart measures its width.
    const more = el("details", "pots-data");
    more.append(el("summary", null, table.getAttribute("data-pots-show") || T.data), table);
    fig.append(more);
    try {
      if (type === "stack") stack(fig, data);
      else if (type === "line") line(fig, data, head, table);
      else bars(fig, data, table);
    } catch (e) {
      // The table stays as it was.
      fig.replaceWith(table);
      table[DONE].delete("chart");
      throw e;
    }
    fig.append(more);
  }

  function bars(fig, data, table) {
    const marks = (table.getAttribute("data-marks") || "")
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // The number first, then its name: "380 You", "€10,000 Budget", "10 000 Budget" in French.
        const m = s.match(/^((?:[~≈约]\s?)?[^\p{L}]*\d)\s*(.*)$/u);
        return m ? { v: num(m[1]), label: m[2] || s } : { v: NaN, label: s };
      });
    const max = parseFloat(table.getAttribute("data-max")) || Math.max(0, extent(data.map((d) => (d.cells[0] ? d.cells[0].v : NaN)))[1], extent(marks.map((m) => m.v))[1]);
    const ul = el("ul", "pots-hbars");
    if (marks.length) {
      const li = el("li", "pots-marks");
      li.setAttribute("aria-hidden", "true");
      const tr = el("span", "pots-track");
      marks.forEach((m) => {
        // Past the middle, the name gives way towards the start.
        const s = el("span", parseFloat(pct(m.v, max)) > 50 ? "pots-end" : null);
        s.append(el("span", null, m.label));
        s.style.setProperty("--v", pct(m.v, max));
        tr.append(s);
      });
      li.append(tr);
      ul.append(li);
    }
    data.forEach((d) => {
      const li = el("li", d.cls);
      const c = d.cells[0] || { text: "", v: NaN };
      li.append(el("span", "pots-l", d.label), el("span", "pots-v", c.text));
      const tr = el("span", "pots-track");
      if (!isNaN(c.v)) {
        const f = el("span", "pots-fill");
        f.style.setProperty("--v", pct(c.v, max));
        tr.append(f);
      }
      marks.forEach((m) => {
        const k = el("span", "pots-mark");
        k.style.setProperty("--v", pct(m.v, max));
        tr.append(k);
      });
      li.append(tr);
      ul.append(li);
    });
    fig.append(ul);
  }

  function stack(fig, data) {
    const items = data.filter((d) => d.cells[0] && d.cells[0].v > 0);
    const total = items.reduce((s, d) => s + d.cells[0].v, 0);
    const barEl = el("div", "pots-stackbar");
    barEl.setAttribute("role", "img");
    barEl.setAttribute("aria-label", items.map((d) => d.label + " " + d.cells[0].text).join(", "));
    const legend = el("ul", "pots-legend");
    items.forEach((d, i) => {
      const s = el("span", "pots-s" + ((i % 7) + 1));
      s.style.setProperty("--v", pct(d.cells[0].v, total));
      barEl.append(s);
      const li = el("li");
      li.append(el("i", "pots-s" + ((i % 7) + 1)), el("span", null, d.label), el("span", "pots-v", d.cells[0].text + " · " + Math.round((d.cells[0].v / total) * 100) + "%"));
      legend.append(li);
    });
    fig.append(barEl, legend);
  }

  function line(fig, data, head, table) {
    const box = el("div", "pots-linebox");
    fig.append(box);
    const series = (data[0] ? data[0].cells : []).map((_, s) => ({ name: head[s + 1] || "", pts: data.map((d) => (d.cells[s] ? d.cells[s].v : NaN)) }));
    let [min, hi] = extent(series.map((s) => extent(s.pts)).flat());
    if (!isFinite(min)) return;
    const fixed = parseFloat(table.getAttribute("data-min"));
    // From zero, unless the values sit far from it; then from just below the lowest, so the change shows.
    let lo = !isNaN(fixed) ? fixed : min > 0 && hi - min < min ? min - (hi - min) * 0.25 : Math.min(0, min);
    // All values equal, or a data-min above them: a scale from zero.
    if (!(hi > lo)) {
      lo = Math.min(0, min);
      hi = Math.max(0, hi);
      if (hi === lo) hi = lo + 1;
    }
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    // A few ticks, each at lo plus a whole number of steps, so a step too small to add to a big value still ends.
    const ticks = Math.min(12, Math.round((hi - lo) / step));
    // Many points: in each run of k, the lowest and the highest, so a spike stays and the path stays small.
    const run = Math.ceil(data.length / 500);
    const shown = series.map((se) => {
      if (run < 2) return se.pts.map((v, i) => i);
      const out = [];
      for (let a = 0; a < se.pts.length; a += run) {
        let lo2 = -1, hi2 = -1;
        for (let i = a; i < Math.min(a + run, se.pts.length); i++) {
          const v = se.pts[i];
          if (isNaN(v)) continue;
          if (lo2 < 0 || v < se.pts[lo2]) lo2 = i;
          if (hi2 < 0 || v > se.pts[hi2]) hi2 = i;
        }
        if (lo2 >= 0) out.push(...(lo2 === hi2 ? [lo2] : lo2 < hi2 ? [lo2, hi2] : [hi2, lo2]));
      }
      return out;
    });
    let last = 0;
    function render() {
      const W = Math.round(box.clientWidth);
      if (!W || W === last) return;
      last = W;
      const H = Math.max(180, Math.min(300, Math.round(W * 0.45)));
      const L = 8 + 7 * Math.max(fmt(lo).length, fmt(hi).length), R = 12, Tp = 10, B = 28;
      const x = (i) => L + (data.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (data.length - 1));
      const y = (v) => Tp + (H - Tp - B) * (1 - (v - lo) / (hi - lo || 1));
      const s = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img" });
      s.setAttribute("aria-label", (fig.querySelector("figcaption") || {}).textContent || "chart");
      for (let t = 0; t <= ticks; t++) {
        const v = lo + t * step;
        s.append(svg("line", { class: v === lo ? "pots-axis pots-base" : "pots-axis", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
        s.append(svg("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
      }
      const every = Math.ceil(data.length / Math.max(2, Math.floor((W - L - R) / 64)));
      data.forEach((d, i) => {
        const end = i === data.length - 1 && data.length > 1;
        // Every few labels, and the last one; a label too close to the last one gives way to it.
        if (end || (i % every === 0 && data.length - 1 - i >= every * 0.6))
          s.append(svg("text", { x: x(i), y: H - 6, "text-anchor": end ? "end" : i === 0 ? "start" : "middle" }, d.label));
      });
      series.forEach((se, k) => {
        let p = "";
        shown[k].forEach((i) => {
          const v = se.pts[i];
          if (isNaN(v)) return;
          p += (p ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
        });
        s.append(svg("path", { d: p, class: "pots-s" + ((k % 7) + 1) }));
        if (data.length <= 24)
          se.pts.forEach((v, i) => {
            if (!isNaN(v)) s.append(svg("circle", { cx: x(i), cy: y(v), r: 3.5, class: "pots-s" + ((k % 7) + 1) }));
          });
      });
      box.replaceChildren(s);
      if (series.length > 1) {
        const legend = el("ul", "pots-legend");
        series.forEach((se, k) => {
          const li = el("li");
          li.append(el("i", "pots-s" + ((k % 7) + 1)), el("span", null, se.name));
          legend.append(li);
        });
        box.append(legend);
      }
    }
    render();
    if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(render)).observe(box);
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /* ---- Sorting and filtering ---- */
  function sortable(table) {
    if (!table.tHead || !table.tHead.rows[0] || !table.tBodies[0] || !once(table, "sort")) return;
    const ths = [...table.tHead.rows[0].cells];
    // What a cell sorts by: its data-value, else its text.
    const key = (r, i) => {
      const c = r.cells[i];
      return c ? (c.getAttribute("data-value") ?? c.textContent).trim() : "";
    };
    ths.forEach((th, i) => {
      const b = el("button", "pots-sort");
      b.type = "button";
      while (th.firstChild) b.append(th.firstChild);
      th.append(b);
      b.addEventListener("click", () => {
        const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        ths.forEach((t) => t.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", dir);
        const body = table.tBodies[0];
        const rows = [...body.rows];
        // Numbers when every cell that is not empty is one; else text, in the page's language.
        const values = new Map(rows.map((r) => [r, r.cells[i] ? cellValue(r.cells[i]) : NaN]));
        const numeric = rows.every((r) => !key(r, i) || !isNaN(values.get(r)));
        rows.sort((a, b2) => {
          const x = key(a, i), y = key(b2, i);
          if (!x || !y) return !x && !y ? 0 : !x ? 1 : -1;
          const c = numeric ? values.get(a) - values.get(b2) : x.localeCompare(y, lang, { numeric: true });
          return dir === "ascending" ? c : -c;
        });
        body.append(...rows);
      });
    });
  }

  function filter(input) {
    let target = null;
    try {
      target = document.querySelector(input.getAttribute("data-pots-filter"));
    } catch {}
    if (!target || !once(input, "filter")) return;
    const items = () =>
      target.matches("table")
        ? [...(target.tBodies[0] || target).rows].filter((r) => r.parentElement !== target.tHead)
        : target.querySelector("[data-pots-item]")
          ? [...target.querySelectorAll("[data-pots-item]")]
          : [...target.children];
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      items().forEach((it) => it.classList.toggle("pots-hide", !!q && !it.textContent.toLowerCase().includes(q)));
      target.querySelectorAll("[data-pots-group]").forEach((g) => {
        const its = [...g.querySelectorAll("[data-pots-item]")];
        g.classList.toggle("pots-hide", its.length > 0 && its.every((x) => x.classList.contains("pots-hide")));
      });
      target.dispatchEvent(new CustomEvent("pots-filter", { detail: { query: q } }));
    });
  }

  /* ---- Contents: mark the section on screen ---- */
  const still = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  function toc(nav) {
    if (!once(nav, "toc")) return;
    const links = [...nav.querySelectorAll('a[href^="#"]')];
    const targets = links.map((a) => {
      try {
        return document.getElementById(decodeURIComponent(a.hash.slice(1)));
      } catch {
        return null;
      }
    });
    let queued = false, current = -2;
    function update() {
      queued = false;
      let cur = -1;
      targets.forEach((t, i) => {
        if (t && t.getBoundingClientRect().top < 140) cur = i;
      });
      if (cur === current) return;
      current = cur;
      links.forEach((a, i) => (i === cur ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
      if (cur >= 0 && nav.scrollWidth > nav.clientWidth + 2) {
        const a = links[cur];
        nav.scrollTo({ left: a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2, behavior: still && still.matches ? "auto" : "smooth" });
      }
    }
    addEventListener("scroll", () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

  /* ---- Tables: a box that scrolls a wide table, so the table itself can take the full width ---- */
  function scroller(table) {
    if (!table.parentElement || table.parentElement.classList.contains("pots-scroll")) return;
    const box = el("div", "pots-scroll" + (table.classList.contains("pots-wide") ? " pots-wide" : ""));
    table.before(box);
    box.append(table);
  }

  /* ---- Light or dark: the reader's choice, from a switch at the page's top corner ---- */
  // It is kept in the browser for every page of this host, as it is not private. A choice that is the system's own
  // is forgotten, so the page follows the system again. pots.js has the same switch; the first of the two makes it.
  function themeSwitch() {
    if (window.PotsTheme) return;
    const root = document.documentElement, KEY = "pots-theme";
    const system = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : { matches: false };
    const read = () => {
      try {
        const v = localStorage.getItem(KEY);
        return v === "light" || v === "dark" ? v : null;
      } catch {
        return null;
      }
    };
    const shown = () => read() || (system.matches ? "dark" : "light");
    let button = null;
    function apply() {
      const v = read();
      if (v) root.setAttribute("data-pots-theme", v);
      else root.removeAttribute("data-pots-theme");
      if (!button) return;
      const dark = shown() === "dark";
      button.setAttribute("data-icon", dark ? "sun" : "moon");
      button.setAttribute("aria-pressed", String(dark));
    }
    function set(v) {
      try {
        if (v === (system.matches ? "dark" : "light")) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, v);
      } catch {}
      apply();
    }
    apply();
    window.PotsTheme = {
      get: shown,
      set,
      // The button, once the body is there, and only on a page that uses pots.css.
      button() {
        if (button || !document.body || !getComputedStyle(root).getPropertyValue("--pots-bg")) return;
        const zh = /^zh/i.test(lang || "");
        button = el("button", "pots-theme");
        button.type = "button";
        button.setAttribute("aria-label", zh ? "深色模式" : "Dark mode");
        button.title = zh ? "切换浅色或深色" : "Switch light or dark";
        button.addEventListener("click", () => set(shown() === "dark" ? "light" : "dark"));
        document.body.prepend(button);
        apply();
      },
    };
    if (system.addEventListener) system.addEventListener("change", apply);
    addEventListener("storage", (e) => e.key === KEY && apply());
  }

  // Each part on its own: one that fails keeps its plain HTML, and the others still start.
  function each(selector, part) {
    document.querySelectorAll(selector).forEach((e) => {
      try {
        part(e);
      } catch (err) {
        console.error("pots-ui:", err);
      }
    });
  }
  function start() {
    each("table[data-pots-chart]", chart);
    each("table", scroller);
    each("table[data-pots-sort]", sortable);
    each("[data-pots-tabs]", tabs);
    each("input[data-pots-filter]", filter);
    each("nav.pots-toc", toc);
    try {
      window.PotsTheme.button();
    } catch (err) {
      console.error("pots-ui:", err);
    }
  }
  document.addEventListener("invalid", opener, true);
  // At once, before the page is shown when the script is not deferred, so the reader's choice does not flash.
  try {
    themeSwitch();
  } catch (err) {
    console.error("pots-ui:", err);
  }
  window.PotsUI = { num, tabs, chart, sortable, filter };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
