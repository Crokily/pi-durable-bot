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
const SKILLS = ["discord-channel", "pages", "slack-channel", "telegram-channel"];
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
      expect(readFileSync(join(installed, "kit", "pots.js"), "utf8")).toBe(readFileSync(join(repo, "kit", "pots.js"), "utf8"));
      expect(readFileSync(join(installed, "kit", "pots.css"), "utf8")).toBe(readFileSync(join(repo, "kit", "pots.css"), "utf8"));
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

describe("the prompt", () => {
  const facts: PromptFacts = {
    id: "ada",
    name: "Ada",
    paths: botPaths(join(work, "bots", "ada")),
    botsDir: join(work, "bots"),
    pots: "pots",
    machine: { os: "Linux 6.8 (arm64)", hostname: "box", user: "ada", shell: "bash" },
    secretsDir: join(work, "secrets"),
    fallbackWakeMinutes: 120,
    sharedMemory: join(work, "memory"),
  };

  it("points to the channel skills and the pages skill, not to docs", () => {
    const folder = folderSection(facts);
    expect(folder).toContain("slack-channel, discord-channel, telegram-channel");
    expect(folder).toContain("the pages skill");
    expect(folder).toContain("pots page secret");
    expect(folder).not.toMatch(/docs[\\/]|channels[\\/]/);
    expect(folderSection(facts, true)).not.toContain("pots page secret");
  });

  it("names a token file for this bot, and says how to make another bot", () => {
    for (const folder of [folderSection(facts), folderSection(facts, true)]) {
      expect(folder).toContain("such as slack-ada.env");
      expect(folder).toContain('pots bot new <name> --about "<what it is for>"');
      expect(folder).toContain('pots chat --bot <its id> -m "<text>"');
      expect(folder).not.toContain("A new folder with a bot.json is a new bot");
    }
    expect(folderSection(facts)).toContain('"file": "<app>-ada.env"');
    expect(workSection(facts)).toContain("bots that share a screen wait for each other");
  });

  it("lists the page and form commands", () => {
    const work = workSection(facts);
    expect(work).toContain("pots page link <name> [--for <person address>]");
    expect(work).toContain("pots page unlink <link ID or URL> | list");
    expect(work).toContain("pots page secret --file <name>.env --keys A,B [--text <text>] [--for <person address>]");
    expect(work).toContain("pots form add <name> <JSON, or -> | remove <name> | list");
  });
});
