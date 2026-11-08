import { Command } from "effect/cli";
import { piModule } from "../agent/models.ts";

// pots mcp: pi's own pi mcp (add, remove, list, login, logout) with its options and behaviour, because npm links only
// pots, not pi. Servers go into pi's mcp.json and sign-ins into pi's mcp-auth.json, in ~/.pi/agent (or
// PI_CODING_AGENT_DIR), which pi and every bot of the computer share; a bot uses a change from its next wake. A sign-in
// is the person's, as with pots login: pi opens the browser, and asks for the redirected URL when the browser is on
// another computer.

interface McpCli {
  runMcpCommand(args: string[], options: { cwd: string; agentDir: string; log: (line: string) => void; error: (line: string) => void }): Promise<number>;
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
  // pi's messages name its own command, which is not on PATH here.
  const named = (line: string) => line.replaceAll(/\bpi mcp\b/g, "pots mcp");
  const code = await runMcpCommand(args, {
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    log: (line) => console.log(named(line)),
    error: (line) => console.error(named(line)),
  });
  // A browser sign-in leaves the browser's spare connection to pi's callback server open: end once the output is out.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))));
  process.exit(code);
}
