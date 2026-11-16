import type { InvokeResponse } from "@microsoft/teams.api";
import { App, type AppOptions, type HttpRouteHandler, type IActivityEvent, type IHttpServerAdapter, type IPlugin } from "@microsoft/teams.apps";
import type { ILogger } from "@microsoft/teams.common";

/**
 * Microsoft's Teams SDK app, used only for its transports and its tokens: the Socket Mode socket (or, in HTTP mode, the
 * check of Microsoft's signature on each request) and the bot's and Graph's tokens. Every activity goes to one
 * handler, which stores it; none of the SDK's routes, replies or state runs. The SDK answers Teams with the handler's
 * answer, after the handler: on the socket an acknowledgement with its status, over HTTP the response.
 */
export class TeamsApp extends App {
  readonly #handle: (activity: Record<string, any>) => Promise<InvokeResponse>;

  constructor(handle: (activity: Record<string, any>) => Promise<InvokeResponse>, options: AppOptions<IPlugin>) {
    super(options);
    this.#handle = handle;
  }

  override async onActivity(event: IActivityEvent): Promise<InvokeResponse> {
    return this.#handle(event.body as Record<string, any>);
  }
}

/**
 * The SDK's HTTP transport, without a server of its own: the SDK registers its messaging route here, and the channel
 * calls it with the requests that the page server got.
 */
export class RouteAdapter implements IHttpServerAdapter {
  handler?: HttpRouteHandler;

  registerRoute(_method: "POST", _path: string, handler: HttpRouteHandler): void {
    this.handler = handler;
  }
}

/** One socket of Socket Mode, as the SDK makes it: tests give a fake one. */
export interface SocketConnection {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

/** What the SDK gives a socket of Socket Mode: where to send each envelope, and when it is ready or closed. */
export interface SocketHandlers {
  onActivity(envelope: unknown): Promise<unknown>;
  onReady(frame: { connectionId?: string }): void;
  onClosed(error?: Error): void;
}

/** Make Socket Mode's sockets with this function instead of the SDK's own (for tests). */
export function useSocketConnections(app: App, make: (handlers: SocketHandlers) => SocketConnection): void {
  const adapter = app.socketMode as unknown as { createConnection: (url: string, handlers: SocketHandlers) => SocketConnection } | undefined;
  if (!adapter) throw new Error("the app is not in Socket Mode");
  adapter.createConnection = (_url, handlers) => make(handlers);
}

/** The SDK's log lines, as the channel's log; debug and trace lines are left out. */
export function quietLogger(log: (message: string, data?: Record<string, unknown>) => void): ILogger {
  const line = (level: string) => (...parts: unknown[]) =>
    log(`Teams SDK ${level}`, { message: parts.map((part) => (part instanceof Error ? part.message : typeof part === "string" ? part : safeJson(part))).join(" ").slice(0, 2000) });
  const logger: ILogger = {
    debug: () => {},
    trace: () => {},
    info: () => {},
    warn: line("warning"),
    error: line("error"),
    log: (level, ...parts) => (level === "error" || level === "warn" ? line(level)(...parts) : undefined),
    child: () => logger,
  };
  return logger;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
