import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Expand a leading "~/". */
export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

/** Read KEY=value lines and return only the asked keys. Values are never logged. */
export function readSecrets(path: string, keys: readonly string[]): Record<string, string> {
  const file = expandHome(path);
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !keys.includes(match[1]!)) continue;
    values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`${file}: missing ${missing.join(", ")}`);
  return values;
}
