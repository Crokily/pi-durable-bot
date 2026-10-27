import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlValue } from "../core/types.ts";

/**
 * The gateway's tables, in the same SQLite file as pi-durable (whose tables start with `pi_`).
 * The agent reads them with read-only SQL, so the names and columns are part of its prompt (see SCHEMA_DOC).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  error TEXT
);
CREATE INDEX IF NOT EXISTS gw_events_state ON gw_events (state);

CREATE TABLE IF NOT EXISTS gw_messages (
  channel TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT,
  user_name TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  is_mention INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  subtype TEXT,
  files TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  send_id TEXT,
  event_id TEXT,
  wake TEXT,
  PRIMARY KEY (channel, ts)
);
CREATE INDEX IF NOT EXISTS gw_messages_created ON gw_messages (created_at);
CREATE INDEX IF NOT EXISTS gw_messages_thread ON gw_messages (channel, thread_ts);

CREATE TABLE IF NOT EXISTS gw_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  at INTEGER NOT NULL,
  event_id TEXT
);

CREATE TABLE IF NOT EXISTS gw_channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_users (
  id TEXT PRIMARY KEY,
  name TEXT,
  real_name TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_outbox (
  send_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  thread_ts TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  ts TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS gw_patrols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL,
  state TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);

CREATE TABLE IF NOT EXISTS gw_wakes (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  channel TEXT,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
);
`;

/** What the agent is told about the log. Keep in sync with SCHEMA. */
export const SCHEMA_DOC = `Tables (SQLite, read-only for you; times are Unix ms; ts is the Slack message ts):
- gw_messages(channel, ts, thread_ts, user_id, user_name, is_self, is_mention, text, subtype, files, created_at, edited_at, deleted_at, send_id, wake)
  One row per Slack message, current text. thread_ts is set for thread replies (and on a thread's parent when it has replies: thread_ts = ts).
  is_self = 1 for your own messages. deleted_at is set when the message was deleted. wake: how the gateway handled it (mention, dm, relevant, not_relevant, steer, self, ...).
- gw_edits(channel, ts, kind, old_text, new_text, at): every edit ('edit') and delete ('delete').
- gw_channels(id, name, type): type is channel, group, im or mpim.
- gw_users(id, name, real_name)
- gw_outbox(send_id, channel, thread_ts, text, state, ts, created_at, sent_at): what you sent.
- gw_patrols(id, due_at, note, state, set_by): patrol schedule.
- gw_wakes(id, reason, channel, created_at, detail): every time you were woken, with the Jev answers for 'relevant'.
Text search: use LIKE, for example text LIKE '%发票%'.`;

export interface MessageRow {
  channel: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  user_name: string | null;
  is_self: number;
  is_mention: number;
  text: string;
  created_at: number;
  wake: string | null;
}

export class LogStore {
  readonly sql: Sql;
  readonly #readonly: DatabaseSync;

  private constructor(sql: Sql, path: string) {
    this.sql = sql;
    // A second connection that cannot write. In WAL mode, readers never wait for writers.
    this.#readonly = new DatabaseSync(path, { readOnly: true });
  }

  static async open(sql: Sql, path: string): Promise<LogStore> {
    await sql.exec(SCHEMA);
    return new LogStore(sql, path);
  }

  close(): void {
    this.#readonly.close();
  }

