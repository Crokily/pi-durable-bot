import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { openDatabase } from "../../src/agent/agent.ts";
import type { Address, ChannelAdapter, ChannelSink, Happening, SentMessage } from "../../src/core/channel.ts";
import type { Judge } from "../../src/core/judge.ts";
import type { Sql } from "../../src/core/sql.ts";
import type { PlaceWake, WakeTarget } from "../../src/core/wake.ts";
import type { GatewayOptions } from "../../src/gateway/config.ts";
import { gatewayLayer } from "../../src/gateway/gateway.ts";
import { MessageLog, type UndecidedEvent } from "../../src/gateway/log.ts";
import type { Timer } from "../../src/gateway/timers.ts";
import type { WakerSettings } from "../../src/gateway/waker.ts";

// The gateway core in one process, on an in-memory SQLite database, for tests that use Effect's TestClock.

export const SETTINGS: WakerSettings = { debounceMs: 3_000, debounceMaxMs: 20_000, judgeThreshold: 0.5, judgeContextMessages: 20 };

/** What the core did, with the TestClock time of each. */
export class Recorder {
  readonly wakes: { wake: PlaceWake; at: number }[] = [];
  readonly timers: { timer: Timer; at: number }[] = [];
  readonly prints: { message: string; data?: Record<string, unknown> }[] = [];
  /** Places the bot works on now. */
  readonly working = new Set<Address>();
  readonly #clock: Clock.Clock;

  constructor(clock: Clock.Clock) {
    this.#clock = clock;
  }

  now(): number {
    return this.#clock.currentTimeMillisUnsafe();
  }

  target(): WakeTarget {
    return {
      name: "Coworker",
      isWorkingOn: (place) => this.working.has(place),
      deliver: async (wake) => {
        this.wakes.push({ wake, at: this.now() });
        return { submission: `submission-${this.wakes.length}` };
      },
      responsibilities: async () => "pricing",
    };
  }
}

export interface CoreOptions {
  readonly settings?: Partial<WakerSettings>;
  readonly judge?: Judge;
  readonly fallbackWakeMinutes?: number;
  /** Fails a timer's wake when it returns true. */
  readonly failTimer?: (timer: Timer) => boolean;
}

/** Build the gateway core on a fresh in-memory database for the effect, with a recorder of what it does. */
export const withCore = <A, E, R>(options: CoreOptions, body: (recorder: Recorder, sql: Sql) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* Effect.acquireRelease(
      Effect.promise(() => openDatabase(":memory:")),
      (db) => Effect.promise(() => db.close()),
    );
    const recorder = new Recorder(yield* Clock.Clock);
    const gatewayOptions: GatewayOptions = {
      bot: "coworker",
      judge: () => options.judge,
      settings: () => ({ ...SETTINGS, ...options.settings }),
      fallbackWakeMinutes: () => options.fallbackWakeMinutes ?? 120,
      fireTimer: async (timer) => {
        if (options.failTimer?.(timer)) throw new Error("the bot is busy");
        recorder.timers.push({ timer, at: recorder.now() });
        return { submission: `timer-${timer.id}` };
      },
      print: (message, data) => recorder.prints.push({ message, ...(data ? { data } : {}) }),
    };
    return yield* body(recorder, sql).pipe(Effect.provide(gatewayLayer(sql, gatewayOptions)));
  }).pipe(Effect.scoped);

/** Let promise work (SQLite, adapters) finish while the TestClock stands still. */
export const settle = Effect.repeat(
  Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))),
  { times: 3 },
);

/**
 * Move the TestClock forward and let the woken work finish. The TestClock does not wait for promises, so a fiber that
 * wakes up and reads SQLite could see the clock already at the end of a long jump; steps of at most `step` keep every
 * piece of work at the time it belongs to.
 */
export const advance = (ms: number, step = ms) =>
  Effect.gen(function* () {
    for (let left = ms; left > 0; left -= step) {
      yield* TestClock.adjust(Math.min(step, left));
      yield* settle;
    }
    if (ms === 0) yield* settle;
  });

let next = 0;

/** A happening as the test channel makes it. */
export function message(place: string, text: string, options: { person?: string; at?: number; fromMe?: boolean } = {}): Happening {
  const id = `m${++next}`;
  return {
    kind: "message",
    at: options.at ?? 0,
    place: { address: `mem:#${place}`, name: place, kind: place.startsWith("dm-") ? "dm" : "channel" },
    message: `mem:#${place}/${id}`,
    person: { address: `mem:@${options.person ?? "alice"}`, name: options.person ?? "alice" },
    fromMe: options.fromMe ?? false,
    mentionsMe: /@bot\b/.test(text),
    text,
  };
}

/** Log a happening as if an inbox event brought it, and return its undecided event. */
export const logHappening = (happening: Happening) =>
  Effect.gen(function* () {
    const log = yield* MessageLog;
    const [event] = yield* log.apply("mem", `event-${++next}`, [happening]);
    return event as UndecidedEvent;
  });

/**
 * A channel on an in-memory platform, with addresses "mem:#place/id". Tests can make it fail at chosen points.
 */
export class MemoryChannel implements ChannelAdapter {
  readonly id = "mem";
  readonly me = { address: "mem:@bot", name: "Coworker" };
  /** The platform: every message on it, in order. */
  readonly platform: { id: string; place: string; text: string; sendId?: string }[] = [];
  /** Throw from send before the platform takes the message. */
  failBeforeSend = false;
  /** What the gateway gave the adapter at start, for tests that act as the platform. */
  sink: ChannelSink | undefined;
  #ids = 0;

  async start(sink: ChannelSink): Promise<void> {
    this.sink = sink;
  }
  async backfill(): Promise<void> {}
  async stop(): Promise<void> {}

  owns(address: Address): boolean {
    return address.startsWith("mem:");
  }

  placeOf(address: Address): Address | undefined {
    const place = /^mem:#([\w-]+)/.exec(address)?.[1];
    return place ? `mem:#${place}` : undefined;
  }

  async translate(raw: unknown): Promise<Happening[]> {
    const record = raw as { id: string; place: string; text: string; sendId?: string; person?: string };
    return [
      {
        ...message(record.place, record.text, { person: record.person ?? "bot", fromMe: record.person === undefined }),
        message: `mem:#${record.place}/${record.id}`,
        ...(record.sendId ? { sendId: record.sendId } : {}),
        raw,
      },
    ];
  }

  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    if (this.failBeforeSend) throw new Error("the platform is down");
    const place = this.placeOf(to)!.slice("mem:#".length);
    const record = { id: `s${++this.#ids}`, place, text, sendId };
    this.platform.push(record);
    return { message: `mem:#${place}/${record.id}`, place: `mem:#${place}`, raw: record };
  }

  async findSent(to: Address, sendId: string): Promise<SentMessage | undefined> {
    const place = this.placeOf(to)!.slice("mem:#".length);
    const record = this.platform.find((item) => item.place === place && item.sendId === sendId);
    return record && { message: `mem:#${place}/${record.id}`, place: `mem:#${place}`, raw: record };
  }

  async react(): Promise<void> {}

  async call(): Promise<unknown> {
    return null;
  }
}
