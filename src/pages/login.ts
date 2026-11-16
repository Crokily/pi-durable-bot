import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Models, Provider } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Sql } from "../core/sql.ts";
import { formatTime } from "../core/time.ts";
import type { Print } from "../gateway/config.ts";

// Login pages: one-time links with which a person signs in to a model provider, with a subscription or an API key, from
// any device. The login is pi's own (models.login), run in this process as pots login runs it in a terminal, so the
// callback servers stay here, and the PKCE verifier too, unless pi puts it in the sign-in URL (Anthropic's does). The
// page renders pi's AuthInteraction: pi's questions become fields and buttons, its sign-in links and device codes are
// shown, and the page follows pi while it waits. pi writes the login to its auth.json, which every bot of this user and
// the pi command line share. Nothing happens before Start; the first browser that presses Start keeps the link (a
// cookie). The person may sign in several times, until Done or the end of the link. Each login wakes the bot once, with
// the provider and the models it can use now: never a key, a code, a sign-in URL, an account, or pi's own error text,
// which can hold a provider's answer.
//
// pi reads a stored key as a config value: "!command" runs a command, and "$NAME" takes an environment variable. A key
// typed on the page is stored so that pi reads it back as it was typed (literalKey): a page never runs a command here.

/** A login link that nobody started stops working after this long. */
export const LOGIN_UNOPENED_MS = 3_600_000;
/** How long a login link works after Start: as long as OpenAI's device codes. */
export const LOGIN_MINUTES = 15;
/** The name of the cookie that binds a link to the browser that pressed Start. */
export const LOGIN_COOKIE = "pots_login";
/** How long a page's question for news waits, and when a failed wake is tried again. For tests: change them. */
export const loginTimes = { waitMs: 20_000, wakeRetryMs: 10_000 };

