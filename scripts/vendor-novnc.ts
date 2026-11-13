// Builds kit/desktop/novnc.js, the noVNC client that the desktop page loads, from noVNC's release on npm, and copies its
// license files next to it. Run it again only to move to another noVNC version:
//
//   node scripts/vendor-novnc.ts
//
// The release is checked against its pinned SHA-512 before it is opened. Each source file's license notice is kept: its
// first comment, and every comment that names a copyright or a license, are marked as legal comments (/*!), which
// esbuild keeps where they are. The bundle is not minified, so it stays readable as the source it is made of.
// esbuild is run with npx at a pinned version; it is not a dependency of Pots.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.7.0";
const TARBALL = `https://registry.npmjs.org/@novnc/novnc/-/novnc-${VERSION}.tgz`;
/** dist.integrity of @novnc/novnc@1.7.0 on the npm registry. */
const INTEGRITY = "sha512-ucEJOx4T2avIRCleodk7YobZj5O2Ga2AeLfQ69A/yjG9HHba2+PDgwSkN3FttrmG+70ZGx21sElNFouK13RzyA==";
const ESBUILD = "esbuild@0.28.2";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "kit", "desktop");
const work = mkdtempSync(join(tmpdir(), "pots-novnc-"));

try {
  const response = await fetch(TARBALL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${TARBALL}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const digest = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (digest !== INTEGRITY) throw new Error(`${TARBALL} does not match its pinned SHA-512 (got ${digest})`);
  writeFileSync(join(work, "novnc.tgz"), tarball);
  run("tar", ["-xzf", "novnc.tgz"], work);
  const source = join(work, "package");

  // Keep every license notice: the first comment of a file, and each block comment about a copyright or a license.
  for (const file of walk(source).filter((path) => path.endsWith(".js"))) {
    const text = readFileSync(file, "utf8");
    let first = true;
    const kept = text.replace(/\/\*(?!!)([\s\S]*?)\*\//g, (comment: string, body: string, at: number) => {
      const header = first && text.slice(0, at).trim() === "";
      first = false;
      return header || /copyright|licen[cs]e|permission/i.test(body) ? `/*!${body}*/` : comment;
    });
    writeFileSync(file, kept);
  }

  writeFileSync(
    join(source, "pots-entry.js"),
    [
      'export { default as RFB } from "./core/rfb.js";',
      'export { default as KeyTable } from "./core/input/keysym.js";',
      'export { default as keysyms } from "./core/input/keysymdef.js";',
      "",
    ].join("\n"),
  );
  const banner = [
    "/*!",
    ` * noVNC ${VERSION} (https://github.com/novnc/noVNC/tree/v${VERSION}), joined into one file for Pots' desktop page by`,
    " * scripts/vendor-novnc.ts with esbuild, which prints the code again without changing what it does and leaves out the",
    " * comments that are not license notices. noVNC is licensed under the MPL 2.0, and the pako files in it under the MIT",
    " * license; the license texts and noVNC's AUTHORS are in the novnc/ folder next to this file. The source of this",
    ` * version: ${TARBALL}`,
    " */",
  ].join("\n");
  mkdirSync(out, { recursive: true });
  run(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "--yes",
      ESBUILD,
      "pots-entry.js",
      "--bundle",
      "--format=esm",
      "--target=es2022",
      "--legal-comments=inline",
      "--charset=utf8",
      `--banner:js=${banner}`,
      `--outfile=${join(out, "novnc.js")}`,
    ],
    source,
  );

  const licenses = join(out, "novnc");
  rmSync(licenses, { recursive: true, force: true });
  mkdirSync(licenses);
  for (const [from, to] of [
    ["LICENSE.txt", "LICENSE.txt"],
    ["AUTHORS", "AUTHORS"],
    ["docs/LICENSE.MPL-2.0", "LICENSE.MPL-2.0"],
    ["docs/LICENSE.BSD-2-Clause", "LICENSE.BSD-2-Clause"],
    ["docs/LICENSE.BSD-3-Clause", "LICENSE.BSD-3-Clause"],
    ["docs/LICENSE.OFL-1.1", "LICENSE.OFL-1.1"],
    ["vendor/pako/LICENSE", "LICENSE.pako"],
  ] as const) {
    copyFileSync(join(source, from), join(licenses, to));
  }
  const size = statSync(join(out, "novnc.js")).size;
  console.log(`wrote ${relative(repo, join(out, "novnc.js"))} (${Math.round(size / 1024)} KB) and ${relative(repo, licenses)}/`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}
