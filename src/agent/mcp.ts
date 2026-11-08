import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { piModule } from "./models.ts";

// MCP servers, through pi's own MCP support: pi's mcp.json (~/.pi/agent/mcp.json, and .pi/mcp.json in the bot's working
// directory), pi's connections and sign-ins (tokens in ~/.pi/agent/mcp-auth.json), and pi's adapters of server tools.
// pi's MCP extension is written for a pi session, so its parts are joined here for pi-durable: every server tool is a
// tool that only codemode scripts call and that the codemode section does not list, as with pi's default exposure. So
// the tools declared to the model and the system prompt stay the same while servers come, go and connect. One set of
// connections per bot serves its main agent and all its children.

/** The text of the mcp_servers section without servers, so the sections after it stay where they are. */
const NO_SERVERS = "MCP servers whose tools are not declared to you: none.";
/** Script globals that list or look up tools, so a script that uses one may call any tool (pi's codemode tool). */
const DISCOVERY = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;
/** pi's resource tools, which reach every server with resources. */
const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

// ---- pi's MCP parts, from modules pi-coding-agent does not export. Check them when pi is upgraded. ----

/** pi's McpServerConnection: one configured server, which reconnects when a call finds the connection gone. */
interface Connection {
  readonly name: string;
  readonly state: "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
  readonly error: string | undefined;
  readonly tools: readonly { readonly name: string }[];
  readonly hasResources: boolean;
  readonly instructions: string | undefined;
  readonly timeoutMs: number;
  /** The server URL when it signs in with OAuth. */
  readonly oauthUrl: string | undefined;
  getClient(): Promise<unknown>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

/** A tool as pi's MCP extension defines it for a pi session. */
interface PiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly outputSchema?: object;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ content: (TextContent | ImageContent)[]; structuredContent?: unknown; isError?: boolean }>;
}

interface Credentials {
  tokens(name: string, serverUrl: string): unknown;
}

interface Pi {
  getAgentDir(): string;
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  getMcpToolExposure(config: McpServerConfig, tool: string): McpExposure;
  mcpNamespace(server: string): string;
  createMcpToolName(server: string, tool: string, isTaken?: (name: string) => boolean): string;
  createMcpToolDefinition(options: {
    server: string;
    tool: { readonly name: string };
    name: string;
    exposure: McpExposure;
    namespace: { name: string };
    timeoutMs: number;
    getClient: () => Promise<Connection>;
    readableResources?: () => boolean;
  }): PiTool;
  createMcpResourceToolDefinitions(options: { exposure: McpExposure; servers: () => readonly Connection[] }): PiTool[];
  renderServersSection(servers: readonly { entry: McpServerEntry; connection?: { instructions?: string } }[]): string | undefined;
}

/** The part that talks to servers, loaded when the first server connects, as in pi. */
interface Runtime {
  McpServerConnection: new (options: {
    entry: McpServerEntry;
    cwd: string;
    createTransport: (entry: McpServerEntry, cwd: string, authProvider: unknown) => unknown;
    credentials: Credentials;
    providerToken: (provider: string) => Promise<string | undefined>;
    onTools: (connection: Connection) => void;
    onChange: (connection: Connection) => void;
    log: unknown;
  }) => Connection;
  createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider: unknown): unknown;
  McpOAuthCredentialStore: new () => Credentials;
  McpServerLog: new (path: string) => unknown;
  /** pi-mcp's stdio transport. */
  StdioTransport: new (options: { env?: Record<string, string>; inheritEnv?: boolean }) => unknown;
}

async function loadPi(): Promise<Pi> {
  const [{ getAgentDir }, config, servers, tools, resources, extension] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import(piModule("./extensions/mcp/config.js")),
    import(piModule("./core/mcp-servers.js")),
    import(piModule("./extensions/mcp/tools.js")),
    import(piModule("./extensions/mcp/resources.js")),
    import(piModule("./extensions/mcp/index.js")),
  ]);
  return { getAgentDir, ...config, ...servers, ...tools, ...resources, ...extension } as Pi;
}

async function loadRuntime(): Promise<Runtime> {
  const [runtime, { StdioTransport }] = await Promise.all([import(piModule("./extensions/mcp/runtime.js")), import("@earendil-works/pi-mcp")]);
  return { ...runtime, StdioTransport } as Runtime;
}

// ---- The servers of one bot ----

