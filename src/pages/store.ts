import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Screen, ScreenLeases } from "../agent/screen.ts";
import type { VncSetting } from "../bot/definition.ts";
import { CLAIM_LINE, writeSecrets } from "../core/env-file.ts";
import type { Sql } from "../core/sql.ts";
import type { Print } from "../gateway/config.ts";
import { BotDesktop } from "./desktop.ts";
import { folderVersion, identity, listPageNames, pageFolder, pageNameProblem } from "./files.ts";

// A bot's pages and links, in its own bot.sqlite: each link is written before it is given out, so it works after a
// restart; it goes with its page, or with the bot. A link is to one folder: when that folder is deleted, or another
// folder takes its name, the link is dead for good. Secret values never come here: a password page's link keeps only
// its file, its key names, its times and the ID of the submission that claimed it.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_pages (
  name TEXT PRIMARY KEY,
  version TEXT,
  changed_at INTEGER NOT NULL,
  opened_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  page TEXT NOT NULL,
  made_for TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  folder TEXT
);
CREATE INDEX IF NOT EXISTS bot_page_links_page ON bot_page_links (page);
CREATE TABLE IF NOT EXISTS bot_secret_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  file TEXT NOT NULL,
  keys TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  made_for TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  claimed_at INTEGER,
  used_at INTEGER,
  woken_at INTEGER,
  claim TEXT
);
`;

/** Columns that came after the tables, added to a bot.sqlite from before them. */
const ADDED_COLUMNS = [
  ["bot_page_links", "folder", "TEXT"],
  ["bot_secret_links", "claim", "TEXT"],
] as const;

const DAY_MS = 86_400_000;
/** A page under pages/, not pages/keep/, that nobody opened or linked and nothing changed for this long is deleted with its links. */
export const PAGE_DAYS = 30;
/** A password page's wake that failed is tried again after this long. For tests: change ms. */
export const secretWakeRetry = { ms: 10_000 };
/** A password link that was not submitted stops working after this long. */
export const SECRET_LINK_MS = 3_600_000;
/** Password links are listed and kept this long after they were made. */
const SECRET_KEEP_MS = 7 * DAY_MS;
/** An open is written at most this often per page: a page loads many files, and a live page asks for its version often. */
const OPEN_WRITE_MS = 60_000;
/** Random bytes of a token: 144 bits, 24 base64url characters. */
const TOKEN_BYTES = 18;

const SECRET_FILE = /^\w[\w.-]{0,99}$/;
const SECRET_KEY = /^[A-Za-z_]\w{0,99}$/;
const MAX_KEYS = 20;
const MAX_TEXT = 2_000;

interface PageRow {
  name: string;
  version: string | null;
  changed_at: number;
  opened_at: number | null;
}

/** A page with the time its newest link was made, which counts as activity for the cleanup. */
const PAGE_ACTIVITY = "SELECT p.*, (SELECT MAX(l.created_at) FROM bot_page_links l WHERE l.page = p.name) AS linked_at FROM bot_pages p";

interface LinkRow {
  id: number;
  token: string;
  page: string;
  made_for: string | null;
  created_at: number;
  /** The identity of the page folder the link was made for (device and inode). */
  folder: string | null;
}

interface SecretRow {
  id: number;
  token: string;
  file: string;
  keys: string;
  text: string;
  made_for: string | null;
  created_at: number;
  expires_at: number;
  state: "open" | "writing" | "used" | "revoked";
  claimed_at: number | null;
  used_at: number | null;
  woken_at: number | null;
  /** The ID of the submission that claimed the link, also in a comment line of the file it wrote. */
  claim: string | null;
}

/** A page link someone opened: what the page server needs to serve it and to tell the bot. */
export interface OpenedLink {
  readonly id: string;
  readonly page: string;
  readonly madeFor: string | null;
}

export interface SecretView {
  readonly id: string;
  readonly file: string;
  readonly keys: readonly string[];
  readonly text: string;
  readonly expiresAt: number;
  readonly state: "open" | "used" | "expired";
}

export type SecretResult = "saved" | "used" | "expired" | "missing" | { readonly problem: string };

export interface PageListing {
  pages: {
    page: string;
    kept: boolean;
    version: string | null;
    lastOpened: number | null;
    lastChanged: number | null;
    links: { link: string; token: string; for: string | null; created: number }[];
  }[];
  secretLinks: { link: string; token: string; file: string; keys: string[]; for: string | null; created: number; expires: number; state: "open" | "used" | "expired" }[];
  desktopLinks: Awaited<ReturnType<BotDesktop["list"]>>;
}

export interface BotPagesOptions {
  readonly id: string;
  /** The bot's folder: pages/ is in it. */
  readonly dir: string;
  readonly sql: Sql;
  /** Where password pages write their files. */
  readonly secretsDir: string;
  /** The bot's name, for the password page. */
  readonly name: () => string;
  /** Wake the bot now with this note, once per request ID. */
  readonly wake: (note: string, requestId: string) => Promise<unknown>;
  readonly print: Print;
  /** The wall clock; tests move it. */
  readonly clock?: () => number;
  /** For desktop pages: bot.json's vnc and screen, read at each use, and the screen leases (by default this process's). */
  readonly desktop?: { readonly vnc: () => VncSetting | undefined; readonly screen: () => Screen | undefined; readonly leases?: () => ScreenLeases };
}

/** "made for X", for the notes and the page: who a link was made for, never who used it. */
export const madeFor = (person: string | null) => person ?? "anyone";

const linkId = (row: { id: number }) => `L${row.id}`;
const secretId = (row: { id: number }) => `S${row.id}`;
const newToken = () => randomBytes(TOKEN_BYTES).toString("base64url");

/** The pages and links of one bot. */
export class BotPages {
  readonly id: string;
  readonly dir: string;
  /** The bot's desktop pages. */
  readonly desktop: BotDesktop;
  readonly #sql: Sql;
  readonly #options: BotPagesOptions;
  readonly #clock: () => number;
  #cleaning: ReturnType<typeof setInterval> | undefined;
  /** The next try of password-page wakes that failed, and whether the store stopped, so none is tried after. */
  #wakeRetry: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  /** The cleanup that runs now, which a stop waits for, so it never runs on a closed database. */
  #cleanup: Promise<void> = Promise.resolve();
  /** One change at a time per page: making or opening a link waits while a cleanup deletes the page, and the reverse. */
  readonly #locks = new Map<string, Promise<void>>();
  /** Test hooks: a crash between the steps of a password page's submission. */
  readonly crashTests = { beforeSecretWrite: () => {}, afterSecretWrite: () => {}, afterSecretUsed: () => {} };

  private constructor(options: BotPagesOptions, desktop: BotDesktop) {
    this.id = options.id;
    this.dir = options.dir;
    this.desktop = desktop;
    this.#sql = options.sql;
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  static async open(options: BotPagesOptions): Promise<BotPages> {
    await options.sql.exec(SCHEMA);
    for (const [table, name, type] of ADDED_COLUMNS) {
      const columns = new Set((await options.sql.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name));
      if (!columns.has(name)) await options.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    const desktop = await BotDesktop.open({
      sql: options.sql,
      dir: options.dir,
      name: options.name,
      vnc: options.desktop?.vnc ?? (() => undefined),
      screen: options.desktop?.screen ?? (() => undefined),
      ...(options.desktop?.leases ? { leases: options.desktop.leases } : {}),
      secretsDir: options.secretsDir,
      wake: options.wake,
      print: options.print,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    return new BotPages(options, desktop);
  }

  /** Run work alone for this page, in this process: the one gateway is the only process that serves and cleans. */
  async #withPage<T>(page: string, work: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(page) ?? Promise.resolve();
    const run = before.then(work);
    const after = run.then(
      () => {},
      () => {},
    );
    this.#locks.set(page, after);
    try {
      return await run;
    } finally {
      if (this.#locks.get(page) === after) this.#locks.delete(page);
    }
  }

  /**
   * The identity of the page's folder now, after the links of a folder that is gone, or that another folder of the same
   * name replaced, are taken back for good; a link from before folders were recorded takes the folder it finds. Run
   * under #withPage.
   */
  async #settle(page: string): Promise<string | undefined> {
    const folder = await pageFolder(this.dir, page);
    const current = folder ? await identity(folder) : undefined;
    const now = this.#clock();
    await this.#sql.transaction(async (tx) => {
      if (current === undefined) {
        await tx.run("UPDATE bot_page_links SET revoked_at = ? WHERE page = ? AND revoked_at IS NULL", now, page);
        return;
      }
      await tx.run("UPDATE bot_page_links SET folder = ? WHERE page = ? AND revoked_at IS NULL AND folder IS NULL", current, page);
      await tx.run("UPDATE bot_page_links SET revoked_at = ? WHERE page = ? AND revoked_at IS NULL AND folder != ?", now, page, current);
    });
    return current;
  }

  get botName(): string {
    return this.#options.name();
  }

  /**
   * After a start: finish what a stop or a crash cut off between the steps of a password page's submission. A link
   * claimed whose file was written is marked used; one whose file was not is open again, so the person can send it
   * again. A link used whose wake was not set wakes the bot now, once.
   */
  async resume(): Promise<void> {
    await this.desktop.resume();
    for (const row of await this.#sql.all<SecretRow>("SELECT * FROM bot_secret_links WHERE state = 'writing'")) {
      // Only the claim's own line in the file shows that its write happened: a file with the keys may be an older one.
      if (await this.#written(row)) await this.#sql.run("UPDATE bot_secret_links SET state = 'used', used_at = ? WHERE id = ?", this.#clock(), row.id);
      else await this.#sql.run("UPDATE bot_secret_links SET state = 'open', claimed_at = NULL, claim = NULL WHERE id = ?", row.id);
    }
    await this.#wakePending();
  }

  /** Set the wake of each used password link that has none. */
  async #wakePending(): Promise<void> {
    for (const row of await this.#sql.all<SecretRow>("SELECT * FROM bot_secret_links WHERE state = 'used' AND woken_at IS NULL")) await this.#wakeSecret(row);
  }

  /** Try the wakes that failed again after secretWakeRetry.ms, and again after that while one fails. */
  #retryWakes(): void {
    if (this.#wakeRetry || this.#stopped) return;
    this.#wakeRetry = setTimeout(() => {
      this.#wakeRetry = undefined;
      this.#wakePending().catch((error: unknown) => {
        this.#options.print("secret page wake failed", { error: error instanceof Error ? error.message : String(error) });
        this.#retryWakes();
      });
    }, secretWakeRetry.ms).unref();
  }

  /** Delete old pages now, and then once a day, on the wall clock. */
  startCleanup(): void {
    const clean = () => {
      this.#cleanup = this.#cleanup
        .then(() => this.cleanup())
        .then(
          () => {},
          (error: unknown) => this.#options.print("pages cleanup failed", { error: String(error) }),
        );
    };
    clean();
    this.#cleaning = setInterval(clean, DAY_MS).unref();
  }

  stopCleanup(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#cleaning);
    clearTimeout(this.#wakeRetry);
    return this.#cleanup;
  }

  // ---- Links ----

  async createLink(page: string, person?: string): Promise<{ id: string; token: string }> {
    const problem = pageNameProblem(page);
    if (problem) throw new Error(problem);
    const forPerson = personProblem(person);
    return this.#withPage(page, async () => {
      const folder = await this.#settle(page);
      if (!folder) throw new Error(`there is no page folder pages/${page}/ (or it is a symbolic link); write pages/${page}/index.html first`);
      await this.#observe(page);
      const token = newToken();
      const now = this.#clock();
      const id = await this.#sql.transaction(async (tx) => {
        await tx.run("INSERT INTO bot_page_links (token, page, made_for, created_at, folder) VALUES (?, ?, ?, ?, ?)", token, page, forPerson, now, folder);
        return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
      });
      return { id: linkId({ id }), token };
    });
  }

  async createSecretLink(input: { file: string; keys: readonly string[]; text?: string; person?: string }): Promise<{ id: string; token: string; expiresAt: number }> {
    if (!SECRET_FILE.test(input.file)) throw new Error(`bad --file ${JSON.stringify(input.file)}: a file name in the secrets folder, such as slack.env`);
    if (input.keys.length === 0 || input.keys.length > MAX_KEYS) throw new Error(`give 1 to ${MAX_KEYS} keys with --keys, such as SLACK_APP_TOKEN,SLACK_BOT_TOKEN`);
    for (const key of input.keys) if (!SECRET_KEY.test(key)) throw new Error(`bad key ${JSON.stringify(key)}: letters, digits and "_", not starting with a digit`);
    if (new Set(input.keys).size !== input.keys.length) throw new Error("a key is given twice");
    const text = input.text ?? "";
    if (text.length > MAX_TEXT) throw new Error(`--text is longer than ${MAX_TEXT} characters`);
    const forPerson = personProblem(input.person);
    const token = newToken();
    const now = this.#clock();
    const expiresAt = now + SECRET_LINK_MS;
    const id = await this.#sql.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO bot_secret_links (token, file, keys, text, made_for, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
        token,
        input.file,
        JSON.stringify(input.keys),
        text,
        forPerson,
        now,
        expiresAt,
      );
      return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
    });
    return { id: secretId({ id }), token, expiresAt };
  }

  /** Revoke a link by its ID (L3, S2, D1) or its token. The link ID, or undefined when there is no such link. */
  async revoke(link: string): Promise<string | undefined> {
    const desktop = await this.desktop.revoke(link);
    if (desktop) return desktop;
    const now = this.#clock();
    return this.#sql.transaction(async (tx) => {
      const number = /^([LS])(\d+)$/.exec(link);
      const page = number?.[1] === "L" ? await tx.get<LinkRow>("SELECT * FROM bot_page_links WHERE id = ? AND revoked_at IS NULL", Number(number[2])) : undefined;
      const byToken = number ? undefined : await tx.get<LinkRow>("SELECT * FROM bot_page_links WHERE token = ? AND revoked_at IS NULL", link);
      const found = page ?? byToken;
      if (found) {
        await tx.run("UPDATE bot_page_links SET revoked_at = ? WHERE id = ?", now, found.id);
        return linkId(found);
      }
      const secret =
        number?.[1] === "S"
          ? await tx.get<SecretRow>("SELECT * FROM bot_secret_links WHERE id = ? AND state != 'revoked'", Number(number[2]))
          : number
            ? undefined
            : await tx.get<SecretRow>("SELECT * FROM bot_secret_links WHERE token = ? AND state != 'revoked'", link);
      if (!secret) return undefined;
      // A link being used or used stays as it is: its file is written, and its wake goes out.
      if (secret.state === "open") await tx.run("UPDATE bot_secret_links SET state = 'revoked' WHERE id = ?", secret.id);
      return secretId(secret);
    });
  }

  async list(): Promise<PageListing> {
    const names = new Set(await listPageNames(this.dir));
    for (const name of names) await this.#observe(name);
    for (const { page } of await this.#sql.all<{ page: string }>("SELECT DISTINCT page FROM bot_page_links WHERE revoked_at IS NULL")) {
      await this.#withPage(page, () => this.#settle(page));
    }
    const rows = await this.#sql.all<PageRow>("SELECT * FROM bot_pages ORDER BY name");
    const links = await this.#sql.all<LinkRow>("SELECT * FROM bot_page_links WHERE revoked_at IS NULL ORDER BY id");
    const pages: PageListing["pages"] = [];
    for (const name of [...new Set([...names, ...rows.map((row) => row.name)])].sort()) {
      const row = rows.find((item) => item.name === name);
      pages.push({
        page: name,
        kept: name.startsWith("keep/"),
        version: names.has(name) ? (row?.version ?? null) : null,
        lastOpened: row?.opened_at ?? null,
        lastChanged: row?.changed_at ?? null,
        links: links.filter((link) => link.page === name).map((link) => ({ link: linkId(link), token: link.token, for: link.made_for, created: link.created_at })),
      });
    }
    const now = this.#clock();
    const secrets = await this.#sql.all<SecretRow>("SELECT * FROM bot_secret_links WHERE state != 'revoked' ORDER BY id");
    return {
      pages,
      secretLinks: secrets.map((row) => ({
        link: secretId(row),
        token: row.token,
        file: row.file,
        keys: JSON.parse(row.keys) as string[],
        for: row.made_for,
        created: row.created_at,
        expires: row.expires_at,
        state: secretState(row, now),
      })),
      desktopLinks: await this.desktop.list(),
    };
  }

  // ---- Serving ----

  /**
   * The page link with this token, when it is not revoked and its page folder is still the one it was made for; the
   * page counts as opened now. Alone for its page, so a cleanup either sees the open and keeps the page, or deleted the
   * page and its links before it. A link whose folder is gone or replaced is taken back here.
   */
  async openLink(token: string): Promise<OpenedLink | undefined> {
    const found = await this.#sql.get<LinkRow>("SELECT * FROM bot_page_links WHERE token = ? AND revoked_at IS NULL", token);
    if (!found) return undefined;
    return this.#withPage(found.page, async () => {
      await this.#settle(found.page);
      const now = this.#clock();
      return this.#sql.transaction(async (tx) => {
        const link = await tx.get<LinkRow>("SELECT * FROM bot_page_links WHERE token = ? AND revoked_at IS NULL", token);
        if (!link) return undefined;
        await tx.run("UPDATE bot_pages SET opened_at = ? WHERE name = ? AND (opened_at IS NULL OR opened_at < ?)", now, link.page, now - OPEN_WRITE_MS);
        return { id: linkId(link), page: link.page, madeFor: link.made_for };
      });
    });
  }

  /** The page's version now; a change since the last look counts as the page's last change. */
  version(page: string): Promise<string | undefined> {
    return this.#observe(page);
  }

  /** Someone sent answers on a page: wake the bot, once per submission ID. */
  async answer(link: OpenedLink, submission: string, version: string, answers: Record<string, unknown>): Promise<void> {
    const note = `page answer: someone used link ${link.id} (made for ${madeFor(link.madeFor)}) on page ${link.page} (version ${version}): ${JSON.stringify(answers)}`;
    await this.#options.wake(note, `page:${link.id}:${submission}`);
    this.#options.print("page answer", { link: link.id, page: link.page });
  }

  /** A password link, for its page: undefined when there is none or it was revoked. A GET never uses it up. */
  async secretLink(token: string): Promise<SecretView | undefined> {
    const row = await this.#sql.get<SecretRow>("SELECT * FROM bot_secret_links WHERE token = ? AND state != 'revoked'", token);
    if (!row) return undefined;
    return { id: secretId(row), file: row.file, keys: JSON.parse(row.keys) as string[], text: row.text, expiresAt: row.expires_at, state: secretState(row, this.#clock()) };
  }

  /**
   * Someone sent a password page. The first submission of an open link that has every value wins: it claims the link,
   * writes the values to the file, marks the link used and wakes the bot, each step recorded, so resume() finishes the
   * sequence after a crash. The values are only in this call.
   */
  async submitSecret(token: string, form: URLSearchParams): Promise<SecretResult> {
    const now = this.#clock();
    const claim = randomBytes(12).toString("hex");
    const claimed = await this.#sql.transaction(async (tx): Promise<SecretRow | SecretResult> => {
      const row = await tx.get<SecretRow>("SELECT * FROM bot_secret_links WHERE token = ?", token);
      if (!row || row.state === "revoked") return "missing";
      if (row.state !== "open") return "used";
      if (row.expires_at <= now) return "expired";
      const problem = valuesProblem(JSON.parse(row.keys) as string[], form);
      if (problem) return { problem };
      await tx.run("UPDATE bot_secret_links SET state = 'writing', claimed_at = ?, claim = ? WHERE id = ?", now, claim, row.id);
      return row;
    });
    if (typeof claimed === "string" || "problem" in claimed) return claimed;
    const keys = JSON.parse(claimed.keys) as string[];
    this.crashTests.beforeSecretWrite();
    try {
      // The claim's line goes in the same write as the values: after a crash, it alone shows the write happened.
      writeSecrets(join(this.#options.secretsDir, claimed.file), Object.fromEntries(keys.map((key) => [key, form.get(key)!.trim()])), claim);
    } catch (error) {
      await this.#sql.run("UPDATE bot_secret_links SET state = 'open', claimed_at = NULL, claim = NULL WHERE id = ? AND state = 'writing'", claimed.id);
      throw new Error(`could not write ${claimed.file} in the secrets folder: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.crashTests.afterSecretWrite();
    await this.#sql.run("UPDATE bot_secret_links SET state = 'used', used_at = ? WHERE id = ?", this.#clock(), claimed.id);
    this.crashTests.afterSecretUsed();
    try {
      await this.#wakeSecret(claimed);
    } catch (error) {
      // The values are in the file and the link is used, so the person is done. The bot's wake is tried again.
      this.#options.print("secret page wake failed", { link: secretId(claimed), error: error instanceof Error ? error.message : String(error) });
      this.#retryWakes();
    }
    return "saved";
  }

  async #wakeSecret(row: SecretRow): Promise<void> {
    const keys = JSON.parse(row.keys) as string[];
    const id = secretId(row);
    const note = `secret page: someone used link ${id} (made for ${madeFor(row.made_for)}) and wrote ${keys.join(", ")} to ${row.file} in the secrets folder`;
    await this.#options.wake(note, `secret:${id}`);
    await this.#sql.run("UPDATE bot_secret_links SET woken_at = ? WHERE id = ?", this.#clock(), row.id);
    this.#options.print("secret page used", { link: id, file: row.file, keys });
  }

  /** Whether a claimed link's file was written by its claim: the file has the claim's own comment line. */
  async #written(row: SecretRow): Promise<boolean> {
    if (!row.claim) return false;
    const text = await readFile(join(this.#options.secretsDir, row.file), "utf8").catch(() => "");
    return text.split("\n").includes(`${CLAIM_LINE}${row.claim}`);
  }

  // ---- Age ----

  /**
   * Look at a page's files now: a page seen for the first time, or whose version changed since the last look, counts as
   * changed now. Its version, or undefined when its folder is not there.
   */
  async #observe(page: string): Promise<string | undefined> {
    const folder = await pageFolder(this.dir, page);
    const version = folder ? await folderVersion(folder) : undefined;
    if (version === undefined) return undefined;
    const now = this.#clock();
    await this.#sql.run(
      "INSERT INTO bot_pages (name, version, changed_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version, changed_at = excluded.changed_at WHERE bot_pages.version IS NOT excluded.version",
      page,
      version,
      now,
    );
    return version;
  }

  /**
   * Delete each page under pages/ (not pages/keep/) that nobody opened or linked and nothing changed for PAGE_DAYS days, with its
   * links; the records of a page whose folder is gone go by the same rule. Each page is looked at again right before it
   * is deleted, alone for that page until it is gone, so one opened, linked or changed meanwhile stays, and no link is
   * made to it while it goes. Password and desktop links are deleted 7 days after they were made, once they ended. For tests, hooks.beforeDelete
   * runs between the first look and the second, and hooks.beforeRemove after the second, before the folder is removed.
   * The names of the deleted pages.
   */
  async cleanup(hooks: { beforeDelete?: (page: string) => Promise<void>; beforeRemove?: (page: string) => Promise<void> } = {}): Promise<string[]> {
    for (const name of await listPageNames(this.dir)) await this.#observe(name);
    type Activity = PageRow & { linked_at: number | null };
    const stale = (row: Activity, now: number) => Math.max(row.opened_at ?? 0, row.changed_at, row.linked_at ?? 0) < now - PAGE_DAYS * DAY_MS;
    const candidates = (await this.#sql.all<Activity>(PAGE_ACTIVITY)).filter((row) => !row.name.startsWith("keep/") && stale(row, this.#clock()));
    const deleted: string[] = [];
    for (const candidate of candidates) {
      await hooks.beforeDelete?.(candidate.name);
      const gone = await this.#withPage(candidate.name, async () => {
        await this.#observe(candidate.name);
        const row = await this.#sql.get<Activity>(`${PAGE_ACTIVITY} WHERE p.name = ?`, candidate.name);
        if (!row || !stale(row, this.#clock())) return false;
        await hooks.beforeRemove?.(candidate.name);
        // Only a plain folder in pages/: never what a link points to. The records go once the folder is gone; when its
        // removal fails, they stay, and the next cleanup tries again.
        const folder = await pageFolder(this.dir, candidate.name);
        if (folder) await rm(folder, { recursive: true, force: true });
        await this.#sql.transaction(async (tx) => {
          await tx.run("DELETE FROM bot_page_links WHERE page = ?", candidate.name);
          await tx.run("DELETE FROM bot_pages WHERE name = ?", candidate.name);
        });
        return true;
      });
      if (!gone) continue;
      deleted.push(candidate.name);
      this.#options.print("page deleted", { page: candidate.name, days: PAGE_DAYS });
    }
    await this.#sql.run("DELETE FROM bot_secret_links WHERE created_at < ? AND state IN ('open', 'used', 'revoked') AND (state != 'used' OR woken_at IS NOT NULL)", this.#clock() - SECRET_KEEP_MS);
    await this.desktop.cleanup();
    return deleted;
  }
}

