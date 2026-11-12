import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The tests run the same wherever they are started, and never reach the desktop of the person who runs them. This runs
// once before the test files (globalSetup in vitest.config.ts); the test processes, and the pots commands and gateways
// that the tests start, get the environment it leaves.
export default function setup(): () => void {
  // In a Pots bot's own shell POTS_BOT names that bot, and every pots command of a test would look for it; a routine's
  // command also has POTS_FROM. POTS_TEST_ variables stay: they turn on optional tests.
  for (const key of Object.keys(process.env)) if (key.startsWith("POTS_") && !key.startsWith("POTS_TEST_")) delete process.env[key];

  // The sign-in tests get a login page's address, which pots opens with $BROWSER or xdg-open, and pi (pots mcp login)
  // with xdg-open or macOS's open. On a desktop such as XFCE or GNOME, xdg-open ignores $BROWSER and asks the desktop,
  // and a browser that is already running opens the page even with no DISPLAY. So BROWSER is a command that does
  // nothing, an xdg-open and an open that do nothing come first on PATH, and the desktop's variables are taken out.
  // (pi's opener on Windows, rundll32, cannot be replaced this way.)
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete process.env[key];
  const folder = mkdtempSync(join(tmpdir(), "pots-test-env-"));
  const bin = join(folder, "bin");
  mkdirSync(bin);
  for (const name of ["xdg-open", "open"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.BROWSER = "true";

  // An empty home folder: pi and Pots read ~/.agents/skills, ~/.cloudflared and others there, and pots service writes
  // there. The tests that need a home folder of their own still make one.
  const home = join(folder, "home");
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => rmSync(folder, { recursive: true, force: true });
}
