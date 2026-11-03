import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatTime } from "../core/time.ts";

// A screen runs one computer-use task at a time, as a person's desktop does. The agents find their own commands for the
// screen, so code cannot see screen use in bash; the screen tool is how an agent says it uses the screen. It holds a
// lease on the screen for its conversation, in a file every Pots process of this user on the machine shares.

/** The variables that point a program at a screen. bash runs without them; the screen tool has them. */
export const SCREEN_VARIABLES = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY"] as const;

/** A lease frees when its holder has not used the screen for this long. */
export const SCREEN_IDLE_MS = 10 * 60_000;
/** While a screen command runs, its lease counts as used; this often the holder says so again. */
const HEARTBEAT_MS = 30_000;

export interface Screen {
  /** One key per screen on this machine; undefined when no screen is known. */
  key: string | undefined;
  /** Which screen it is, in words the agent knows. */
  label: string;
  /** The environment of screen commands, on top of bash's. */
  env: Record<string, string>;
}

/**
 * The bot's screen: the screen setting of bot.json, else the gateway's own screen variables. macOS and Windows have one
 * screen per machine, so every agent shares one key there; elsewhere the key is the X display or the Wayland socket.
 */
export function screenOf(setting: Readonly<Record<string, string>> | undefined, gatewayEnv: NodeJS.ProcessEnv, platform = process.platform): Screen {
  const env: Record<string, string> = {};
  if (setting) Object.assign(env, setting);
  else for (const name of SCREEN_VARIABLES) if (gatewayEnv[name]) env[name] = gatewayEnv[name];
  if (platform === "darwin") return { key: "macos", label: "the screen of this Mac", env };
  if (platform === "win32") return { key: "windows", label: "the screen of this Windows computer", env };
  if (env.DISPLAY) return { key: x11Key(env.DISPLAY), label: `DISPLAY=${env.DISPLAY}`, env };
  const wayland = env.WAYLAND_DISPLAY;
  if (wayland) {
    const socket = wayland.startsWith("/") ? wayland : join(env.XDG_RUNTIME_DIR ?? gatewayEnv.XDG_RUNTIME_DIR ?? "", wayland);
    return { key: `wayland:${socket}`, label: `WAYLAND_DISPLAY=${wayland}`, env };
  }
  return { key: undefined, label: "no screen", env };
}

/** ":1", ":1.0", "unix:1" and "localhost:1" are one display. */
function x11Key(display: string): string {
  const match = /^(.*):(\d+)(?:\.\d+)?$/.exec(display);
  if (!match) return `x11:${display}`;
  const host = ["", "unix", "localhost", "127.0.0.1"].includes(match[1]!) ? "local" : match[1]!;
  return `x11:${host}:${match[2]}`;
}

/** Who uses a screen: one conversation of one bot. */
export interface Holder {
  /** The bot's folder, which no other bot on the machine has, also in another POTS_HOME. */
  bot: string;
  /** The bot's name, for the agents of other bots. */
  name: string;
  /** Who in the bot, for example "the main agent". */
  agent: string;
  conversation: string;
}

export interface Lease extends Holder {
  screen: string;
  pid: number;
  since: number;
  lastUse: number;
  /** Screen commands of the holder that run now. */
  running: number;
}

export type Taken = { ok: true; done(): void } | { ok: false; lease: Lease };

