import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./env-file.ts";
import { SECRETS_DIR } from "./home.ts";

// The secrets Pots knows, and their masking: a known secret in a tool's output becomes [secret] before the model and
// the log get it. Known: the values in the secrets folder, pi's logins, API keys and MCP settings (also the workspace's
// .pi/mcp.json), and the files bot.json names (channel tokens, the VNC password). Read again when a file changes,
// looked at at most once a second, so a tool call costs one regular expression over its output.

/** What a known secret becomes in tool output. */
export const MASK = "[secret]";
/** Shorter values are not masked: they come up in other text by chance. */
export const MIN_SECRET_LENGTH = 8;
/** Files larger than this are not secrets files. */
const MAX_FILE_BYTES = 1_000_000;
/** How often the files are looked at for changes. */
const CHECK_MS = 1_000;

/** pi's folder: ~/.pi/agent, or $PI_CODING_AGENT_DIR. */
export function piAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir ? expandHome(dir) : join(homedir(), ".pi", "agent");
}

/** A file or folder of secrets, and how to read one of its files when not as Pots reads its own. */
export type SecretSource = string | { readonly path: string; readonly read: (file: string) => readonly string[] };

/** A file of pi's: JSON whose values may be references to an environment variable or a command. */
export const piSource = (path: string): SecretSource => ({ path, read: (file) => secretsOfText(readFileSync(file, "utf8"), { pi: true }) });

/** The secrets folder, and pi's logins, API keys and MCP sign-ins and settings. */
export function defaultSecretSources(): SecretSource[] {
  const pi = piAgentDir();
  return [SECRETS_DIR, ...["auth.json", "models.json", "mcp.json", "mcp-auth.json"].map((name) => piSource(join(pi, name)))];
}

/** Keys whose values name or describe something rather than unlock it. */
const NAMING_KEY = /(?:^|_)(?:NAME|USER|USERNAME|LOGIN|EMAIL|URL|URI|HOST|PORT|REGION|ID|DOMAIN|ENDPOINT|DIR|PATH|FILE|MODEL|TYPE|PROVIDER|SCOPE|EXPIRES|METHOD)$/i;
/** Keys of JSON values that are secrets: API keys, tokens, passwords, headers such as Authorization. */
const SECRET_KEY = /key|token|secret|passw|access|refresh|credential|session|cookie|authorization/i;

/** Whether a JSON key holds a secret: tokenUrl, token_type and X-Request-Id name things. */
const secretKey = (key: string) => SECRET_KEY.test(key) && !NAMING_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_"));

/** Whether a value is long and varied enough to mask without hitting other text. */
function maskable(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && new Set(value).size >= 4;
}

/** A value, and each of its lines when it has several, as a file shows them; of "Bearer <token>", the token. */
function add(values: Set<string>, value: string): void {
  for (const each of [value, ...(value.includes("\n") ? value.split("\n") : [])]) {
    const text = each.trim();
    const credential = /^(?:Bearer|Basic|Token|Bot)\s+(\S+)$/i.exec(text)?.[1] ?? text;
    if (maskable(credential)) values.add(credential);
  }
}

/** A value of pi's: "!command" runs a command, $NAME and ${NAME} are environment variables, a bare NAME too in older pi. */
function addPi(values: Set<string>, value: string): void {
  if (value.startsWith("!") || /^[A-Z][A-Z0-9_]*$/.test(value)) return;
  for (const part of value.split(/\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*/)) add(values, part.replace(/\$([$!])/g, "$1"));
}

function walkJson(values: Set<string>, value: unknown, secret: boolean, pi: boolean): void {
  if (typeof value === "string") {
    if (secret) (pi ? addPi : add)(values, value);
  } else if (Array.isArray(value)) {
    for (const item of value) walkJson(values, item, secret, pi);
  } else if (value && typeof value === "object") {
    // Each value by its own key, so { "auth": { "provider": "anthropic" } } does not make a word a secret.
    for (const [key, item] of Object.entries(value)) walkJson(values, item, secretKey(key), pi);
  }
}

/**
 * The secret values of one file: JSON under secret-looking keys, KEY=value values, or the file's other lines. Values
 * are literal; with pi, those of JSON may be pi's references, which are not secrets themselves.
 */
