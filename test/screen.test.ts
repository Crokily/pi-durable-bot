import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenLeases } from "../src/agent/screen.ts";

// The screen lease: one agent at a time on a screen, across conversations, bots and processes, and a lease never stays
// with a holder that is gone. A lease that does not free, or two agents on one screen, would show nowhere.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pots-screen-"));
  dirs.push(dir);
  return join(dir, "screens.sqlite");
}

const main = { bot: "/bots/a", name: "A", agent: "the main agent", conversation: "root" };
const child = { bot: "/bots/a", name: "A", agent: "child 1", conversation: "c1" };
const other = { bot: "/other-home/bots/a", name: "A", agent: "the main agent", conversation: "root" };

describe("screen leases", () => {
  it("lets one conversation use a screen until it gives it up, and tells the others who has it", () => {
    const leases = new ScreenLeases(leaseFile());
    const first = leases.take("x11:local:99", main);
    expect(first.ok).toBe(true);
    const busy = leases.take("x11:local:99", child);
    expect(busy).toMatchObject({ ok: false, lease: { bot: "/bots/a", agent: "the main agent", running: 1 } });
    expect(leases.take("x11:local:99", other).ok).toBe(false);
    if (first.ok) first.done();
    // Its lease lasts across its calls, and other screens are free.
    expect(leases.take("x11:local:99", main).ok).toBe(true);
    expect(leases.take("x11:local:98", other).ok).toBe(true);
    leases.release("/bots/a", "root");
    expect(leases.take("x11:local:99", child).ok).toBe(true);
    leases.close();
  });

  it("frees a lease when its holder has not used the screen for the idle time", () => {
    const leases = new ScreenLeases(leaseFile(), { idleMs: 60_000 });
    const taken = leases.take("macos", main);
    if (taken.ok) taken.done();
    expect(leases.take("macos", child, Date.now() + 30_000).ok).toBe(false);
    expect(leases.take("macos", child, Date.now() + 61_000).ok).toBe(true);
    leases.close();
  });

  it("frees a lease when the process that holds it is gone, also in the middle of a command", () => {
    const file = leaseFile();
    const module = new URL("../src/agent/screen.ts", import.meta.url).href;
    // Another Pots process takes the screen and dies without giving it up.
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { ScreenLeases } from ${JSON.stringify(module)}; new ScreenLeases(${JSON.stringify(file)}).take("macos", ${JSON.stringify(other)}); process.exit(0);`,
    ]);
    const leases = new ScreenLeases(file);
    expect(leases.take("macos", main).ok).toBe(true);
    leases.close();
  });
});