/** Machine-wide, for the processes of this user: /tmp is the same for a service and a terminal, $TMPDIR is not. */
function defaultFile(): string {
  if (process.platform === "win32") return join(tmpdir(), "pots-screens.sqlite");
  return join("/tmp", `pots-screens-${process.getuid?.() ?? "user"}.sqlite`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  screen TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  conversation TEXT NOT NULL,
  pid INTEGER NOT NULL,
  since INTEGER NOT NULL,
  last_use INTEGER NOT NULL,
  running INTEGER NOT NULL
);`;

interface Row {
  screen: string;
  bot: string;
  name: string;
  agent: string;
  conversation: string;
  pid: number;
  since: number;
  last_use: number;
  running: number;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The screen leases of every Pots process of this user on this machine, in one SQLite file. A lease belongs to one
 * conversation and lasts across its calls, until the holder releases it (its run or child ended, the bot stopped),
 * until it has not been used for the idle time, or until the holder's process is gone.
 */
export class ScreenLeases {
  readonly #db: DatabaseSync;
  readonly #idleMs: number;
  /** Running screen commands of this process, by screen and holder, for the heartbeat. */
  readonly #running = new Map<string, number>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(file = defaultFile(), options: { idleMs?: number } = {}) {
    this.#db = new DatabaseSync(file, { timeout: 10_000 });
    this.#db.exec(SCHEMA);
    this.#idleMs = options.idleMs ?? SCREEN_IDLE_MS;
  }

  static #shared: ScreenLeases | undefined;
  /** The one store of this process. */
  static shared(): ScreenLeases {
    return (ScreenLeases.#shared ??= new ScreenLeases());
  }

  /** The one store of this process, once something used it. */
  static get opened(): ScreenLeases | undefined {
    return ScreenLeases.#shared;
  }

  get idleMs(): number {
    return this.#idleMs;
  }

  /**
   * Take the screen for a screen command of holder, or keep the lease it has. While another holder has a lease that is
   * still in force, gives that lease instead. A holder has one lease: taking a screen gives up the one it had before.
   * done(): the command ended.
   */
  take(screen: string, holder: Holder, now = Date.now()): Taken {
    const busy = this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM leases WHERE screen = ?").get(screen) as Row | undefined;
      const mine = row !== undefined && row.bot === holder.bot && row.conversation === holder.conversation && row.pid === process.pid;
      if (row && !mine && this.#inForce(row, now)) return lease(row);
      this.#db
        .prepare("DELETE FROM leases WHERE bot = ? AND conversation = ? AND pid = ? AND screen <> ?")
        .run(holder.bot, holder.conversation, process.pid, screen);
      this.#db
        .prepare(
          `INSERT INTO leases (screen, bot, name, agent, conversation, pid, since, last_use, running) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (screen) DO UPDATE SET bot = excluded.bot, name = excluded.name, agent = excluded.agent, conversation = excluded.conversation,
             pid = excluded.pid, since = excluded.since, last_use = excluded.last_use, running = excluded.running`,
        )
        .run(screen, holder.bot, holder.name, holder.agent, holder.conversation, process.pid, mine ? row.since : now, now, mine ? row.running + 1 : 1);
      return undefined;
    });
    if (busy) return { ok: false, lease: busy };
    const key = JSON.stringify([screen, holder.bot, holder.conversation]);
    this.#running.set(key, (this.#running.get(key) ?? 0) + 1);
    this.#beat();
    let done = false;
    return {
      ok: true,
      done: () => {
        if (done) return;
        done = true;
        const left = (this.#running.get(key) ?? 1) - 1;
        if (left > 0) this.#running.set(key, left);
        else this.#running.delete(key);
        this.#beat();
        this.#db
          .prepare("UPDATE leases SET running = max(running - 1, 0), last_use = ? WHERE screen = ? AND bot = ? AND conversation = ? AND pid = ?")
          .run(Date.now(), screen, holder.bot, holder.conversation, process.pid);
      },
    };
  }

  /** Give up the leases this process holds for the bot: of one conversation, or all of them. */
  release(bot: string, conversation?: string): void {
    if (conversation === undefined) this.#db.prepare("DELETE FROM leases WHERE bot = ? AND pid = ?").run(bot, process.pid);
    else this.#db.prepare("DELETE FROM leases WHERE bot = ? AND conversation = ? AND pid = ?").run(bot, conversation, process.pid);
  }

  /** The lease in force on the screen, if any. */
  holder(screen: string, now = Date.now()): Lease | undefined {
    const row = this.#db.prepare("SELECT * FROM leases WHERE screen = ?").get(screen) as Row | undefined;
    return row && this.#inForce(row, now) ? lease(row) : undefined;
  }

  close(): void {
    this.#running.clear();
    this.#beat();
    this.#db.close();
  }

  #inForce(row: Row, now: number): boolean {
    return now - row.last_use < this.#idleMs && processAlive(row.pid);
  }

  /** A long screen command keeps its lease: its holder is not idle while it runs. */
  #beat(): void {
    if (this.#running.size === 0) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      return;
    }
    this.#heartbeat ??= setInterval(() => {
      for (const key of this.#running.keys()) {
        const [screen, bot, conversation] = JSON.parse(key) as [string, string, string];
        this.#db.prepare("UPDATE leases SET last_use = ? WHERE screen = ? AND bot = ? AND conversation = ? AND pid = ?").run(Date.now(), screen, bot, conversation, process.pid);
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function lease(row: Row): Lease {
  return {
    screen: row.screen,
    bot: row.bot,
    name: row.name,
    agent: row.agent,
    conversation: row.conversation,
    pid: row.pid,
    since: row.since,
    lastUse: row.last_use,
    running: row.running,
  };
}

/** What an agent learns when another agent has the screen. */
export function renderBusy(screen: Screen, lease: Lease, idleMs: number, self: string): string {
  const who = lease.bot === self ? lease.agent : `${lease.agent} of ${lease.name} (bot folder ${lease.bot})`;
  return (
    `Not run: ${screen.label} is in use by ${who}, since ${formatTime(lease.since)}. ` +
    `Its last use: ${formatTime(lease.lastUse)}${lease.running > 0 ? ", and a screen command of it is running now" : ""}. ` +
    `The screen frees when that agent's work ends, or when it has not used the screen for ${Math.round(idleMs / 60_000)} minutes` +
    `${lease.running > 0 ? "" : ` (at ${formatTime(lease.lastUse + idleMs)})`}.`
  );
}

export const NO_SCREEN =
  "Not run: you have no screen. The screen setting in bot.json, or the gateway's environment when that is unset, has no DISPLAY or WAYLAND_DISPLAY. " +
  'When you have found or set up a desktop, write its environment into the screen setting of bot.json, for example "screen": {"DISPLAY": ":99"}.';
