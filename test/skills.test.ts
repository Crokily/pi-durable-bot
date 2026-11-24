import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { piModule } from "../src/agent/models.ts";
import { botPaths } from "../src/bot/definition.ts";
import { folderSection, type PromptFacts, workSection } from "../src/bot/prompt.ts";

// The skills and the page kit that come with Pots: what each skill says about itself, that pi's loader finds them for
// every bot, from the source tree and from the package as npm packs it (Astra A12), and that the prompt points to them.
// Also the skill for pi users (pi-package/skills), which pi loads through the package's pi manifest.

const repo = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["desktop-page", "discord-channel", "pages", "slack-channel", "teams-channel", "telegram-channel"];
const PI_SKILLS = ["pots-setup"];
const work = realpathSync(mkdtempSync(join(tmpdir(), "pots-skills-")));

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** pi's rules for a skill name (the Agent Skills spec). */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// pi's own front matter parser, without the seconds that pi's whole entry takes to load.
const { parseFrontmatter } = (await import(piModule("./utils/frontmatter.js"))) as {
  parseFrontmatter(content: string): { frontmatter: Record<string, string> };
};

/** A skill's front matter as pi reads it. pi skips a skill whose YAML does not parse, such as a plain value with ": ". */
function frontMatter(file: string): Record<string, string> {
  return parseFrontmatter(readFileSync(file, "utf8")).frontmatter;
}

interface Loaded {
  skills: string;
  warnings: { message: string; warnings?: string }[];
}

/**
 * pi's skills section as a bot gets it, from the resources module at moduleUrl, once for each of the given pi folders
 * (PI_CODING_AGENT_DIR), in one process of its own, since loading pi takes seconds. Its home folder is empty, so the
 * skills of the computer that runs the test stay out.
 */