const DAY_MS = 86_400_000;
/** Login links are listed and kept this long after they were made. */
const KEEP_MS = 7 * DAY_MS;
const MAX_TEXT = 2_000;
/** The longest answer to one of pi's questions: a key, a code or a pasted URL. */
const MAX_ANSWER = 8_192;
/** What the page shows of pi's messages, at most, so a long one cannot fill it. */
const MAX_SHOWN = 2_000;
/** Models listed in a wake, at most. */
const MAX_LISTED = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_login_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  provider TEXT,
  text TEXT NOT NULL DEFAULT '',
  made_for TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER,
  browser TEXT,
  running TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  woken_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_logins (
  link_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  provider TEXT NOT NULL,
  way TEXT NOT NULL,
  at INTEGER NOT NULL,
  note TEXT NOT NULL,
  woken_at INTEGER,
  PRIMARY KEY (link_id, n)
);
`;

type Stored = "open" | "started" | "done" | "expired" | "revoked" | "restarted";

interface LinkRow {
  id: number;
  token: string;
  /** The provider the bot made the link for, or null for any. */
  provider: string | null;
  text: string;
  made_for: string | null;
  created_at: number;
  /** Before Start, when the link stops working unopened; after it, when it ends. */
  expires_at: number;
  state: Stored;
  started_at: number | null;
  /** SHA-256 of the cookie of the browser that pressed Start. */
  browser: string | null;
  /** The provider of the login that runs now: a restart in the middle of it loses it. */
  running: string | null;
  /** Logins of this link that did not succeed, for the wake at its end. */
  failed: number;
  ended_at: number | null;
  /** When the bot was woken about the end, or the end, when no such wake is due. */
  woken_at: number | null;
}

interface LoginRow {
  link_id: number;
  n: number;
  provider: string;
  way: AuthType;
  at: number;
  /** The wake's note, written before it is sent, so a wake sent again says the same. */
  note: string;
  woken_at: number | null;
}

/** A provider the page offers, for one way. */
export interface Choice {
  readonly id: string;
  readonly name: string;
  /** pi has a login or key of this provider stored now, which a new one replaces. */
  readonly replaces: boolean;
}

/** One of pi's events as the page shows it. URLs are http or https only, as pi checks them. */
export type Shown =
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly expiresAt?: number }
  | { readonly type: "info"; readonly message: string; readonly links: readonly { url: string; label?: string }[] }
  | { readonly type: "progress"; readonly message: string };

/**
 * pi's open question, as the page shows it. A select's options are pi's, with the one that works from another device
 * first. replace is Pots' own: the provider got a login while this one waited for its turn, and the person chooses
 * whether this one replaces it ("replace") or not ("cancel").
 */
export type Question =
  | { readonly id: string; readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly type: "replace"; readonly provider: string }
  | {
      readonly id: string;
      readonly type: "select";
      readonly message: string;
      readonly options: readonly { id: string; label: string; description?: string; recommended?: boolean }[];
      /** The labels of the ways that work only on the computer itself, which the page does not offer. */
      readonly hidden: readonly string[];
    };

/** How a login of this link ended, for its page. */
export type Outcome =
  | { readonly ok: true; readonly provider: string; readonly name: string; readonly way: AuthType; readonly replaced: boolean; readonly model?: string; readonly modelProblem?: string; readonly judge?: string; readonly judgeProblem?: string; readonly models: number }
  | { readonly ok: false; readonly provider: string; readonly name: string; readonly way: AuthType; readonly cancelled: boolean; readonly error: string };

/** The link as its page sees it. Only the browser that pressed Start sees the login. */
export interface LoginState {
  readonly id: string;
  readonly state: Stored;
  readonly mine: boolean;
  readonly now: number;
  readonly expires: number;
  readonly started: number | null;
  /** Grows with each change, for the page's wait for news. */
  readonly version: number;
  readonly provider: string | null;
  readonly choices?: { readonly oauth: readonly Choice[]; readonly api_key: readonly Choice[] };
  readonly login?: { readonly provider: string; readonly name: string; readonly way: AuthType; readonly replaces: boolean; readonly events: readonly Shown[]; readonly question?: Question };
  readonly outcomes?: readonly Outcome[];
}

export interface LoginView {
  readonly id: string;
  readonly state: Stored;
  readonly text: string;
  readonly provider: string | null;
  readonly expiresAt: number;
  readonly startedAt: number | null;
  readonly mine: boolean;
  readonly madeFor: string | null;
}

export type LoginStart = { ok: true; secret: string; view: LoginView } | { ok: false; status: number; code: string; error: string };
export type Acted = { ok: true } | { ok: false; status: number; code?: string; error: string };

export interface LoginOptions {
  readonly sql: Sql;
  /** pi's model layer, shared by every bot of the process; undefined where there is none. */
  readonly models: () => Models | undefined;
  /** Wake the bot now with this note, once per request ID. */
  readonly wake: (note: string, requestId: string) => Promise<unknown>;
  readonly print: Print;
  readonly clock?: () => number;
  /** pi's own ID of this installation, which some logins send. */
  readonly deviceId?: () => Promise<string>;
  /** pi's default model of a provider, which is tried after a login. */
  readonly defaultModel?: (provider: string) => Promise<string | undefined>;
  /** Ask a model or a judge for a word: why it cannot answer, or undefined. */
  readonly tryModel?: (models: Models, model: string) => Promise<string | undefined>;
  readonly tryJudge?: (models: Models, judge: string) => Promise<string | undefined>;
}

/** What one started link has in this process: the login that runs, and what the page waits for. */
interface Live {
  timer?: ReturnType<typeof setTimeout>;
  version: number;
  waiters: Set<() => void>;
  /** A login request is between its checks and its start: another one waits for it. */
  beginning?: boolean;
  login?: Running;
  outcomes: Outcome[];
}

interface Running {
  readonly provider: string;
  readonly name: string;
  readonly way: AuthType;
  /** From the person's choice; checked again when the login gets its turn. */
  replaces: boolean;
  readonly abort: AbortController;
  /** Why the login was stopped: the person cancelled it, or the link ended. */
  stopped?: "cancelled" | "ended";
  events: Shown[];
  question?: Question & { resolve(value: string): void; reject(error: Error): void };
}

const linkId = (row: { id: number }) => `G${row.id}`;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const madeFor = (person: string | null) => person ?? "anyone";
const wayWords = (way: AuthType) => (way === "oauth" ? "subscription" : "API key");
const clip = (text: string) => (text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text);

/** An http or https URL as pi gives it, or undefined: nothing else is shown as a link. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

/**
 * A key as pi stores it so that pi reads it back as it is. pi reads "$$" as "$" and "$!" as "!", and runs a value that
 * starts with "!" as a command; with every "$" and "!" written so, a key never runs a command or takes a variable.
 */
export const literalKey = (key: string) => key.replace(/[$!]/g, (char) => `$${char}`);

/**
 * Pots' logins of one provider, one at a time, for all bots that share pi's models in this process: a login checks
 * what it replaces when its turn comes. pi has a queue of its own too, but it says nothing when a login's turn comes.
 */
const turns = new WeakMap<object, Map<string, Promise<void>>>();

/** Wait for this provider's turn, or until the signal ends the wait. Resolves with the function that ends the turn. */
async function turn(models: object, provider: string, signal: AbortSignal, waiting: () => void): Promise<() => void> {
  let queue = turns.get(models);
  if (!queue) turns.set(models, (queue = new Map()));
  const before = queue.get(provider);
  let end!: () => void;
  const mine = new Promise<void>((resolve) => (end = resolve));
  const tail = (before ?? Promise.resolve()).then(() => mine);
  queue.set(provider, tail);
  void tail.then(() => {
    if (queue.get(provider) === tail) queue.delete(provider);
  });
  if (before) {
    waiting();
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal));
        const stop = () => reject(abortError(signal));
        signal.addEventListener("abort", stop, { once: true });
        void before.then(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        });
      });
    } catch (error) {
      end();
      throw error;
    }
  }
  return end;
}

/** A way's ID, to compare loosely: pi writes device_code, device-code, copy_code. */
const loose = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Ways that need files or programs on the computer itself, which a person on another device cannot set up. */
const COMPUTER_ONLY = new Set(["credentialchain", "awsprofile", "adc", "applicationdefaultcredentials", "serviceaccount"]);
/** Ways that work from another device, where pi also offers a browser way whose callback goes to the computer itself. */
const OTHER_DEVICE = new Set(["devicecode", "copycode", "device", "headless"]);

/**
 * pi's choices of a way to sign in, as the page offers them. Where pi offers a browser way and a device-code or
 * copy-code way, the second works from another device: it comes first, marked recommended, and pi's own "(default)"
 * or "(recommended)" goes from the labels. Ways that work only on the computer itself are left out and named. When no
 * ID matches, pi's options stay as they are.
 */
export function shapeOptions(options: readonly { id: string; label: string; description?: string }[]): { options: { id: string; label: string; description?: string; recommended?: boolean }[]; hidden: string[] } {
  const hidden = options.filter((option) => COMPUTER_ONLY.has(loose(option.id))).map((option) => option.label);
  const shown = options.filter((option) => !COMPUTER_ONLY.has(loose(option.id)));
  const best = shown.find((option) => OTHER_DEVICE.has(loose(option.id)));
  const browser = shown.some((option) => loose(option.id).includes("browser"));
  if (!best || !browser) return { options: shown.map((option) => ({ ...option })), hidden };
  const plain = (label: string) => label.replace(/\s*\((default|recommended)\)\s*$/i, "");
  return {
    options: [best, ...shown.filter((option) => option !== best)].map((option) => ({ ...option, label: plain(option.label), ...(option === best ? { recommended: true } : {}) })),
    hidden,
  };
}

/** The login links of one bot, in its bot.sqlite, and the logins that run on them. */
export class BotLogins {
  readonly #options: LoginOptions;
  readonly #sql: Sql;
  readonly #clock: () => number;
  readonly #live = new Map<number, Live>();
  #stopped = false;
  #wakeRetry: ReturnType<typeof setTimeout> | undefined;
  /** For pots login --link: called when a link ends. */
  onEnd: ((id: string) => void) | undefined;

  private constructor(options: LoginOptions) {
    this.#options = options;
    this.#sql = options.sql;
    this.#clock = options.clock ?? Date.now;
  }

  static async open(options: LoginOptions): Promise<BotLogins> {
    await options.sql.exec(SCHEMA);
    return new BotLogins(options);
  }

  #models(): Models {
    const models = this.#options.models();
    if (!models) throw new Error("pi's models are not loaded in this process");
    return models;
  }

  /** The providers the page offers: pi's subscriptions, and pi's providers that take an API key (also TypeSafe). */
  async #choices(): Promise<{ oauth: Choice[]; api_key: Choice[] }> {
    const models = this.#models();
    const stored = await storedProviders(models);
    const providers = models.getProviders();
    const choice = (provider: Provider, name: string): Choice => ({ id: provider.id, name, replaces: stored.has(provider.id) });
    return {
      oauth: providers.filter((provider) => provider.auth.oauth).map((provider) => choice(provider, oauthName(provider))),
      api_key: providers.filter((provider) => provider.auth.apiKey?.login).map((provider) => choice(provider, provider.name)),
    };
  }

  /** A provider's name, for the page of a link made for it. */
  providerName(id: string): string | undefined {
    return this.#options.models()?.getProvider(id)?.name;
  }

  // ---- Links ----

  /** pots page login: a link, written before it is given out. */
  async create(input: { provider?: string; text?: string; person?: string }): Promise<{ id: string; token: string; expiresAt: number }> {
    const text = (input.text ?? "").trim();
    if (text.length > MAX_TEXT) throw new Error(`--text is longer than ${MAX_TEXT} characters`);
    const person = input.person?.trim() || null;
    if (person && (person.length > 200 || /[\u0000-\u001f\u007f]/.test(person))) throw new Error("bad --for: a person's address, on one line");
    const provider = input.provider?.trim() || null;
    if (provider) {
      const choices = await this.#choices();
      if (![...choices.oauth, ...choices.api_key].some((choice) => choice.id === provider)) {
        const ids = [...new Set([...choices.oauth, ...choices.api_key].map((choice) => choice.id))].sort();
        throw new Error(`bad --provider ${JSON.stringify(provider)}: pi has no login or API key for it. pi's providers: ${ids.join(", ")}`);
      }
    } else this.#models();
    const token = randomBytes(18).toString("base64url");
    const now = this.#clock();
    const expiresAt = now + LOGIN_UNOPENED_MS;
    const id = await this.#sql.transaction(async (tx) => {
      await tx.run("INSERT INTO bot_login_links (token, provider, text, made_for, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, 'open')", token, provider, text, person, now, expiresAt);
      return (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
    });
    this.#arm(id, expiresAt);
    this.#options.print("login link made", { link: `G${id}`, ...(provider ? { provider } : {}) });
    return { id: `G${id}`, token, expiresAt };
  }

  async #row(token: string): Promise<LinkRow | undefined> {
    return this.#sql.get<LinkRow>("SELECT * FROM bot_login_links WHERE token = ?", token);
  }

  /** A row's state now: a live link past its time counts as expired, before its timer has run. */
  #state(row: LinkRow): Stored {
    return (row.state === "open" || row.state === "started") && row.expires_at <= this.#clock() ? "expired" : row.state;
  }

  #mine(row: LinkRow, secret: string | undefined): boolean {
    if (!row.browser || !secret) return false;
    const given = Buffer.from(hash(secret), "hex");
    const kept = Buffer.from(row.browser, "hex");
    return given.length === kept.length && timingSafeEqual(given, kept);
  }

  #view(row: LinkRow, secret?: string): LoginView {
    return {
      id: linkId(row),
      state: this.#state(row),
      text: row.text,
      provider: row.provider,
      expiresAt: row.expires_at,
      startedAt: row.started_at,
      mine: this.#mine(row, secret),
      madeFor: row.made_for,
    };
  }

  /** The link with this token, for its page; undefined when there is none. Looking never starts it. */
  async view(token: string, secret?: string): Promise<LoginView | undefined> {
    const row = await this.#row(token);
    if (!row) return undefined;
    if (this.#state(row) !== row.state) await this.checkExpiry();
    return this.#view(row, secret);
  }

  /**
   * The link's state for its page. after: the version the page has; the answer waits, up to loginTimes.waitMs, until
   * something changes, so the page follows pi while it waits for a device code.
   */
  async state(token: string, secret: string | undefined, after?: number): Promise<LoginState | undefined> {
    let row = await this.#row(token);
    if (!row) return undefined;
    const live = this.#live.get(row.id);
    if (after !== undefined && live && live.version <= after && this.#state(row) === "started" && this.#mine(row, secret) && !this.#stopped) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          live.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, loginTimes.waitMs);
        live.waiters.add(done);
      });
      row = (await this.#row(token)) ?? row;
    }
    if (this.#state(row) !== row.state) await this.checkExpiry();
    const now = this.#clock();
    const base = { id: linkId(row), state: this.#state(row), mine: this.#mine(row, secret), now, expires: row.expires_at, started: row.started_at, provider: row.provider };
    const current = this.#live.get(row.id);
    if (!base.mine || base.state !== "started") return { ...base, version: current?.version ?? 0, ...(base.mine && current ? { outcomes: current.outcomes } : {}) };
    const login = current?.login;
    return {
      ...base,
      version: current?.version ?? 0,
      choices: await this.#choices(),
      ...(login
        ? {
            login: {
              provider: login.provider,
              name: login.name,
              way: login.way,
              replaces: login.replaces,
              events: login.events,
              ...(login.question ? { question: publicQuestion(login.question) } : {}),
            },
          }
        : {}),
      outcomes: current?.outcomes ?? [],
    };
  }

  /**
   * The person pressed Start. The first browser to do so keeps the link: it gets a new secret for its cookie. The same
   * browser may press it again (the page reloaded, or was opened again), and keeps its secret.
   */
  async start(token: string, secret: string | undefined): Promise<LoginStart> {
    const row = await this.#row(token);
    if (!row) return { ok: false, status: 404, code: "missing", error: "This link does not work." };
    const state = this.#state(row);
    if (state === "started") {
      if (!this.#mine(row, secret)) return { ok: false, status: 409, code: "elsewhere", error: "This link is open on another device." };
      return { ok: true, secret: secret!, view: this.#view(row, secret) };
    }
    if (state !== "open") return { ok: false, status: 410, code: state, error: "This link has ended." };
    const fresh = randomBytes(32).toString("base64url");
    const now = this.#clock();
    const bound = await this.#sql.transaction(async (tx) => {
      const current = await tx.get<LinkRow>("SELECT * FROM bot_login_links WHERE id = ?", row.id);
      if (!current || this.#state(current) !== "open") return current;
      await tx.run("UPDATE bot_login_links SET state = 'started', started_at = ?, browser = ?, expires_at = ? WHERE id = ?", now, hash(fresh), now + LOGIN_MINUTES * 60_000, row.id);
      return await tx.get<LinkRow>("SELECT * FROM bot_login_links WHERE id = ?", row.id);
    });
    if (!bound || bound.browser !== hash(fresh)) {
      if (bound && this.#state(bound) === "started") {
        if (this.#mine(bound, secret)) return { ok: true, secret: secret!, view: this.#view(bound, secret) };
        return { ok: false, status: 409, code: "elsewhere", error: "This link is open on another device." };
      }
      return { ok: false, status: 410, code: bound ? this.#state(bound) : "missing", error: "This link has ended." };
    }
    this.#liveOf(row.id);
    this.#arm(row.id, bound.expires_at);
    this.#options.print("login page started", { link: linkId(row) });
    return { ok: true, secret: fresh, view: this.#view(bound, fresh) };
  }

  /** A started link of this browser, or why the page cannot act on it. */
  async #own(token: string, secret: string | undefined): Promise<{ row: LinkRow; live: Live } | Extract<Acted, { ok: false }>> {
    const row = await this.#row(token);
    if (!row) return { ok: false, status: 404, code: "missing", error: "This link does not work." };
    if (!this.#mine(row, secret)) return { ok: false, status: 403, code: "elsewhere", error: "Only the device that pressed Start can use this link." };
    if (this.#state(row) !== "started" || this.#stopped) return { ok: false, status: 410, code: this.#state(row), error: "This link has ended." };
    return { row, live: this.#liveOf(row.id) };
  }

  /** The person chose a provider and a way: pi's login runs, and its questions and events go to the page. */
  async begin(token: string, secret: string | undefined, provider: string, way: AuthType): Promise<Acted> {
    const own = await this.#own(token, secret);
    if ("ok" in own) return own;
    const { row, live } = own;
    if (live.login || live.beginning) return { ok: false, status: 409, code: "busy", error: "A sign-in runs on this page already." };
    if (way !== "oauth" && way !== "api_key") return { ok: false, status: 400, error: '"way" must be "oauth" or "api_key"' };
    // Taken before the wait for pi's list, so a second request at the same time finds the page busy.
    live.beginning = true;
    let choices: { oauth: Choice[]; api_key: Choice[] };
    try {
      choices = await this.#choices();
    } finally {
      live.beginning = false;
    }
    // The link may have ended while pi listed its providers.
    if (this.#stopped || this.#live.get(row.id) !== live) return { ok: false, status: 410, code: "ended", error: "This link has ended." };
    const choice = choices[way].find((item) => item.id === provider);
    if (!choice) return { ok: false, status: 400, error: `pi has no ${way === "oauth" ? "subscription login" : "API key"} for ${JSON.stringify(provider)}` };
    const login: Running = { provider, name: choice.name, way, replaces: choice.replaces, abort: new AbortController(), events: [] };
    live.login = login;
    await this.#sql.run("UPDATE bot_login_links SET running = ? WHERE id = ?", provider, row.id);
    this.#bump(live);
    this.#options.print("login page signs in", { link: linkId(row), provider, way });
    void this.#run(row, live, login).catch((error: unknown) => this.#options.print("login page failed", { link: linkId(row), error: error instanceof Error ? error.message : String(error) }));
    return { ok: true };
  }

  /** The person answered pi's open question. */
  async answer(token: string, secret: string | undefined, question: string, value: string): Promise<Acted> {
    const own = await this.#own(token, secret);
    if ("ok" in own) return own;
    const open = own.live.login?.question;
    if (!open || open.id !== question) return { ok: false, status: 409, code: "gone", error: "This question is no longer open." };
    if (typeof value !== "string" || value.length > MAX_ANSWER) return { ok: false, status: 400, error: `the answer must be text of at most ${MAX_ANSWER} characters` };
    const answer = value.trim();
    if (open.type === "select" && !open.options.some((option) => option.id === answer)) return { ok: false, status: 400, error: "choose one of the options" };
    if (open.type === "replace" && answer !== "replace" && answer !== "cancel") return { ok: false, status: 400, error: '"replace" or "cancel"' };
    // pi saves an empty key as it is, over the key it had, and then counts the provider as not signed in.
    if ((open.type === "secret" || open.type === "manual_code") && answer === "") return { ok: false, status: 400, error: "It cannot be empty." };
    if (/[\u0000-\u001f\u007f]/.test(answer)) return { ok: false, status: 400, error: "It has a line break or another control character; paste it again." };
    own.live.login!.question = undefined;
    this.#bump(own.live);
    open.resolve(answer);
    return { ok: true };
  }

  /** The person cancelled the sign-in that runs: the page goes back to the choice. */
  async cancel(token: string, secret: string | undefined): Promise<Acted> {
    const own = await this.#own(token, secret);
    if ("ok" in own) return own;
    const login = own.live.login;
    if (login) {
      login.stopped = "cancelled";
      login.abort.abort(new Error("Cancelled."));
    }
    return { ok: true };
  }

  /** The person pressed Done: the link ends. */
  async done(token: string, secret: string | undefined): Promise<Acted> {
    const own = await this.#own(token, secret);
    if ("ok" in own) return own;
    await this.#finish(own.row.id, "done");
    return { ok: true };
  }

  /** pots page unlink: by link ID (G3) or token. The link ID, or undefined when it is not a login link of this bot. */
  async revoke(link: string): Promise<string | undefined> {
    const number = /^G(\d+)$/.exec(link);
    const row = number
      ? await this.#sql.get<LinkRow>("SELECT * FROM bot_login_links WHERE id = ?", Number(number[1]))
      : /^[A-Za-z0-9_-]{16,128}$/.test(link)
        ? await this.#row(link)
        : undefined;
    if (!row || row.state === "revoked") return undefined;
    await this.#finish(row.id, "revoked");
    return linkId(row);
  }

  /** For pots page list: the links of the last 7 days, with the providers signed in through each. */
  async list(): Promise<{ link: string; token: string; for: string | null; provider: string | null; created: number; expires: number; state: Stored; started: number | null; ended: number | null; signedIn: string[] }[]> {
    const rows = await this.#sql.all<LinkRow>("SELECT * FROM bot_login_links WHERE state != 'revoked' ORDER BY id");
    const logins = await this.#sql.all<LoginRow>("SELECT * FROM bot_logins ORDER BY link_id, n");
    return rows.map((row) => ({
      link: linkId(row),
      token: row.token,
      for: row.made_for,
      provider: row.provider,
      created: row.created_at,
      expires: row.expires_at,
      state: this.#state(row),
      started: row.started_at,
      ended: row.ended_at,
      signedIn: logins.filter((login) => login.link_id === row.id).map((login) => `${login.provider} (${wayWords(login.way)})`),
    }));
  }

  // ---- The login ----

  #liveOf(id: number): Live {
    let live = this.#live.get(id);
    if (!live) {
      live = { version: 1, waiters: new Set(), outcomes: [] };
      this.#live.set(id, live);
    }
    return live;
  }

  /** Something changed that the page shows: the pages that wait hear of it now. */
  #bump(live: Live): void {
    live.version += 1;
    for (const waiter of [...live.waiters]) waiter();
  }

  /**
   * Put a question on the page and wait for its answer. It is withdrawn when one of the signals ends: the login stopped,
   * or pi got the answer another way, such as its callback.
   */
  #ask(live: Live, login: Running, shown: Question, signals: readonly AbortSignal[], literal = false): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const aborted = signals.find((signal) => signal.aborted);
      if (aborted) return reject(abortError(aborted));
      const withdraw = (signal: AbortSignal) => () => {
        if (login.question?.id !== shown.id) return;
        login.question = undefined;
        this.#bump(live);
        reject(abortError(signal));
      };
      for (const signal of signals) signal.addEventListener("abort", withdraw(signal), { once: true });
      login.question = { ...shown, resolve: (value: string) => resolve(literal ? literalKey(value) : value), reject } as NonNullable<Running["question"]>;
      this.#bump(live);
    });
  }

  /** pi's callbacks, answered on the page. */
  #interaction(live: Live, login: Running): AuthInteraction {
    return {
      signal: login.abort.signal,
      prompt: async (prompt: AuthPrompt) => {
        const signals = [login.abort.signal, ...(prompt.signal ? [prompt.signal] : [])];
        const id = randomBytes(9).toString("base64url");
        if (prompt.type === "select") {
          const shaped = shapeOptions(prompt.options);
          if (shaped.options.length === 0) throw new Error(`${shaped.hidden.join(", ")} must be set up on the computer itself, not from a page.`);
          return this.#ask(live, login, { id, type: "select", message: clip(prompt.message), options: shaped.options, hidden: shaped.hidden }, signals);
        }
        // An API key login's secret is the key pi stores: as it was typed, never a command or a variable.
        const literal = login.way === "api_key" && prompt.type === "secret";
        return this.#ask(live, login, { id, type: prompt.type, message: clip(prompt.message), ...(prompt.placeholder ? { placeholder: clip(prompt.placeholder) } : {}) }, signals, literal);
      },
      notify: (event: AuthEvent) => {
        const shown = showEvent(event, this.#clock());
        if (!shown) return;
        // One line of progress at a time: the newest.
        login.events = [...login.events.filter((item) => !(shown.type === "progress" && item.type === "progress")), shown].slice(-20);
        this.#bump(live);
      },
    };
  }

  /**
   * The login's turn has come: what it replaces is checked again. A provider that got a login while this one waited is
   * replaced only when the person says so on the page.
   */
  async #checkReplaces(live: Live, login: Running): Promise<void> {
    const now = (await storedProviders(this.#models())).has(login.provider);
    const asked = login.replaces;
    login.replaces = now;
    if (now && !asked) {
      this.#bump(live);
      const answer = await this.#ask(live, login, { id: randomBytes(9).toString("base64url"), type: "replace", provider: login.name }, [login.abort.signal]);
      if (answer !== "replace") {
        login.stopped = "cancelled";
        throw new Error("Cancelled.");
      }
    }
  }

  async #run(row: LinkRow, live: Live, login: Running): Promise<void> {
    const models = this.#models();
    const way = wayWords(login.way);
    let committed = false;
    let failure: Extract<Outcome, { ok: false }> | undefined;
    let end: (() => void) | undefined;
    try {
      end = await turn(models, login.provider, login.abort.signal, () => {
        login.events = [...login.events, { type: "progress", message: `Waiting for another sign-in to ${login.name} to end…` }];
        this.#bump(live);
      });
      login.events = login.events.filter((item) => item.type !== "progress");
      await this.#checkReplaces(live, login);
      const deviceId = this.#options.deviceId ? await this.#options.deviceId() : undefined;
      try {
        await models.login(login.provider, login.way, this.#interaction(live, login), deviceId ? { getDeviceId: () => deviceId } : {});
      } catch (error) {
        // pi saved the login, and only its own models did not follow yet: the login counts.
        if (!(error instanceof CredentialSynchronizationError)) throw error;
        this.#options.print("login page: pi saved the login but did not update its models", { link: linkId(row), provider: login.provider });
      }
      committed = true;
    } catch (error) {
      const reason = login.stopped === "cancelled" ? "Cancelled." : error instanceof Error ? error.message : String(error);
      failure = { ok: false, provider: login.provider, name: login.name, way: login.way, cancelled: login.stopped === "cancelled", error: clip(reason) };
    } finally {
      end?.();
    }
    login.question?.reject(new Error("The sign-in ended."));
    login.question = undefined;
    if (!committed) {
      if (this.#stopped) return;
      if (live.login === login) live.login = undefined;
      if (login.stopped !== "ended") live.outcomes = [...live.outcomes, failure!].slice(-10);
      await this.#sql.run(`UPDATE bot_login_links SET running = NULL${failure!.cancelled || login.stopped === "ended" ? "" : ", failed = failed + 1"} WHERE id = ?`, row.id);
      this.#options.print("login page did not sign in", { link: linkId(row), provider: login.provider, way, ...(failure!.cancelled ? { cancelled: true } : {}) });
      this.#bump(live);
      return;
    }
    // pi has the login now. It is written down at once, with a note without the model's try, so that the end of the
    // link or a restart while the model is tried never says that nobody signed in.
    const base: Extract<Outcome, { ok: true }> = { ok: true, provider: login.provider, name: login.name, way: login.way, replaced: login.replaces, models: 0 };
    const first = await this.#loginNote(row, base);
    const n = await this.#sql.transaction(async (tx) => {
      const last = await tx.get<{ n: number | null }>("SELECT MAX(n) AS n FROM bot_logins WHERE link_id = ?", row.id);
      const next = (last?.n ?? 0) + 1;
      await tx.run("INSERT INTO bot_logins (link_id, n, provider, way, at, note) VALUES (?, ?, ?, ?, ?, ?)", row.id, next, login.provider, login.way, this.#clock(), first);
      await tx.run("UPDATE bot_login_links SET running = NULL WHERE id = ?", row.id);
      return next;
    });
    this.#options.print("login page signed in", { link: linkId(row), provider: login.provider, way });
    if (this.#stopped) return;
    login.events = [...login.events.filter((item) => item.type !== "progress"), { type: "progress", message: "Signed in. Trying a model…" }];
    this.#bump(live);
    // A model that cannot be listed or tried does not undo the login.
    const outcome = await this.#tryAfter(login).catch((error: unknown) => ({ ...base, modelProblem: clip(error instanceof Error ? error.message : String(error)) }));
    const note = await this.#loginNote(row, outcome);
    await this.#sql.run("UPDATE bot_logins SET note = ? WHERE link_id = ? AND n = ? AND woken_at IS NULL", note, row.id, n);
    if (this.#stopped) return;
    if (live.login === login) live.login = undefined;
    if (login.stopped !== "ended") live.outcomes = [...live.outcomes, outcome].slice(-10);
    this.#bump(live);
    await this.#wakeLogin(row.id, n);
  }

  /**
   * After a login, as pots login does: the models pi can use with it now, and pi's default model of the provider tried,
   * or the first one; for a provider that has only judges, such as TypeSafe's Jev, the first judge.
   */
  async #tryAfter(login: Running): Promise<Extract<Outcome, { ok: true }>> {
    const models = this.#models();
    const base = { ok: true as const, provider: login.provider, name: login.name, way: login.way, replaced: login.replaces };
    const chat = await models.getAvailable(login.provider);
    if (chat.length > 0) {
      const preferred = await this.#options.defaultModel?.(login.provider).catch(() => undefined);
      const tried = chat.find((model) => model.id === preferred) ?? chat[0]!;
      const name = `${tried.provider}/${tried.id}`;
      const problem = this.#options.tryModel ? await this.#options.tryModel(models, name) : undefined;
      return { ...base, model: name, models: chat.length, ...(problem ? { modelProblem: clip(problem) } : {}) };
    }
    const judges = await models.getAvailableOfType("classifier", login.provider);
    if (judges.length > 0) {
      const name = `${judges[0]!.provider}/${judges[0]!.id}`;
      const problem = this.#options.tryJudge ? await this.#options.tryJudge(models, name) : undefined;
      return { ...base, judge: name, models: 0, ...(problem ? { judgeProblem: clip(problem) } : {}) };
    }
    return { ...base, models: 0 };
  }

  /** The note of a login's wake: the provider, what it replaced, and the models and judges the bot can use with it now. */
  async #loginNote(row: LinkRow, outcome: Extract<Outcome, { ok: true }>): Promise<string> {
    const models = this.#models();
    const list = (names: string[]) => (names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more` : names.join(", "));
    // pi may fail to list them just after a login (its models did not follow yet): the note then leaves them out.
    const listed = await Promise.all([models.getAvailable(outcome.provider), models.getAvailableOfType("classifier", outcome.provider)]).catch(() => undefined);
    const chat = (listed?.[0] ?? []).map((model) => `${model.provider}/${model.id}`);
    const judges = (listed?.[1] ?? []).map((model) => `${model.provider}/${model.id}`);
    const parts = [
      `login page: someone used link ${linkId(row)} (made for ${madeFor(row.made_for)}) and signed in to ${outcome.name} (provider ${outcome.provider}, ${wayWords(outcome.way)}), for every bot and pi on this computer.`,
      outcome.replaced ? `It replaced the ${outcome.provider} ${outcome.way === "oauth" ? "login" : "key"} that pi had before.` : "",
      chat.length > 0 ? `Usable now: ${list(chat)}.` : "",
      judges.length > 0 ? `Judges usable now: ${list(judges)}.` : "",
      outcome.model ? (outcome.modelProblem ? `${outcome.model} did not answer when Pots tried it with this login.` : `${outcome.model} answered when Pots tried it.`) : "",
      outcome.judge ? (outcome.judgeProblem ? `${outcome.judge} did not answer when Pots tried it as a judge.` : `${outcome.judge} answered when Pots tried it as a judge.`) : "",
      listed && chat.length === 0 && judges.length === 0 ? "pi lists no model or judge for this login." : "",
    ];
    return parts.filter(Boolean).join(" ");
  }

  async #wakeLogin(linkRowId: number, n: number): Promise<void> {
    const row = await this.#sql.get<LoginRow>("SELECT * FROM bot_logins WHERE link_id = ? AND n = ?", linkRowId, n);
    if (!row || row.woken_at !== null) return;
    try {
      await this.#options.wake(row.note, `login:G${linkRowId}:${n}`);
      await this.#sql.run("UPDATE bot_logins SET woken_at = ? WHERE link_id = ? AND n = ?", this.#clock(), linkRowId, n);
    } catch (error) {
      this.#options.print("login page wake failed", { link: `G${linkRowId}`, error: String(error) });
      this.#retryWakes();
    }
  }

  // ---- Ends ----

  /** Run checkExpiry when the link's time comes. */
  #arm(id: number, expiresAt: number): void {
    if (this.#stopped) return;
    const live = this.#liveOf(id);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => void this.checkExpiry(), Math.max(0, expiresAt - this.#clock()) + 50).unref();
  }

  /** End the live links whose time has come. The timers call it; tests that move the clock call it too. */
  async checkExpiry(): Promise<void> {
    const due = await this.#sql.all<LinkRow>("SELECT * FROM bot_login_links WHERE state IN ('open', 'started') AND expires_at <= ?", this.#clock());
    for (const row of due) await this.#finish(row.id, "expired");
  }

  /**
   * End a link: its new state goes into the table first. A login that runs stops, and the page hears of it. The bot is
   * woken about the end when nobody signed in through the link, or when a restart lost a login, but not for a link it
   * took back itself.
   */
  async #finish(id: number, state: "done" | "expired" | "revoked" | "restarted"): Promise<void> {
    const now = this.#clock();
    const ended = await this.#sql.transaction(async (tx) => {
      const row = await tx.get<LinkRow>("SELECT * FROM bot_login_links WHERE id = ?", id);
      if (!row || (row.state !== "open" && row.state !== "started")) return undefined;
      const logins = (await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM bot_logins WHERE link_id = ?", id))!.n;
      const due = state === "restarted" || (state !== "revoked" && logins === 0);
      await tx.run("UPDATE bot_login_links SET state = ?, ended_at = ?, woken_at = ? WHERE id = ?", state, now, due ? null : now, id);
      return { ...row, state, ended_at: now, woken_at: due ? null : now };
    });
    if (!ended) return;
    const live = this.#live.get(id);
    if (live) {
      clearTimeout(live.timer);
      if (live.login) {
        live.login.stopped = "ended";
        live.login.abort.abort(new Error(state === "done" ? "The page was closed with Done." : "The link ended."));
      }
      this.#bump(live);
      this.#live.delete(id);
    }
    this.#options.print("login page ended", { link: linkId(ended), state });
    if (ended.woken_at === null) await this.#wakeEnd(ended);
    this.onEnd?.(linkId(ended));
  }

  async #wakeEnd(row: LinkRow): Promise<void> {
    try {
      await this.#options.wake(this.#endNote(row), `login:${linkId(row)}:end`);
      await this.#sql.run("UPDATE bot_login_links SET woken_at = ? WHERE id = ?", this.#clock(), row.id);
    } catch (error) {
      this.#options.print("login page wake failed", { link: linkId(row), error: String(error) });
      this.#retryWakes();
    }
  }

  #endNote(row: LinkRow): string {
    const link = `link ${linkId(row)} (made for ${madeFor(row.made_for)})`;
    const failed = row.failed > 0 ? ` ${row.failed === 1 ? "One sign-in" : `${row.failed} sign-ins`} on it failed; their page showed why.` : "";
    if (row.state === "restarted") {
      return `login page: Pots restarted while someone was signing in to ${row.running ?? "a provider"} on ${link}, so that sign-in was lost and the link ended. A new link (pots page login) lets them try again.`;
    }
    if (row.state === "done") return `login page: someone pressed Done on ${link} without signing in to anything.${failed}`;
    if (row.started_at === null) return `login page: ${link} expired at ${formatTime(row.expires_at)}: nobody pressed Start within an hour.`;
    return `login page: ${link} ended at ${formatTime(row.expires_at)}, ${LOGIN_MINUTES} minutes after Start, and nobody signed in.${failed}`;
  }

  /** Send the wakes that failed after a while, and again while one fails; the next start does too. */
  #retryWakes(): void {
    if (this.#wakeRetry || this.#stopped) return;
    this.#wakeRetry = setTimeout(() => {
      this.#wakeRetry = undefined;
      this.#wakePending().catch((error: unknown) => {
        this.#options.print("login page wake failed", { error: String(error) });
        this.#retryWakes();
      });
    }, loginTimes.wakeRetryMs).unref();
  }

  async #wakePending(): Promise<void> {
    for (const login of await this.#sql.all<LoginRow>("SELECT * FROM bot_logins WHERE woken_at IS NULL ORDER BY link_id, n")) await this.#wakeLogin(login.link_id, login.n);
    for (const row of await this.#sql.all<LinkRow>("SELECT * FROM bot_login_links WHERE state IN ('done', 'expired', 'restarted') AND woken_at IS NULL")) await this.#wakeEnd(row);
  }

  // ---- Start and stop ----

  /**
   * After a start: a login that ran when Pots stopped is lost, as pi's sign-in was in this process, so its link ends as
   * restarted. Links whose time came while Pots was stopped end; the others get their timers. Wakes not sent yet go.
   */
  async resume(): Promise<void> {
    for (const row of await this.#sql.all<LinkRow>("SELECT * FROM bot_login_links WHERE state = 'started' AND running IS NOT NULL")) await this.#finish(row.id, "restarted");
    for (const row of await this.#sql.all<LinkRow>("SELECT * FROM bot_login_links WHERE state IN ('open', 'started')")) this.#arm(row.id, row.expires_at);
    await this.checkExpiry();
    await this.#wakePending();
  }

  /** The gateway stops: logins that run stop; their links end as restarted at the next start. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#wakeRetry);
    for (const live of this.#live.values()) {
      clearTimeout(live.timer);
      live.login?.abort.abort(new Error("Pots is stopping."));
      for (const waiter of [...live.waiters]) waiter();
    }
    this.#live.clear();
  }

  /** Forget login links 7 days after they were made, once they ended and the bot heard of them. */
  async cleanup(): Promise<void> {
    const old = "SELECT id FROM bot_login_links WHERE created_at < ? AND state NOT IN ('open', 'started') AND woken_at IS NOT NULL";
    const cutoff = this.#clock() - KEEP_MS;
    await this.#sql.transaction(async (tx) => {
      await tx.run(`DELETE FROM bot_logins WHERE woken_at IS NOT NULL AND link_id IN (${old})`, cutoff);
      await tx.run(`DELETE FROM bot_login_links WHERE id IN (${old}) AND id NOT IN (SELECT link_id FROM bot_logins)`, cutoff);
    });
  }
}

/** The providers pi has a login or key of now. pi's ModelRuntime lists them without a secret; a plain Models does not. */
async function storedProviders(models: Models): Promise<Set<string>> {
  const listing = (models as Partial<Pick<ModelRuntime, "listCredentials">>).listCredentials;
  return new Set((listing ? await listing.call(models).catch(() => []) : []).map((item) => item.providerId));
}

/** A subscription's name as pots login shows it. */
function oauthName(provider: Provider): string {
  return provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? provider.name;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The question was withdrawn.");
}

/** The question without its callbacks, for the page. */
function publicQuestion(question: NonNullable<Running["question"]>): Question {
  const { resolve: _resolve, reject: _reject, ...shown } = question;
  return shown;
}

/** One of pi's events as the page shows it, or undefined for one with no URL that can be opened. */
function showEvent(event: AuthEvent, now: number): Shown | undefined {
  switch (event.type) {
    case "auth_url": {
      const url = webUrl(event.url);
      return url ? { type: "auth_url", url, ...(event.instructions ? { instructions: clip(event.instructions) } : {}) } : undefined;
    }
    case "device_code": {
      const url = webUrl(event.verificationUri);
      if (!url) return undefined;
      return { type: "device_code", userCode: clip(event.userCode), verificationUri: url, ...(event.expiresInSeconds ? { expiresAt: now + event.expiresInSeconds * 1000 } : {}) };
    }
    case "info":
      return {
        type: "info",
        message: clip(event.message),
        links: (event.links ?? []).flatMap((link) => {
          const url = webUrl(link.url);
          return url ? [{ url, ...(link.label ? { label: clip(link.label) } : {}) }] : [];
        }),
      };
    case "progress":
      return { type: "progress", message: clip(event.message) };
  }
}
