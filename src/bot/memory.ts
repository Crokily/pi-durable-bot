import type { Sql } from "../core/sql.ts";

// The bot's memory: short entries it keeps across pages. Each bot has its own, in bot.sqlite, and the bots of one
// POTS_HOME share one more, for facts about the user, in memory.sqlite there. An entry is its text and when it last
// changed; nothing else. To forget an entry is to delete it, as in Claude Code: the memory pass reads only the
// messages since the last pass, so a forgotten fact comes back only when someone says it again.

const DAY = 86_400_000;

interface Row {
  id: number;
  text: string;
  updated_at: number;
}

export interface MemoryEntry {
  /** "m3" for the bot's own, "s3" for a shared one. */
  id: string;
  text: string;
  updatedAt: number;
  shared: boolean;
}

/** One memory table: a bot's own or the shared one. Entry IDs have a letter in front, so the two do not mix. */
export class MemoryTable {
  readonly #sql: Sql;
  readonly #table: string;
  readonly #letter: string;

  private constructor(sql: Sql, table: string, letter: string) {
    this.#sql = sql;
    this.#table = table;
    this.#letter = letter;
  }

  /** table: the name of its SQLite table; letter: what IDs start with. */
  static async open(sql: Sql, table: string, letter: string): Promise<MemoryTable> {
    await sql.exec(`
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${table}_applied (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);`);
    // The keys of memory passes stay: they are small, and a pass that saved and then stopped can run again at any later start.
    return new MemoryTable(sql, table, letter);
  }

  get shared(): boolean {
    return this.#letter === "s";
  }

  /** The number of an ID of this table, or undefined for an ID of the other one. */
  number(id: string): number | undefined {
    const match = /^([a-z])(\d+)$/.exec(id.trim().toLowerCase());
    return match && match[1] === this.#letter ? Number(match[2]) : undefined;
  }

  async entries(): Promise<MemoryEntry[]> {
    const rows = await this.#sql.all<Row>(`SELECT * FROM ${this.#table} ORDER BY id`);
    return rows.map((row) => this.#entry(row));
  }

  async add(text: string, now = Date.now()): Promise<MemoryEntry> {
    const row = await this.#sql.get<Row>(`INSERT INTO ${this.#table} (text, updated_at) VALUES (?, ?) RETURNING *`, text, now);
    return this.#entry(row!);
  }

  /** Throws for an entry that does not exist. */
  async change(id: string, text: string, now = Date.now()): Promise<MemoryEntry> {
    const row = await this.#sql.get<Row>(`UPDATE ${this.#table} SET text = ?, updated_at = ? WHERE id = ? RETURNING *`, text, now, this.#require(id));
    if (!row) throw new Error(`no entry ${id} in memory`);
    return this.#entry(row);
  }

  /** Delete the entry. Throws for an entry that does not exist. */
  async forget(id: string): Promise<void> {
    const row = await this.#sql.get<Row>(`DELETE FROM ${this.#table} WHERE id = ? RETURNING *`, this.#require(id));
    if (!row) throw new Error(`no entry ${id} in memory`);
  }

  /**
   * Apply a memory pass's changes to this table in one transaction, once per key. An added text that is there already
   * is left out. Returns what it did, in words for the gateway's output.
   */
  async apply(key: string, changes: readonly MemoryChange[], now = Date.now()): Promise<string[]> {
    if (changes.length === 0) return [];
    return this.#sql.transaction(async (tx) => {
      if (await tx.get(`SELECT 1 AS done FROM ${this.#table}_applied WHERE key = ?`, key)) return ["applied before"];
      await tx.run(`INSERT INTO ${this.#table}_applied (key, at) VALUES (?, ?)`, key, now);
      const done: string[] = [];
      // Each change sees the table as the changes before it left it.
      for (const change of changes) {
        if (change.kind === "add") {
          if ((await tx.all<Row>(`SELECT * FROM ${this.#table}`)).some((row) => same(row.text) === same(change.text))) continue;
          const row = await tx.get<Row>(`INSERT INTO ${this.#table} (text, updated_at) VALUES (?, ?) RETURNING id`, change.text, now);
          done.push(`added ${this.#letter}${row!.id}`);
        } else {
          const row = await tx.get<Row>(`SELECT * FROM ${this.#table} WHERE id = ?`, this.number(change.id) ?? -1);
          if (!row) continue;
          if (change.kind === "change") await tx.run(`UPDATE ${this.#table} SET text = ?, updated_at = ? WHERE id = ?`, change.text, now, row.id);
          else await tx.run(`DELETE FROM ${this.#table} WHERE id = ?`, row.id);
          done.push(`${change.kind === "change" ? "changed" : "forgot"} ${change.id}`);
        }
      }
      return done;
    });
  }

  #require(id: string): number {
    const number = this.number(id);
    if (number === undefined) throw new Error(`no entry ${id} in memory`);
    return number;
  }

  #entry(row: Row): MemoryEntry {
    return { id: `${this.#letter}${row.id}`, text: row.text, updatedAt: row.updated_at, shared: this.shared };
  }
}

