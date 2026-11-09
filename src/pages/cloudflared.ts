import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";

// cloudflared, the program that makes a Cloudflare Quick Tunnel: one already on this computer, or the official release
// for this OS and processor, pinned to one version, checked against its published SHA-256 and only then put in place.

export const CLOUDFLARED_VERSION = "2026.10.7";

interface Asset {
  /** The release asset's file name. */
  readonly name: string;
  /** SHA-256 of the program, as the release notes publish it. For a .tgz, that is the program inside it. */
  readonly sha256: string;
  /** For a .tgz: SHA-256 of the archive itself, as GitHub lists the asset's digest. Checked before it is opened. */
  readonly archiveSha256?: string;
}

/** By `${process.platform}-${process.arch}`. Windows on ARM runs the x64 build. */
const ASSETS: Record<string, Asset> = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12",
    archiveSha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd",
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86",
    archiveSha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848",
  },
  "linux-x64": { name: "cloudflared-linux-amd64", sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872" },
  "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775" },
  "linux-arm": { name: "cloudflared-linux-arm", sha256: "74f690f6707182839b63e0465726c7776dd63f0a174390b911d5d71f35cab94e" },
  "linux-ia32": { name: "cloudflared-linux-386", sha256: "4823d2f038395617e04e4070601ab45c0c43f31f15ee7586be299e19ef49d46e" },
  "win32-x64": { name: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343" },
  "win32-arm64": { name: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343" },
  "win32-ia32": { name: "cloudflared-windows-386.exe", sha256: "88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082" },
};

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/download";
/** A download that takes longer than this is stopped. */
const DOWNLOAD_MS = 5 * 60_000;

const programName = (platform: NodeJS.Platform) => (platform === "win32" ? "cloudflared.exe" : "cloudflared");

/** cloudflared in binDir (Pots's own copy), then on PATH; undefined when there is none. */
export function findCloudflared(binDir: string, platform = process.platform, path = process.env.PATH ?? ""): string | undefined {
  const name = programName(platform);
  for (const dir of [binDir, ...path.split(delimiter).filter(Boolean)]) {
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

export interface DownloadOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Where the release assets are; tests point it at a server of their own. */
  readonly releases?: string;
  /** Pinned assets by platform-arch; tests give their own. */
  readonly assets?: Record<string, Asset>;
  readonly print?: (message: string, data?: Record<string, unknown>) => void;
  /** PATH to look in first; tests give their own. */
  readonly path?: string;
}

/** One download at a time per folder, in this process: the gateway is the only one that downloads. */
const downloading = new Map<string, Promise<string>>();

/** cloudflared on this computer, or downloaded into binDir. */
export function ensureCloudflared(binDir: string, options: DownloadOptions = {}): Promise<string> {
  const found = findCloudflared(binDir, options.platform, options.path);
  if (found) return Promise.resolve(found);
  const running = downloading.get(binDir);
  if (running) return running;
  const download = downloadCloudflared(binDir, options).finally(() => downloading.delete(binDir));
  downloading.set(binDir, download);
  return download;
}

/**
 * Download the pinned release for this OS and processor into binDir: to a temporary file, checked against its SHA-256,
 * made executable, and only then renamed to its place, so an interrupted download never leaves a program that does not
 * work. A .tgz (macOS) is opened here, in memory, after the archive's own SHA-256 was checked.
 */
export async function downloadCloudflared(binDir: string, options: DownloadOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = (options.assets ?? ASSETS)[`${platform}-${arch}`];
  if (!asset) throw new Error(`there is no cloudflared release for ${platform}-${arch}; install cloudflared yourself and put it on PATH`);
  await mkdir(binDir, { recursive: true });
  // What an earlier download left when it was cut off.
  for (const name of await readdir(binDir)) if (/^cloudflared\.[0-9a-f]+\.(?:download|part)$/.test(name)) await rm(join(binDir, name), { force: true });

  const url = `${options.releases ?? RELEASES}/${CLOUDFLARED_VERSION}/${asset.name}`;
  const id = randomBytes(6).toString("hex");
  const download = join(binDir, `cloudflared.${id}.download`);
  const part = join(binDir, `cloudflared.${id}.part`);
  const target = join(binDir, programName(platform));
  options.print?.("downloading cloudflared", { version: CLOUDFLARED_VERSION, asset: asset.name });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), hashing, createWriteStream(download, { mode: 0o600 }));
    const digest = hash.digest("hex");
    if (asset.name.endsWith(".tgz")) {
      if (digest !== asset.archiveSha256) throw new Error(`${asset.name} does not match its SHA-256 (got ${digest})`);
      const program = untar(gunzipSync(await readFile(download)), "cloudflared");
      if (!program) throw new Error(`${asset.name} has no cloudflared in it`);
      const inner = createHash("sha256").update(program).digest("hex");
      if (inner !== asset.sha256) throw new Error(`cloudflared in ${asset.name} does not match its SHA-256 (got ${inner})`);
      await writeFile(part, program, { mode: 0o755 });
      await rm(download, { force: true });
    } else {
      if (digest !== asset.sha256) throw new Error(`${asset.name} does not match its SHA-256 (got ${digest})`);
      await rename(download, part);
    }
    await chmod(part, 0o755);
    await rename(part, target);
  } catch (error) {
    await rm(download, { force: true });
    await rm(part, { force: true });
    throw new Error(`could not download cloudflared ${CLOUDFLARED_VERSION} from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  options.print?.("cloudflared downloaded", { path: target });
  return target;
}

/**
 * The contents of the regular file whose last path part is name, from a tar archive (ustar, with pax or GNU long-name
 * entries skipped). Only read, never written anywhere by its own path.
 */
export function untar(archive: Buffer, name: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const start = offset + 512;
    if ((type === "0" || type === "") && path.split("/").pop() === name) return archive.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}