function loadSkills(moduleUrl: string, name: string, piDirs: string[]): Loaded[] {
  const home = join(work, name, "home");
  const workspace = join(work, name, "workspace");
  for (const dir of [home, workspace, ...piDirs]) mkdirSync(dir, { recursive: true });
  const script = [
    "const [moduleUrl, cwd, ...piDirs] = process.argv.slice(1);",
    "const { openResources } = await import(moduleUrl);",
    "const out = [];",
    "for (const pi of piDirs) {",
    "  process.env.PI_CODING_AGENT_DIR = pi;",
    "  const warnings = [];",
    "  const resources = await openResources(cwd, (message, data) => warnings.push({ message, ...data }));",
    '  out.push({ skills: resources.skills() ?? "", warnings });',
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, moduleUrl, workspace, ...piDirs], {
    cwd: workspace,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`loading the skills failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Loaded[];
}

/** The <location> of each skill in pi's skills section, by name. */
function locations(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of section.matchAll(/<name>([^<]+)<\/name>[\s\S]*?<location>([^<]+)<\/location>/g)) out[match[1]!] = match[2]!;
  return out;
}

/** A gzipped tar as npm pack writes it, unpacked into dest without its first folder ("package/"). */
function unpack(tarball: string, dest: string): void {
  const tar = gunzipSync(readFileSync(tarball));
  let longPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longPath = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    if (type !== "0" && type !== "") continue;
    const prefix = field(345, 155);
    const path = longPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longPath = undefined;
    const target = resolve(dest, path.split("/").slice(1).join("/"));
    if (relative(dest, target).startsWith("..")) throw new Error(`${path} leaves the package`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

describe("the skills that come with Pots", () => {
  it("each names its folder, says when to use it, and links only to files that exist", () => {
    expect(readdirSync(join(repo, "skills")).sort()).toEqual(SKILLS);
    expect(readdirSync(join(repo, "pi-package", "skills")).sort()).toEqual(PI_SKILLS);
    const files = [...SKILLS.map((name) => join(repo, "skills", name, "SKILL.md")), ...PI_SKILLS.map((name) => join(repo, "pi-package", "skills", name, "SKILL.md"))];
    for (const file of files) {
      const name = basename(dirname(file));
      const meta = frontMatter(file);
      expect(meta.name).toBe(name);
      expect(meta.name).toMatch(NAME);
      expect(meta.description!.length).toBeGreaterThan(80);
      expect(meta.description!.length).toBeLessThanOrEqual(1024);
      expect(meta.description).toMatch(/Use when/);
      const text = readFileSync(file, "utf8");
      for (const link of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = link[1]!;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        expect(existsSync(resolve(dirname(file), target)), `${name}: ${target}`).toBe(true);
      }
      expect(text).not.toContain("docs/channels");
      // An env file holds values as typed, so sourcing it would run a value's $(…); a skill reads one line instead.
      for (const line of text.split("\n")) expect(line, `${name} sources a file: ${line}`).not.toMatch(/(^|[\s;&|(`])(source|\.)\s+["']?[~$/\w.-]*(\.env|secrets)/);
    }
  });

  it("are found for every bot from the source tree, and a person's own skill of the same name is used instead", { timeout: 60_000 }, () => {
    const source = pathToFileURL(join(repo, "src", "agent", "resources.ts")).href;
    const ownPi = join(work, "source", "own-pi");
    const own = join(ownPi, "skills", "pages", "SKILL.md");
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, "---\nname: pages\ndescription: My own pages. Use when I say so.\n---\n\nMine.\n");
    const [plain, overridden] = loadSkills(source, "source", [join(work, "source", "pi"), ownPi]);

    const found = locations(plain!.skills);
    for (const name of SKILLS) expect(found[name]).toBe(join(repo, "skills", name, "SKILL.md"));
    expect(plain!.warnings).toEqual([]);

    const mine = locations(overridden!.skills);
    expect(mine.pages).toBe(own);
    expect(mine["slack-channel"]).toBe(join(repo, "skills", "slack-channel", "SKILL.md"));
    expect(overridden!.warnings.map((warning) => warning.message)).toEqual(["skill warnings"]);
    expect(overridden!.warnings[0]!.warnings).toContain('name "pages" collision');
  });

  it(
    "are in the package as npm packs it, with the kit, found from the installed package, and pots-setup is found by pi through the package manifest",
    () => {
      const packed = join(work, "packed");
      mkdirSync(packed);
      // The build that npm's prepare script runs before it packs, run here, which is twice as fast as npm doing it.
      const build = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: repo, encoding: "utf8" });
      if (build.status !== 0) throw new Error(`the build failed: ${build.stdout}${build.stderr}`);
      const windows = process.platform === "win32";
      const pack = spawnSync(windows ? "npm.cmd" : "npm", ["pack", "--ignore-scripts", "--pack-destination", windows ? `"${packed}"` : packed], {
        cwd: repo,
        encoding: "utf8",
        shell: windows,
      });
      if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
      const tarball = readdirSync(packed).find((file) => file.endsWith(".tgz"));
      expect(tarball).toBeDefined();

      // Installed as npm installs it, into node_modules of a folder of its own; its dependencies are this checkout's,
      // which keeps the test quick.
      const installed = join(work, "app", "node_modules", "pi-durable-bot");
      unpack(join(packed, tarball!), installed);
      symlinkSync(join(repo, "node_modules"), join(installed, "node_modules"), "junction");

      for (const name of SKILLS) expect(existsSync(join(installed, "skills", name, "SKILL.md")), name).toBe(true);
      expect(existsSync(join(installed, "skills", "slack-channel", "slack-app-manifest.yaml"))).toBe(true);
      expect(existsSync(join(installed, "skills", "pages", "shot.mjs"))).toBe(true);
      expect(readFileSync(join(installed, "kit", "pots.js"), "utf8")).toBe(readFileSync(join(repo, "kit", "pots.js"), "utf8"));
      expect(readFileSync(join(installed, "kit", "pots.css"), "utf8")).toBe(readFileSync(join(repo, "kit", "pots.css"), "utf8"));
      expect(readFileSync(join(installed, "kit", "pots-ui.js"), "utf8")).toBe(readFileSync(join(repo, "kit", "pots-ui.js"), "utf8"));
      // The desktop page's script, noVNC, and noVNC's license texts.
      for (const file of ["desktop.js", "desktop.css", "novnc.js", "novnc/LICENSE.txt", "novnc/LICENSE.MPL-2.0", "novnc/LICENSE.pako"]) {
        expect(readFileSync(join(installed, "kit", "desktop", file), "utf8"), file).toBe(readFileSync(join(repo, "kit", "desktop", file), "utf8"));
      }
      expect(existsSync(join(installed, "docs", "channels"))).toBe(false);

      // A pi user who installs the package as a pi package: pi reads it from its settings and finds pots-setup through
      // the package's pi manifest; a skill whose front matter does not parse would be a warning and missing here.
      const piUser = join(work, "installed", "pi-user");
      mkdirSync(piUser, { recursive: true });
      writeFileSync(join(piUser, "settings.json"), JSON.stringify({ packages: [installed] }));
      for (const name of PI_SKILLS) expect(existsSync(join(installed, "pi-package", "skills", name, "SKILL.md")), name).toBe(true);
      expect(existsSync(join(installed, "docs", "for-agents.md"))).toBe(true);

      const [loaded, asPiPackage] = loadSkills(pathToFileURL(join(installed, "dist", "agent", "resources.js")).href, "installed", [join(work, "installed", "pi"), piUser]);
      const found = locations(loaded!.skills);
      for (const name of SKILLS) expect(found[name]).toBe(join(installed, "skills", name, "SKILL.md"));
      expect(found["pots-setup"]).toBeUndefined();
      expect(loaded!.warnings).toEqual([]);

      const fromPackage = locations(asPiPackage!.skills);
      for (const name of PI_SKILLS) expect(fromPackage[name]).toBe(join(installed, "pi-package", "skills", name, "SKILL.md"));
      expect(asPiPackage!.warnings).toEqual([]);
    },
    120_000,
  );
});