  /** Store a raw event before it is acked. False when the event ID is already known. */
  async addEvent(eventId: string, body: unknown): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      if (await tx.get("SELECT 1 AS x FROM gw_events WHERE event_id = ?", eventId)) return false;
      await tx.run("INSERT INTO gw_events (event_id, received_at, body) VALUES (?, ?, ?)", eventId, Date.now(), JSON.stringify(body));
      return true;
    });
  }

  async finishEvent(eventId: string, error?: string): Promise<void> {
    await this.sql.run("UPDATE gw_events SET state = ?, error = ? WHERE event_id = ?", error ? "error" : "done", error ?? null, eventId);
  }

  async unfinishedEvents(): Promise<{ event_id: string; body: string }[]> {
    return this.sql.all("SELECT event_id, body FROM gw_events WHERE state = 'new' ORDER BY received_at");
  }

  /** Insert a message, or fill in a row that a send already wrote. Returns true when the row is new. */
  async putMessage(row: Omit<MessageRow, "wake"> & { subtype?: string | null; files?: string | null; send_id?: string | null; event_id?: string | null; wake?: string | null }): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const existing = await tx.get<{ ts: string }>("SELECT ts FROM gw_messages WHERE channel = ? AND ts = ?", row.channel, row.ts);
      if (existing) {
        await tx.run(
          `UPDATE gw_messages SET thread_ts = coalesce(?, thread_ts), user_id = coalesce(?, user_id), user_name = coalesce(?, user_name),
             text = ?, files = coalesce(?, files), event_id = coalesce(event_id, ?) WHERE channel = ? AND ts = ?`,
          row.thread_ts,
          row.user_id,
          row.user_name,
          row.text,
          row.files ?? null,
          row.event_id ?? null,
          row.channel,
          row.ts,
        );
        return false;
      }
      await tx.run(
        `INSERT INTO gw_messages (channel, ts, thread_ts, user_id, user_name, is_self, is_mention, text, subtype, files, created_at, send_id, event_id, wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.channel,
        row.ts,
        row.thread_ts,
        row.user_id,
        row.user_name,
        row.is_self,
        row.is_mention,
        row.text,
        row.subtype ?? null,
        row.files ?? null,
        row.created_at,
        row.send_id ?? null,
        row.event_id ?? null,
        row.wake ?? null,
      );
      // A reply makes its parent a thread parent.
      if (row.thread_ts && row.thread_ts !== row.ts) {
        await tx.run("UPDATE gw_messages SET thread_ts = ts WHERE channel = ? AND ts = ? AND thread_ts IS NULL", row.channel, row.thread_ts);
      }
      return true;
    });
  }

  async editMessage(channel: string, ts: string, newText: string, at: number, eventId: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const old = await tx.get<{ text: string }>("SELECT text FROM gw_messages WHERE channel = ? AND ts = ?", channel, ts);
      await tx.run(
        "INSERT INTO gw_edits (channel, ts, kind, old_text, new_text, at, event_id) VALUES (?, ?, 'edit', ?, ?, ?, ?)",
        channel,
        ts,
        old?.text ?? null,
        newText,
        at,
        eventId,
      );
      await tx.run("UPDATE gw_messages SET text = ?, edited_at = ? WHERE channel = ? AND ts = ?", newText, at, channel, ts);
    });
  }

  async deleteMessage(channel: string, ts: string, at: number, eventId: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const old = await tx.get<{ text: string }>("SELECT text FROM gw_messages WHERE channel = ? AND ts = ?", channel, ts);
      await tx.run(
        "INSERT INTO gw_edits (channel, ts, kind, old_text, new_text, at, event_id) VALUES (?, ?, 'delete', ?, NULL, ?, ?)",
        channel,
        ts,
        old?.text ?? null,
        at,
        eventId,
      );
      await tx.run("UPDATE gw_messages SET deleted_at = ? WHERE channel = ? AND ts = ?", at, channel, ts);
    });
  }

  async setWake(channel: string, tss: readonly string[], wake: string): Promise<void> {
    for (const ts of tss) await this.sql.run("UPDATE gw_messages SET wake = ? WHERE channel = ? AND ts = ?", wake, channel, ts);
  }

  async deletedAmong(channel: string, tss: readonly string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const ts of tss) {
      if (await this.sql.get("SELECT 1 AS x FROM gw_messages WHERE channel = ? AND ts = ? AND deleted_at IS NOT NULL", channel, ts)) deleted.push(ts);
    }
    return deleted;
  }

  /** Messages from others that the gateway saw but did not decide on, for example because of a crash. */
  async undecided(since: number): Promise<MessageRow[]> {
    return this.sql.all(
      "SELECT * FROM gw_messages WHERE wake IS NULL AND is_self = 0 AND deleted_at IS NULL AND created_at >= ? ORDER BY created_at",
      since,
    );
  }

  async recentMessages(channel: string, beforeTs: string, limit: number): Promise<MessageRow[]> {
    const rows = await this.sql.all<MessageRow>(
      "SELECT * FROM gw_messages WHERE channel = ? AND ts < ? AND deleted_at IS NULL ORDER BY ts DESC LIMIT ?",
      channel,
      beforeTs,
      limit,
    );
    return rows.reverse();
  }

  async latestTs(channel: string): Promise<string | undefined> {
    return (await this.sql.get<{ ts: string }>("SELECT max(ts) AS ts FROM gw_messages WHERE channel = ?", channel))?.ts ?? undefined;
  }

  async putChannel(id: string, name: string | null, type: string): Promise<void> {
    await this.sql.run(
      "INSERT INTO gw_channels (id, name, type, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type, updated_at = excluded.updated_at",
      id,
      name,
      type,
      Date.now(),
    );
  }

  async channel(id: string): Promise<{ id: string; name: string | null; type: string } | undefined> {
    return this.sql.get("SELECT id, name, type FROM gw_channels WHERE id = ?", id);
  }

  async channelByName(name: string): Promise<{ id: string } | undefined> {
    return this.sql.get("SELECT id FROM gw_channels WHERE name = ?", name);
  }

  async putUser(id: string, name: string, realName: string): Promise<void> {
    await this.sql.run(
      "INSERT INTO gw_users (id, name, real_name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, real_name = excluded.real_name, updated_at = excluded.updated_at",
      id,
      name,
      realName,
      Date.now(),
    );
  }

  async outbox(sendId: string): Promise<{ send_id: string; channel: string; thread_ts: string | null; state: string; ts: string | null; created_at: number } | undefined> {
    return this.sql.get("SELECT * FROM gw_outbox WHERE send_id = ?", sendId);
  }

  async outboxStart(sendId: string, channel: string, threadTs: string | undefined, text: string): Promise<void> {
    await this.sql.run(
      "INSERT INTO gw_outbox (send_id, channel, thread_ts, text, state, created_at) VALUES (?, ?, ?, ?, 'sending', ?)",
      sendId,
      channel,
      threadTs ?? null,
      text,
      Date.now(),
    );
  }

  async outboxDone(sendId: string, ts: string): Promise<void> {
    await this.sql.run("UPDATE gw_outbox SET state = 'sent', ts = ?, sent_at = ? WHERE send_id = ?", ts, Date.now(), sendId);
  }

  async addWake(id: string, reason: string, channel: string | undefined, detail: unknown): Promise<void> {
    await this.sql.run(
      "INSERT OR IGNORE INTO gw_wakes (id, reason, channel, created_at, detail) VALUES (?, ?, ?, ?, ?)",
      id,
      reason,
      channel ?? null,
      Date.now(),
      JSON.stringify(detail),
    );
  }

  async wakeChannel(id: string): Promise<string | undefined> {
    return (await this.sql.get<{ channel: string | null }>("SELECT channel FROM gw_wakes WHERE id = ?", id))?.channel ?? undefined;
  }

  async pendingPatrol(): Promise<{ id: number; due_at: number; note: string } | undefined> {
    return this.sql.get("SELECT id, due_at, note FROM gw_patrols WHERE state = 'pending' ORDER BY due_at LIMIT 1");
  }

  /** Replace every pending patrol with one new one. */
  async setPatrol(dueAt: number, note: string, setBy: "agent" | "default"): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.run("UPDATE gw_patrols SET state = 'replaced' WHERE state = 'pending'");
      await tx.run(
        "INSERT INTO gw_patrols (due_at, note, state, set_by, created_at) VALUES (?, ?, 'pending', ?, ?)",
        dueAt,
        note,
        setBy,
        Date.now(),
      );
    });
  }

  async firePatrol(id: number): Promise<void> {
    await this.sql.run("UPDATE gw_patrols SET state = 'fired', fired_at = ? WHERE id = ?", Date.now(), id);
  }

  /** One read-only statement for the agent. Rows are capped so a wide query cannot flood the context. */
  query(sql: string, params: readonly SqlValue[], maxRows = 500): Record<string, unknown>[] {
    const statement = this.#readonly.prepare(sql);
    const rows: Record<string, unknown>[] = [];
    for (const row of statement.iterate(...(params as SqlValue[]))) {
      rows.push(row as Record<string, unknown>);
      if (rows.length >= maxRows) break;
    }
    return rows;
  }
}
