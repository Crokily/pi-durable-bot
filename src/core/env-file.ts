import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

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

/** Set KEY=value lines in a file readable only by this user: keys already there are replaced, other lines are kept. */
export function writeSecrets(path: string, values: Record<string, string>): void {
  const file = expandHome(path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim()) : [];
  const kept = lines.filter((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
    return !(key && key in values);
  });
  const text = [...kept, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("\n");
  writeFileSync(file, `${text}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
