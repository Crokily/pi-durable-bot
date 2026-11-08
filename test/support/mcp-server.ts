import { createInterface } from "node:readline";

// A small MCP server for tests, over stdio: one JSON-RPC message per line, as the MCP stdio transport sends them. Its
// one tool, shout, answers with the text in capitals; it also says which bot started it (POTS_BOT) and whether it got
// the screen's DISPLAY. Run it with node: `node test/support/mcp-server.ts`.

const INSTRUCTIONS = "Shouts text back in capitals.";

const tools = [
  {
    name: "shout",
    description: "Say the text in capitals.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

function answer(request: Request): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "shouter", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const args = (request.params?.arguments ?? {}) as { text?: string };
      const text = `${String(args.text ?? "").toUpperCase()}! (bot ${process.env.POTS_BOT ?? "none"}, display ${process.env.DISPLAY === undefined ? "no" : "yes"})`;
      return { content: [{ type: "text", text }] };
    }
    default:
      throw Object.assign(new Error(`no method ${request.method}`), { code: -32601 });
  }
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line) as Request;
  // A notification gets no answer.
  if (request.id === undefined) return;
  try {
    send({ jsonrpc: "2.0", id: request.id, result: answer(request) });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: (error as { code?: number }).code ?? -32603, message: (error as Error).message } });
  }
});
