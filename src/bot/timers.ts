import type { Sql } from "../core/sql.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_timers_pending ON bot_timers (due_at) WHERE state = 'pending';
`;

export interface Timer {
  id: number;
  due_at: number;
  note: string;
  /** "agent": set by the agent. "fallback": the default patrol while the agent has none set. */
  set_by: "agent" | "fallback";
  created_at: number;
}

const CHECK_MS = 30_000;

/**
 * Timed wakes. The agent sets as many as it likes. While it has none pending, one fallback wake is kept,
 * fallbackMinutes after the moment it had none left (the start, the last firing, or a cancel).
 */
export class Timers {
  readonly #sql: Sql;
  readonly #fallbackMinutes: () => number;
  readonly #fire: (timer: Timer) => Promise<void>;
  readonly #log: (message: string, data?: Record<string, unknown>) => void;
  #timer?: NodeJS.Timeout;
  #check: Promise<void> = Promise.resolve();
  #stopped = false;

  private constructor(sql: Sql, fallbackMinutes: () => number, fire: (timer: Timer) => Promise<void>, log: (message: string, data?: Record<string, unknown>) => void) {
    this.#sql = sql;
    this.#fallbackMinutes = fallbackMinutes;
    this.#fire = fire;
    this.#log = log;
  }

  static async open(sql: Sql, fallbackMinutes: () => number, fire: (timer: Timer) => Promise<void>, log: (message: string, data?: Record<string, unknown>) => void): Promise<Timers> {
    await sql.exec(SCHEMA);
    return new Timers(sql, fallbackMinutes, fire, log);
  }

  async start(): Promise<void> {
    await this.#ensureFallback();
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#check;
  }

  async add(dueAt: number, note: string): Promise<Timer> {
    if (!Number.isFinite(dueAt)) throw new Error("bad time");
    const timer = await this.#sql.transaction(async (tx) => {
      await tx.run("UPDATE bot_timers SET state = 'replaced' WHERE state = 'pending' AND set_by = 'fallback'");
      await tx.run("INSERT INTO bot_timers (due_at, note, state, set_by, created_at) VALUES (?, ?, 'pending', 'agent', ?)", dueAt, note, Date.now());
      return (await tx.get<Timer>("SELECT id, due_at, note, set_by, created_at FROM bot_timers WHERE id = last_insert_rowid()"))!;
    });
    this.#schedule();
    return timer;
  }

  async cancel(id: number): Promise<boolean> {
    const found = await this.#sql.get("SELECT 1 AS x FROM bot_timers WHERE id = ? AND state = 'pending'", id);
    if (!found) return false;
    await this.#sql.run("UPDATE bot_timers SET state = 'cancelled' WHERE id = ?", id);
    await this.#ensureFallback();
    this.#schedule();
    return true;
  }

  /** The fallback interval changed: put the pending fallback wake at the new interval from now. */
  async resetFallback(): Promise<void> {
    await this.#sql.run("UPDATE bot_timers SET state = 'replaced' WHERE state = 'pending' AND set_by = 'fallback'");
    await this.#ensureFallback();
    this.#schedule();
  }

  pending(): Promise<Timer[]> {
    return this.#sql.all("SELECT id, due_at, note, set_by, created_at FROM bot_timers WHERE state = 'pending' ORDER BY due_at");
  }

  /** Keep a fallback wake while the agent has none of its own. */
  async #ensureFallback(): Promise<void> {
    const pending = await this.pending();
    if (pending.length > 0) return;
    const dueAt = Date.now() + this.#fallbackMinutes() * 60_000;
    await this.#sql.run("INSERT INTO bot_timers (due_at, note, state, set_by, created_at) VALUES (?, '', 'pending', 'fallback', ?)", dueAt, Date.now());
  }

  #schedule(): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#check = this.#check
      .then(async () => {
        const next = (await this.pending())[0];
        const wait = next ? Math.max(0, Math.min(CHECK_MS, next.due_at - Date.now())) : CHECK_MS;
        if (this.#stopped) return;
        this.#timer = setTimeout(() => void this.#fireDue(), wait);
      })
      .catch((error) => this.#log("timer schedule failed", { error: String(error) }));
  }

  async #fireDue(): Promise<void> {
    this.#check = this.#check
      .then(async () => {
        for (const timer of await this.pending()) {
          if (this.#stopped || timer.due_at > Date.now()) break;
          await this.#fire(timer);
          await this.#sql.run("UPDATE bot_timers SET state = 'fired', fired_at = ? WHERE id = ?", Date.now(), timer.id);
          this.#log("timer fired", { id: timer.id, setBy: timer.set_by });
        }
        await this.#ensureFallback();
      })
      .catch((error) => this.#log("timer failed", { error: String(error) }));
    await this.#check;
    this.#schedule();
  }
}
