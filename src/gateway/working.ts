import type { Address, WorkingSign } from "../core/channel.ts";
import type { Print } from "./config.ts";

/** The longest the bot shows that it works in a place without sending there. */
export const WORKING_CAP_MS = 10 * 60_000;

/** The longest a send waits for a show already on its way to the same place. */
export const SHOW_WAIT_MS = 2_000;

interface Shown {
  readonly at: Address;
  readonly sign: WorkingSign;
  readonly repeat: NodeJS.Timeout;
  cap: NodeJS.Timeout;
  /** A show is on its way; the next one waits for the one after it. */
  showing: boolean;
  /** Aborts when the sign stops. */
  readonly stopped: AbortController;
}

/**
 * Shows people in a place that the bot works there, as a chat app shows a person typing: the channel's sign, again
 * every so often so it does not fade, until stop, or WORKING_CAP_MS after it started. One sign per place. The calls of a
 * place go to the platform in order, so a stop never comes before a show that was still on its way. When the platform
 * refuses a show, the sign stops there, and the refusal is printed once. Once closed, it shows nothing more.
 */
export class Working {
  readonly #signOf: (at: Address) => WorkingSign | undefined;
  readonly #print: Print;
  readonly #capMs: number;
  readonly #shown = new Map<Address, Shown>();
  /** Per place, the platform's last call. */
  readonly #calls = new Map<Address, Promise<void>>();
  /** Per place, the show that has gone to the platform and not come back yet. */
  readonly #shows = new Map<Address, Promise<void>>();
  #closed = false;

  constructor(options: { sign: (at: Address) => WorkingSign | undefined; print: Print; capMs?: number }) {
    this.#signOf = options.sign;
    this.#print = options.print;
    this.#capMs = options.capMs ?? WORKING_CAP_MS;
  }

  /**
   * Show in `place`, at `at` (a message, a thread or the place), that the bot works, counting the cap from `since`
   * (Unix ms). Again in the same place: the sign moves to the new `at`, and the cap counts from the new `since`.
   */
  start(place: Address, at: Address, since = Date.now()): void {
    if (this.#closed) return;
    const left = this.#capMs - (Date.now() - since);
    const before = this.#shown.get(place);
    if (before?.at === at && left > 0) {
      clearTimeout(before.cap);
      before.cap = this.#capTimer(place, left);
      return;
    }
    this.stop(place);
    if (left <= 0) return;
    const sign = this.#sign(at);
    if (!sign) return;
    const show = () => {
      if (shown.showing) return;
      shown.showing = true;
      const { signal } = shown.stopped;
      // A show still waiting for the call before it when the sign stops does not go, and a send does not wait for it.
      const waits = this.#calls.has(place);
      let done!: () => void;
      const tracked = new Promise<void>((resolve) => (done = resolve));
      this.#shows.set(place, tracked);
      void tracked.then(() => {
        if (this.#shows.get(place) === tracked) this.#shows.delete(place);
      });
      let started = false;
      if (waits) signal.addEventListener("abort", () => started || done(), { once: true });
      const call = this.#call(place, () => {
        if (waits && signal.aborted) return Promise.resolve();
        started = true;
        return sign.show(at, signal);
      });
      call.then(done, done);
      call.then(
        () => void (shown.showing = false),
        (error: unknown) => {
          shown.showing = false;
          if (this.#shown.get(place) !== shown) return;
          this.#end(place, shown);
          this.#print("could not show that the bot works; stopped there", { place, error: String(error) });
        },
      );
    };
    const repeat = setInterval(show, Math.max(1_000, sign.every));
    repeat.unref();
    const shown: Shown = { at, sign, repeat, cap: this.#capTimer(place, left), showing: false, stopped: new AbortController() };
    this.#shown.set(place, shown);
    show();
  }

  /** Stop the sign in a place, if it shows there. */
  stop(place: Address): void {
    const shown = this.#shown.get(place);
    if (!shown) return;
    this.#end(place, shown);
    const { sign, at } = shown;
    if (!sign.stop) return;
    this.#call(place, () => sign.stop!(at)).catch((error: unknown) => this.#print("could not stop showing that the bot works", { place, error: String(error) }));
  }

  /**
   * The bot is about to send to a place: the sign there stops, and this waits for a show that is already on its way, at
   * most `waitMs`, so it does not reach the platform after the message and show the sign again under it. Without such
   * a show, it does not wait; nor for a stop.
   */
  async beforeSend(place: Address, waitMs = SHOW_WAIT_MS): Promise<void> {
    const before = this.#shows.get(place);
    this.stop(place);
    if (!before) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([before, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  stopAll(): void {
    for (const place of [...this.#shown.keys()]) this.stop(place);
  }

  /** Stop every sign, and show none again: the bot stops. */
  close(): void {
    this.#closed = true;
    this.stopAll();
  }

  /** The places where the sign shows now. */
  get places(): Address[] {
    return [...this.#shown.keys()];
  }

  #sign(at: Address): WorkingSign | undefined {
    try {
      return this.#signOf(at);
    } catch {
      return undefined;
    }
  }

  #capTimer(place: Address, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => this.stop(place), ms);
    timer.unref();
    return timer;
  }

  #end(place: Address, shown: Shown): void {
    clearInterval(shown.repeat);
    clearTimeout(shown.cap);
    shown.stopped.abort();
    this.#shown.delete(place);
  }

  /** Run a platform call after the place's last one. */
  #call(place: Address, work: () => Promise<void>): Promise<void> {
    const next = (this.#calls.get(place) ?? Promise.resolve()).then(work);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.#calls.set(place, settled);
    void settled.then(() => {
      if (this.#calls.get(place) === settled) this.#calls.delete(place);
    });
    return next;
  }
}
