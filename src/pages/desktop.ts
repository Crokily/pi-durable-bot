import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { RawData, WebSocket } from "ws";
import { desktopHolder, type Screen, ScreenLeases } from "../agent/screen.ts";
import type { VncSetting } from "../bot/definition.ts";
import { expandHome } from "../core/env-file.ts";
import type { Sql } from "../core/sql.ts";
import { formatTime } from "../core/time.ts";
import type { Print } from "../gateway/config.ts";
import { type Channel, connectVnc, type DesktopLayout, Reader, readDesktopLayout, readServerInit, readVncPassword, restoreDesktopLayout, sizeText, VncError, type VncTarget } from "./rfb.ts";

// Desktop pages: one-time links with which a person sees and controls the bot's screen in their browser, through the
// VNC server that shows it on this computer. Pots signs in to that server itself and carries the browser's WebSocket to
// it, so the VNC password never leaves this process. Nothing streams before the person presses Start; the first browser
// that presses Start keeps the link (a cookie), and may open it again until it ends. While it is started, the person has
// the bot's screen lease, so no agent drives the screen under their hands. The link ends when they hand the desktop
// back (done, or "I can't do it"), when it expires, or when the bot takes it back; then Pots sets the desktop's size back
// to what it was at Start, gives the screen back, and wakes the bot, once.

