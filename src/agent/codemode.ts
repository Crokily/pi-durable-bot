import type { Context } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { PromptInput, ToolRegistration } from "@earendil-works/pi-durable";
import { type CodemodeNamespace, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

// pi's code mode, as pi-durable gives it: the codemode tool, whose JavaScript scripts call the agent's other tools and
// the MCP servers' tools in a QuickJS sandbox and survive a restart, and the codemode section, which lists the tools
// scripts can call. Every agent of the bot has it from its first request, also without an MCP server, so the tools
// declared to the model stay the same for the bot's whole life.

/** A script's memory, as in pi. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** One sandbox for every bot of the process; it starts a worker thread for each script. */
let sandbox: CodemodeSandbox | undefined;

export interface Codemode {
  /** The codemode tool first, then the tools behind the models.* of scripts, which only scripts call. */
  tools: readonly ToolRegistration[];
  /** The codemode section, tagged as pi tags it. Undefined without the request's input, which it lists the tools of. */
  section(input?: PromptInput, context?: Context): Promise<string | undefined>;
}

/** namespaces: the MCP servers, read at each script, as they come and go. */
export function createCodemode(namespaces: () => readonly CodemodeNamespace[]): Codemode {
  const extension = createCodemodeExtension({
    get sandbox() {
      return (sandbox ??= new CodemodeSandbox({ memoryLimitBytes: MEMORY_LIMIT_BYTES }));
    },
    get namespaces() {
      return namespaces();
    },
  });
  const section = extension.sections![0]!;
  return {
    tools: extension.tools!,
    section: async (input, context) => {
      if (!input || !context) return undefined;
      const text = await section.render(input, context);
      return text === undefined ? undefined : `<${section.key}>\n${text}\n</${section.key}>`;
    },
  };
}
