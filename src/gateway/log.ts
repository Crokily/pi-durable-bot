import type { Address, Happening, PersonInfo, PlaceInfo, PlaceKind } from "../core/channel.ts";
import type { Sql, SqlExecutor } from "../core/sql.ts";

/**
 * The gateway's tables: the inbox, the message log and the outbox. They share the bot's SQLite file with
 * pi-durable (tables `pi_`) and the bot (tables `bot_`). The agent reads them with read-only SQL, so the
 * names and columns are part of its prompt (LOG_SCHEMA).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_inbox (
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  raw TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  error TEXT,
  PRIMARY KEY (channel, event_id)
);
CREATE INDEX IF NOT EXISTS gw_inbox_state ON gw_inbox (state);

CREATE TABLE IF NOT EXISTS gw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  inbox_event TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  place TEXT,
  thread TEXT,
  message TEXT,
  person TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  raw TEXT,
  wake TEXT
);
CREATE INDEX IF NOT EXISTS gw_events_place ON gw_events (place, at);
CREATE INDEX IF NOT EXISTS gw_events_message ON gw_events (message);
CREATE INDEX IF NOT EXISTS gw_events_undecided ON gw_events (id) WHERE wake IS NULL;

CREATE TABLE IF NOT EXISTS gw_messages (
  address TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  place TEXT,
  thread TEXT,
  person TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  mentions TEXT,
  files TEXT,
  at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  send_id TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS gw_messages_place ON gw_messages (place, at);
CREATE INDEX IF NOT EXISTS gw_messages_thread ON gw_messages (thread, at);

CREATE TABLE IF NOT EXISTS gw_places (
  address TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT,
  kind TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_people (
  address TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT,
  real_name TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_outbox (
  send_id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS gw_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** What the agent is told about these tables. Keep in sync with SCHEMA. */
export const LOG_SCHEMA = `Times are Unix ms. Columns that hold an address (place, thread, message, person, to_address) hold the address strings you pass to send, react and pb.
- gw_events(id, channel, kind, at, place, thread, message, person, from_me, mentions_me, text, raw, wake)
  Everything that happened, in order: kind is message, edit, delete, reaction_added, reaction_removed, join, leave, update (a change to a message that is not its text, for example a link preview), command, interaction, or another word the channel uses.
  text: the message text for message and edit, the emoji for reactions. from_me = 1: done by you (for update: a change to your own message). raw: the platform's data (JSON), for details and for call.
  wake: how the gateway handled the event: self (yours, no notice), log (only logged), mention, dm, relevant, jev_no (Jev saw no need), steer. NULL: not decided yet.
- gw_messages(address, channel, place, thread, person, from_me, mentions_me, text, mentions, files, at, edited_at, deleted_at, send_id, raw)
  One row per message with its current text. thread: the thread the message is in; a message that starts a thread has its own address there.
  deleted_at is set for deleted messages; the text stays. mentions and files are JSON.
- gw_places(address, channel, name, kind): kind is channel, dm (one-to-one) or group.
- gw_people(address, channel, name, real_name)
- gw_outbox(send_id, to_address, text, state, message, created_at, sent_at): what you sent with send.
- gw_inbox(channel, event_id, received_at, raw, state, error): the raw events as received.
Text search: LIKE, for example text LIKE '%invoice%'.`;

/** A new logged event that needs a wake decision. */
export interface UndecidedEvent {
  id: number;
  channel: string;
  kind: string;
  at: number;
  place: string | null;
  place_name: string | null;
  place_kind: PlaceKind | null;
  thread: string | null;
  message: string | null;
  person: string | null;
  person_name: string | null;
  from_me: number;
  mentions_me: number;
  text: string | null;
}