/** A desktop link that nobody started stops working after this long. */
export const DESKTOP_UNOPENED_MS = 3_600_000;
/** How long a desktop link works after Start, unless the bot gives another number. */
export const DESKTOP_MINUTES = 15;
export const DESKTOP_MAX_MINUTES = 60;
/** What a step can ask the person to type, so their page offers the right field. */
export const INPUT_KINDS = ["password", "code", "text"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
/**
 * After the last connection of a started link closed, the desktop's size is set back after restoreAfterMs, unless the
 * browser came back. The server pings each connection every pingMs, so proxies keep it, and ends one that stops
 * answering. For tests: change them.
 */
export const desktopTimes = { restoreAfterMs: 20_000, pingMs: 25_000, wakeRetryMs: 10_000 };
/** The name of the cookie that binds a link to the browser that pressed Start. */
export const DESKTOP_COOKIE = "pots_desktop";

const DAY_MS = 86_400_000;
/** Desktop links are listed and kept this long after they were made. */
const KEEP_MS = 7 * DAY_MS;
const MAX_TEXT = 2_000;
const MAX_NOTE = 1_000;
/** How long Pots waits for the VNC server: to sign in and read the desktop, or to set its size back. */
const VNC_TIMEOUT_MS = 10_000;
/** Bytes waiting for the browser above which Pots stops reading the VNC server until they are sent. */
const HIGH_WATER = 8 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_desktop_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  input TEXT,
  area TEXT,
  minutes INTEGER NOT NULL,
  made_for TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER,
  browser TEXT,
  layout TEXT,
  ended_at INTEGER,
  note TEXT,
  restored_at INTEGER,
  woken_at INTEGER
);
`;

type Stored = "open" | "started" | "done" | "cannot" | "expired" | "revoked";

interface DesktopRow {
  id: number;
  token: string;
  text: string;
  input: InputKind | null;
  /** The area to show first, [x, y, width, height] in the desktop's pixels, as JSON. */
  area: string | null;
  minutes: number;
  made_for: string | null;
  created_at: number;
  /** Before Start, when the link stops working unopened; after it, when the session ends. */
  expires_at: number;
  state: Stored;
  started_at: number | null;
  /** SHA-256 of the cookie of the browser that pressed Start. */
  browser: string | null;
  /** The desktop's layout when the link was made, and again at Start: what Pots sets back at the end. */
  layout: string | null;
  ended_at: number | null;
  /** What the person wrote when they handed the desktop back. */
  note: string | null;
  restored_at: number | null;
  woken_at: number | null;
}

/** A desktop link as its page and pots page list see it. */
export interface DesktopView {
  readonly id: string;
  readonly state: Stored;
  readonly text: string;
  readonly input: InputKind | null;
  readonly area: readonly [number, number, number, number] | null;
  readonly minutes: number;
  readonly expiresAt: number;
  readonly startedAt: number | null;
  /** Whether the desktop can take the shape of the person's screen. */
  readonly resizable: boolean;
  /** The desktop's size at Start (before it, when the link was made). */
  readonly size: { width: number; height: number } | null;
  /** This browser pressed Start. */
  readonly mine: boolean;
  readonly madeFor: string | null;
}

export type StartResult = { ok: true; secret: string; view: DesktopView } | { ok: false; status: number; code: string; error: string };

export interface DesktopOptions {
  readonly sql: Sql;
  /** The bot's folder: the holder of its screen lease. */
  readonly dir: string;
  readonly name: () => string;
  /** bot.json's vnc, read at each use. */
  readonly vnc: () => VncSetting | undefined;
  readonly secretsDir: string;
  /** The bot's screen, whose lease the person holds while a link is started. */
  readonly screen: () => Screen | undefined;
  /** The screen leases; by default the one store of this process. */
  readonly leases?: () => ScreenLeases;
  /** Wake the bot now with this note, once per request ID. */
  readonly wake: (note: string, requestId: string) => Promise<unknown>;
  readonly print: Print;
  readonly clock?: () => number;
}

/** A link that is open or started, in this process. */
interface Live {
  timer?: ReturnType<typeof setTimeout>;
  restoreTimer?: ReturnType<typeof setTimeout>;
  streams: Set<Stream>;
  lease?: { done(): void };
  /** Restores and new connections, one after another. */
  queue: Promise<unknown>;
}

interface Stream {
  close(code: number, reason: string): void;
}

/**
 * The Starts of this process, one after another: between the check that nobody uses the screen and the binding, a
 * Start waits for the VNC server, and two links must not both pass the check meanwhile.
 */
let starting: Promise<unknown> = Promise.resolve();

const linkId = (row: { id: number }) => `D${row.id}`;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const madeFor = (person: string | null) => person ?? "anyone";

/** The desktop links of one bot, in its bot.sqlite, and their connections. */
export class BotDesktop {
  readonly #options: DesktopOptions;
  readonly #sql: Sql;
  readonly #clock: () => number;
  readonly #live = new Map<number, Live>();
  #stopped = false;
  #wakeRetry: ReturnType<typeof setTimeout> | undefined;

  private constructor(options: DesktopOptions) {
    this.#options = options;
    this.#sql = options.sql;
    this.#clock = options.clock ?? Date.now;
  }

  static async open(options: DesktopOptions): Promise<BotDesktop> {
    await options.sql.exec(SCHEMA);
    return new BotDesktop(options);
  }

  #leases(): ScreenLeases {
    return this.#options.leases?.() ?? ScreenLeases.shared();
  }

  /** The VNC server of bot.json, with its password read now. */
  #target(): VncTarget {
    const vnc = this.#options.vnc();
    if (!vnc) {
      throw new VncError(
        'bot.json has no "vnc": a desktop page needs a VNC server that shows your screen on this computer, set as "vnc": {"port": 5900, "passwordFile": "vnc.env"}; the desktop-page skill says how to set one up',
      );
    }
    if (!vnc.passwordFile) return { port: vnc.port, password: undefined };
    const file = isAbsolute(expandHome(vnc.passwordFile)) ? expandHome(vnc.passwordFile) : join(this.#options.secretsDir, vnc.passwordFile);
    return { port: vnc.port, password: readVncPassword(file), passwordFile: file };
  }

  // ---- Links ----

  /** pots page desktop: check that the VNC server answers, then make a link, written before it is given out. */
  async create(input: { text: string; input?: string; area?: string; minutes?: number; person?: string }): Promise<{ id: string; token: string; expiresAt: number }> {
    const text = input.text.trim();
    if (!text) throw new Error("--text is required: what the person should do on your screen, and when to press Done");
    if (text.length > MAX_TEXT) throw new Error(`--text is longer than ${MAX_TEXT} characters`);
    if (input.input !== undefined && !(INPUT_KINDS as readonly string[]).includes(input.input)) throw new Error(`bad --input ${JSON.stringify(input.input)}: password, code or text`);
    const area = input.area === undefined ? null : parseArea(input.area);
    const minutes = input.minutes ?? DESKTOP_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > DESKTOP_MAX_MINUTES) throw new Error(`bad --minutes: a whole number from 1 to ${DESKTOP_MAX_MINUTES}`);
    const person = input.person?.trim() || null;
    if (person && (person.length > 200 || /[\u0000-\u001f\u007f]/.test(person))) throw new Error("bad --for: a person's address, on one line");
    // A link to a desktop that Pots cannot reach would only fail in the person's hands.
    const layout = await readDesktopLayout(this.#target(), VNC_TIMEOUT_MS);
    const token = randomBytes(18).toString("base64url");
    const now = this.#clock();
    const expiresAt = now + DESKTOP_UNOPENED_MS;
    const id = await this.#sql.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO bot_desktop_links (token, text, input, area, minutes, made_for, created_at, expires_at, state, layout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
        token,
        text,
        (input.input as InputKind | undefined) ?? null,
        area ? JSON.stringify(area) : null,
        minutes,
        person,
        now,
        expiresAt,
        JSON.stringify(layout),
      );
      return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
    });
    this.#arm(id, expiresAt);
    this.#options.print("desktop link made", { link: `D${id}`, desktop: sizeText(layout), resizable: layout.screens !== undefined });
    return { id: `D${id}`, token, expiresAt };
  }

  async #row(token: string): Promise<DesktopRow | undefined> {
    return this.#sql.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE token = ?", token);
  }

  /** A row's state now: a live link past its time counts as expired, before its timer has run. */
  #state(row: DesktopRow): Stored {
    return (row.state === "open" || row.state === "started") && row.expires_at <= this.#clock() ? "expired" : row.state;
  }

  #mine(row: DesktopRow, secret: string | undefined): boolean {
    if (!row.browser || !secret) return false;
    const given = Buffer.from(hash(secret), "hex");
    const kept = Buffer.from(row.browser, "hex");
    return given.length === kept.length && timingSafeEqual(given, kept);
  }

  #view(row: DesktopRow, secret?: string): DesktopView {
    const layout = row.layout ? (JSON.parse(row.layout) as DesktopLayout) : null;
    return {
      id: linkId(row),
      state: this.#state(row),
      text: row.text,
      input: row.input,
      area: row.area ? (JSON.parse(row.area) as [number, number, number, number]) : null,
      minutes: row.minutes,
      expiresAt: row.expires_at,
      startedAt: row.started_at,
      resizable: layout?.screens !== undefined,
      size: layout ? { width: layout.width, height: layout.height } : null,
      mine: this.#mine(row, secret),
      madeFor: row.made_for,
    };
  }

  /** The link with this token, for its page; undefined when there is none. Looking never starts or uses it. */
  async view(token: string, secret?: string): Promise<DesktopView | undefined> {
    const row = await this.#row(token);
    if (!row) return undefined;
    if (this.#state(row) !== row.state) await this.checkExpiry();
    return this.#view(row, secret);
  }

  /**
   * The person pressed Start. The first browser to do so keeps the link: it gets a new secret for its cookie. The same
   * browser may press it again (the page reloaded, or it was opened again), and keeps its secret. Before the link is
   * bound, Pots checks that it reaches the desktop, and reads the desktop's layout to set back at the end.
   */
  async start(token: string, secret: string | undefined): Promise<StartResult> {
    const row = await this.#row(token);
    if (!row) return { ok: false, status: 404, code: "missing", error: "This link does not work." };
    const state = this.#state(row);
    if (state === "started") {
      if (!this.#mine(row, secret)) return { ok: false, status: 409, code: "elsewhere", error: "This link is open on another device." };
      this.#hold(row.id);
      return { ok: true, secret: secret!, view: this.#view(row, secret) };
    }
    if (state !== "open") return { ok: false, status: 410, code: state, error: "This link has ended." };
    const turn = starting.then(() => this.#bind(row, secret));
    starting = turn.catch(() => {});
    return turn;
  }

  /** The rest of a Start, alone among the Starts of this process. */
  async #bind(row: DesktopRow, secret: string | undefined): Promise<StartResult> {
    const busy = await this.#busy(row.id);
    if (busy) return { ok: false, status: 409, code: "busy", error: `Someone is using this desktop through another link (${busy}).` };
    let layout: DesktopLayout;
    try {
      layout = await readDesktopLayout(this.#target(), VNC_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.print("desktop page could not reach the desktop", { link: linkId(row), error: reason });
      await this.#options
        .wake(
          `desktop page: someone pressed Start on link ${linkId(row)} (made for ${madeFor(row.made_for)}), but Pots could not reach your desktop: ${reason}. Their page says so; the link still works, and Start tries again.`,
          `desktop:${linkId(row)}:unreachable`,
        )
        .catch((wakeError: unknown) => this.#options.print("desktop page wake failed", { link: linkId(row), error: String(wakeError) }));
      return { ok: false, status: 503, code: "unreachable", error: reason };
    }
    const fresh = randomBytes(32).toString("base64url");
    const now = this.#clock();
    const bound = await this.#sql.transaction(async (tx) => {
      const current = await tx.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", row.id);
      if (!current || this.#state(current) !== "open") return current;
      // The same browser pressed Start twice at once: the first one bound it.
      if (current.state === "started") return current;
      await tx.run(
        "UPDATE bot_desktop_links SET state = 'started', started_at = ?, browser = ?, layout = ?, expires_at = ? WHERE id = ?",
        now,
        hash(fresh),
        JSON.stringify(layout),
        now + current.minutes * 60_000,
        row.id,
      );
      return await tx.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", row.id);
    });
    if (!bound || bound.browser !== hash(fresh)) {
      // Another browser was a moment faster, or the link ended meanwhile.
      if (bound && this.#state(bound) === "started") {
        if (this.#mine(bound, secret)) return { ok: true, secret: secret!, view: this.#view(bound, secret) };
        return { ok: false, status: 409, code: "elsewhere", error: "This link is open on another device." };
      }
      return { ok: false, status: 410, code: bound ? this.#state(bound) : "missing", error: "This link has ended." };
    }
    this.#arm(row.id, bound.expires_at);
    this.#hold(row.id);
    this.#options.print("desktop page started", { link: linkId(row), desktop: sizeText(layout) });
    return { ok: true, secret: fresh, view: this.#view(bound, fresh) };
  }

  /** Another link that a person uses on this screen now, of this bot or another one; undefined when there is none. */
  async #busy(id: number): Promise<string | undefined> {
    const other = await this.#sql.get<{ id: number }>("SELECT id FROM bot_desktop_links WHERE state = 'started' AND expires_at > ? AND id != ?", this.#clock(), id);
    if (other) return linkId(other);
    const key = this.#options.screen()?.key;
    if (key === undefined) return undefined;
    try {
      const lease = this.#leases().holder(key);
      const link = lease ? /^desktop:(D\d+)$/.exec(lease.conversation)?.[1] : undefined;
      if (link && !(lease!.bot === this.#options.dir && link === `D${id}`)) return lease!.bot === this.#options.dir ? link : `${link} of ${lease!.name}`;
    } catch (error) {
      this.#options.print("could not read the screen lease", { error: String(error) });
    }
    return undefined;
  }

  /** The person handed the desktop back: done, or they could not do the step. */
  async end(token: string, secret: string | undefined, how: "done" | "cannot", note: string): Promise<{ ok: true; restored: boolean } | { ok: false; status: number; error: string }> {
    const row = await this.#row(token);
    if (!row) return { ok: false, status: 404, error: "This link does not work." };
    if (!this.#mine(row, secret)) return { ok: false, status: 403, error: "Only the device that pressed Start can hand the desktop back." };
    if (this.#state(row) !== "started") return { ok: false, status: 410, error: "This link has ended." };
    const text = note.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, MAX_NOTE);
    const restored = await this.#finish(row.id, how, text || null);
    return { ok: true, restored: restored === "set" };
  }

  /** pots page unlink: by link ID (D3) or token. The link ID, or undefined when it is not a desktop link of this bot. */
  async revoke(link: string): Promise<string | undefined> {
    const number = /^D(\d+)$/.exec(link);
    const row = number
      ? await this.#sql.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", Number(number[1]))
      : /^[A-Za-z0-9_-]{16,128}$/.test(link)
        ? await this.#row(link)
        : undefined;
    if (!row || row.state === "revoked") return undefined;
    await this.#finish(row.id, "revoked", null);
    return linkId(row);
  }

  /** For pots page list: the links of the last 7 days. */
  async list(): Promise<
    {
      link: string;
      token: string;
      for: string | null;
      text: string;
      created: number;
      expires: number;
      state: Stored;
      started: number | null;
      ended: number | null;
      connected: boolean;
    }[]
  > {
    const rows = await this.#sql.all<DesktopRow>("SELECT * FROM bot_desktop_links WHERE state != 'revoked' ORDER BY id");
    return rows.map((row) => ({
      link: linkId(row),
      token: row.token,
      for: row.made_for,
      text: row.text,
      created: row.created_at,
      expires: row.expires_at,
      state: this.#state(row),
      started: row.started_at,
      ended: row.ended_at,
      connected: (this.#live.get(row.id)?.streams.size ?? 0) > 0,
    }));
  }

  // ---- Ends ----

  #liveOf(id: number): Live {
    let live = this.#live.get(id);
    if (!live) {
      live = { streams: new Set(), queue: Promise.resolve() };
      this.#live.set(id, live);
    }
    return live;
  }

  /** Run checkExpiry when the link's time comes. */
  #arm(id: number, expiresAt: number): void {
    if (this.#stopped) return;
    const live = this.#liveOf(id);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => void this.checkExpiry(), Math.max(0, expiresAt - this.#clock()) + 50).unref();
  }

  /** End the live links whose time has come. The timers call it; tests that move the clock call it too. */
  async checkExpiry(): Promise<void> {
    const due = await this.#sql.all<DesktopRow>("SELECT * FROM bot_desktop_links WHERE state IN ('open', 'started') AND expires_at <= ?", this.#clock());
    for (const row of due) await this.#finish(row.id, "expired", null);
  }

  /**
   * End a link: its new state goes into the table first, so a crash after it finishes the rest at the next start. Then
   * its connections close, the desktop's size is set back to the one at Start, the screen lease goes, and the bot is
   * woken, but not for a link it took back itself. The result of setting the size back, when the link was started.
   */
  async #finish(id: number, state: "done" | "cannot" | "expired" | "revoked", note: string | null): Promise<string | undefined> {
    const now = this.#clock();
    const ended = await this.#sql.transaction(async (tx) => {
      const row = await tx.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", id);
      if (!row || (row.state !== "open" && row.state !== "started")) return undefined;
      await tx.run("UPDATE bot_desktop_links SET state = ?, ended_at = ?, note = ? WHERE id = ?", state, now, note, id);
      return { ...row, state, ended_at: now, note };
    });
    if (!ended) return undefined;
    const live = this.#live.get(id);
    this.#live.delete(id);
    if (live) {
      clearTimeout(live.timer);
      clearTimeout(live.restoreTimer);
      for (const stream of live.streams) stream.close(4000, `link ${state}`);
    }
    this.#options.print("desktop page ended", { link: linkId(ended), state });
    return this.#settle(ended, live);
  }

  /** The steps after a link ended: set the size back, give the screen back, wake the bot. Each step is recorded. */
  async #settle(row: DesktopRow, live: Live | undefined): Promise<string | undefined> {
    let restored: string | undefined;
    if (row.started_at !== null && row.restored_at === null) {
      if (live) await live.queue.catch(() => {});
      restored = await this.#restore(row);
      await this.#sql.run("UPDATE bot_desktop_links SET restored_at = ? WHERE id = ?", this.#clock(), row.id);
    }
    this.#letGo(row.id, live);
    if (row.state !== "revoked" && row.woken_at === null) {
      try {
        await this.#options.wake(this.#endNote(row, restored), `desktop:${linkId(row)}`);
        await this.#sql.run("UPDATE bot_desktop_links SET woken_at = ? WHERE id = ?", this.#clock(), row.id);
      } catch (error) {
        this.#options.print("desktop page wake failed", { link: linkId(row), error: String(error) });
        this.#retryWakes();
      }
    }
    return restored;
  }

  /** Set the wakes that failed after a while, and again while one fails; the next start does too. */
  #retryWakes(): void {
    if (this.#wakeRetry || this.#stopped) return;
    this.#wakeRetry = setTimeout(() => {
      this.#wakeRetry = undefined;
      void this.#sql
        .all<DesktopRow>("SELECT * FROM bot_desktop_links WHERE state IN ('done', 'cannot', 'expired') AND woken_at IS NULL")
        .then(async (rows) => {
          for (const row of rows) await this.#settle(row, undefined);
        })
        .catch((error: unknown) => {
          this.#options.print("desktop page wake failed", { error: String(error) });
          this.#retryWakes();
        });
    }, desktopTimes.wakeRetryMs).unref();
  }

  #endNote(row: DesktopRow, restored: string | undefined): string {
    const link = `link ${linkId(row)} (made for ${madeFor(row.made_for)})`;
    const note = row.note ? ` Their note: ${JSON.stringify(row.note)}.` : " They left no note.";
    const layout = row.layout ? (JSON.parse(row.layout) as DesktopLayout) : undefined;
    const size =
      restored === undefined || !layout
        ? ""
        : restored === "set"
          ? ` Its size is back to ${sizeText(layout)}, as at Start.`
          : restored === "same" || restored === "unsupported"
            ? ""
            : ` Pots could not set its size back to ${sizeText(layout)}, as at Start: ${restored}.`;
    const yours = ` The screen is yours again.${size}`;
    if (row.state === "done") return `desktop page: someone handed your desktop back on ${link} and pressed Done: the step is done, they say.${note}${yours}`;
    if (row.state === "cannot") return `desktop page: someone handed your desktop back on ${link} without doing the step: they pressed "I can't do it".${note}${yours}`;
    if (row.started_at === null) return `desktop page: ${link} expired at ${formatTime(row.expires_at)}: nobody pressed Start within an hour.`;
    return `desktop page: ${link} ended at ${formatTime(row.expires_at)}, ${row.minutes} minutes after Start, and nobody pressed Done.${yours}`;
  }

  /** Set the desktop back to its layout at Start. What happened, in words, or undefined when there was nothing to do. */
  async #restore(row: DesktopRow): Promise<string | undefined> {
    const layout = row.layout ? (JSON.parse(row.layout) as DesktopLayout) : undefined;
    if (!layout?.screens) return undefined;
    try {
      const result = await restoreDesktopLayout(this.#target(), layout, VNC_TIMEOUT_MS);
      if (result !== "same") this.#options.print("desktop size set back", { link: linkId(row), size: sizeText(layout), result });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.print("desktop size not set back", { link: linkId(row), error: reason });
      return reason;
    }
  }

  // ---- The screen ----

  /** The person takes the bot's screen lease, also from an agent that holds it. */
  #hold(id: number): void {
    const live = this.#liveOf(id);
    if (live.lease) return;
    const key = this.#options.screen()?.key;
    if (key === undefined) return;
    try {
      live.lease = this.#leases().seize(key, {
        bot: this.#options.dir,
        name: this.#options.name(),
        agent: `a person, through desktop page link D${id}`,
        conversation: desktopHolder(`D${id}`),
      });
    } catch (error) {
      this.#options.print("could not take the screen for a desktop page", { link: `D${id}`, error: String(error) });
    }
  }

  #letGo(id: number, live: Live | undefined): void {
    const held = live?.lease !== undefined;
    live?.lease?.done();
    if (live) live.lease = undefined;
    // A bot with no screen never opened the lease file; it need not open it now.
    if (!held && this.#options.screen()?.key === undefined) return;
    try {
      this.#leases().release(this.#options.dir, desktopHolder(`D${id}`));
    } catch (error) {
      this.#options.print("could not give the screen back after a desktop page", { link: `D${id}`, error: String(error) });
    }
  }

  // ---- Connections ----

  /**
   * Carry a browser's WebSocket to the VNC server, for a started link of this browser. A new connection takes the place
   * of the one before (another tab, or the page loaded again). False when the link does not take it.
   */
  async attach(token: string, secret: string | undefined, ws: WebSocket): Promise<boolean> {
    const row = await this.#row(token);
    if (!row || this.#state(row) !== "started" || !this.#mine(row, secret) || this.#stopped) {
      ws.close(4000, "link not started");
      return false;
    }
    const live = this.#liveOf(row.id);
    clearTimeout(live.restoreTimer);
    for (const stream of live.streams) stream.close(4001, "opened again");
    const link = linkId(row);
    let closed = false;
    let socketClose: (() => void) | undefined;
    const stream: Stream = {
      close: (code, reason) => {
        if (closed) return;
        closed = true;
        socketClose?.();
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
        setTimeout(() => ws.terminate(), 2_000).unref();
      },
    };
    live.streams.add(stream);
    const forget = () => {
      if (!live.streams.delete(stream)) return;
      // The browser may come back; if it does not, the desktop gets its size back after a while.
      if (live.streams.size === 0 && this.#live.get(row.id) === live && !this.#stopped) {
        clearTimeout(live.restoreTimer);
        live.restoreTimer = setTimeout(() => {
          live.queue = live.queue.then(async () => {
            if (live.streams.size > 0 || this.#live.get(row.id) !== live) return;
            const current = await this.#sql.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", row.id);
            if (current && this.#state(current) === "started") await this.#restore(current);
          });
        }, desktopTimes.restoreAfterMs).unref();
      }
    };
    ws.once("close", () => {
      closed = true;
      socketClose?.();
      forget();
    });

    // What the browser sends before the bridge is ready waits in a reader.
    const fromBrowser = new Reader();
    const early = (data: RawData) => fromBrowser.push(bytesOf(data));
    ws.on("message", early);
    ws.once("close", () => fromBrowser.fail(new Error("the browser closed the connection")));
    ws.on("error", (error) => this.#options.print("desktop page connection error", { link, error: error.message }));
    await live.queue.catch(() => {});
    if (closed) return true;
    let vnc: Awaited<ReturnType<typeof connectVnc>>;
    try {
      vnc = await connectVnc(this.#target(), VNC_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.print("desktop page lost the desktop", { link, error: reason });
      // The person waits on a page that tries again by itself; the bot may be able to bring the server back.
      await this.#options
        .wake(
          `desktop page: the person on link ${link} (made for ${madeFor(row.made_for)}) lost your desktop: Pots could not reach it: ${reason}. Their page tries again by itself until the link ends.`,
          `desktop:${link}:lost`,
        )
        .catch((wakeError: unknown) => this.#options.print("desktop page wake failed", { link, error: String(wakeError) }));
      stream.close(4002, "Pots could not reach the desktop");
      return true;
    }
    try {
      socketClose = () => vnc.socket.destroy();
      if (closed) {
        vnc.socket.destroy();
        return true;
      }
      vnc.socket.once("close", () => stream.close(4002, "the VNC server closed the connection"));
      // The browser signs in with no password: Pots has signed in already.
      const browser: Channel = { read: (n) => fromBrowser.read(n), write: (data) => ws.send(data) };
      browser.write(Buffer.from("RFB 003.008\n", "latin1"));
      const version = (await browser.read(12)).toString("latin1");
      if (version !== "RFB 003.008\n") throw new Error(`the browser speaks ${JSON.stringify(version)}`);
      browser.write(Buffer.from([1, 1]));
      if ((await browser.read(1))[0] !== 1) throw new Error("the browser chose a sign-in Pots did not offer");
      browser.write(Buffer.alloc(4));
      // ClientInit: whatever the browser asks, the desktop stays shared with its other viewers.
      await browser.read(1);
      vnc.write(Buffer.from([1]));
      const init = await readServerInit(vnc);
      browser.write(init.bytes);
      // From here on, bytes go both ways as they come.
      ws.off("message", early);
      const rest = fromBrowser.take();
      if (rest.length > 0) vnc.write(rest);
      ws.on("message", (data: RawData) => {
        if (!vnc.socket.write(bytesOf(data))) {
          ws.pause();
          vnc.socket.once("drain", () => ws.resume());
        }
      });
      let waiting: ReturnType<typeof setInterval> | undefined;
      vnc.handOver((chunk) => {
        if (closed) return;
        ws.send(chunk);
        if (ws.bufferedAmount > HIGH_WATER && !waiting) {
          vnc.socket.pause();
          waiting = setInterval(() => {
            if (!closed && ws.bufferedAmount > HIGH_WATER / 8) return;
            clearInterval(waiting);
            waiting = undefined;
            vnc.socket.resume();
          }, 50);
        }
      });
      // Pings keep proxies from closing a quiet connection, and find one whose browser has gone.
      let answered = true;
      ws.on("pong", () => (answered = true));
      const ping = setInterval(() => {
        if (!answered) return stream.close(4003, "the browser stopped answering");
        answered = false;
        ws.ping();
      }, desktopTimes.pingMs);
      ws.once("close", () => {
        clearInterval(ping);
        clearInterval(waiting);
        vnc.socket.destroy();
      });
      this.#options.print("desktop page connected", { link, desktop: `${init.width}×${init.height}` });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!closed) this.#options.print("desktop page connection failed", { link, error: reason });
      stream.close(4002, reason.slice(0, 120));
    }
    return true;
  }

  // ---- Start and stop ----

  /**
   * At a start, before the agents run: a person who had a started link keeps the screen, as before the stop. The
   * page connects again by itself.
   */
  async holdScreens(): Promise<void> {
    const rows = await this.#sql.all<DesktopRow>("SELECT * FROM bot_desktop_links WHERE state = 'started' AND expires_at > ?", this.#clock());
    for (const row of rows) this.#hold(row.id);
  }

  /**
   * After a start: end the links whose time came while Pots was stopped, finish ends a stop or a crash cut off (the
   * size, the screen, the wake), and set the timers of the others.
   */
  async resume(): Promise<void> {
    for (const row of await this.#sql.all<DesktopRow>("SELECT * FROM bot_desktop_links WHERE state IN ('open', 'started')")) this.#arm(row.id, row.expires_at);
    await this.checkExpiry();
    const unfinished = await this.#sql.all<DesktopRow>(
      "SELECT * FROM bot_desktop_links WHERE state IN ('done', 'cannot', 'expired', 'revoked') AND ((started_at IS NOT NULL AND restored_at IS NULL) OR (state != 'revoked' AND woken_at IS NULL))",
    );
    for (const row of unfinished) await this.#settle(row, undefined);
  }

  /** The gateway stops: close the connections, and set the desktop's size back. The links stay; after the start they go on. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#wakeRetry);
    const lives = [...this.#live.entries()];
    for (const [, live] of lives) {
      clearTimeout(live.timer);
      clearTimeout(live.restoreTimer);
      for (const stream of live.streams) stream.close(1012, "Pots is restarting");
    }
    await Promise.all(
      lives.map(async ([id, live]) => {
        await live.queue.catch(() => {});
        const row = await this.#sql.get<DesktopRow>("SELECT * FROM bot_desktop_links WHERE id = ?", id).catch(() => undefined);
        if (row && row.state === "started") await this.#restore(row);
        this.#letGo(id, live);
      }),
    );
    this.#live.clear();
  }

  /** Forget desktop links 7 days after they were made, once they ended. */
  async cleanup(): Promise<void> {
    await this.#sql.run(
      "DELETE FROM bot_desktop_links WHERE created_at < ? AND state NOT IN ('open', 'started') AND (started_at IS NULL OR restored_at IS NOT NULL) AND (state = 'revoked' OR woken_at IS NOT NULL)",
      this.#clock() - KEEP_MS,
    );
  }
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** --area x,y,width,height: whole numbers, in the desktop's pixels. */
function parseArea(text: string): [number, number, number, number] {
  const parts = text.split(",").map((part) => part.trim());
  const numbers = parts.map(Number);
  if (parts.length !== 4 || numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 65_535) || numbers[2] === 0 || numbers[3] === 0) {
    throw new Error(`bad --area ${JSON.stringify(text)}: x,y,width,height in your screen's pixels, such as 440,300,400,260`);
  }
  return numbers as [number, number, number, number];
}
