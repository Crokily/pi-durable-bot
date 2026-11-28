import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { TeamsFormatConverter } from "@chat-adapter/teams";
import type { InvokeResponse } from "@microsoft/teams.api";
import { convertEmojiPlaceholders } from "chat";
import type {
  Address,
  ChannelAdapter,
  ChannelConfig,
  ChannelEnv,
  ChannelRequest,
  ChannelResponse,
  ChannelSink,
  FileInfo,
  Happening,
  PersonInfo,
  PlaceInfo,
  PlaceKind,
  SentMessage,
  WorkingSign,
} from "../../core/channel.ts";
import { expandHome, readSecrets } from "../../core/env-file.ts";
import { quietLogger, RouteAdapter, type SocketConnection, type SocketHandlers, TeamsApp, useSocketConnections } from "./sdk.ts";

// Addresses (only this file parses them). Teams IDs have ":", "@" and ";" but no "/", so "/" separates the parts:
//   place               <id>:#<conversation ID>                       teams:#19:abc@thread.tacv2  (a channel; a group chat
//                                                                      is 19:…@thread.v2, a DM a:…)
//   message             <id>:#<conversation ID>/<message ID>          teams:#19:abc@thread.v2/1731800000000
//   message in a thread <id>:#<channel ID>/<root ID>/<message ID>     a reply in a channel's thread
//   person              <id>:@<Microsoft Entra object ID>             teams:@6f1c…; the bot itself, and a person whose
//                                                                      object ID Teams did not give, by their Teams ID
//                                                                      (28:… for the bot, 29:… for a person)
// A thread is its first message, as in Slack: <id>:#<channel ID>/<root ID>. Teams gives a channel's events the
// conversation ID with ";messageid=<root ID>"; the address has the root as its own part. Group chats and DMs have no
// threads. The tenant is the env file's, so it is in no address.

/**
 * What the inbox stores for this channel. activity: an activity as Teams sent it, with when it came. history: a
 * message that the backfill read from Microsoft Graph, in the conversation it is in, with where that backfill started.
 * sent: a message this channel posted, with the Markdown the bot wrote and the send ID, when it came from send.
 */
type Raw =
  | { source: "activity"; at: number; activity: Activity }
  | { source: "history"; conversation: string; message: GraphMessage; since?: number }
  | { source: "sent"; sendId?: string; markdown?: string; activity: Activity };

type Activity = Record<string, any>;

interface Account {
  id?: string;
  name?: string;
  aadObjectId?: string;
}

/** A chatMessage of Microsoft Graph (https://learn.microsoft.com/graph/api/resources/chatmessage). */
interface GraphMessage {
  id: string;
  replyToId?: string | null;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  chatId?: string | null;
  channelIdentity?: { teamId?: string; channelId?: string } | null;
  from?: { user?: { id?: string; displayName?: string } | null; application?: { id?: string; displayName?: string } | null } | null;
  body?: { contentType?: string; content?: string };
  attachments?: { contentType?: string; contentUrl?: string | null; name?: string | null }[];
  mentions?: { mentioned?: { user?: { id?: string } | null; application?: { id?: string } | null } }[];
  /** A root message's replies, with $expand=replies. */
  replies?: GraphMessage[];
  "replies@odata.nextLink"?: string;
}

/** What the channel learned about a conversation from its events: what Graph and sending need later, also after a restart. */
interface Conversation {
  type?: string;
  serviceUrl?: string;
  name?: string;
  channelName?: string;
  tenant?: string;
  team?: { id?: string; aadGroupId?: string; name?: string };
}

/** What the channel keeps between starts, in a file in the bot's folder. */
interface State {
  conversations: Record<string, Conversation>;
  /** By Entra object ID: the person's Teams ID (29:…) and name. */
  people: Record<string, { id?: string; name?: string }>;
  /** The DM conversation with each person, by Entra object ID or Teams ID. */
  dms: Record<string, string>;
  /**
   * By conversation: where a backfill began that has not ended well. Live messages do not move it; the next backfill
   * starts from it at the latest, and only a whole reading of the place removes it.
   */
  recovering: Record<string, number>;
}

/** Where a message is: its conversation, and the root of its thread in a channel. */
interface Where {
  conversation: string;
  root?: string;
}

/** An address taken apart. */
type Parsed = { conversation: string; root?: string; message?: string } | { user: string };

/** For tests: other addresses for Microsoft's services, a token, Socket Mode's sockets, and shorter waits. */
export interface TeamsEndpoints {
  /** Microsoft Graph, with its version: https://graph.microsoft.com/v1.0. */
  graph?: string;
  /** Where to send when no event gave a service URL. */
  serviceUrl?: string;
  /** Instead of signing in with the client secret. */
  token?: (scope: string | string[], tenantId?: string) => string | Promise<string>;
  socket?: (handlers: SocketHandlers) => SocketConnection;
  /** In ms: how long one try of a request may take, and how long a request is tried again. */
  timeouts?: { request?: number; retry?: number };
}

export interface TeamsOptions {
  /** The env file with CLIENT_ID, CLIENT_SECRET and TENANT_ID. */
  secrets?: string;
  /** socket: Socket Mode (the default); http: Teams posts to the page server. */
  mode: "socket" | "http";
  /**
   * Only for Microsoft 365 Agents Playground on this computer: requests without Microsoft's signature, on a server of
   * the channel's own at 127.0.0.1, never on the page server. It takes no secrets, so no token is ever sent.
   */
  playground: boolean;
  /** The playground's port on 127.0.0.1: 3978, where the Playground looks by default; 0 for any free one. */
  port?: number;
}

/** About 28 KB is the largest message Teams takes (Microsoft Learn: "Send and receive messages"); counted as UTF-8. */
const MAX_BYTES = 28_000;
/** Teams' Bot Connector, where a message goes when no event has given its service URL yet. */
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Responses worth trying again, as Microsoft's rate-limit page says: too many requests, and the service busy. */
const RETRY_STATUS = new Set([412, 429, 502, 503, 504]);
/** A request is tried again until a try fails a minute or more after the first began, as on Slack. */
const RETRY_MS = 60_000;
/** One try of a request, its token included. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Where Microsoft 365 Agents Playground sends by default: http://localhost:3978/api/messages. */
const PLAYGROUND_PORT = 3978;
const PLAYGROUND_PATH = "/api/messages";
const MAX_PLAYGROUND_BODY = 1024 * 1024;
/** Activities that are not stored: nobody needs them. */
const SKIPPED = new Set(["typing"]);
/**
 * The reactions Teams lets a bot set, by the emoji and the names people give them. Teams takes other reaction IDs as
 * well (as "<code point>_<name>", for example 1f440_eyes), which pass as they are.
 */
const REACTIONS: Record<string, string> = {
  "👍": "like",
  "❤️": "heart",
  "❤": "heart",
  "😆": "laugh",
  "😮": "surprised",
  "😢": "sad",
  "😠": "angry",
  "👀": "1f440_eyes",
  "✅": "2705_whiteheavycheckmark",
  "🚀": "launch",
  "📌": "1f4cc_pushpin",
};
const REACTION_NAMES: Record<string, string> = {
  like: "like",
  thumbsup: "like",
  "+1": "like",
  heart: "heart",
  laugh: "laugh",
  laughing: "laugh",
  surprised: "surprised",
  open_mouth: "surprised",
  sad: "sad",
  cry: "sad",
  angry: "angry",
  eyes: "1f440_eyes",
  white_check_mark: "2705_whiteheavycheckmark",
  rocket: "launch",
  launch: "launch",
  pushpin: "1f4cc_pushpin",
};
const REACTION_EMOJI: Record<string, string> = Object.fromEntries(Object.entries(REACTIONS).filter(([emoji]) => emoji !== "❤").map(([emoji, id]) => [id, emoji]));
/** Headers that a proxy adds: a request with one came from outside this computer. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip", "tailscale-user-login"];

/** Chat SDK's Teams converter: Markdown as Teams' Markdown, and Teams' HTML as Markdown. */
const converter = new TeamsFormatConverter();