export function secretsOfText(text: string, options: { pi?: boolean } = {}): string[] {
  const values = new Set<string>();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      walkJson(values, JSON.parse(trimmed), false, options.pi === true);
      return [...values];
    } catch {
      // Not JSON: lines.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    // Padded Base64, such as YWJjZGVmZ2g=, is a value, not an empty assignment.
    const base64 = /^[A-Za-z0-9+/]+={1,2}$/.test(line.trim()) && /[a-z]/.test(line) && !line.includes("_");
    if (!match || base64) add(values, line);
    else if (!NAMING_KEY.test(match[1]!)) add(values, match[2]!.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return [...values];
}

/** A file of Pots or of a person: its values are literal. */
const readLiteral = (file: string) => secretsOfText(readFileSync(file, "utf8"));

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A tool result's parts that reach the model, a program or the log. */
interface MaskableResult {
  readonly output?: readonly ({ type: string; text?: string } | object)[];
  readonly structuredOutput?: unknown;
  readonly details?: unknown;
  readonly diagnostics?: readonly { message: string }[];
}

/** Output that streams in chunks, masked; what could be the start of a secret waits for the next chunk. */
export interface MaskedStream {
  write(chunk: string): string;
  /** What still waits, at the end. */
  flush(): string;
}

/**
 * The known secrets, from files and folders (each file of a folder), read again when one changes. sources: paths, ~/
 * and relative ones as the channels read them, called at each look, so a new file in bot.json counts.
 */
export class KnownSecrets {
  readonly #sources: () => readonly SecretSource[];
  #checked = -Infinity;
  /** Each file's values as last read, and its mtime and size then; none when reading it failed. */
  #read = new Map<string, { signature: string; values: readonly string[] }>();
  #values: readonly string[] = [];
  #pattern: RegExp | undefined;
  #longest = 0;
  #firsts = new Set<string>();

  constructor(sources: () => readonly SecretSource[] = defaultSecretSources) {
    this.#sources = sources;
  }

  /** The values, longest first. */
  values(): readonly string[] {
    this.#refresh();
    return this.#values;
  }

  /** text with every known secret replaced by [secret]; the same string when there is none. */
  mask(text: string): string {
    this.#refresh();
    const pattern = this.#pattern;
    if (!pattern || text.length < MIN_SECRET_LENGTH) return text;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, MASK);
  }

  /** Any JSON-like value with its strings masked; the same value when nothing changed. */
  maskValue<T>(value: T): T {
    if (typeof value === "string") return this.mask(value) as T;
    if (Array.isArray(value)) {
      let changed = false;
      const items = value.map((item: unknown) => {
        const masked = this.maskValue(item);
        if (masked !== item) changed = true;
        return masked;
      });
      return (changed ? items : value) as T;
    }
    if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
      let changed = false;
      const entries = Object.entries(value).map(([key, item]) => {
        // Image data is not text.
        const masked = key === "data" && (value as { type?: unknown }).type === "image" ? item : this.maskValue(item);
        if (masked !== item) changed = true;
        return [key, masked] as const;
      });
      return (changed ? Object.fromEntries(entries) : value) as T;
    }
    return value;
  }

  /** A tool result with its known secrets masked, or undefined when it has none. */
  maskResult<T extends MaskableResult>(result: T): T | undefined {
    this.#refresh();
    if (!this.#pattern) return undefined;
    const output = this.maskValue(result.output);
    const structuredOutput = this.maskValue(result.structuredOutput);
    const details = this.maskValue(result.details);
    const diagnostics = this.maskValue(result.diagnostics);
    if (output === result.output && structuredOutput === result.structuredOutput && details === result.details && diagnostics === result.diagnostics) return undefined;
    return {
      ...result,
      ...(output === undefined ? {} : { output }),
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(details === undefined ? {} : { details }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  }

  /** A masked stream: a secret split between two chunks is masked too. */
  stream(): MaskedStream {
    let held = "";
    return {
      write: (chunk) => {
        const text = this.mask(held + chunk);
        const keep = this.#startOfSecret(text);
        held = keep === 0 ? "" : text.slice(text.length - keep);
        return keep === 0 ? text : text.slice(0, text.length - keep);
      },
      flush: () => {
        const rest = held;
        held = "";
        return rest;
      },
    };
  }

  /** The length of the longest end of text that is the start of a known secret, but not all of it. */
  #startOfSecret(text: string): number {
    if (this.#longest === 0) return 0;
    for (let at = Math.max(0, text.length - this.#longest + 1); at < text.length; at++) {
      if (!this.#firsts.has(text[at]!)) continue;
      const end = text.length - at;
      for (const value of this.#values) if (value.length > end && value.startsWith(text.slice(at))) return end;
    }
    return 0;
  }

  #refresh(): void {
    const now = Date.now();
    if (now - this.#checked < CHECK_MS) return;
    this.#checked = now;
    const files = this.#files();
    let changed = files.length !== this.#read.size;
    const read = new Map<string, { signature: string; values: readonly string[] }>();
    for (const file of files) {
      const before = this.#read.get(file.path);
      if (before?.signature === file.signature) {
        read.set(file.path, before);
        continue;
      }
      changed = true;
      try {
        read.set(file.path, { signature: file.signature, values: file.read(file.path) });
      } catch {
        // Gone or unreadable: tried again at the next look, which a chmod alone would not show. Meanwhile its values as
        // last read.
        read.set(file.path, { signature: "", values: before?.values ?? [] });
      }
    }
    this.#read = read;
    if (!changed) return;
    this.#values = [...new Set([...read.values()].flatMap((file) => file.values))].sort((a, b) => b.length - a.length);
    this.#pattern = this.#values.length === 0 ? undefined : new RegExp(this.#values.map(escape).join("|"), "g");
    this.#longest = this.#values[0]?.length ?? 0;
    this.#firsts = new Set(this.#values.map((value) => value[0]!));
  }

  /** The files to read, each once: a file a source names keeps that source's reader, also when it is in a folder. */
  #files(): { path: string; signature: string; read: (file: string) => readonly string[] }[] {
    const files = new Map<string, { path: string; signature: string; read: (file: string) => readonly string[] }>();
    const take = (path: string, read: (file: string) => readonly string[], named: boolean) => {
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES && (named || !files.has(path))) files.set(path, { path, signature: `${named}:${stat.mtimeMs}:${stat.size}`, read });
        return stat.isDirectory();
      } catch {
        return false;
      }
    };
    for (const source of this.#sources()) {
      const path = resolve(expandHome(typeof source === "string" ? source : source.path));
      if (!take(path, typeof source === "string" ? readLiteral : source.read, true)) continue;
      try {
        for (const name of readdirSync(path).sort()) take(join(path, name), readLiteral, false);
      } catch {
        // Unreadable folder.
      }
    }
    return [...files.values()];
  }
}
