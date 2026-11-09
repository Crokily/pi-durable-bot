import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { POTS_HOME } from "../core/home.ts";

// POTS_HOME/settings.json: what every bot of this POTS_HOME shares. Today the page server's port and public address.

/** ~/.pots/settings.json. */
export const SETTINGS_FILE = join(POTS_HOME, "settings.json");

export interface HostSettings {
  /** The address people open page links at, such as a Tailscale Funnel or a domain. Unset: a Cloudflare Quick Tunnel. */
  publicUrl?: string;
  /** The page server's port on 127.0.0.1, chosen once and kept. */
  pagePort?: number;
}

/** Read settings.json; a missing file is no settings. Throws with a message a person can act on when it is not valid. */
export function readSettings(file = SETTINGS_FILE): HostSettings {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} must hold a JSON object`);
  const settings = value as Record<string, unknown>;
  const result: HostSettings = {};
  if (settings.publicUrl !== undefined && settings.publicUrl !== null && settings.publicUrl !== "") {
    result.publicUrl = publicUrl(settings.publicUrl, file);
  }
  if (settings.pagePort !== undefined && settings.pagePort !== null) {
    const port = settings.pagePort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${file}: "pagePort" must be a port number from 1 to 65535`);
    result.pagePort = port;
  }
  return result;
}

/** An http(s) address without a trailing slash, so a link is the address and /p/<token>/. */
function publicUrl(value: unknown, file: string): string {
  let url: URL;
  try {
    if (typeof value !== "string") throw new Error("not a string");
    url = new URL(value);
  } catch {
    throw new Error(`${file}: "publicUrl" must be an address such as "https://coly.tail1234.ts.net"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${file}: "publicUrl" must start with https:// or http://`);
  if (url.search || url.hash) throw new Error(`${file}: "publicUrl" must not have a query or a fragment`);
  return url.href.replace(/\/+$/, "");
}

/**
 * Set one setting and keep the others, as they are in the file. Written whole: to a part file first, then renamed, so no
 * reader sees it half written. A file that is not valid JSON is not overwritten.
 */
export async function writeSetting(key: keyof HostSettings, value: HostSettings[keyof HostSettings], file = SETTINGS_FILE): Promise<void> {
  readSettings(file);
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  current[key] = value;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const part = `${file}.${randomBytes(6).toString("hex")}.part`;
  try {
    await writeFile(part, `${JSON.stringify(current, null, 2)}\n`);
    await rename(part, file);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
}