export interface LoggedMessage {
  address: string;
  place: string | null;
  thread: string | null;
  person: string | null;
  person_name: string | null;
  from_me: number;
  text: string;
  at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export class MessageLog {
  readonly sql: Sql;

  private constructor(sql: Sql) {
    this.sql = sql;
  }

  static async open(sql: Sql): Promise<MessageLog> {
    await sql.exec(SCHEMA);
    return new MessageLog(sql);
  }

  // ---- Inbox ----

  /** False when the event ID is already known. */
  async addInbox(channel: string, eventId: string, raw: unknown): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      if (await tx.get("SELECT 1 AS x FROM gw_inbox WHERE channel = ? AND event_id = ?", channel, eventId)) return false;
      await tx.run("INSERT INTO gw_inbox (channel, event_id, received_at, raw) VALUES (?, ?, ?, ?)", channel, eventId, Date.now(), JSON.stringify(raw));
      return true;
    });
  }

  async unfinishedInbox(): Promise<{ channel: string; event_id: string; raw: string }[]> {
    return this.sql.all("SELECT channel, event_id, raw FROM gw_inbox WHERE state != 'done' ORDER BY received_at, rowid");
  }

  async failInbox(channel: string, eventId: string, error: string): Promise<void> {
    await this.sql.run("UPDATE gw_inbox SET state = 'error', error = ? WHERE channel = ? AND event_id = ?", error, channel, eventId);
  }

  /**
   * Write the happenings of one inbox event to the log and mark the event done, in one transaction.
   * Returns the new events that still need a wake decision.
   */
  async apply(channel: string, eventId: string, happenings: readonly Happening[]): Promise<UndecidedEvent[]> {
    const ids = await this.sql.transaction(async (tx) => {
      const ids: number[] = [];
      for (const happening of happenings) {
        const id = await applyOne(tx, channel, eventId, happening);
        if (id !== undefined) ids.push(id);
      }
      await tx.run("UPDATE gw_inbox SET state = 'done', error = NULL WHERE channel = ? AND event_id = ?", channel, eventId);
      return ids;
    });
    const undecided: UndecidedEvent[] = [];
    for (const id of ids) {
      const row = await this.sql.get<UndecidedEvent>(`${UNDECIDED_SELECT} WHERE e.id = ? AND e.wake IS NULL`, id);
      if (row) undecided.push(row);
    }
    return undecided;
  }

  async undecided(): Promise<UndecidedEvent[]> {
    return this.sql.all(`${UNDECIDED_SELECT} WHERE e.wake IS NULL ORDER BY e.id`);
  }

  async setWake(ids: readonly number[], wake: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      for (const id of ids) await tx.run("UPDATE gw_events SET wake = ? WHERE id = ?", wake, id);
    });
  }

  // ---- Reads for backfill and Jev ----

  async newestMessage(place: Address): Promise<Address | undefined> {
    const row = await this.sql.get<{ address: string }>("SELECT address FROM gw_messages WHERE place = ? ORDER BY at DESC LIMIT 1", place);
    return row?.address;
  }

  async threads(place: Address): Promise<Address[]> {
    const rows = await this.sql.all<{ thread: string }>(
      "SELECT thread FROM gw_messages WHERE place = ? AND thread IS NOT NULL GROUP BY thread ORDER BY max(at) DESC",
      place,
    );
    return rows.map((row) => row.thread);
  }

  /** Messages in a place before an event, oldest first. */
  async messagesBefore(place: Address, at: number, limit: number): Promise<LoggedMessage[]> {
    const rows = await this.sql.all<LoggedMessage>(
      `SELECT m.address, m.place, m.thread, m.person, p.name AS person_name, m.from_me, m.text, m.at, m.edited_at, m.deleted_at
       FROM gw_messages m LEFT JOIN gw_people p ON p.address = m.person
       WHERE m.place = ? AND m.at < ? ORDER BY m.at DESC LIMIT ?`,
      place,
      at,
      limit,
    );
    return rows.reverse();
  }

  async message(address: Address): Promise<LoggedMessage | undefined> {
    return this.sql.get<LoggedMessage>(
      `SELECT m.address, m.place, m.thread, m.person, p.name AS person_name, m.from_me, m.text, m.at, m.edited_at, m.deleted_at
       FROM gw_messages m LEFT JOIN gw_people p ON p.address = m.person WHERE m.address = ?`,
      address,
    );
  }

  async place(address: Address): Promise<PlaceInfo | undefined> {
    const row = await this.sql.get<{ address: string; name: string | null; kind: PlaceKind }>("SELECT address, name, kind FROM gw_places WHERE address = ?", address);
    return row && { address: row.address, kind: row.kind, ...(row.name ? { name: row.name } : {}) };
  }

  // ---- Outbox ----

  async outbox(sendId: string): Promise<{ send_id: string; to_address: string; state: string; message: string | null; created_at: number } | undefined> {
    return this.sql.get("SELECT send_id, to_address, state, message, created_at FROM gw_outbox WHERE send_id = ?", sendId);
  }

  async outboxStart(sendId: string, to: Address, text: string): Promise<void> {
    await this.sql.run("INSERT INTO gw_outbox (send_id, to_address, text, state, created_at) VALUES (?, ?, ?, 'sending', ?)", sendId, to, text, Date.now());
  }

  async outboxDone(sendId: string, message: Address): Promise<void> {
    await this.sql.run("UPDATE gw_outbox SET state = 'sent', message = ?, sent_at = ? WHERE send_id = ?", message, Date.now(), sendId);
  }

  // ---- State ----

  async getState(key: string): Promise<string | undefined> {
    return (await this.sql.get<{ value: string }>("SELECT value FROM gw_state WHERE key = ?", key))?.value;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.sql.run("INSERT INTO gw_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
}

const UNDECIDED_SELECT = `SELECT e.id, e.channel, e.kind, e.at, e.place, pl.name AS place_name, pl.kind AS place_kind, e.thread, e.message,
  e.person, pe.name AS person_name, e.from_me, e.mentions_me, e.text
  FROM gw_events e LEFT JOIN gw_places pl ON pl.address = e.place LEFT JOIN gw_people pe ON pe.address = e.person`;

/**
 * Apply one happening. Returns the new event row ID, or undefined when it adds nothing (a message already logged,
 * for example the same message from a live event and from backfill).
 */
async function applyOne(tx: SqlExecutor, channel: string, eventId: string, h: Happening): Promise<number | undefined> {
  const now = Date.now();
  if (h.place) await putPlace(tx, channel, h.place, now);
  if (h.person) await putPerson(tx, channel, h.person, now);
  const raw = h.raw === undefined ? null : JSON.stringify(h.raw);
  let thread = h.thread ?? null;

  if (h.kind === "message" && h.message) {
    const known = await tx.get<{ address: string }>("SELECT address FROM gw_messages WHERE address = ?", h.message);
    if (known) {
      // The same message again. Fill in what the first copy did not have.
      await tx.run(
        "UPDATE gw_messages SET thread = coalesce(thread, ?), send_id = coalesce(send_id, ?), person = coalesce(person, ?) WHERE address = ?",
        thread,
        h.sendId ?? null,
        h.person?.address ?? null,
        h.message,
      );
      return undefined;
    }
    await tx.run(
      `INSERT INTO gw_messages (address, channel, place, thread, person, from_me, mentions_me, text, mentions, files, at, send_id, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      h.message,
      channel,
      h.place?.address ?? null,
      thread,
      h.person?.address ?? null,
      h.fromMe ? 1 : 0,
      h.mentionsMe ? 1 : 0,
      h.text ?? "",
      h.mentions?.length ? JSON.stringify(h.mentions) : null,
      h.files?.length ? JSON.stringify(h.files) : null,
      h.at,
      h.sendId ?? null,
      raw,
    );
    // A reply makes its root a thread root.
    if (thread && h.threadRoot && h.threadRoot !== h.message) {
      await tx.run("UPDATE gw_messages SET thread = ? WHERE address = ? AND thread IS NULL", thread, h.threadRoot);
    }
  } else if (h.message) {
    const known = await tx.get<{ thread: string | null }>("SELECT thread FROM gw_messages WHERE address = ?", h.message);
    thread ??= known?.thread ?? null;
    if (h.kind === "edit") {
      if (known) {
        await tx.run(
          "UPDATE gw_messages SET text = ?, mentions_me = ?, mentions = ?, files = coalesce(?, files), edited_at = ?, raw = ? WHERE address = ?",
          h.text ?? "",
          h.mentionsMe ? 1 : 0,
          h.mentions?.length ? JSON.stringify(h.mentions) : null,
          h.files?.length ? JSON.stringify(h.files) : null,
          h.at,
          raw,
          h.message,
        );
      } else {
        await tx.run(
          `INSERT INTO gw_messages (address, channel, place, thread, person, from_me, mentions_me, text, mentions, files, at, edited_at, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          h.message,
          channel,
          h.place?.address ?? null,
          thread,
          h.person?.address ?? null,
          h.fromMe ? 1 : 0,
          h.mentionsMe ? 1 : 0,
          h.text ?? "",
          h.mentions?.length ? JSON.stringify(h.mentions) : null,
          h.files?.length ? JSON.stringify(h.files) : null,
          h.at,
          h.at,
          raw,
        );
      }
    } else if (h.kind === "delete" && known) {
      await tx.run("UPDATE gw_messages SET deleted_at = ? WHERE address = ?", h.at, h.message);
    } else if (h.kind === "update" && known && raw !== null) {
      await tx.run("UPDATE gw_messages SET raw = ?, files = coalesce(?, files) WHERE address = ?", raw, h.files?.length ? JSON.stringify(h.files) : null, h.message);
    }
  }

  // Own events never notify the bot. Deletes are only logged. Everything else waits for the waker's decision.
  const wake = h.fromMe ? "self" : h.kind === "delete" ? "log" : null;
  await tx.run(
    `INSERT INTO gw_events (channel, inbox_event, kind, at, place, thread, message, person, from_me, mentions_me, text, raw, wake)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    channel,
    eventId,
    h.kind,
    h.at,
    h.place?.address ?? null,
    thread,
    h.message ?? null,
    h.person?.address ?? null,
    h.fromMe ? 1 : 0,
    h.mentionsMe ? 1 : 0,
    h.text ?? null,
    raw,
    wake,
  );
  return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
}

async function putPlace(tx: SqlExecutor, channel: string, place: PlaceInfo, now: number): Promise<void> {
  await tx.run(
    `INSERT INTO gw_places (address, channel, name, kind, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET name = coalesce(excluded.name, name), kind = excluded.kind, updated_at = excluded.updated_at`,
    place.address,
    channel,
    place.name ?? null,
    place.kind,
    now,
  );
}

async function putPerson(tx: SqlExecutor, channel: string, person: PersonInfo, now: number): Promise<void> {
  await tx.run(
    `INSERT INTO gw_people (address, channel, name, real_name, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET name = coalesce(excluded.name, name), real_name = coalesce(excluded.real_name, real_name), updated_at = excluded.updated_at`,
    person.address,
    channel,
    person.name ?? null,
    person.realName ?? null,
    now,
  );
}
