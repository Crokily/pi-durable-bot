import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Chrome, chromePath, kitPage, startChrome } from "./support/chrome.ts";

// The page kit's moving parts (kit/pots-ui.js) and its layout (kit/pots.css) in headless Chrome, and the pages skill's
// screenshot script. Skipped where no Chrome or Chromium is installed.

const path = chromePath();

describe.skipIf(!path)("the page helper in a browser", () => {
  let chrome: Chrome;
  beforeAll(async () => {
    chrome = await startChrome(path!);
  }, 30_000);
  afterAll(async () => {
    await chrome?.stop();
  });

  it("draws a line chart whose values are huge and equal, with a few ticks", async () => {
    const page = await chrome.open(kitPage(""));
    try {
      // 1e16 + 1 is 1e16: a tick step of 1 never moved on.
      const ticks = await page.eval<number>(
        `const t = document.createElement("table");
         t.setAttribute("data-pots-chart", "line");
         t.innerHTML = "<thead><tr><th>Day</th><th>V</th></tr></thead><tbody><tr><td>a</td><td>10000000000000000</td></tr><tr><td>b</td><td>10000000000000000</td></tr></tbody>";
         document.querySelector("main").append(t);
         PotsUI.chart(t);
         document.querySelectorAll(".pots-linebox line").length`,
        2000,
      );
      expect(ticks).toBeGreaterThan(0);
      expect(ticks).toBeLessThanOrEqual(12);
    } finally {
      await page.close();
    }
  });

  it("draws a line chart of 50,000 rows and three series, with a bounded number of points", { timeout: 20_000 }, async () => {
    const page = await chrome.open(kitPage(""));
    try {
      const drawn = await page.eval<{ paths: number; points: number }>(
        `const t = document.createElement("table");
         t.setAttribute("data-pots-chart", "line");
         const rows = [];
         // Values from 0 to 99, and one spike of 1000 in the middle.
         for (let i = 0; i < 50000; i++) rows.push("<tr><td>" + i + "</td><td>" + (i === 25000 ? 1000 : i % 100) + "</td><td>" + (i % 37) + "</td><td>" + (i % 51) + "</td></tr>");
         t.innerHTML = "<thead><tr><th>x</th><th>a</th><th>b</th><th>c</th></tr></thead><tbody>" + rows.join("") + "</tbody>";
         document.querySelector("main").append(t);
         PotsUI.chart(t);
         const paths = [...document.querySelectorAll(".pots-linebox path")];
         ({ paths: paths.length, points: Math.max(...paths.map((p) => p.getAttribute("d").split(/[ML]/).length - 1)) })`,
        10_000,
      );
      expect(drawn.paths).toBe(3);
      expect(drawn.points).toBeLessThanOrEqual(2000);
      // A spike in the middle stays.
      const top = await page.eval<number>(`Math.min(...[...document.querySelector(".pots-linebox path").getAttribute("d").matchAll(/[ML][\\d.]+ ([\\d.]+)/g)].map((m) => +m[1]))`);
      expect(top).toBeLessThan(20);
    } finally {
      await page.close();
    }
  });

  it("sorts a column of text as text, a column of numbers as numbers, and takes data-value first", async () => {
    const page = await chrome.open(
      kitPage(`<table data-pots-sort id="t"><thead><tr><th>Name</th><th>Size</th><th>Price</th><th>Cost</th></tr></thead><tbody>
        <tr><td>Zebra 1</td><td data-value="2">medium</td><td>−12</td><td>€1,50</td></tr>
        <tr><td>Apple 2</td><td data-value="3">large</td><td>5</td><td>€10</td></tr>
        <tr><td>Bear 3</td><td data-value="1">small</td><td>-3</td><td>€2</td></tr></tbody></table>`),
    );
    try {
      const column = async (i: number) => {
        await page.eval(`document.querySelectorAll("#t th button")[${i}].click()`);
        return page.eval<string[]>(`[...document.querySelectorAll("#t tbody tr")].map((r) => r.cells[0].textContent)`);
      };
      expect(await column(0)).toEqual(["Apple 2", "Bear 3", "Zebra 1"]);
      expect(await column(1)).toEqual(["Bear 3", "Zebra 1", "Apple 2"]);
      // −12 is negative.
      expect(await column(2)).toEqual(["Zebra 1", "Bear 3", "Apple 2"]);
      // On an English page "€1,50" is not a number (it was 150), so the column sorts as text: "€1,50", "€2", "€10".
      expect(await column(3)).toEqual(["Zebra 1", "Bear 3", "Apple 2"]);
    } finally {
      await page.close();
    }
  });

  it("reads numbers with the page's decimal comma", async () => {
    const page = await chrome.open(
      kitPage(
        `<table data-pots-chart="bar" data-max="2000"><thead><tr><th>Ort</th><th>Kosten</th></tr></thead><tbody>
          <tr><td>A</td><td>€1.234,56</td></tr><tr><td>B</td><td>€1,50</td></tr><tr><td>C</td><td data-value="500">fünfhundert</td></tr></tbody></table>`,
        { lang: "de" },
      ),
    );
    try {
      const widths = await page.eval<string[]>(`[...document.querySelectorAll(".pots-fill")].map((f) => f.style.getPropertyValue("--v"))`);
      expect(widths).toEqual([`${((1234.56 / 2000) * 100).toFixed(2)}%`, "0.07%", "25.00%"]);
    } finally {
      await page.close();
    }
  });

  it("opens the tab with an empty required field when the form is sent, and focuses the field", async () => {
    const page = await chrome.open(
      kitPage(`<form id="f"><div data-pots-tabs>
        <section data-tab="One"><input name="a" value="x"></section>
        <section data-tab="Two"><input name="b" id="b" required></section>
      </div><button>Send</button></form>`),
    );
    try {
      const after = await page.eval<{ hidden: boolean; focused: string; sent: boolean }>(
        `let sent = false;
         document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); sent = true; });
         document.querySelector("#f > button").click();
         ({ hidden: document.getElementById("b").closest("section").classList.contains("pots-off"), focused: document.activeElement.id, sent })`,
      );
      expect(after).toEqual({ hidden: false, focused: "b", sent: false });
    } finally {
      await page.close();
    }
  });

  it("does each part once, when the helper is loaded twice or a part is called again", async () => {
    const page = await chrome.open(
      kitPage(
        `<table data-pots-chart="bar" id="c"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table>
         <div data-pots-tabs id="tabs"><section data-tab="One">1</section><section data-tab="Two">2</section></div>
         <table data-pots-sort id="t"><thead><tr><th>N</th></tr></thead><tbody><tr><td>2</td></tr><tr><td>1</td></tr><tr><td>3</td></tr></tbody></table>`,
        { scripts: 2 },
      ),
    );
    try {
      const seen = await page.eval<{ charts: number; tabbars: number; buttons: number; order: string[] }>(
        `PotsUI.chart(document.getElementById("c"));
         PotsUI.tabs(document.getElementById("tabs"));
         PotsUI.sortable(document.getElementById("t"));
         document.querySelector("#t th button").click();
         ({ charts: document.querySelectorAll(".pots-chart").length, tabbars: document.querySelectorAll(".pots-tabbar").length,
            buttons: document.querySelectorAll("#t th button").length, order: [...document.querySelectorAll("#t td")].map((d) => d.textContent) })`,
      );
      expect(seen).toEqual({ charts: 1, tabbars: 1, buttons: 1, order: ["1", "2", "3"] });
    } finally {
      await page.close();
    }
  });

  it("keeps going past a chart with an empty head and a filter with a bad selector", async () => {
    const page = await chrome.open(
      kitPage(`<table data-pots-chart="line" id="c"><thead></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>
        <input data-pots-filter="#">
        <div data-pots-tabs><section data-tab="One">1</section><section data-tab="Two">2</section></div>
        <table data-pots-sort><thead><tr><th>N</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`),
    );
    try {
      const seen = await page.eval<{ chart: boolean; tabs: number; sort: number }>(
        `({ chart: !!document.querySelector(".pots-chart svg"), tabs: document.querySelectorAll(".pots-tabbar").length, sort: document.querySelectorAll(".pots-sort").length })`,
      );
      expect(seen).toEqual({ chart: true, tabs: 1, sort: 1 });
    } finally {
      await page.close();
    }
  });

  it("leaves a chart's table as it was when the chart fails", async () => {
    const page = await chrome.open(kitPage(""));
    try {
      const seen = await page.eval<{ figures: number; parent: string }>(
        `const t = document.createElement("table");
         t.setAttribute("data-pots-chart", "bar");
         t.innerHTML = "<tbody><tr><td>a</td><td>1</td></tr></tbody>";
         document.querySelector("main").append(t);
         // A page script broke something the chart needs.
         t.setAttribute("data-marks", "1 a");
         const keep = String.prototype.split;
         String.prototype.split = () => { throw new Error("broken"); };
         try { PotsUI.chart(t); } catch {} finally { String.prototype.split = keep; }
         ({ figures: document.querySelectorAll("figure").length, parent: t.parentElement.tagName })`,
      );
      expect(seen).toEqual({ figures: 0, parent: "MAIN" });
    } finally {
      await page.close();
    }
  });

  it("names each tab panel by its tab, lets the keyboard reach a text panel, and follows the reading direction", async () => {
    const page = await chrome.open(
      kitPage(`<div data-pots-tabs><section data-tab="One">first</section><section data-tab="Two">second</section><section data-tab="Three"><a href="#">link</a></section></div>`, { dir: "rtl" }),
    );
    try {
      const a11y = await page.eval<{ named: boolean[]; tabindex: (string | null)[] }>(
        `const panels = [...document.querySelectorAll("[role=tabpanel]")];
         ({ named: panels.map((p) => document.getElementById(p.getAttribute("aria-labelledby"))?.getAttribute("aria-controls") === p.id),
            tabindex: panels.map((p) => p.getAttribute("tabindex")) })`,
      );
      expect(a11y).toEqual({ named: [true, true, true], tabindex: ["0", "0", null] });
      await page.eval(`document.querySelector("[role=tab]").focus()`);
      // Right to left, the next tab is on the left.
      await page.key("ArrowLeft", "ArrowLeft", 37);
      expect(await page.eval(`document.activeElement.textContent`)).toBe("Two");
      await page.key("ArrowRight", "ArrowRight", 39);
      expect(await page.eval(`document.activeElement.textContent`)).toBe("One");
    } finally {
      await page.close();
    }
  });

  it("moves the contents row without animation when the reader asks for reduced motion", async () => {
    const sections = Array.from({ length: 10 }, (_, i) => `<h2 id="s${i}">Section number ${i}</h2><p style="height:600px">text</p>`).join("");
    const links = Array.from({ length: 10 }, (_, i) => `<a href="#s${i}">Section number ${i}</a>`).join(" ");
    const page = await chrome.open(kitPage(`<nav class="pots-toc">${links}</nav>${sections}`), {
      width: 390,
      media: { "prefers-reduced-motion": "reduce" },
      before: `window.__behaviors = []; const keep = Element.prototype.scrollTo;
        Element.prototype.scrollTo = function (o) { window.__behaviors.push(o && o.behavior); return keep.apply(this, arguments); };`,
    });
    try {
      const behaviors = await page.eval<string[]>(
        `document.getElementById("s7").scrollIntoView();
         new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__behaviors))))`,
      );
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).not.toContain("smooth");
    } finally {
      await page.close();
    }
  });

  it("keeps a reference line's name on a phone's screen at the end of the scale", async () => {
    const page = await chrome.open(
      kitPage(`<table data-pots-chart="bar" data-marks="100 Budget; 50 Half; 0 Start"><thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>x</td><td>60</td></tr><tr><td>y</td><td>90</td></tr></tbody></table>`),
      { width: 390 },
    );
    try {
      const seen = await page.eval<{ scroll: number; inner: number; track: DOMRect; names: DOMRect[]; lines: DOMRect[] }>(
        `const text = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().toJSON(); };
         ({ scroll: document.documentElement.scrollWidth, inner: innerWidth,
            track: document.querySelector(".pots-marks .pots-track").getBoundingClientRect().toJSON(),
            names: [...document.querySelectorAll(".pots-marks .pots-track > span")].map(text),
            lines: [...document.querySelectorAll("li:not(.pots-marks) .pots-mark")].slice(0, 3).map((m) => m.getBoundingClientRect().toJSON()) })`,
      );
      expect(seen.scroll).toBe(seen.inner);
      const [end, middle, start] = seen.names;
      // At the ends, inside the bar; in the middle, centred over its line.
      expect(end!.right).toBeLessThanOrEqual(seen.track.right + 0.5);
      expect(start!.left).toBeGreaterThanOrEqual(seen.track.left - 0.5);
      expect(Math.abs((middle!.left + middle!.right) / 2 - seen.lines[1]!.left)).toBeLessThan(2);
    } finally {
      await page.close();
    }
  });

  it("lays phone tabs in columns out in one column while the tabs show", async () => {
    const page = await chrome.open(
      kitPage(`<div class="pots-cols pots-wide" data-pots-tabs="phone">
        <section data-tab="Thu"><h3>Thursday</h3><p>Flights arrive</p></section>
        <section data-tab="Fri"><h3>Friday</h3><p>Planning</p></section></div>`),
      { width: 700 },
    );
    try {
      const seen = await page.eval<{ bar: number; panel: number; tabsShown: boolean }>(
        `const bar = document.querySelector(".pots-tabbar"), panel = document.querySelector("[role=tabpanel]:not(.pots-off)");
         ({ bar: bar.getBoundingClientRect().left, panel: panel.getBoundingClientRect().left, tabsShown: getComputedStyle(bar).display !== "none" })`,
      );
      expect(seen.tabsShown).toBe(true);
      expect(seen.panel).toBe(seen.bar);
    } finally {
      await page.close();
    }
  });
});

