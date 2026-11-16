import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../agent/agent.ts";
import type { Models } from "@earendil-works/pi-ai";
import { piLoginHelpers } from "../agent/models.ts";
import { BIN_DIR, SECRETS_DIR } from "../core/home.ts";
import { PageHost } from "../pages/host.ts";
import { LOGIN_MINUTES } from "../pages/login.ts";
import { readSettings, SETTINGS_FILE } from "../pages/settings.ts";
import { BotPages } from "../pages/store.ts";

// pots login --link: the login page when no bot can make the link, for example when its only login has expired. This
// process runs a page server of its own for as long as the link works: at settings.json's publicUrl, on its pagePort,
// or else on a free port with a Quick Tunnel of its own. It prints the link, waits until the person is done or the link
// ends, and prints each login. Its link, its tunnel and their files are in a temporary folder, removed at the end.

export interface LinkInput {
  readonly provider?: string;
  readonly text?: string;
  /** Lines for the person or agent that runs the command. */
  readonly say: (line: string) => void;
  /** Ends the link early, as Ctrl+C does. */
  readonly signal?: AbortSignal;
}

export async function loginLink(models: Models, input: LinkInput): Promise<void> {
  const settings = readSettings(SETTINGS_FILE);
  if (settings.publicUrl && settings.pagePort === undefined) {
    throw new Error(`${SETTINGS_FILE} has a publicUrl but no pagePort yet: start Pots once (pots start) so it chooses the page server's port, then try again.`);
  }
  const folder = mkdtempSync(join(tmpdir(), "pots-login-"));
  const settingsFile = join(folder, "settings.json");
  // The public address and its port as Pots' own; without a publicUrl, any free port and a tunnel of this process.
  writeFileSync(settingsFile, JSON.stringify(settings.publicUrl ? { publicUrl: settings.publicUrl, pagePort: settings.pagePort } : {}));
  const quiet = () => {};
  const sql = await openDatabase(join(folder, "links.sqlite"));
  let pages: BotPages | undefined;
  const host = new PageHost({ home: folder, settingsFile, binDir: BIN_DIR, print: quiet });
  try {
    pages = await BotPages.open({
      id: "pots-login",
      dir: folder,
      sql,
      secretsDir: SECRETS_DIR,
      name: () => "Pots",
      // No bot to wake: the person or agent that runs the command reads it.
      wake: async (note) => input.say(note.replace(/^login page: /, "")),
      print: quiet,
      login: { models: () => models, ...piLoginHelpers },
    });
    await host.start();
    if (host.port === undefined) {
      throw new Error(
        `The page server could not listen: ${host.status().problem ?? "unknown"}. When the Pots gateway runs and serves pages at your publicUrl, ask a bot for the link instead: pots page login --bot <id>.`,
      );
    }
    host.register(pages);
    const ended = new Promise<void>((resolve) => (pages!.login.onEnd = () => resolve()));
    const made = await host.login(pages, { ...(input.provider ? { provider: input.provider } : {}), ...(input.text ? { text: input.text } : {}) });
    input.say(`Open this link on any device to sign in. It works for an hour; after Start, for ${LOGIN_MINUTES} minutes, for one or more logins:\n  ${made.url}`);
    if (made.note) input.say(made.note);
    input.say("Waiting until they press Done or the link ends. Ctrl+C ends it now.");
    const stop = () => void pages?.revoke(made.link);
    input.signal?.addEventListener("abort", stop, { once: true });
    await ended;
    input.signal?.removeEventListener("abort", stop);
  } finally {
    pages?.login.stop();
    await pages?.stopCleanup();
    await pages?.desktop.stop();
    await host.stop();
    await sql.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