export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  const mode = config.mode ?? "socket";
  if (mode !== "socket" && mode !== "http") throw new Error(`channel ${config.id}: "mode" must be "socket" (the default) or "http"`);
  const playground = config.playground === true;
  if (config.playground !== undefined && typeof config.playground !== "boolean") throw new Error(`channel ${config.id}: "playground" must be true or false`);
  if (playground && mode !== "http") throw new Error(`channel ${config.id}: "playground" needs "mode": "http"`);
  if (playground && config.secrets !== undefined) throw new Error(`channel ${config.id}: "playground" takes no "secrets": it is only for Agents Playground on this computer, never with a real app`);
  if (!playground && config.port !== undefined) throw new Error(`channel ${config.id}: "port" is only for "playground"`);
  if (config.port !== undefined && !(Number.isInteger(config.port) && (config.port as number) >= 0 && (config.port as number) < 65536)) throw new Error(`channel ${config.id}: "port" must be a port number`);
  if (!playground && typeof config.secrets !== "string") throw new Error(`channel ${config.id}: "secrets" must name the env file with CLIENT_ID, CLIENT_SECRET and TENANT_ID`);
  return new TeamsChannel(
    config.id,
    { ...(typeof config.secrets === "string" ? { secrets: expandHome(config.secrets) } : {}), mode, playground, ...(typeof config.port === "number" ? { port: config.port } : {}) },
    env,
  );
}

export class TeamsChannel implements ChannelAdapter {
  readonly id: string;
  readonly #options: TeamsOptions;
  readonly #env: ChannelEnv;
  readonly #endpoints: TeamsEndpoints;
  readonly #graph: string;
  readonly #stateFile: string;
  #state: State;
  #app?: TeamsApp;
  #sink?: ChannelSink;
  #route?: { path: string; close(): void };
  /** Playground mode's own server, on 127.0.0.1. */
  #playground?: { server: Server; url: string };
  #clientId?: string;
  #tenantId?: string;
  /** The bot's Teams ID, 28:<client ID>. */
  #botId?: string;
  /** Activities are stored one after another, in the order they came. */
  #storing: Promise<unknown> = Promise.resolve();
  #refilling: Promise<void> = Promise.resolve();
  /** The backfills that run: stop waits for them. */
  readonly #backfills = new Set<Promise<unknown>>();
  /** Aborted by stop: requests, their waits and the backfill end. */
  #stopping = new AbortController();
  /** When each region's socket dropped, in Unix ms: where the backfill after its reconnect starts. */
  readonly #droppedAt = new Map<string, number>();
  /** Where the backfill starts in each known place, by conversation: read before the channel connects. */
  #starts = new Map<string, number>();
  /** The token being got, for each kind, and when it began. */
  readonly #tokens = new Map<"bot" | "graph", { work: Promise<string | undefined>; started: number }>();

  constructor(id: string, options: TeamsOptions, env: ChannelEnv, endpoints: TeamsEndpoints = {}) {
    this.id = id;
    this.#options = options;
    this.#env = env;
    this.#endpoints = endpoints;
    this.#graph = endpoints.graph ?? GRAPH;
    // What playground mode learns comes from requests nobody signed: never mixed with a real app's.
    this.#stateFile = join(env.botDir, "channels", options.playground ? `${id}.playground.json` : `${id}.json`);
    this.#state = readState(this.#stateFile);
  }

  get me(): PersonInfo | undefined {
    return this.#botId ? { address: this.person(this.#botId), name: this.#env.botName } : undefined;
  }

  /** The path Teams posts to in HTTP mode, once started. */
  get path(): string | undefined {
    return this.#route?.path;
  }

  /** Where Agents Playground posts to in playground mode, once started. */
  get playgroundUrl(): string | undefined {
    return this.#playground?.url;
  }

  // ---- Connect ----