export interface McpOptions {
  /** The bot's working directory: its .pi/mcp.json is the project's, and stdio servers start in it. */
  cwd: string;
  /** Whether pi trusts the working directory, as for its skills; only then its .pi/mcp.json counts. */
  projectTrusted: () => boolean;
  /**
   * The environment of stdio servers: the bash tool's, without the screen's variables, so that on Linux a server, like
   * bash, reaches the screen only through the screen tool and its lease.
   */
  env: NodeJS.ProcessEnv;
  /** pi's model layer, for servers that send the token of a pi login (auth.provider). */
  models: Models;
  log: (message: string, data?: Record<string, unknown>) => void;
}

interface Server {
  entry: McpServerEntry;
  /** The entry as mcp.json gave it, to see a change. */
  key: string;
  connection?: Connection;
  /** Settles when the latest connection attempt connected or failed. */
  ready?: Promise<void>;
  /** The stored sign-in when the server came to need one; a sign-in by pots mcp login changes it. */
  signIn?: string;
  /** The state last logged, so each problem is logged once. */
  logged?: string;
  stopped?: boolean;
}

const enabled = (entry: McpServerEntry) => entry.config.enabled !== false;
const keyOf = (entry: McpServerEntry) => JSON.stringify([entry.source, entry.scope, entry.override, entry.config]);
/** Every exposure but hidden is codemode here: the bot declares no server tool to the model and has no tool_search. */
const viaCodemode = (exposure: McpExposure): McpExposure => (exposure === "hidden" ? "hidden" : "codemode");

/** A tool of pi's MCP extension as a pi-durable tool that only scripts call and that the codemode section leaves out. */
function scriptTool(tool: PiTool): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
    callers: ["tools"],
    deferred: true,
    // A call cut off by a crash may have acted on the server already: the script gets an error instead of a second call.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const result = await tool.execute(api.callId, args, context.abortSignal);
      return {
        output: result.content,
        ...(tool.outputSchema && result.structuredContent !== undefined ? { structuredOutput: result.structuredContent as JsonValue } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });
}

/**
 * The MCP servers of one bot, from pi's mcp.json, read again before each request: a server added, removed or changed
 * there connects, goes or reconnects from the bot's next wake, and a server that needed a sign-in is used from the next
 * request after `pots mcp login`. `extension()` holds the servers' tools; it changes as they connect.
 */
export class Mcp {
  readonly #options: McpOptions;
  readonly #pi: Pi;
  readonly #servers = new Map<string, Server>();
  /** The tools of each server, as their connection offers them. */
  readonly #tools = new Map<string, readonly ToolRegistration[]>();
  #resourceTools: readonly ToolRegistration[] = [];
  #extension: Extension = defineExtension({ name: "mcp" });
  readonly #listeners = new Set<() => void>();
  #runtime: Promise<Runtime> | undefined;
  #credentials: Credentials | undefined;
  #serverLog: unknown;
  #errors = "";
  readonly #closing = new Set<Promise<unknown>>();
  #closed = false;

  private constructor(options: McpOptions, pi: Pi) {
    this.#options = options;
    this.#pi = pi;
  }

  static async open(options: McpOptions): Promise<Mcp> {
    const mcp = new Mcp(options, await loadPi());
    mcp.reload();
    return mcp;
  }

  /** The extension with the servers' tools; a new one after every change. */
  extension(): Extension {
    return this.#extension;
  }

