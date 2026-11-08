import { realpathSync } from "node:fs";
import { Command } from "effect/cli";
import { piModule } from "../agent/models.ts";
import { botPaths } from "../bot/definition.ts";
import { botDir, listBots } from "./control.ts";

// pots mcp: pi's own pi mcp (add, remove, list, login, logout) with its options and behaviour, because npm links only
// pots, not pi. Servers go into pi's mcp.json and sign-ins into pi's mcp-auth.json, in ~/.pi/agent (or
// PI_CODING_AGENT_DIR), which pi and every bot of the computer share; a bot uses a change from its next wake. A sign-in
// is the person's, as with pots login: pi opens the browser, and asks for the redirected URL when the browser is on
// another computer. In a bot's workspace, the folder counts as trusted, as it does for the bot.

interface McpCli {
  runMcpCommand(args: string[], options: { cwd: string; agentDir: string; log: (line: string) => void; error: (line: string) => void }): Promise<number>;
}

/** pi's store of the folders a person trusts (trust.json), which pi mcp asks whether to read a project's .pi/mcp.json. */
interface TrustStore {
  prototype: { get(cwd: string): boolean | null };
}

/** Whether a folder is the workspace of a bot of this computer. */
function isBotWorkspace(dir: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  };
  const here = real(dir);
  return here !== undefined && listBots().some((id) => real(botPaths(botDir(id)).workspace) === here);
}

/** Listed in pots --help. pots.ts hands `pots mcp` to pi before this parser sees it: pi's options are not its options. */
export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Add, remove and list MCP servers, and sign in to them, as pi mcp does. pots mcp --help shows how."),
);

/** Run `pots mcp <args>` as pi runs `pi mcp <args>`, then end the process with its exit code. */
export async function runMcp(args: string[]): Promise<never> {
  const [{ getAgentDir }, { runMcpCommand }] = (await Promise.all([import(piModule("./config.js")), import(piModule("./extensions/mcp/cli.js"))])) as [
    { getAgentDir(): string },
    McpCli,
  ];
  const cwd = process.cwd();
  // A bot reads the .pi/mcp.json of its workspace whatever pi's trust.json says (src/agent/resources.ts), so pots mcp
  // in that folder lists, signs in to and adds the servers the bot uses, without saying the file is ignored.
  if (isBotWorkspace(cwd)) {
    const { ProjectTrustStore } = (await import(piModule("./core/trust-manager.js"))) as { ProjectTrustStore: TrustStore };
    const get = ProjectTrustStore.prototype.get;
    ProjectTrustStore.prototype.get = function (dir) {
      return dir === cwd ? true : get.call(this, dir);
    };
  }
  // pi's messages name its own command, which is not on PATH here.
  const named = (line: string) => line.replaceAll(/\bpi mcp\b/g, "pots mcp");
  const code = await runMcpCommand(args, {
    cwd,
    agentDir: getAgentDir(),
    log: (line) => console.log(named(line)),
    error: (line) => console.error(named(line)),
  });
  // A browser sign-in leaves the browser's spare connection to pi's callback server open: end once the output is out.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))));
  process.exit(code);
}
