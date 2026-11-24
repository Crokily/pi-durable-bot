import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandHome } from "./env-file.ts";

// The secrets Pots knows, and their masking: a known secret in a tool's output becomes [secret] before the model and
// the log get it. Known: the values of Pots' own secrets, the files of the secrets folder and the files bot.json names
// (channel tokens, the VNC password). Read again when a file changes, looked at at most once a second, so a tool call
// costs one regular expression over its output.

/** What a known secret becomes in tool output. */
export const MASK = "[secret]";
/** Shorter values are not masked: they come up in other text by chance. */
export const MIN_SECRET_LENGTH = 8;
/** Files larger than this are not secrets files. */
const MAX_FILE_BYTES = 1_000_000;
/** How often the files are looked at for changes. */
const CHECK_MS = 1_000;

/** Keys whose values name or describe something rather than unlock it, such as BANK_ACCOUNT_NAME or BW_CLIENTID. */
const NAMING_KEY = /(?:^|_)(?:NAME|USER|USERNAME|LOGIN|EMAIL|URL|URI|HOST|PORT|REGION|DOMAIN|ENDPOINT|DIR|PATH|FILE|(?:CLIENT|APP|ACCOUNT|TENANT|PROJECT|ORG|USER)?_?ID)$/i;

/** A value, when it is long and varied enough to mask without hitting other text. */
function add(values: Set<string>, value: string): void {
  const text = value.trim();
  if (text.length >= MIN_SECRET_LENGTH && new Set(text).size >= 4) values.add(text);
}

/** The secret values of a text file, taken literally: KEY=value values, except of keys that name a thing, and other lines. */
export function secretsOfText(text: string): string[] {
  const values = new Set<string>();
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

const text = new TextDecoder("utf-8", { fatal: true });

/** The secret values of a file: of a text file, its values; of another, what binary makes of it, such as a VNC password. */
function secretsOfFile(file: string, binary: (data: Buffer) => string | undefined): string[] {
  const data = readFileSync(file);
  try {
    const decoded = text.decode(data);
    if (!/[\0-\x08\x0e-\x1f]/.test(decoded)) return secretsOfText(decoded);
  } catch {
    // Not UTF-8.
  }
  return secretsOfText(binary(data) ?? "");
}

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
  readonly #sources: () => readonly string[];
  readonly #binary: (data: Buffer) => string | undefined;
  #checked = -Infinity;
  /** Each file's values as last read, and its mtime and size then; none when reading it failed. */
  #read = new Map<string, { signature: string; values: readonly string[] }>();
  #values: readonly string[] = [];
  #pattern: RegExp | undefined;
  #longest = 0;
  #firsts = new Set<string>();

  /** binary: the secret in a file that is not text, such as a VNC password file. */
  constructor(sources: () => readonly string[], binary: (data: Buffer) => string | undefined = () => undefined) {
    this.#sources = sources;
    this.#binary = binary;
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
        read.set(file.path, { signature: file.signature, values: secretsOfFile(file.path, this.#binary) });
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

  /** The files to read, each once, with their mtime and size. */
  #files(): { path: string; signature: string }[] {
    const files = new Map<string, { path: string; signature: string }>();
    const take = (path: string) => {
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES) files.set(path, { path, signature: `${stat.mtimeMs}:${stat.size}` });
        return stat.isDirectory();
      } catch {
        return false;
      }
    };
    for (const source of this.#sources()) {
      const path = resolve(expandHome(source));
      if (!take(path)) continue;
      try {
        for (const name of readdirSync(path)) take(join(path, name));
      } catch {
        // Unreadable folder.
      }
    }
    return [...files.values()];
  }
}