  /** Called after the servers' tools changed. */
  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  /**
   * Read mcp.json again: connect servers that are new, stop those that are gone, and reconnect those that changed.
   * Reconnect a server that needed a sign-in once its stored sign-in changed. Cheap when nothing changed.
   */
  reload(): void {
    if (this.#closed) return;
    const pi = this.#pi;
    let loaded: LoadedMcpConfig;
    try {
      loaded = pi.loadMcpConfig({ agentDir: pi.getAgentDir(), cwd: this.#options.cwd, projectTrusted: this.#options.projectTrusted() });
    } catch (error) {
      // The servers that run go on.
      this.#options.log("could not read mcp.json", { error: String(error) });
      return;
    }
    const errors = loaded.errors.join("\n");
    if (errors !== this.#errors && errors) this.#options.log("mcp.json has errors", { errors });
    this.#errors = errors;
    const next = new Map(loaded.servers.map((entry) => [entry.name, entry]));
    let changed = false;
    for (const [name, server] of this.#servers) {
      const entry = next.get(name);
      if (entry && keyOf(entry) === server.key) continue;
      this.#stop(server);
      changed = true;
    }
    for (const entry of loaded.servers) {
      if (this.#servers.has(entry.name)) continue;
      const server: Server = { entry, key: keyOf(entry) };
      this.#servers.set(entry.name, server);
      if (enabled(entry)) this.#start(server);
      changed = true;
    }
    this.#reconnectSignedIn();
    if (changed) this.#changed();
  }

  /** The mcp_servers section, as pi writes it: the servers whose tools scripts call, with what each offers. */
  section(): string {
    const listed = [...this.#servers.values()].map((server) => ({
      entry: {
        ...server.entry,
        config: {
          ...server.entry.config,
          exposure: viaCodemode(server.entry.config.exposure ?? "codemode"),
          ...(server.entry.config.toolExposure
            ? { toolExposure: Object.fromEntries(Object.entries(server.entry.config.toolExposure).map(([tool, exposure]) => [tool, viaCodemode(exposure)])) }
            : {}),
        },
      },
      ...(server.connection?.instructions ? { connection: { instructions: server.connection.instructions } } : {}),
    }));
    return `<mcp_servers>\n${this.#pi.renderServersSection(listed) ?? NO_SERVERS}\n</mcp_servers>`;
  }

  /** The servers as codemode namespaces, for describeNamespace() and searchTools(). */
  namespaces(): CodemodeNamespace[] {
    return [...this.#servers.values()]
      .filter((server) => enabled(server.entry))
      .map((server) => {
        const name = this.#pi.mcpNamespace(server.entry.name);
        const description = server.entry.config.description?.trim();
        const instructions = server.connection?.instructions;
        return { name, prefix: `${name}__`, ...(description ? { description } : {}), ...(instructions ? { instructions } : {}) };
      });
  }

  /**
   * Wait for the servers a script may call, as pi does: those whose namespace (mcp__<server>) it names, or all of them
   * when it looks tools up or uses a resource tool. Returns whether it waited for any.
   */
  async ready(code: string, signal: AbortSignal | undefined): Promise<boolean> {
    const words = DISCOVERY.test(code) ? undefined : (code.match(/\w+/g) ?? []);
    const all = words === undefined || words.some((word) => RESOURCE_TOOLS.has(word));
    const waiting = [...this.#servers.values()].filter((server) => {
      if (!server.ready || !enabled(server.entry)) return false;
      const namespace = this.#pi.mcpNamespace(server.entry.name);
      return all || words.some((word) => word.includes(namespace));
    });
    if (waiting.length === 0) return false;
    const connected = Promise.all(waiting.map((server) => server.ready));
    if (!signal) {
      await connected;
      return true;
    }
    let onAbort = () => {};
    const aborted = new Promise<void>((resolve) => (onAbort = resolve));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([connected, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return true;
  }

  /** Stop every server and wait until their processes and connections are closed. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const server of this.#servers.values()) this.#stop(server);
    await Promise.allSettled([...this.#closing]);
  }

  #start(server: Server): void {
    server.ready = (async () => {
      const runtime = await (this.#runtime ??= loadRuntime());
      if (server.stopped) return;
      this.#credentials ??= new runtime.McpOAuthCredentialStore();
      this.#serverLog ??= new runtime.McpServerLog(join(this.#pi.getAgentDir(), "mcp.log"));
      const connection = new runtime.McpServerConnection({
        entry: server.entry,
        cwd: this.#options.cwd,
        createTransport: (entry, cwd, authProvider) => this.#transport(runtime, entry, cwd, authProvider),
        credentials: this.#credentials,
        providerToken: async (provider) => {
          try {
            return (await this.#options.models.getAuth(provider))?.auth.apiKey;
          } catch {
            return undefined;
          }
        },
        log: this.#serverLog,
        onTools: (current) => {
          if (!server.stopped) this.#register(server, current);
        },
        onChange: (current) => {
          if (!server.stopped) this.#stateChanged(server, current);
        },
      });
      server.connection = connection;
      await connection.getClient().catch(() => undefined);
    })().catch((error: unknown) => this.#options.log("could not start the MCP server", { server: server.entry.name, error: String(error) }));
  }

  /** pi's transport, with a stdio server given the environment of the bot's bash instead of the gateway's. */
  #transport(runtime: Runtime, entry: McpServerEntry, cwd: string, authProvider: unknown): unknown {
    const transport = runtime.createDefaultTransport(entry, cwd, authProvider);
    if ("url" in entry.config) return transport;
    const options = (transport as { options: { env?: Record<string, string> } }).options;
    const base = Object.fromEntries(Object.entries(this.#options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return new runtime.StdioTransport({ ...options, env: { ...base, ...options.env }, inheritEnv: false });
  }

  #stop(server: Server): void {
    server.stopped = true;
    this.#servers.delete(server.entry.name);
    this.#tools.delete(server.entry.name);
    const closing = Promise.allSettled([server.ready, server.connection?.close()]);
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing));
  }

  /** The server's tools as its connection offers them now; as in pi, tools whose names clash get a hash. */
  #register(server: Server, connection: Connection): void {
    const pi = this.#pi;
    const name = server.entry.name;
    const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) => pi.createMcpToolName(name, tool));
    const taken = new Set<string>();
    const tools = connection.tools.flatMap((tool) => {
      if (pi.getMcpToolExposure(server.entry.config, tool.name) === "hidden") return [];
      const toolName = pi.createMcpToolName(name, tool.name, (candidate) => taken.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate));
      taken.add(toolName);
      const definition = pi.createMcpToolDefinition({
        server: name,
        tool,
        name: toolName,
        exposure: "codemode",
        namespace: { name: pi.mcpNamespace(name) },
        timeoutMs: connection.timeoutMs,
        getClient: async () => this.#client(name, tool.name),
        readableResources: () => this.#resourceServers().some((each) => each.name === name),
      });
      return [scriptTool(definition)];
    });
    this.#tools.set(name, tools);
    this.#changed();
  }

  /** The connection for a call, found when the call runs: the server may have changed since the script started. */
  #client(server: string, tool: string): Connection {
    const current = this.#servers.get(server);
    if (!current || !enabled(current.entry)) throw new Error(`MCP server "${server}" is disabled.`);
    const connection = current.connection;
    if (!connection) throw new Error(`MCP server "${server}" is still starting.`);
    if (
      this.#pi.getMcpToolExposure(current.entry.config, tool) === "hidden" ||
      (connection.state === "connected" && !connection.tools.some((offered) => offered.name === tool))
    ) {
      throw new Error(`MCP tool "${server}/${tool}" is no longer available.`);
    }
    return connection;
  }

  /** Enabled servers with resources whose exposure is not hidden: what the resource tools reach. */
  #resourceServers(): Connection[] {
    return [...this.#servers.values()].flatMap((server) =>
      server.connection?.hasResources && enabled(server.entry) && server.entry.config.exposure !== "hidden" ? [server.connection] : [],
    );
  }

  #stateChanged(server: Server, connection: Connection): void {
    // As in pi: a server that needs a sign-in is reconnected once its stored sign-in changes.
    if (connection.state !== "needs-auth") server.signIn = undefined;
    else server.signIn ??= this.#storedSignIn(connection);
    const problem = connection.state === "needs-auth" || connection.state === "failed" ? connection.state : undefined;
    if (problem && server.logged !== problem) {
      this.#options.log("MCP server not connected", { server: server.entry.name, state: problem, ...(connection.error ? { error: connection.error } : {}) });
    }
    server.logged = problem;
    // The resource tools come with the first server that has resources.
    if (connection.state === "connected" && connection.hasResources && this.#resourceTools.length === 0) this.#changed();
  }

  #storedSignIn(connection: Connection): string {
    const url = connection.oauthUrl;
    return url && this.#credentials ? JSON.stringify(this.#credentials.tokens(connection.name, url) ?? null) : "null";
  }

  /** Servers that needed a sign-in and whose stored sign-in changed since, for example by pots mcp login. */
  #reconnectSignedIn(): void {
    for (const server of this.#servers.values()) {
      const connection = server.connection;
      if (!connection || server.signIn === undefined || this.#storedSignIn(connection) === server.signIn) continue;
      server.signIn = undefined;
      const previous = server.ready;
      server.ready = (async () => {
        await previous;
        await connection.reconnect().catch(() => undefined);
      })();
    }
  }

  #changed(): void {
    const withResources = this.#resourceServers().length > 0;
    if (withResources !== this.#resourceTools.length > 0) {
      this.#resourceTools = withResources
        ? this.#pi.createMcpResourceToolDefinitions({ exposure: "codemode", servers: () => this.#resourceServers() }).map(scriptTool)
        : [];
    }
    this.#extension = defineExtension({ name: "mcp", tools: [...[...this.#tools.values()].flat(), ...this.#resourceTools] });
    for (const listener of this.#listeners) listener();
  }
}