  /**
   * Connect: in Socket Mode, open the sockets (the SDK keeps them open and reconnects by itself); in HTTP mode, serve
   * the channel's path on the page server; in playground mode, serve Agents Playground on 127.0.0.1. Every activity is
   * stored before Teams gets its answer.
   */
  async start(sink: ChannelSink): Promise<void> {
    const { mode, playground } = this.#options;
    if (playground && this.#options.secrets) throw new Error(`channel ${this.id}: playground mode takes no secrets`);
    this.#stopping = new AbortController();
    this.#droppedAt.clear();
    const secrets = this.#options.secrets ? readSecrets(this.#options.secrets, ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]) : undefined;
    this.#clientId = secrets?.CLIENT_ID;
    this.#tenantId = secrets?.TENANT_ID;
    if (this.#clientId) this.#botId = `28:${this.#clientId}`;
    this.#sink = sink;
    this.#starts = new Map();
    for (const place of await sink.places()) {
      const parsed = this.#tryParse(place);
      if (!parsed || !("conversation" in parsed)) continue;
      const newest = await sink.newestMessage(place);
      const message = newest ? this.#tryParse(newest) : undefined;
      const at = message && "message" in message ? messageTime(message.message) : undefined;
      if (at !== undefined) this.#starts.set(parsed.conversation, at);
    }
    const app = new TeamsApp((activity) => this.#receive(sink, activity), {
      // A test's token, in place of the secret: the SDK would sign in with a secret first.
      ...(secrets ? { clientId: secrets.CLIENT_ID, tenantId: secrets.TENANT_ID, ...(this.#endpoints.token ? { token: this.#endpoints.token } : { clientSecret: secrets.CLIENT_SECRET }) } : {}),
      logger: quietLogger(sink.log),
      serviceUrl: this.#endpoints.serviceUrl ?? DEFAULT_SERVICE_URL,
      ...(mode === "socket" ? { socketMode: true } : { httpServerAdapter: new RouteAdapter(), dangerouslyAllowUnauthenticatedRequests: playground }),
    });
    this.#app = app;
    if (mode === "socket") {
      if (this.#endpoints.socket) useSocketConnections(app, this.#endpoints.socket);
      // Each region has its own socket, which drops and comes back on its own.
      app.socketMode?.events.on("disconnected", ({ geo, error, terminal }) => {
        if (!this.#droppedAt.has(geo)) this.#droppedAt.set(geo, Date.now());
        sink.log(terminal ? "Teams refused the socket, and it will not reconnect" : "socket dropped", { region: geo, ...(error ? { error: error.message } : {}) });
      });
      app.socketMode?.events.on("reconnected", ({ geo }) => {
        // Teams is not known to keep events while a socket is down: read what came meanwhile, from a minute before the drop.
        const since = (this.#droppedAt.get(geo) ?? Date.now()) - 60_000;
        this.#droppedAt.delete(geo);
        sink.log("socket reconnected", { region: geo });
        this.#recover(sink, () => since).catch((error) => sink.log("backfill failed", { error: String(error) }));
      });
      try {
        await app.start();
      } catch (error) {
        throw new Error(`Teams did not open the socket (Socket Mode): ${errorText(error)}. If the app was made without Socket Mode, set "mode": "http" (the teams-channel skill says how).`, { cause: error });
      }
      return;
    }
    await app.initialize();
    const adapter = app.server.adapter as RouteAdapter;
    if (playground) {
      this.#playground = await this.#servePlayground(adapter);
      sink.log("taking Agents Playground requests, only from this computer", { endpoint: this.#playground.url });
      return;
    }
    const http = this.#env.http;
    if (!http) throw new Error(`channel ${this.id}: HTTP mode needs Pots' page server`);
    this.#route = http.serve((request) => this.#request(request, adapter));
    const base = http.publicUrl();
    sink.log("taking Teams requests", {
      path: this.#route.path,
      ...(base ? { endpoint: `${base.replace(/\/+$/, "")}${this.#route.path}` } : { problem: "settings.json has no publicUrl, so Teams cannot reach this computer" }),
    });
  }

  /**
   * Take no more activities, end the requests and backfills that run, and wait for them and for the activities already
   * taken to be stored.
   */
  async stop(): Promise<void> {
    this.#stopping.abort(new Error(`channel ${this.id} stopped`));
    this.#route?.close();
    this.#route = undefined;
    const playground = this.#playground;
    this.#playground = undefined;
    if (playground) {
      playground.server.closeAllConnections();
      await new Promise<void>((resolve) => playground.server.close(() => resolve()));
    }
    const app = this.#app;
    this.#app = undefined;
    this.#tokens.clear();
    await app?.stop().catch(() => {});
    await Promise.allSettled([...this.#backfills]);
    await this.#storing.catch(() => {});
  }

  /** Keep a backfill until it ends, for stop. */
  #track<T>(work: Promise<T>): Promise<T> {
    this.#backfills.add(work);
    void work.finally(() => this.#backfills.delete(work)).catch(() => {});
    return work;
  }

  /**
   * Playground mode's server: the playground port on 127.0.0.1, which nothing outside this computer reaches. A request
   * must name this computer as its host (a page that points a name of its own at 127.0.0.1 cannot send), come from no
   * proxy and no browser page, and be JSON.
   */
  async #servePlayground(adapter: RouteAdapter): Promise<{ server: Server; url: string }> {
    const server = createServer((incoming, response) => {
      void this.#playgroundRequest(incoming, adapter).then(
        (answer) => {
          response.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
        },
        () => {
          response.writeHead(500).end();
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port ?? PLAYGROUND_PORT, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}${PLAYGROUND_PATH}` };
  }

  async #playgroundRequest(incoming: IncomingMessage, adapter: RouteAdapter): Promise<ChannelResponse> {
    const refuse = (status: number, error: string): ChannelResponse => {
      incoming.resume();
      return { status, body: { error } };
    };
    if ((incoming.url ?? "").split("?")[0] !== PLAYGROUND_PATH) return refuse(404, "not found");
    const host = (incoming.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const local = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    if (!local || PROXY_HEADERS.some((name) => incoming.headers[name] !== undefined) || incoming.headers.origin !== undefined) {
      return refuse(403, "playground mode takes requests only from this computer");
    }
    if (!/^application\/json\b/i.test(incoming.headers["content-type"] ?? "")) return refuse(415, "send JSON");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += (chunk as Buffer).length;
      if (size > MAX_PLAYGROUND_BODY) return { status: 413, body: { error: "too large" } };
      chunks.push(chunk as Buffer);
    }
    return this.#request({ method: incoming.method ?? "GET", headers: incoming.headers, body: Buffer.concat(chunks) }, adapter);
  }

  /**
   * A request in HTTP mode, from the page server or (in playground mode) the channel's own server: the SDK checks
   * Microsoft's signature, except in playground mode, then #receive runs.
   */
  async #request(request: ChannelRequest, adapter: RouteAdapter): Promise<ChannelResponse> {
    if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "not JSON" } };
    }
    if (!adapter.handler) return { status: 503, body: { error: "not ready" } };
    const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
    const answer = await adapter.handler({ body, headers });
    return { status: answer.status, ...(answer.body !== undefined ? { body: answer.body } : {}) };
  }

  /**
   * One activity from Teams: learn what sending and Graph need from it, store it, then answer. A store that fails
   * throws, and Teams gets an error. A click on a card (an invoke) gets "OK" as soon as it is stored; the bot changes
   * the card later.
   */
  async #receive(sink: ChannelSink, activity: Activity): Promise<InvokeResponse> {
    if (SKIPPED.has(activity.type)) return { status: 200 };
    this.#learn(activity);
    const eventId = activityEventId(activity);
    const stored = this.#storing.then(() => sink.receive(eventId, { source: "activity", at: Date.now(), activity } satisfies Raw));
    this.#storing = stored.catch(() => {});
    try {
      await stored;
    } catch (error) {
      sink.log("activity not stored; Teams gets an error", { event: eventId, error: String(error) });
      throw error;
    }
    if (activity.type === "invoke" && activity.name === "adaptiveCard/action") {
      return { status: 200, body: { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: "OK" } };
    }
    return { status: 200 };
  }

  /** What an activity tells about its conversation and its people, kept for sending, names and Graph. */
  #learn(activity: Activity): void {
    const before = JSON.stringify(this.#state);
    const recipient = activity.recipient as Account | undefined;
    // Teams gives the bot's ID as 28:<client ID>; Agents Playground gives an ID of its own.
    if (!this.#botId && recipient?.id && (recipient.id.startsWith("28:") || this.#options.playground)) this.#botId = recipient.id;
    const where = whereOf(activity);
    if (where) {
      const conversation = (this.#state.conversations[where.conversation] ??= {});
      const data = activity.channelData ?? {};
      if (activity.conversation?.conversationType) conversation.type = activity.conversation.conversationType;
      if (typeof activity.serviceUrl === "string") conversation.serviceUrl = activity.serviceUrl.replace(/\/+$/, "");
      const tenant = activity.conversation?.tenantId ?? data.tenant?.id;
      if (tenant) conversation.tenant = tenant;
      if (activity.conversation?.name) conversation.name = activity.conversation.name;
      if (data.team?.id) {
        conversation.team = {
          ...conversation.team,
          id: data.team.id,
          ...(data.team.aadGroupId ? { aadGroupId: data.team.aadGroupId } : {}),
          ...(data.team.name ? { name: data.team.name } : {}),
        };
      }
      // channelData.channel is the channel the event is about: a new or renamed one comes in the General channel. The
      // General channel has the team's ID, and Teams gives it no name.
      const named = data.channel?.id ? (this.#state.conversations[data.channel.id] ??= {}) : undefined;
      if (named && data.channel.name) named.channelName = data.channel.name;
      if (named && data.team && named !== conversation) named.team = { ...conversation.team };
      if (where.conversation === data.team?.id) conversation.channelName ??= "General";
      // The team's Entra group ID, for Graph, comes with some events only: every channel of the team gets it.
      if (data.team?.id && data.team.aadGroupId) this.#knowTeam(data.team.id, data.team.aadGroupId);
      const from = activity.from as Account | undefined;
      if (conversation.type === "personal" && from?.id && from.id !== this.#botId) {
        this.#state.dms[from.aadObjectId ?? from.id] = where.conversation;
        if (from.name) conversation.name = from.name;
      }
    }
    for (const account of [activity.from, ...(activity.membersAdded ?? [])] as (Account | undefined)[]) {
      if (!account?.aadObjectId || account.id === this.#botId) continue;
      const person = (this.#state.people[account.aadObjectId] ??= {});
      if (account.id) person.id = account.id;
      if (account.name) person.name = account.name;
    }
    if (JSON.stringify(this.#state) !== before) this.#save();
  }

  /** A team's Entra group ID, for every conversation of the team the channel knows. */
  #knowTeam(team: string, group: string): void {
    for (const conversation of Object.values(this.#state.conversations)) {
      if (conversation.team?.id === team) conversation.team = { ...conversation.team, aadGroupId: group };
    }
  }

  #save(): void {
    try {
      writeState(this.#stateFile, this.#state);
    } catch (error) {
      this.#env.log("could not keep what the channel learned", { error: String(error) });
    }
  }

  owns(address: Address): boolean {
    return address.startsWith(`${this.id}:`);
  }

  // ---- Addresses ----

  placeOf(address: Address): Address | undefined {
    const parsed = this.#parse(address);
    return "conversation" in parsed ? this.place(parsed.conversation) : undefined;
  }

  place(conversation: string): Address {
    return `${this.id}:#${conversation}`;
  }

  person(id: string): Address {
    return `${this.id}:@${id}`;
  }

  /** A message's address. A root message of a channel's thread is the thread's address. */
  #messageAt(where: Where, message: string): Address {
    if (!where.root || where.root === message) return `${this.id}:#${where.conversation}/${message}`;
    return `${this.id}:#${where.conversation}/${where.root}/${message}`;
  }

  #threadAt(where: Where): Address | undefined {
    return where.root ? `${this.id}:#${where.conversation}/${where.root}` : undefined;
  }

  #parse(address: Address): Parsed {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const rest = address.slice(this.id.length + 1);
    const place = /^#([^/\s]+)(?:\/([^/\s]+))?(?:\/([^/\s]+))?$/.exec(rest);
    if (place) {
      if (place[3]) return { conversation: place[1]!, root: place[2]!, message: place[3] };
      return { conversation: place[1]!, ...(place[2] ? { message: place[2] } : {}) };
    }
    const person = /^@([^/\s]+)$/.exec(rest);
    if (person) return { user: person[1]! };
    throw new Error(`bad ${this.id} address: ${address}`);
  }

  #tryParse(address: Address): Parsed | undefined {
    try {
      return this.#parse(address);
    } catch {
      return undefined;
    }
  }

  // ---- Translate ----

  async translate(value: unknown): Promise<Happening[]> {
    const raw = value as Raw;
    if (raw.source === "history") return this.#history(raw.conversation, raw.message, raw.since);
    if (raw.source === "sent") return this.#sent(raw);
    const { activity, at } = raw;
    const where = whereOf(activity);
    const time = Date.parse(activity.timestamp ?? "");
    const when = Number.isFinite(time) ? time : at;
    switch (activity.type) {
      case "message":
        if (!where) return [];
        return activity.value !== undefined && !activity.text ? [this.#submit(activity, where, when)] : [this.#message("message", activity, where, when)];
      case "messageUpdate":
        // An edit, or a deleted message brought back (undeleteMessage): either way the message as it is now.
        return where ? [this.#message("edit", activity, where, when)] : [];
      case "messageDelete":
        if (!where || !activity.id) return [];
        return [{ kind: "delete", at: when, place: this.#placeInfo(where.conversation), message: this.#messageAt(where, activity.id), ...this.#thread(where), fromMe: false, raw: activity }];
      case "messageReaction":
        return where ? this.#reactions(activity, where, when) : [];
      case "conversationUpdate":
        return where ? this.#conversationUpdate(activity, where, when) : [];
      case "installationUpdate": {
        const added = String(activity.action ?? "").startsWith("add");
        const place = where ? this.#placeInfo(where.conversation) : undefined;
        return [
          {
            kind: added ? "join" : "leave",
            at: when,
            ...(place ? { place } : {}),
            ...this.#meAsPerson(),
            fromMe: false,
            text: `${added ? "the app was added to" : "the app was removed from"} ${place?.name ? `"${place.name}"` : "this place"}${activity.from?.name ? ` by ${activity.from.name}` : ""}`,
            raw: activity,
          },
        ];
      }
      case "invoke":
        return [this.#invoke(activity, where, when)];
      default:
        if (!where) return [];
        return [{ kind: "system", at: when, place: this.#placeInfo(where.conversation), ...this.#personOf(activity.from), fromMe: false, text: `Teams activity ${activity.type}${activity.name ? ` ${activity.name}` : ""}`, raw: activity }];
    }
  }

  /** A message or an edit, as an activity gives it. */
  #message(kind: "message" | "edit", activity: Activity, where: Where, at: number): Happening {
    const mentioned = (activity.entities ?? []).filter((entity: any) => entity?.type === "mention" && entity.mentioned?.id);
    const from = activity.from as Account | undefined;
    const thread = this.#threadAt(where);
    const isReply = thread !== undefined && where.root !== activity.id;
    return {
      kind,
      at,
      place: this.#placeInfo(where.conversation),
      message: this.#messageAt(where, activity.id),
      ...(isReply ? { thread, ...(kind === "message" ? { threadRoot: thread } : {}) } : {}),
      ...this.#personOf(from),
      fromMe: from?.id !== undefined && from.id === this.#botId,
      mentionsMe: mentioned.some((entity: any) => entity.mentioned.id === (activity.recipient?.id ?? this.#botId)),
      text: activityText(activity),
      mentions: mentioned.filter((entity: any) => entity.mentioned.id !== this.#botId).map((entity: any) => this.person(this.#personId(entity.mentioned))),
      ...activityFiles(activity),
      raw: activity,
    };
  }

  /** A click on an Action.Submit button of a card: a message with the card's values and no text. */
  #submit(activity: Activity, where: Where, at: number): Happening {
    return {
      kind: "interaction",
      at,
      place: this.#placeInfo(where.conversation),
      ...(activity.replyToId ? { message: this.#messageAt(where, activity.replyToId) } : {}),
      ...this.#thread(where),
      ...this.#personOf(activity.from),
      fromMe: false,
      text: `clicked a card's Action.Submit button${valuesText(activity.value)}`,
      raw: activity,
    };
  }

  /** An invoke: a click on a card's Action.Execute button, or another request of Teams to the app. */
  #invoke(activity: Activity, where: Where | undefined, at: number): Happening {
    const action = activity.value?.action ?? {};
    const text =
      activity.name === "adaptiveCard/action"
        ? `clicked card button${action.title ? ` "${action.title}"` : ""}${action.verb ? ` (verb ${action.verb})` : ""}${valuesText(action.data)}`
        : `Teams sent the request ${activity.name ?? "invoke"}${valuesText(activity.value)}`;
    return {
      kind: "interaction",
      at,
      ...(where ? { place: this.#placeInfo(where.conversation) } : {}),
      ...(where && activity.replyToId ? { message: this.#messageAt(where, activity.replyToId) } : {}),
      ...(where ? this.#thread(where) : {}),
      ...this.#personOf(activity.from),
      fromMe: false,
      text,
      raw: activity,
    };
  }

  /** Reactions: Teams sends them only on the bot's own messages. */
  #reactions(activity: Activity, where: Where, at: number): Happening[] {
    if (!activity.replyToId) return [];
    const happenings: Happening[] = [];
    for (const [list, kind] of [
      [activity.reactionsAdded, "reaction_added"],
      [activity.reactionsRemoved, "reaction_removed"],
    ] as const) {
      for (const reaction of (list ?? []) as { type?: string }[]) {
        happenings.push({
          kind,
          at,
          place: this.#placeInfo(where.conversation),
          message: this.#messageAt(where, activity.replyToId),
          ...this.#thread(where),
          ...this.#personOf(activity.from),
          fromMe: activity.from?.id === this.#botId,
          text: REACTION_EMOJI[reaction.type ?? ""] ?? reaction.type ?? "?",
          raw: activity,
        });
      }
    }
    return happenings;
  }

  /** People who joined or left, the bot added or removed, and changes to a team, its channels or a chat. */
  #conversationUpdate(activity: Activity, where: Where, at: number): Happening[] {
    const place = this.#placeInfo(where.conversation);
    const happenings: Happening[] = [];
    for (const [list, kind] of [
      [activity.membersAdded, "join"],
      [activity.membersRemoved, "leave"],
    ] as const) {
      for (const member of (list ?? []) as Account[]) {
        const mine = member.id === this.#botId || member.id === activity.recipient?.id;
        happenings.push({
          kind,
          at,
          place,
          ...(mine ? this.#meAsPerson() : this.#personOf(member)),
          fromMe: false,
          ...(mine ? { text: `${kind === "join" ? "added to" : "removed from"} ${place.name ? `"${place.name}"` : "this place"}` } : {}),
          raw: activity,
        });
      }
    }
    const event = activity.channelData?.eventType as string | undefined;
    const text = event ? updateText(event, activity) : activity.topicName ? `the chat's name changed to "${activity.topicName}"` : undefined;
    if (text) happenings.push({ kind: "system", at, place, ...this.#personOf(activity.from), fromMe: false, text, raw: activity });
    return happenings;
  }

  /**
   * A message the backfill read from Graph, as it is now. System messages (a member added, a call) are not read as
   * messages. One edited after the backfill's start is also an edit, at its edit time: the log keeps a message it has
   * and takes the edit, and an older edit never replaces a newer one.
   */
  #history(conversation: string, message: GraphMessage, since?: number): Happening[] {
    if (message.messageType && message.messageType !== "message") return [];
    const where: Where = { conversation, ...(message.replyToId ? { root: message.replyToId } : {}) };
    const created = Date.parse(message.createdDateTime ?? "");
    const at = Number.isFinite(created) ? created : Date.now();
    const address = this.#messageAt(where, message.id);
    const thread = this.#threadAt(where);
    const place = this.#placeInfo(conversation);
    if (message.deletedDateTime) {
      return [{ kind: "delete", at: Date.parse(message.deletedDateTime) || at, place, message: address, ...(thread ? { thread } : {}), fromMe: false, raw: message }];
    }
    const user = message.from?.user;
    const application = message.from?.application;
    const fromMe = application?.id !== undefined && application.id === this.#clientId;
    const person = fromMe ? this.me : user?.id ? { address: this.person(user.id), ...(user.displayName ? { name: user.displayName } : {}) } : undefined;
    const content = message.body?.content ?? "";
    const files = (message.attachments ?? []).filter((file) => file.contentType === "reference" && file.contentUrl);
    const common = {
      place,
      message: address,
      ...(person ? { person } : {}),
      fromMe,
      mentionsMe: (message.mentions ?? []).some((mention) => mention.mentioned?.application?.id !== undefined && mention.mentioned.application.id === this.#clientId),
      text: message.body?.contentType === "html" ? htmlToMarkdown(content) : content,
      mentions: (message.mentions ?? []).flatMap((mention) => (mention.mentioned?.user?.id ? [this.person(mention.mentioned.user.id)] : [])),
      ...(files.length ? { files: files.map((file) => ({ ...(file.name ? { name: file.name } : {}), url: file.contentUrl! })) } : {}),
      raw: message,
    };
    const happenings: Happening[] = [{ kind: "message", at, ...common, ...(thread ? { thread, threadRoot: thread } : {}) }];
    const edited = Date.parse(message.lastEditedDateTime ?? "");
    if (Number.isFinite(edited) && (since === undefined || edited > since)) happenings.push({ kind: "edit", at: edited, ...common, ...(thread ? { thread } : {}) });
    return happenings;
  }

  /** A message this channel posted: from send, with its send ID, or from call. */
  #sent(raw: Extract<Raw, { source: "sent" }>): Happening[] {
    const activity = raw.activity;
    const where = whereOf(activity);
    if (!where || !activity.id) return [];
    const thread = this.#threadAt(where);
    const isReply = thread !== undefined && where.root !== activity.id;
    const at = Date.parse(activity.timestamp ?? "");
    return [
      {
        kind: "message",
        at: Number.isFinite(at) ? at : Date.now(),
        place: this.#placeInfo(where.conversation),
        message: this.#messageAt(where, activity.id),
        ...(isReply ? { thread, threadRoot: thread } : {}),
        ...this.#meAsPerson(),
        fromMe: true,
        text: raw.markdown ?? activityText(activity),
        ...(raw.sendId ? { sendId: raw.sendId } : {}),
        raw: activity,
      },
    ];
  }

  #thread(where: Where): { thread?: string } {
    const thread = this.#threadAt(where);
    return thread ? { thread } : {};
  }

  #meAsPerson(): { person?: PersonInfo } {
    const me = this.me;
    return me ? { person: me } : {};
  }

  /** A Teams account as a person: by Entra object ID, or the Teams ID when Teams did not give one. */
  #personOf(account: Account | undefined): { person?: PersonInfo } {
    if (!account?.id && !account?.aadObjectId) return {};
    if (account.id !== undefined && account.id === this.#botId) return this.#meAsPerson();
    const id = this.#personId(account);
    const name = account.name || this.#state.people[id]?.name;
    return { person: { address: this.person(id), ...(name ? { name } : {}) } };
  }

  /** The ID in a person's address: the Entra object ID, also when only the Teams ID came and the channel has seen both. */
  #personId(account: Account): string {
    if (account.aadObjectId) return account.aadObjectId;
    const known = Object.entries(this.#state.people).find(([, person]) => person.id === account.id)?.[0];
    return known ?? account.id!;
  }

  #placeInfo(conversation: string): PlaceInfo {
    const known = this.#state.conversations[conversation];
    const kind = placeKind(conversation, known?.type);
    const name =
      kind === "channel"
        ? [known?.team?.name, known?.channelName ? `#${known.channelName}` : undefined].filter(Boolean).join(" ") || undefined
        : known?.name;
    return { address: this.place(conversation), kind, ...(name ? { name } : {}) };
  }

  // ---- Backfill ----

  /**
   * Store the messages that came while Pots was down, from Microsoft Graph, in every channel and group chat the log
   * knows: each from its newest logged message, or else from when Pots last ran. DMs are not read: they need a
   * permission for every chat of the organisation. Oldest first in each place.
   */
  async backfill(sink: ChannelSink): Promise<void> {
    const lastAlive = sink.lastAlive();
    if (lastAlive === undefined || this.#options.playground) return;
    const starts = this.#starts;
    await this.#recover(sink, (conversation) => starts.get(conversation) ?? lastAlive);
  }

  /** A backfill after the ones under way: one at a time, so each place's recovery start is kept by one of them. */
  #recover(sink: ChannelSink, startOf: (conversation: string) => number): Promise<void> {
    const run = this.#refilling.then(() => this.#backfill(sink, startOf));
    this.#refilling = run.catch(() => {});
    return this.#track(run);
  }

  /**
   * Each place is read whole before anything of it is stored. Before any place is read, the start of each is kept in
   * the state file (or an earlier start kept there, by a backfill that did not end well), and only a whole reading of
   * the place removes it: live messages that came meanwhile do not move where the next backfill starts. stop ends it.
   */
  async #backfill(sink: ChannelSink, startOf: (conversation: string) => number): Promise<void> {
    const stopping = this.#stopping.signal;
    const recovering = this.#state.recovering;
    const places: { place: string; conversation: string; kind: string; since: number }[] = [];
    for (const place of await sink.places()) {
      const parsed = this.#tryParse(place);
      if (!parsed || !("conversation" in parsed)) continue;
      const conversation = parsed.conversation;
      const kind = placeKind(conversation, this.#state.conversations[conversation]?.type);
      if (kind === "dm") continue;
      const since = Math.min(startOf(conversation), recovering[conversation] ?? Infinity);
      recovering[conversation] = since;
      places.push({ place, conversation, kind, since });
    }
    if (places.length) this.#save();
    let added = 0;
    for (const { place, conversation, kind, since } of places) {
      if (stopping.aborted) return;
      try {
        const messages = kind === "channel" ? await this.#channelHistory(conversation, since) : await this.#chatHistory(conversation, since);
        messages.sort((a, b) => (Date.parse(a.createdDateTime ?? "") || 0) - (Date.parse(b.createdDateTime ?? "") || 0));
        for (const message of messages) {
          if (stopping.aborted) return;
          const where: Where = { conversation, ...(message.replyToId ? { root: message.replyToId } : {}) };
          await sink.receive(`history:${messageKey(where, message.id)}:${message.lastModifiedDateTime ?? ""}`, { source: "history", conversation, message, since } satisfies Raw);
          added++;
        }
        if (stopping.aborted) return;
        delete recovering[conversation];
        this.#save();
      } catch (error) {
        if (stopping.aborted) return;
        sink.log("backfill skipped a place; it is read again from the same start next time", { place, error: errorText(error) });
      }
    }
    sink.log("backfill done", { messages: added });
  }

  /**
   * A channel's messages changed after since, from Graph: root messages with their replies. Graph gives the roots
   * newest first by the last change in the whole thread, its replies included, and filters nothing by time: read pages
   * until one has no thread changed after since. Graph gives no such order for a thread's replies, so every page of the
   * replies of each root read is read.
   */
  async #channelHistory(channel: string, since: number): Promise<GraphMessage[]> {
    const team = await this.#teamGroup(channel);
    const base = `/teams/${encodeURIComponent(team)}/channels/${encodeURIComponent(channel)}/messages`;
    const found: GraphMessage[] = [];
    for await (const page of this.#pages(`${this.#graph}${base}?$top=50&$expand=replies`)) {
      let changed = false;
      for (const root of page) {
        const replies = [...(root.replies ?? [])];
        // The replies Graph did not expand (all of them, if it expanded none), to the end.
        const rest = root.replies === undefined ? `${this.#graph}${base}/${encodeURIComponent(root.id)}/replies?$top=50` : root["replies@odata.nextLink"];
        if (rest) for await (const more of this.#pages(rest)) replies.push(...more);
        const newer = replies.filter((reply) => changedAfter(reply, since));
        if (changedAfter(root, since)) found.push(withoutReplies(root));
        found.push(...newer.map((reply) => ({ ...withoutReplies(reply), replyToId: reply.replyToId ?? root.id })));
        changed ||= newer.length > 0 || changedAfter(root, since);
      }
      if (!changed) break;
    }
    return found;
  }

  /**
   * The Entra group ID of a channel's team, which Graph needs: from the channel's events, from another channel of the
   * same team, or else from Teams' Bot Connector (by the team's ID, or by the channel's when no event gave the team).
   */
  async #teamGroup(channel: string): Promise<string> {
    const conversations = this.#state.conversations;
    const team = conversations[channel]?.team;
    if (team?.aadGroupId) return team.aadGroupId;
    const teamId = team?.id;
    const known = teamId ? Object.values(conversations).find((each) => each.team?.id === teamId && each.team.aadGroupId)?.team?.aadGroupId : undefined;
    const details = known ? undefined : ((await this.#fetch("bot", "GET", `${this.#serviceUrl(channel)}/v3/teams/${teamId ?? channel}`)) as { id?: string; name?: string; aadGroupId?: string } | null);
    const group = known ?? details?.aadGroupId;
    if (!group) throw new Error("Teams did not give the Entra group of this channel's team");
    const conversation = (conversations[channel] ??= {});
    conversation.team = { ...conversation.team, id: teamId ?? details?.id ?? channel, aadGroupId: group, ...(details?.name && !conversation.team?.name ? { name: details.name } : {}) };
    this.#knowTeam(conversation.team.id!, group);
    this.#save();
    return group;
  }

  /** A group chat's messages changed after since, newest first, from Graph. */
  async #chatHistory(chat: string, since: number): Promise<GraphMessage[]> {
    const query = new URLSearchParams({ $top: "50", $orderby: "lastModifiedDateTime desc", $filter: `lastModifiedDateTime gt ${new Date(since).toISOString()}` });
    const found: GraphMessage[] = [];
    for await (const page of this.#pages(`${this.#graph}/chats/${encodeURIComponent(chat)}/messages?${query}`)) found.push(...page.filter((message) => changedAfter(message, since)));
    return found;
  }

  /**
   * The pages of a Graph list, following @odata.nextLink to the end: no page is left out, so nothing is lost between
   * what was read and where the next backfill starts. A link that leaves Graph or comes again is an error.
   */
  async *#pages(first: string): AsyncGenerator<GraphMessage[]> {
    let url: string | undefined = first;
    const seen = new Set<string>();
    while (url) {
      if (!url.startsWith(`${this.#graph}/`)) throw new Error(`Microsoft Graph gave a next page outside Graph: ${url.slice(0, 200)}`);
      if (seen.has(url)) throw new Error("Microsoft Graph gave the same next page twice");
      seen.add(url);
      const answer = (await this.#fetch("graph", "GET", url)) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
      yield answer.value ?? [];
      url = answer["@odata.nextLink"];
    }
  }

  // ---- Send ----

  checkText(_to: Address, text: string): string | undefined {
    return refusal(this.#outgoing(text).text);
  }

  /**
   * Post the text. Teams keeps no field of ours on a message, so a sent message cannot be found again by its send ID:
   * a crash between Teams taking it and Pots recording it posts it twice. A text over Teams' limit is refused, never cut.
   */
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const { text: content, entities } = this.#outgoing(text);
    const refused = refusal(content);
    if (refused) throw new Error(refused);
    const target = await this.#target(to);
    const activity: Activity = { type: "message", text: content, textFormat: "markdown", ...(entities.length ? { entities } : {}) };
    const conversationId = target.root ? `${target.conversation};messageid=${target.root}` : target.conversation;
    await this.#sink?.sending(this.place(target.conversation));
    const answer = (await this.#fetch("bot", "POST", `${this.#serviceUrl(target.conversation)}/v3/conversations/${conversationId}/activities`, activity)) as { id?: string };
    if (!answer?.id) throw new Error("Teams took the message but gave no ID");
    const sent: Activity = { ...activity, id: answer.id, conversation: { id: conversationId }, ...(this.#botId ? { from: { id: this.#botId, name: this.#env.botName } } : {}), timestamp: new Date().toISOString() };
    const where: Where = { conversation: target.conversation, ...(target.root ? { root: target.root } : {}) };
    return { message: this.#messageAt(where, answer.id), place: this.place(target.conversation), raw: { source: "sent", sendId, markdown: text, activity: sent } satisfies Raw };
  }

  /**
   * A "typing" activity in the conversation of `at`, in its thread in a channel. Teams shows it about 3 seconds. It
   * counts toward the conversation's rate limits as a message does, so it is not tried again.
   */
  readonly working: WorkingSign = {
    every: 3_000,
    show: async (at) => {
      const target = await this.#target(at);
      const conversationId = target.root ? `${target.conversation};messageid=${target.root}` : target.conversation;
      await this.#fetch("bot", "POST", `${this.#serviceUrl(target.conversation)}/v3/conversations/${conversationId}/activities`, { type: "typing" }, true);
    },
  };

  /** Teams keeps no send ID on a message. */
  async findSent(_to: Address, _sendId: string, _since: number): Promise<SentMessage | undefined> {
    return undefined;
  }

  /**
   * The text as Teams takes it: Markdown through Chat SDK's converter, and each person address in angle brackets as a
   * Teams mention, with the person's name from what the channel has seen.
   */
  #outgoing(text: string): { text: string; entities: Record<string, unknown>[] } {
    const prefix = this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const people: string[] = [];
    const marked = text.replace(new RegExp(`<${prefix}:@([^>\\s/]+)>`, "g"), (_token, id: string) => `${people.push(id) - 1}`);
    const rendered = convertEmojiPlaceholders(converter.renderPostable({ markdown: marked }), "teams");
    const entities: Record<string, unknown>[] = [];
    const content = rendered.replace(/(\d+)/g, (_token, index: string) => {
      const id = people[Number(index)]!;
      const known = this.#state.people[id];
      const name = known?.name ?? id;
      const tag = `<at>${escapeHtml(name)}</at>`;
      entities.push({ type: "mention", text: tag, mentioned: { id: known?.id ?? id, name } });
      return tag;
    });
    return { text: content, entities };
  }

  /**
   * Where a send goes. A place: a new post in a channel, or a message in a chat. A thread, or a message in one: a reply in
   * that thread. A channel's root message: a reply in its thread. A message in a chat: a message in that chat. A person:
   * the DM with them, made when there is none.
   */
  async #target(to: Address): Promise<Where> {
    const parsed = this.#parse(to);
    if ("user" in parsed) return { conversation: await this.#dm(parsed.user) };
    if (parsed.root) return { conversation: parsed.conversation, root: parsed.root };
    if (parsed.message && placeKind(parsed.conversation, this.#state.conversations[parsed.conversation]?.type) === "channel") return { conversation: parsed.conversation, root: parsed.message };
    return { conversation: parsed.conversation };
  }

  /** The DM conversation with a person: the one Teams gave, or a new one (Teams makes it, or gives the one there is). */
  async #dm(user: string): Promise<string> {
    const known = this.#state.dms[user];
    if (known) return known;
    const tenant = this.#tenantId ?? Object.values(this.#state.conversations).find((conversation) => conversation.tenant)?.tenant;
    if (!this.#botId) throw new Error("the bot's Teams ID is not known yet");
    const member = this.#state.people[user]?.id ?? user;
    const answer = (await this.#fetch("bot", "POST", `${this.#serviceUrl()}/v3/conversations`, {
      isGroup: false,
      bot: { id: this.#botId },
      members: [{ id: member }],
      ...(tenant ? { tenantId: tenant, channelData: { tenant: { id: tenant } } } : {}),
    })) as { id?: string };
    if (!answer?.id) throw new Error("Teams made no DM");
    this.#state.dms[user] = answer.id;
    (this.#state.conversations[answer.id] ??= {}).type = "personal";
    this.#save();
    return answer.id;
  }

  /** Where to send for a conversation: the service URL of its events, or else of any event, or else the default. */
  #serviceUrl(conversation?: string): string {
    const known = conversation ? this.#state.conversations[conversation]?.serviceUrl : undefined;
    return (
      known ??
      Object.values(this.#state.conversations).find((each) => each.serviceUrl)?.serviceUrl ??
      (this.#endpoints.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, "")
    );
  }

  /**
   * React to a message. Teams takes a few reactions from a bot: like, heart, laugh, surprised, sad, angry and some
   * others by their Teams ID; an emoji or a name it does not take is refused here.
   */
  async react(message: Address, emoji: string, remove: boolean): Promise<void> {
    const parsed = this.#parse(message);
    if (!("conversation" in parsed) || !parsed.message) throw new Error(`not a message address: ${message}`);
    const type = reactionType(emoji);
    const conversationId = parsed.root ? `${parsed.conversation};messageid=${parsed.root}` : parsed.conversation;
    await this.#fetch("bot", remove ? "DELETE" : "PUT", `${this.#serviceUrl(parsed.conversation)}/v3/conversations/${conversationId}/activities/${parsed.message}/reactions/${encodeURIComponent(type)}`);
  }

  /**
   * The content of a file of a message. A file in a DM comes with a download link of its own, which needs no token; an
   * image pasted in a message is read with the bot token, only at the address of Teams' Bot Connector that Teams' own
   * events gave (as Chat SDK does: no other host gets the token). A file in a channel or a group chat is a SharePoint
   * link, which needs Graph file permissions that only an admin can give: it is not read.
   */
  async fetchFile(file: FileInfo, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const url = new URL(file.url ?? "");
    let headers: Record<string, string> = {};
    if (url.protocol === "https:" && isSharePoint(url.hostname) && url.searchParams.has("tempauth")) {
      // A DM file's own download link.
    } else if (this.#connectorOrigins().has(connectorOrigin(url) ?? "")) {
      const token = await abortable(() => this.#token("bot"), AbortSignal.any([signal, this.#stopping.signal, AbortSignal.timeout(this.#requestTimeout)]));
      headers = token ? { authorization: `Bearer ${token}` } : {};
    } else if (isSharePoint(url.hostname)) {
      throw new Error("Teams gives files in channels and group chats as SharePoint links; reading them needs Graph file permissions (Files.Read.All or Sites.Read.All) that an admin grants. Ask the person to send the file in a DM, or to share it with you another way.");
    } else {
      throw new Error(`not a Teams file URL: ${url.origin}`);
    }
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Teams answered ${response.status} ${response.statusText}`);
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  /**
   * A request with the bot's token. method is "<HTTP method> <path>": a path of Teams' Bot Connector API (/v3/…), at
   * the service URL of the conversation in it; or "graph:<HTTP method> <path>" for Microsoft Graph, with the app's own
   * token (what the app's resource-specific permissions allow). params are the query for GET and DELETE, and the JSON
   * body for the others. A message posted with POST /v3/conversations/<ID>/activities, or as a reply with POST
   * /v3/conversations/<ID>/activities/<activity ID>, is stored as the bot's own.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const match = /^(graph:)?(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/.exec(method.trim());
    if (!match) throw new Error(`call takes "<GET|POST|PUT|PATCH|DELETE> /v3/<path>" for Teams, or "graph:<METHOD> /<path>" for Microsoft Graph; not ${JSON.stringify(method)}`);
    const [, graph, verb, path] = match as unknown as [string, string | undefined, string, string];
    const query = verb === "GET" || verb === "DELETE" ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])) : undefined;
    const body = query ? undefined : params;
    if (graph) {
      const base = path.startsWith("/beta/") ? this.#graph.replace(/\/v1\.0$/, "") : this.#graph;
      return this.#fetch("graph", verb, `${base}${path}${query?.size ? `?${query}` : ""}`, body);
    }
    if (!path.startsWith("/v3/")) throw new Error(`a Teams path starts with /v3/, for example /v3/conversations/<ID>/activities; for Microsoft Graph, use "graph:${verb} ${path}"`);
    const conversation = /^\/v3\/conversations\/([^/;]+)/.exec(path)?.[1];
    const [, posted, replied] = (verb === "POST" && (body?.type === undefined || body.type === "message") && /^\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/.exec(path)) || [];
    // A message the bot posts: the typing there stops first.
    if (posted && conversation) await this.#sink?.sending(this.place(conversation));
    const result = await this.#fetch("bot", verb, `${this.#serviceUrl(conversation)}${path}${query?.size ? `?${query}` : ""}`, body);
    const id = (result as { id?: unknown } | null)?.id;
    if (posted && typeof id === "string") {
      const activity = {
        ...body,
        id,
        conversation: { id: posted },
        ...(replied ? { replyToId: replied } : {}),
        ...(this.#botId ? { from: { id: this.#botId, name: this.#env.botName } } : {}),
        timestamp: new Date().toISOString(),
      };
      await this.#sink?.receive(`sent:${messageKey(whereOf(activity)!, id)}`, { source: "sent", activity } satisfies Raw).catch((error: unknown) => this.#sink?.log("sent message not stored", { error: String(error) }));
    }
    return result;
  }

  /** The origins of Teams' Bot Connector: the service URLs Teams' events gave, and the default one. */
  #connectorOrigins(): Set<string> {
    const urls = [...Object.values(this.#state.conversations).map((conversation) => conversation.serviceUrl), this.#endpoints.serviceUrl ?? DEFAULT_SERVICE_URL];
    return new Set(urls.flatMap((each) => (each ? [connectorOrigin(new URL(each))].filter((origin): origin is string => origin !== undefined) : [])));
  }

  get #requestTimeout(): number {
    return this.#endpoints.timeouts?.request ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * The bot's token for Teams, or the app's token for Graph; never one in playground mode. The SDK and MSAL take no
   * signal, so a getting that a request stops waiting for goes on: the requests of the next minute (as long as a
   * request is tried) wait for the same one rather than begin more, and what it gives after stop goes nowhere.
   */
  #token(kind: "bot" | "graph"): Promise<string | undefined> {
    const app = this.#app;
    if (!app) throw new TeamsError(`channel ${this.id} is not started`);
    if (this.#options.playground) return Promise.resolve(undefined);
    const known = this.#tokens.get(kind);
    if (known && Date.now() - known.started < (this.#endpoints.timeouts?.retry ?? RETRY_MS) + this.#requestTimeout) return known.work;
    const provider = app.tokenProvider;
    const work = (kind === "bot" ? provider.getAppToken() : provider.getAppToken(app.cloud.graphScope, this.#tenantId)).then((token) => (token ? String(token) : undefined));
    const getting = { work, started: Date.now() };
    this.#tokens.set(kind, getting);
    void work
      .finally(() => {
        if (this.#tokens.get(kind) === getting) this.#tokens.delete(kind);
      })
      .catch(() => {});
    return work;
  }

  /**
   * One request to Teams or Graph. One that fails before Teams answers, or that Teams answers with "too many requests"
   * or "busy", is tried again after the wait Teams asks for or a growing one, until a try fails a minute or more after
   * the first began. Each try, its token included, has REQUEST_TIMEOUT_MS. stop ends the request and its waits. The
   * error says what Teams answered, never the token. once: no second try.
   */
  async #fetch(kind: "bot" | "graph", method: string, url: string, body?: unknown, once = false): Promise<unknown> {
    const stopping = this.#stopping.signal;
    const retryMs = this.#endpoints.timeouts?.retry ?? RETRY_MS;
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      if (stopping.aborted) throw new TeamsError(`channel ${this.id} stopped`);
      const signal = AbortSignal.any([stopping, AbortSignal.timeout(this.#requestTimeout)]);
      let wait: number;
      let failure: string;
      try {
        const token = await abortable(() => this.#token(kind), signal);
        const response = await fetch(url, {
          method,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), accept: "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal,
          redirect: "error",
        });
        const text = await response.text();
        const data = text ? parseJson(text) : null;
        if (response.ok) return data;
        failure = `${kind === "graph" ? "Microsoft Graph" : "Teams"} answered ${response.status}${answerText(data, text)}`;
        if (!RETRY_STATUS.has(response.status)) throw new TeamsError(failure);
        wait = retryAfter(response.headers.get("retry-after")) ?? backoff(attempt);
      } catch (error) {
        if (error instanceof TeamsError) throw error;
        if (stopping.aborted) throw new TeamsError(`channel ${this.id} stopped`);
        failure = `${kind === "graph" ? "Microsoft Graph" : "Teams"} did not answer: ${errorText(error)}`;
        wait = backoff(attempt);
      }
      if (once || Date.now() - started >= retryMs) throw new TeamsError(`${failure}; tried for ${Math.round((Date.now() - started) / 1000)} s, then gave up`);
      await sleep(Math.min(wait, Math.max(retryMs - (Date.now() - started), 0)), undefined, { signal: stopping }).catch(() => {});
    }
  }
}

class TeamsError extends Error {}

/** The conversation of an activity, without ";messageid=", and the root of its thread in a channel. */
function whereOf(activity: Activity): Where | undefined {
  const id = activity.conversation?.id;
  if (typeof id !== "string" || !id) return undefined;
  const [conversation] = id.split(";");
  const root = /;messageid=([^;]+)/.exec(id)?.[1];
  return { conversation: conversation!, ...(root ? { root } : {}) };
}

/**
 * An activity's event ID. An activity Teams sends again has the same one. An edit is one event per edit time; an
 * activity without an ID is known by its content.
 */
function activityEventId(activity: Activity): string {
  const where = whereOf(activity) ?? { conversation: "" };
  const id = activity.id ?? createHash("sha256").update(JSON.stringify(activity)).digest("hex").slice(0, 32);
  if (activity.type === "messageUpdate") return `${activity.channelData?.eventType ?? "messageUpdate"}:${messageKey(where, id)}:${activity.timestamp ?? ""}`;
  return `${activity.type}${activity.name ? `/${activity.name}` : ""}:${messageKey(where, id)}`;
}

/**
 * A message in an event ID: its conversation, its thread's root when it is a reply, and its ID, as in its address.
 * Graph keeps a message ID unique only in its chat, channel or thread
 * (https://learn.microsoft.com/graph/api/resources/chatmessage): replies in two threads of a channel can have the same.
 * A root message, or one outside a thread, keeps the key it always had.
 */
function messageKey(where: Where, id: string): string {
  return where.root && where.root !== id ? `${where.conversation}/${where.root}/${id}` : `${where.conversation}/${id}`;
}

/** A message ID of Teams is the time it was made, in Unix ms. */
function messageTime(id: string | undefined): number | undefined {
  return id && /^\d{12,14}$/.test(id) ? Number(id) : undefined;
}

function changedAfter(message: GraphMessage, since: number): boolean {
  const changed = Date.parse(message.lastModifiedDateTime ?? message.createdDateTime ?? "");
  return !Number.isFinite(changed) || changed > since;
}

/** A message as the backfill stores it: a root without the replies Graph expanded, which are stored on their own. */
function withoutReplies(message: GraphMessage): GraphMessage {
  const { replies: _replies, "replies@odata.nextLink": _next, ...rest } = message;
  return rest;
}

/** A DM is "personal"; a group chat "groupChat"; a channel "channel". Without an event's word, by the ID's form. */
function placeKind(conversation: string, type: string | undefined): PlaceKind {
  if (type === "channel") return "channel";
  if (type === "groupChat") return "group";
  if (type === "personal") return "dm";
  if (/@thread\.(tacv2|skype)$/.test(conversation)) return "channel";
  if (/@thread\.v2$/.test(conversation)) return "group";
  return "dm";
}

/** A message's text as Markdown: its HTML when Teams sent one, else its text. */
function activityText(activity: Activity): string {
  const html = (activity.attachments ?? []).find((attachment: any) => attachment?.contentType === "text/html" && typeof attachment.content === "string")?.content as string | undefined;
  const text = html ?? (typeof activity.text === "string" ? activity.text : "");
  if (activity.textFormat === "markdown" && !html) return text;
  return htmlToMarkdown(text);
}

/** Teams' HTML as Markdown, with the line breaks of its blocks kept; mentions as @name. */
function htmlToMarkdown(html: string): string {
  if (!/[<&]/.test(html)) return html;
  const blocks = html
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_all, code: string) => `<p>\`\`\`\n${code.replace(/<br\s*\/?>/gi, "\n")}\n\`\`\`</p>`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol|h\d|blockquote)>/gi, "$&\n\n");
  return converter.toMarkdown(blocks).trim();
}

/** The files of a message: a DM's files with their download link, pasted images, and SharePoint links in channels. */
function activityFiles(activity: Activity): { files?: FileInfo[] } {
  const files: FileInfo[] = [];
  for (const attachment of (activity.attachments ?? []) as Record<string, any>[]) {
    const type = String(attachment?.contentType ?? "");
    if (type === "application/vnd.microsoft.teams.file.download.info" && attachment.content?.downloadUrl) {
      files.push({ ...(attachment.name ? { name: attachment.name } : {}), ...(attachment.content.fileType ? { type: mimeOf(attachment.content.fileType) } : {}), url: attachment.content.downloadUrl });
    } else if (type.startsWith("image/") && attachment.contentUrl) {
      files.push({ ...(attachment.name ? { name: attachment.name } : {}), ...(type !== "image/*" ? { type } : {}), url: attachment.contentUrl });
    } else if (type === "reference" && attachment.contentUrl) {
      files.push({ ...(attachment.name ? { name: attachment.name } : {}), url: attachment.contentUrl });
    }
  }
  return files.length ? { files } : {};
}

function mimeOf(fileType: string): string {
  const types: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip" };
  return types[fileType.toLowerCase()] ?? "application/octet-stream";
}

/** A card's values, one a line, after a colon; nothing when there are none. */
function valuesText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return `: ${String(value)}`;
  const lines = Object.entries(value as Record<string, unknown>).map(([key, each]) => `${key}: ${(typeof each === "string" ? each || "(empty)" : JSON.stringify(each)).replace(/\r?\n/g, "\n  ")}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** A change in a team or a chat, in words. */
function updateText(event: string, activity: Activity): string | undefined {
  const channel = activity.channelData?.channel?.name;
  const team = activity.channelData?.team?.name;
  switch (event) {
    case "teamMemberAdded":
    case "teamMemberRemoved":
      return undefined;
    case "channelCreated":
      return `the channel ${channel ? `"${channel}" ` : ""}was created`;
    case "channelRenamed":
      return `a channel was renamed to "${channel ?? "?"}"`;
    case "channelDeleted":
      return `the channel ${channel ? `"${channel}" ` : ""}was deleted`;
    case "channelRestored":
      return `the channel ${channel ? `"${channel}" ` : ""}was restored`;
    case "teamRenamed":
      return `the team was renamed to "${team ?? "?"}"`;
    case "teamDeleted":
      return "the team was deleted";
    case "teamArchived":
      return "the team was archived";
    case "teamUnarchived":
      return "the team was unarchived";
    case "teamRestored":
      return "the team was restored";
    default:
      return `Teams event ${event}`;
  }
}

/** A reaction as Teams takes it, from an emoji, a name such as :eyes:, or Teams' own ID. */
function reactionType(emoji: string): string {
  const text = emoji.trim();
  if (REACTIONS[text]) return REACTIONS[text];
  const name = /^:?([\w+-]+):?$/.exec(text)?.[1];
  if (name && REACTION_NAMES[name.toLowerCase()]) return REACTION_NAMES[name.toLowerCase()]!;
  if (/^[0-9a-f]{4,6}_\w+$/.test(text)) return text;
  throw new Error(
    `Teams does not take the reaction ${text} from a bot. Use one of 👍 ❤️ 😆 😮 😢 😠 👀 ✅ 🚀 📌 (or like, heart, laugh, surprised, sad, angry, eyes, white_check_mark, rocket, pushpin), or a Teams reaction ID such as 1f440_eyes`,
  );
}

function refusal(text: string): string | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > MAX_BYTES ? `Teams allows about ${MAX_BYTES} bytes in one message; this one has ${bytes}. Send it in parts, or as a page.` : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isSharePoint(host: string): boolean {
  return host.endsWith(".sharepoint.com") || host.endsWith(".sharepoint.us") || host.endsWith(".sharepoint-df.com");
}

/** The origin of a URL that may get the bot token: HTTPS, or HTTP on this computer (as Chat SDK has it, for tests). */
function connectorOrigin(url: URL): string | undefined {
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) return url.origin;
  return undefined;
}

/**
 * What start gives, or the signal's reason once it aborts: for work that takes no signal, such as getting a token. It
 * does not start once the signal has aborted, and an end of the work that comes after is taken and dropped.
 */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const work = start();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What Teams or Graph said in a refused request: its error code and message. */
function answerText(data: unknown, text: string): string {
  const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
  if (error && typeof error === "object") return `: ${[error.code, error.message].filter(Boolean).join(": ")}`;
  if (typeof data === "string" && text) return `: ${text.slice(0, 500)}`;
  return data ? `: ${JSON.stringify(data).slice(0, 500)}` : "";
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 30_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : undefined;
}

/** 1, 2, 4, 8, 15 s, with up to half more at random so many bots do not try at the same moment. */
function backoff(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return base + Math.floor(Math.random() * base * 0.5);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readState(file: string): State {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    return { conversations: value.conversations ?? {}, people: value.people ?? {}, dms: value.dms ?? {}, recovering: value.recovering ?? {} };
  } catch {
    return { conversations: {}, people: {}, dms: {}, recovering: {} };
  }
}

/** Written whole, to a part file first, so a crash leaves the old file or the new one. */
function writeState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const part = `${file}.${randomBytes(6).toString("hex")}.part`;
  try {
    writeFileSync(part, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(part, file);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}