describe.skipIf(!path)("the pages skill's screenshot script", () => {
  let chrome: Chrome;
  const out = mkdtempSync(join(tmpdir(), "pots-shot-"));
  beforeAll(async () => {
    chrome = await startChrome(path!);
  }, 30_000);
  afterAll(async () => {
    await chrome?.stop();
    rmSync(out, { recursive: true, force: true });
  });

  it("takes a phone-width page at that width, not a crop of a wider one", async () => {
    const url = chrome.serve(kitPage(`<p id="w">width</p><script>document.getElementById("w").textContent = innerWidth;</script>`));
    const png = join(out, "phone.png");
    // Not spawnSync: the page comes from this process.
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [fileURLToPath(new URL("../skills/pages/shot.mjs", import.meta.url)), url, "390", png, "dark"], { env: { ...process.env, CHROME: path }, timeout: 30_000 }, (error, out, err) =>
        error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out),
      ),
    );
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ width: 390, innerWidth: 390, scrollsSideways: false, errors: [] });
    // The PNG's width, from its header.
    expect(readFileSync(png).readUInt32BE(16)).toBe(390);
  }, 40_000);

  it("takes a page taller than 16000px in parts that cover all of it", async () => {
    const url = chrome.serve(kitPage(`<div style="height: 26600px"></div>`));
    const png = join(out, "long.png");
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [fileURLToPath(new URL("../skills/pages/shot.mjs", import.meta.url)), url, "390", png], { env: { ...process.env, CHROME: path }, timeout: 30_000 }, (error, out, err) =>
        error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out),
      ),
    );
    const report = JSON.parse(stdout);
    expect(report.files).toEqual([png, join(out, "long-2.png")]);
    // The heights, from the PNG headers, add up to the page's.
    const heights = report.files.map((f: string) => readFileSync(f).readUInt32BE(20));
    expect(heights[0]).toBe(16000);
    expect(heights[0] + heights[1]).toBe(report.height);
  }, 40_000);
});
