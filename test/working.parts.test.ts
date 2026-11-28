import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingSign } from "../src/core/channel.ts";
import { WORKING_CAP_MS, Working } from "../src/gateway/working.ts";

// The typing people see where the bot works (src/gateway/working.ts), on its own, on a clock the test moves: when the
// channel's sign shows again, when it stops, and what a refusal does.

/** A sign that records its calls. refuse: the next shows fail, as a platform refuses. slow: shows wait for release. */
function recordedSign(every: number, options: { stop?: boolean } = {}) {
  const calls: string[] = [];
  let refuse = false;
  let hold: Promise<void> | undefined;
  let release = () => {};
  const sign: WorkingSign = {
    every,
    show: async (at) => {
      calls.push(`show ${at}`);
      if (hold) await hold;
      if (refuse) throw new Error("missing permission");
    },
    ...(options.stop === false ? {} : { stop: async (at: string) => void calls.push(`stop ${at}`) }),
  };
  return {
    sign,
    calls,
    refuse: () => void (refuse = true),
    slow: () => void (hold = new Promise<void>((resolve) => (release = resolve))),
    release: () => {
      hold = undefined;
      release();
    },
  };
}

function working(sign: WorkingSign) {
  const printed: { message: string; data?: Record<string, unknown> }[] = [];
  const shown = new Working({ sign: () => sign, print: (message, data) => void printed.push({ message, ...(data ? { data } : {}) }) });
  return { shown, printed };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("typing where the bot works", () => {
  it.each([
    ["Discord", 8_000],
    ["Slack", 90_000],
    ["Telegram", 4_000],
    ["Teams", 3_000],
  ])("shows %s's sign at once, then again every %i ms until it stops", async (_platform, every) => {
    const sign = recordedSign(every);
    const { shown } = working(sign.sign);
    shown.start("p:#a", "p:#a/1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sign.calls).toEqual(["show p:#a/1"]);
    await vi.advanceTimersByTimeAsync(every - 1);
    expect(sign.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sign.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(every * 3);
    expect(sign.calls).toHaveLength(5);
    shown.stop("p:#a");
    await vi.advanceTimersByTimeAsync(every * 3);
    expect(sign.calls.slice(5)).toEqual(["stop p:#a/1"]);
    expect(shown.places).toEqual([]);
  });

  it("stops 10 minutes after it started without a send, counted from when it first showed", async () => {
    const sign = recordedSign(60_000);
    const { shown } = working(sign.sign);
    shown.start("p:#a", "p:#a/1");
    await vi.advanceTimersByTimeAsync(WORKING_CAP_MS - 1);
    expect(shown.places).toEqual(["p:#a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown.places).toEqual([]);
    expect(sign.calls.at(-1)).toBe("stop p:#a/1");
    const shows = sign.calls.filter((call) => call.startsWith("show")).length;
    await vi.advanceTimersByTimeAsync(WORKING_CAP_MS);
    expect(sign.calls.filter((call) => call.startsWith("show"))).toHaveLength(shows);

    // After a restart, the time that passed counts: 4 minutes in, 6 are left; 10 minutes in, nothing shows.
    shown.start("p:#b", "p:#b/1", Date.now() - 4 * 60_000);
    await vi.advanceTimersByTimeAsync(6 * 60_000 - 1);
    expect(shown.places).toEqual(["p:#b"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown.places).toEqual([]);
    sign.calls.length = 0;
    shown.start("p:#c", "p:#c/1", Date.now() - WORKING_CAP_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sign.calls).toEqual([]);
  });

  it("starts again for a new message in the place: the sign moves there, and the 10 minutes count from it", async () => {
    const sign = recordedSign(5_000);
    const { shown } = working(sign.sign);
    shown.start("p:#a", "p:#a/1");
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    shown.start("p:#a", "p:#a/2");
    await vi.advanceTimersByTimeAsync(0);
    expect(sign.calls.slice(-2)).toEqual(["stop p:#a/1", "show p:#a/2"]);
    // The same message or thread again: the sign stays, and the cap counts from now.
    shown.start("p:#a", "p:#a/2");
    await vi.advanceTimersByTimeAsync(WORKING_CAP_MS - 1);
    expect(shown.places).toEqual(["p:#a"]);
    expect(sign.calls.filter((call) => call.startsWith("stop"))).toEqual(["stop p:#a/1"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown.places).toEqual([]);
  });

  it("keeps places apart", async () => {
    const sign = recordedSign(5_000);
    const { shown } = working(sign.sign);
    shown.start("p:#a", "p:#a/1");
    shown.start("p:#b", "p:#b/1");
    shown.stop("p:#a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sign.calls).toEqual(["show p:#a/1", "show p:#b/1", "stop p:#a/1", "show p:#b/1"]);
    shown.stopAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(sign.calls.at(-1)).toBe("stop p:#b/1");
  });

  it("stops after a show that was still on its way, and sends no second show while one waits", async () => {
    const sign = recordedSign(1_000);
    const { shown } = working(sign.sign);
    sign.slow();
    shown.start("p:#a", "p:#a/1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sign.calls).toEqual(["show p:#a/1"]);
    shown.stop("p:#a");
    await vi.advanceTimersByTimeAsync(0);
    expect(sign.calls).toEqual(["show p:#a/1"]);
    sign.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sign.calls).toEqual(["show p:#a/1", "stop p:#a/1"]);
  });

  it("stops in a place the platform refuses, says so once, and does not try again until it starts anew", async () => {
    const sign = recordedSign(1_000);
    const { shown, printed } = working(sign.sign);
    sign.refuse();
    shown.start("p:#a", "p:#a/1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sign.calls).toEqual(["show p:#a/1"]);
    expect(shown.places).toEqual([]);
    expect(printed).toEqual([{ message: "could not show that the bot works; stopped there", data: { place: "p:#a", error: "Error: missing permission" } }]);
    shown.start("p:#a", "p:#a/2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sign.calls).toEqual(["show p:#a/1", "show p:#a/2"]);
  });

  it("shows nothing where the channel has no sign, and calls no stop for a sign that fades", async () => {
    const none = new Working({ sign: () => undefined, print: () => {} });
    none.start("p:#a", "p:#a/1");
    expect(none.places).toEqual([]);
    const throws = new Working({ sign: () => { throw new Error("the gateway is stopped"); }, print: () => {} });
    throws.start("p:#a", "p:#a/1");
    expect(throws.places).toEqual([]);

    const sign = recordedSign(8_000, { stop: false });
    const { shown } = working(sign.sign);
    shown.start("p:#a", "p:#a/1");
    shown.stop("p:#a");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sign.calls).toEqual(["show p:#a/1"]);
  });
});