describe("the pages skill", () => {
  const text = readFileSync(join(repo, "skills", "pages", "SKILL.md"), "utf8");
  const css = readFileSync(join(repo, "kit", "pots.css"), "utf8");
  const ui = readFileSync(join(repo, "kit", "pots-ui.js"), "utf8");
  const display = text.slice(text.indexOf("## Display pages"), text.indexOf("## Answer pages"));

  it("starts from the goal: get information across better than plain text, in a better form only when it fits", () => {
    const goal = display.indexOf("**The goal.**");
    expect(goal).toBeGreaterThan(0);
    expect(display.indexOf("**The text.**")).toBeGreaterThan(goal);
    expect(display).toContain("A display page exists to get information across better than plain text in a chat can.");
    expect(display).toContain("Never put in a chart, a card or a widget for show");
  });

  it("asks for Simplified Technical words in the reader's ubiquitous language", () => {
    expect(display).toContain(
      "Always write in ASD-STE100 Simplified Technical <the reader's language>, and use the reader's ubiquitous language.",
    );
  });

  it("pairs kinds of information with a form, and says how to write a component of its own", () => {
    for (const form of ["bar chart", "Parts of a whole", "line chart", "sorting and a search box", "A calendar", "Numbered steps", "A checklist", "A slider", "SVG", "Folded away"]) expect(display, form).toContain(form);
    expect(display).toContain("When a sentence says it faster, write the sentence.");
    expect(display).toContain("Write the full content in the HTML first, so the page reads well without your script");
    expect(display).toContain("Put the script in a file of the page");
    expect(display).toContain("On a computer, put text next to its chart");
  });

  it("has an example display page that loads the kit, keeps its script in a file and uses only what the kit has", () => {
    const html = /```html\r?\n([\s\S]*?)```/.exec(display)![1]!;
    const script = /```js\r?\n([\s\S]*?)```/.exec(display)![1]!;
    expect(html).toContain('<link rel="stylesheet" href="../../__pots/kit/pots.css">');
    expect(html).toContain('<script src="../../__pots/kit/pots-ui.js" defer></script>');
    expect(html).toContain('<script src="cost.js" defer></script>');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).not.toMatch(/<script>|<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=/);
    for (const name of new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1]!.split(" ")))) expect(css, name).toContain(`.${name}`);
    for (const attribute of new Set([...html.matchAll(/\b(data-pots-[a-z]+|data-tab|data-marks)=/g)].map((match) => match[1]!))) expect(ui, attribute).toContain(attribute);
    for (const id of [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]!)) expect(html, id).toContain(`id="${id}"`);
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
    expect(text).not.toMatch(/meal|Coly/i);
  });

  it("says how to take screenshots as a phone, as a computer and in dark mode, with its script that sets the width", () => {
    const check = text.slice(text.indexOf("### Look at it before you send it"), text.indexOf("## Answer pages"));
    // --window-size can not go below about 500 pixels, so a "phone" shot was a crop of a wider page.
    expect(check).not.toMatch(/^[^`]*--window-size=390/m);
    expect(check).toContain('shot.mjs "$url" 390 ');
    expect(check).toContain('shot.mjs "$url" 1440 ');
    expect(check).toMatch(/shot\.mjs "\$url" 390 \S+ dark/);
    expect(check).toContain("innerWidth");
    const script = readFileSync(join(repo, "skills", "pages", "shot.mjs"), "utf8");
    for (const part of ["--headless=new", "--user-data-dir=", "Emulation.setDeviceMetricsOverride", "prefers-color-scheme", "innerWidth"]) expect(script, part).toContain(part);
    expect(check).toContain("http://127.0.0.1:<pagePort>");
    expect(check).toContain("use `bash`");
  });

  it("names every kit file it tells to link, and each is in the kit", () => {
    const files = new Set([...text.matchAll(/__pots\/kit\/([\w.-]+\.(?:css|js))/g)].map((match) => match[1]!));
    expect([...files].sort()).toEqual(["pots-ui.js", "pots.css", "pots.js"]);
    for (const file of files) expect(existsSync(join(repo, "kit", file)), file).toBe(true);
  });
});

describe("the prompt", () => {
  const facts: PromptFacts = {
    id: "ada",
    name: "Ada",
    paths: botPaths(join(work, "bots", "ada")),
    botsDir: join(work, "bots"),
    pots: "pots",
    machine: { os: "Linux 6.8 (arm64)", hostname: "box", user: "ada", shell: "bash" },
    secretsDir: join(work, "secrets"),
    sharedMemory: join(work, "memory"),
  };

  it("points to the channel skills and the pages skill, not to docs", () => {
    const folder = folderSection(facts);
    expect(folder).toContain("slack-channel, discord-channel, telegram-channel, teams-channel");
    expect(folder).toContain("the pages skill");
    expect(folder).toContain("pots page secret");
    expect(folder).not.toMatch(/docs[\\/]|channels[\\/]/);
    expect(folderSection(facts, true)).not.toContain("pots page secret");
  });

  it("names a token file for this bot, says how to make another bot, and asks before an action that may cost money", () => {
    for (const folder of [folderSection(facts), folderSection(facts, true)]) {
      expect(folder).toContain("such as slack-ada.env");
      expect(folder).toContain('pots bot new <name> --about "<what it is for>"');
      expect(folder).toContain('pots chat --bot <its id> -m "<text>"');
      expect(folder).not.toContain("A new folder with a bot.json is a new bot");
    }
    expect(folderSection(facts)).toContain('"file": "<app>-ada.env"');
    expect(workSection(facts)).toContain("bots that share a screen wait for each other");
    expect(workSection(facts)).toContain("Your actions need no approval, with one exception: before an action, make sure whether it may cost money; if it may, get the person's OK on what it costs, then do it yourself.");
    expect(workSection(facts)).toContain("Looking something up, measuring or drafting needs no OK");
    expect(workSection(facts)).toContain("When you need them, ask once, first in your message, and go on with the rest.");
  });

  it("lists the page, desktop and form commands", () => {
    const work = workSection(facts);
    expect(work).toContain("pots page link <name> [--for <person address>]");
    expect(work).toContain("pots page unlink <link ID or URL> | list");
    expect(work).toContain("pots page secret --file <name>.env --keys A,B [--text <text>] [--for <person address>]");
    expect(work).toContain("pots page desktop --text <text> [--for <person address>] [--input password|code|text] [--area x,y,w,h] [--minutes 15]");
    expect(work).toContain("the desktop-page skill");
    expect(work).toContain("pots form add <name> <JSON, or -> | remove <name> | list");
  });
});
