import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

// Where pages live and which files a link may serve: only regular files inside the link's own page folder, after the
// real path is resolved. No "..", no encoded separators, no symbolic link, junction or hard link that leads out.

/** A page name: "deploy-plan", or "keep/annual-report" for a page that is never deleted by age. */
const NAME = /^(?:keep\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function pageNameProblem(name: string): string | undefined {
  if (!NAME.test(name) || name === "keep") return `bad page name ${JSON.stringify(name)}: use a folder name in pages/ (letters, digits, "-" and "_"), or keep/<name>`;
  return undefined;
}

/** The bot's pages folder. */
export const pagesDir = (botDir: string) => join(botDir, "pages");

/**
 * True when path is inside root, or is root itself when allowRoot. Both are canonical paths from the file system
 * (realpath, which is the native one), compared exactly: never by case, since a case-sensitive file system, which macOS
 * and Windows can have too, holds pages/Report and pages/report side by side.
 */
export function inside(root: string, path: string, allowRoot = false): boolean {
  if (path === root) return allowRoot;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * A folder's or file's identity on the file system, which a folder of the same name made later does not share: its
 * device and inode, and its birth time, since a file system can give a freed inode to the next folder it makes.
 */
export async function identity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

/**
 * The real path of a page's folder, when it is a plain folder in the bot's pages/ folder: no symbolic link or junction
 * on the way from the bot folder (pages/, keep/ and the page's own folder). Undefined otherwise.
 */
export async function pageFolder(botDir: string, name: string): Promise<string | undefined> {
  if (pageNameProblem(name)) return undefined;
  try {
    const base = await realpath(botDir);
    const expected = join(base, "pages", ...name.split("/"));
    const folder = await realpath(join(botDir, "pages", ...name.split("/")));
    if (folder !== expected) return undefined;
    // realpath already followed any link; lstat says whether the parts themselves are links.
    let path = join(base, "pages");
    for (const part of ["", ...name.split("/")]) {
      if (part) path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    }
    return folder;
  } catch {
    return undefined;
  }
}

/** Windows names that open a device, not a file, also with an extension: CON, NUL, COM1.txt. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * The path segments of a URL path below a page or the kit, decoded, or undefined when the path must be refused: an
 * encoded "/" or "\", a backslash, "." or "..", a NUL, an empty segment in the middle, bad percent-encoding, and on
 * Windows a ":" (drive letters and alternate streams), a device name or a name that ends with a dot or a space (Windows
 * drops those, so the name would stand for another one).
 */
export function pathSegments(raw: string): string[] | undefined {
  if (raw === "") return [];
  if (/%(?:2f|5c|00)/i.test(raw) || raw.includes("\\")) return undefined;
  const parts = raw.split("/");
  const segments: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === "") {
      // Only at the end: "dir/" is the folder's index.html.
      if (index === parts.length - 1) break;
      return undefined;
    }
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (segment === "." || segment === ".." || /[\\/\0]/.test(segment)) return undefined;
    if (process.platform === "win32" && (segment.includes(":") || WINDOWS_DEVICE.test(segment) || /[. ]$/.test(segment))) return undefined;
    segments.push(segment);
  }
  return segments;
}

export type Resolved =
  /** An open file: stream it from handle, which the caller closes. */
  | { kind: "file"; path: string; handle: FileHandle; size: number; mtimeMs: number }
  /** A folder asked for without the closing "/": the browser must come back with it, or relative links break. */
  | { kind: "folder" };

/** For tests: runs after a file was found and checked, before it is opened, so a test can swap it for a link. */
export const fileTestHooks: { beforeOpen?: (path: string) => Promise<void> | void } = {};

/**
 * Open the file that segments name inside root (a canonical path), when it is a regular file that stays in root. A
 * folder gives its index.html when trailingSlash. The file is opened once, without following a link in its last part
 * where the system can (O_NOFOLLOW), and then the open descriptor is checked: a regular file, with one name only when
 * refuseHardLinks (a second name may be a file outside the folder), and the same file (device and inode) that its path
 * still leads to, inside root. So a file or a folder above it swapped for a link between the first look and the open is
 * refused, and what is sent is read from that descriptor, never from the path again.
 */
export async function openFile(root: string, segments: readonly string[], trailingSlash: boolean, refuseHardLinks: boolean): Promise<Resolved | undefined> {
  let path: string;
  try {
    path = await realpath(join(root, ...segments));
    if (!inside(root, path, true)) return undefined;
    const info = await stat(path);
    if (info.isDirectory()) {
      if (!trailingSlash && segments.length > 0) return { kind: "folder" };
      path = await realpath(join(path, "index.html"));
      if (!inside(root, path)) return undefined;
    } else if (trailingSlash) return undefined;
    await fileTestHooks.beforeOpen?.(path);
  } catch {
    return undefined;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || (refuseHardLinks && opened.nlink > 1n)) throw new Error("not a plain file");
    const again = await realpath(path);
    if (!inside(root, again)) throw new Error("left the folder");
    const there = await stat(again, { bigint: true });
    if (there.dev !== opened.dev || there.ino !== opened.ino) throw new Error("another file");
    return { kind: "file", path: again, handle, size: Number(opened.size), mtimeMs: Number(opened.mtimeMs) };
  } catch {
    await handle.close().catch(() => {});
    return undefined;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** At most this many entries count for a page's version; a larger page changes version only within them. */
const VERSION_ENTRIES = 5_000;

/**
 * A short string that changes whenever a file of the folder changes, comes or goes: from each entry's path, size,
 * modification and change time. Symbolic links count by where they point. Undefined when the folder is not there.
 */
export async function folderVersion(folder: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++count > VERSION_ENTRIES) return;
      const path = join(dir, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      hash.update(`${relative(folder, path)}\0${info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : "f"}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\n`);
      if (info.isDirectory()) await walk(path);
    }
  };
  try {
    await walk(folder);
  } catch {
    return undefined;
  }
  return hash.digest("hex").slice(0, 16);
}

/** The page folders of a bot: the folders in pages/ but keep/, and those in pages/keep/. Links are left out. */
export async function listPageNames(botDir: string): Promise<string[]> {
  const names: string[] = [];
  const folders = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
  for (const name of await folders(pagesDir(botDir))) {
    if (name === "keep") {
      for (const kept of await folders(join(pagesDir(botDir), "keep"))) if (!pageNameProblem(`keep/${kept}`)) names.push(`keep/${kept}`);
    } else if (!pageNameProblem(name)) names.push(name);
  }
  return names.sort();
}
