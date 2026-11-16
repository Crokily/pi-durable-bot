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
 *   <input data-pots-filter="#list">           hides rows, or [data-pots-item] elements, that do not contain the text.
 *   <nav class="pots-toc">                     marks the section on screen.
 *   every <table>                              goes in a <div class="pots-scroll">, so a wide one scrolls inside it.
 * It sets only textContent and CSS custom properties, never HTML from text, so it works under the private-page CSP.
 */
(function () {
  "use strict";
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

  function num(text) {
    const m = String(text).replace(/[,，\s]/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
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
  function tabs(box) {
    const panels = [...box.children].filter((c) => c.hasAttribute("data-tab"));
    if (panels.length < 2) return;
    const id = "pots-tab-" + ++tabSeq;
    const bar = el("div", "pots-tabbar");
    bar.setAttribute("role", "tablist");
    const buttons = panels.map((p, i) => {
      const b = el("button", null, p.getAttribute("data-tab"));
      b.type = "button";
      b.setAttribute("role", "tab");
      if (!p.id) p.id = id + "-" + i;
      b.setAttribute("aria-controls", p.id);
      p.setAttribute("role", "tabpanel");
      b.addEventListener("click", () => select(i, true));
      bar.append(b);
      return b;
    });
    bar.addEventListener("keydown", (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -2;
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

  /* ---- Charts ---- */
  function chart(table) {
    const type = table.getAttribute("data-pots-chart") || "bar";
    const head = table.tHead ? [...table.tHead.rows[0].cells].map((c) => c.textContent.trim()) : [];
    const body = table.tBodies[0] || table;
    const rows = [...body.rows].filter((r) => r.cells.length > 1 && r.parentElement !== table.tHead);
    const data = rows.map((r) => ({
      label: r.cells[0].textContent.trim(),
      cls: r.className,
      cells: [...r.cells].slice(1).map((c) => ({ text: c.textContent.trim(), v: num(c.textContent) })),
    }));
    const fig = el("figure", "pots-chart pots-" + type + (table.classList.contains("pots-wide") ? " pots-wide" : ""));
    if (table.caption) fig.append(el("figcaption", null, table.caption.textContent.trim()));
    table.before(fig);
    if (type === "stack") stack(fig, data);
    else if (type === "line") line(fig, data, head, table);
    else bars(fig, data, table);
    const more = el("details", "pots-data");
    more.append(el("summary", null, table.getAttribute("data-pots-show") || T.data), table);
    fig.append(more);
  }

  function bars(fig, data, table) {
    const marks = (table.getAttribute("data-marks") || "")
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ v: num(s), label: s.replace(/^[^\d-]*-?\d+(?:\.\d+)?\s*/, "") || s }));
    const max = parseFloat(table.getAttribute("data-max")) || Math.max(0, ...data.map((d) => d.cells[0].v || 0), ...marks.map((m) => m.v || 0));
    const ul = el("ul", "pots-hbars");
    if (marks.length) {
      const li = el("li", "pots-marks");
      li.setAttribute("aria-hidden", "true");
      const tr = el("span", "pots-track");
      marks.forEach((m) => {
        const s = el("span", null, m.label);
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
    const all = series.flatMap((s) => s.pts).filter((v) => !isNaN(v));
    if (!all.length) return;
    let hi = Math.max(...all);
    const min = Math.min(...all);
    // From zero, unless the values sit far from it; then from just below the lowest, so the change shows.
    let lo = table.hasAttribute("data-min") ? parseFloat(table.getAttribute("data-min")) : min > 0 && hi - min < min ? min - (hi - min) * 0.25 : Math.min(0, min);
    const step = niceStep((hi - lo) / 4 || 1);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
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
      for (let v = lo; v <= hi + step / 2; v += step) {
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
        se.pts.forEach((v, i) => {
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
    if (!table.tHead || !table.tBodies[0]) return;
    const ths = [...table.tHead.rows[0].cells];
    const text = (r, i) => (r.cells[i] ? r.cells[i].textContent.trim() : "");
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
        const numeric = rows.every((r) => !text(r, i) || !isNaN(num(text(r, i))));
        rows.sort((a, b2) => {
          const x = text(a, i), y = text(b2, i);
          if (!x || !y) return !x && !y ? 0 : !x ? 1 : -1;
          const c = numeric ? num(x) - num(y) : x.localeCompare(y, lang, { numeric: true });
          return dir === "ascending" ? c : -c;
        });
        body.append(...rows);
      });
    });
  }

  function filter(input) {
    const target = document.querySelector(input.getAttribute("data-pots-filter"));
    if (!target) return;
    const items = () =>
      target.matches("table")
        ? [...target.tBodies[0].rows]
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
  function toc(nav) {
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
        nav.scrollTo({ left: a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2, behavior: "smooth" });
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
    if (table.parentElement.classList.contains("pots-scroll")) return;
    const box = el("div", "pots-scroll" + (table.classList.contains("pots-wide") ? " pots-wide" : ""));
    table.before(box);
    box.append(table);
  }

  function start() {
    document.querySelectorAll("table[data-pots-chart]").forEach(chart);
    document.querySelectorAll("table").forEach(scroller);
    document.querySelectorAll("table[data-pots-sort]").forEach(sortable);
    document.querySelectorAll("[data-pots-tabs]").forEach(tabs);
    document.querySelectorAll("input[data-pots-filter]").forEach(filter);
    document.querySelectorAll("nav.pots-toc").forEach(toc);
  }
  window.PotsUI = { num, tabs, chart, sortable, filter };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
