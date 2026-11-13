import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

// The systemd service on Linux, with unit files in a folder of the test's own and the commands recorded, not run. These
// tests run on every system: the decisions are in the code, not in systemd.

const home = mkdtempSync(join(tmpdir(), "pots-service-"));
// Before service.ts reads it, so an install makes its folder here and never in ~/.pots.
process.env.POTS_HOME = join(home, "pots");
const { systemdManager } = await import("../src/cli/service.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

function setUp(systemUnitUser?: string) {
  const dir = mkdtempSync(join(home, "units-"));
  const files = { user: join(dir, "user", "pots.service"), system: join(dir, "system", "pots.service") };
  if (systemUnitUser !== undefined) {
    mkdirSync(join(dir, "system"));
    writeFileSync(files.system, `[Service]\nUser=${systemUnitUser}\nExecStart=/usr/bin/node pots.js start\n`);
  }
  const commands: string[] = [];
  const manager = systemdManager(files, (command, args) => {
    commands.push([command, ...args].join(" "));
    return Effect.succeed("");
  });
  return { files, commands, manager };
}

describe("the systemd service", () => {
  it("leaves another user's system service alone, and gives this user a user service of their own", async () => {
    const { files, commands, manager } = setUp("someone-else");
    expect(manager.installed()).toBe(false);
    expect(manager.kind).toBe("systemd --user");
    await Effect.runPromise(manager.uninstall());
    await Effect.runPromise(manager.restart());
    expect(commands).toEqual(["systemctl --user restart pots.service"]);

    commands.length = 0;
    await Effect.runPromise(manager.install({ system: false }));
    expect(readFileSync(files.user, "utf8")).toContain("WantedBy=default.target");
    // The kernel's kill of one of its processes for memory, such as an MCP server's, does not stop the gateway.
    expect(readFileSync(files.user, "utf8")).toContain("\nOOMPolicy=continue\n");
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable pots.service",
      "systemctl --user restart pots.service",
      `loginctl enable-linger ${userInfo().username}`,
    ]);
    expect(manager.installed()).toBe(true);

    // A system service of this user's would replace the other user's.
    commands.length = 0;
    const system = await Effect.runPromise(Effect.flip(manager.install({ system: true })));
    expect(system.message).toBe(`a system service of user someone-else is installed (${files.system}); use a user service: pots service install`);
    expect(commands).toEqual([]);
    await Effect.runPromise(manager.uninstall());
    expect(commands).toEqual(["systemctl --user disable --now pots.service", "systemctl --user daemon-reload"]);
    expect(existsSync(files.user)).toBe(false);
    expect(readFileSync(files.system, "utf8")).toContain("User=someone-else");
  });

  it("brings a unit that an older version wrote up to date when it restarts", async () => {
    const { files, commands, manager } = setUp();
    await Effect.runPromise(manager.install({ system: false }));
    const current = readFileSync(files.user, "utf8");
    const old = current.replace("OOMPolicy=continue\n", "");
    writeFileSync(files.user, old);
    commands.length = 0;
    await Effect.runPromise(manager.restart());
    expect(readFileSync(files.user, "utf8")).toBe(current);
    expect(commands).toEqual(["systemctl --user daemon-reload", "systemctl --user restart pots.service"]);

    // Up to date, or not written by Pots: only the restart.
    commands.length = 0;
    await Effect.runPromise(manager.restart());
    const own = "[Service]\nExecStart=/usr/bin/node pots.js start\nTimeoutStopSec=30\n";
    writeFileSync(files.user, own);
    await Effect.runPromise(manager.restart());
    expect(readFileSync(files.user, "utf8")).toBe(own);
    expect(commands).toEqual(["systemctl --user restart pots.service", "systemctl --user restart pots.service"]);
  });

  it("takes a system service that runs as this user as its own", async () => {
    const { files, commands, manager } = setUp(userInfo().username);
    expect(manager.installed()).toBe(true);
    expect(manager.kind).toBe("systemd");
    const user = await Effect.runPromise(Effect.flip(manager.install({ system: false })));
    expect(user.message).toBe(`a system service is installed (${files.system}); use pots service install --system, or uninstall it first`);
    await Effect.runPromise(manager.restart());
    await Effect.runPromise(manager.uninstall());
    expect(commands).toEqual([
      "sudo systemctl restart pots.service",
      "sudo systemctl disable --now pots.service",
      `sudo rm -f ${files.system}`,
      "sudo systemctl daemon-reload",
    ]);
  });
});