/** A change a memory pass asked for. */
export type MemoryChange = { kind: "add"; text: string; shared: boolean } | { kind: "change"; id: string; text: string } | { kind: "forget"; id: string };

/** Texts that differ only in case and spaces are the same entry. */
function same(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The bot's own memory and the shared one, as the bot uses them. */
export class Memory {
  readonly own: MemoryTable;
  readonly shared: MemoryTable;

  constructor(own: MemoryTable, shared: MemoryTable) {
    this.own = own;
    this.shared = shared;
  }

  async entries(): Promise<MemoryEntry[]> {
    return [...(await this.shared.entries()), ...(await this.own.entries())];
  }

  add(text: string, shared: boolean): Promise<MemoryEntry> {
    if (!text.trim()) throw new Error("the text is empty");
    return (shared ? this.shared : this.own).add(text.trim());
  }

  change(id: string, text: string): Promise<MemoryEntry> {
    if (!text.trim()) throw new Error("the text is empty");
    return this.#table(id).change(id, text.trim());
  }

  forget(id: string): Promise<void> {
    return this.#table(id).forget(id);
  }

  /** The memory as the bot reads it, shared entries first. */
  async render(now = Date.now()): Promise<string> {
    return renderEntries(await this.entries(), now);
  }

  /**
   * Apply a memory pass's answer, once per key: JSON with a list of changes, or "Nothing to save." Returns what it did,
   * in words for the gateway's output, with entry IDs and no text.
   */
  async applyAnswer(key: string, answer: string): Promise<string> {
    const changes = parseChanges(answer);
    // Not the answer itself: the gateway's output holds no memory text.
    if (changes === undefined) return "answer not understood, nothing saved";
    const own = changes.filter((change) => (change.kind === "add" ? !change.shared : this.own.number(change.id) !== undefined));
    const shared = changes.filter((change) => (change.kind === "add" ? change.shared : this.shared.number(change.id) !== undefined));
    const done = [...(await this.own.apply(key, own)), ...(await this.shared.apply(key, shared))];
    return done.length === 0 ? "nothing to save" : done.join(", ");
  }

  #table(id: string): MemoryTable {
    if (this.own.number(id) !== undefined) return this.own;
    if (this.shared.number(id) !== undefined) return this.shared;
    throw new Error(`no entry ${id} in memory; IDs look like m3 (this bot's) or s3 (shared)`);
  }
}

/**
 * Entries, one per line, the text's later lines indented. An entry older than a day gets a line in front that says
 * how old it is.
 */
export function renderEntries(entries: readonly MemoryEntry[], now = Date.now()): string {
  if (entries.length === 0) return "Your memory is empty.";
  return entries
    .map((entry) => {
      const text = entry.text.replace(/\r?\n/g, "\n  ");
      const days = Math.floor((now - entry.updatedAt) / DAY);
      return days >= 1 ? `- ${entry.id}: This entry is ${days} day${days === 1 ? "" : "s"} old and may be out of date.\n  ${text}` : `- ${entry.id}: ${text}`;
    })
    .join("\n");
}

/** The changes in a memory pass's answer; [] for "Nothing to save."; undefined when it is neither. */
export function parseChanges(answer: string): MemoryChange[] | undefined {
  const text = answer.trim();
  if (/^nothing to save\.?$/i.test(text)) return [];
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const list = (value as { changes?: unknown }).changes;
  if (!Array.isArray(list)) return undefined;
  const changes: MemoryChange[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null) continue;
    if (typeof item.add === "string" && item.add.trim()) changes.push({ kind: "add", text: item.add.trim(), shared: item.shared === true });
    else if (typeof item.change === "string" && typeof item.text === "string" && item.text.trim()) changes.push({ kind: "change", id: item.change.trim(), text: item.text.trim() });
    else if (typeof item.forget === "string") changes.push({ kind: "forget", id: item.forget.trim() });
  }
  return changes;
}