function secretState(row: SecretRow, now: number): "open" | "used" | "expired" {
  if (row.state === "used" || row.state === "writing") return "used";
  return row.expires_at <= now ? "expired" : "open";
}

/** The person a link is made for, as given, or null for anyone. */
function personProblem(person: string | undefined): string | null {
  if (person === undefined || person === "") return null;
  if (person.length > 200 || /[\u0000-\u001f\u007f]/.test(person)) throw new Error("bad --for: a person's address, on one line");
  return person;
}

/** Why the form's values cannot be written, or undefined: every key needs a value on one line. */
function valuesProblem(keys: readonly string[], form: URLSearchParams): string | undefined {
  for (const key of keys) {
    const value = form.get(key)?.trim();
    if (!value) return "Fill in every value.";
    if (/[\u0000-\u001f\u007f]/.test(value)) return `The value of ${key} has a line break or another control character; paste it again.`;
  }
  return undefined;
}

/** The crash test files of a bot folder: with one there, the process dies at that point, once. */
export function secretCrashTests(dir: string, print: Print): BotPages["crashTests"] {
  const crash = (file: string, message: string) => () => {
    const path = join(dir, file);
    if (!existsSync(path)) return;
    unlinkSync(path);
    print(message);
    process.kill(process.pid, "SIGKILL");
  };
  return {
    beforeSecretWrite: crash("crash-before-secret-write", "crash test: dying after the secret link was claimed, before its file was written"),
    afterSecretWrite: crash("crash-after-secret-write", "crash test: dying after the secret file was written"),
    afterSecretUsed: crash("crash-after-secret-used", "crash test: dying after the secret link was marked used"),
  };
}
