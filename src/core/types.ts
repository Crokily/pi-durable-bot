// The middle layer. The gateway (Chat SDK) and the agent (pi-durable) share only these types.
// Nothing here imports either dependency.

/** Async SQLite access. pi-durable's NodeSqliteDatabase has this shape, so both sides share one connection. */
export interface Sql extends SqlExecutor {
  transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqlValue[]): Promise<void>;
  get<T extends object>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export type SqlValue = null | number | bigint | string | Uint8Array;

/** Why the agent wakes up. */
export type WakeReason = "mention" | "dm" | "relevant" | "patrol" | "steer";

/** What the gateway hands to the agent: where, who and why. The agent reads the details from the log. */
export interface Wake {
  /** Stable ID. Submitting the same wake twice gives one submission. */
  readonly id: string;
  readonly reason: WakeReason;
  /** Slack channel ID. Absent for a patrol. */
  readonly channel?: string;
  readonly channelName?: string;
  /** Set when all new messages are in one thread. */
  readonly threadTs?: string;
  /** Authors of the new messages, as "name (ID)". */
  readonly people: readonly string[];
  /** ts of the first and last new message. */
  readonly fromTs?: string;
  readonly toTs?: string;
  readonly count: number;
  /** The agent's own patrol note, or why Jev woke it. */
  readonly note?: string;
}

/** The agent side, as the gateway sees it. */
export interface AgentPort {
  /** Start a run, or queue it after the current run. */
  wake(wake: Wake): Promise<void>;
  /** Give new messages to the running work. */
  steer(wake: Wake): Promise<void>;
  /** True while a run works on this channel. */
  isActiveChannel(channel: string): Promise<boolean>;
}

export interface SendResult {
  readonly channel: string;
  readonly ts: string;
  /** True when a crash left the send unclear, and the message was found on Slack instead of sent again. */
  readonly recovered?: boolean;
}

/** The gateway side, as the agent sees it. */
export interface GatewayPort {
  readonly botName: string;
  /** Post into a channel or a thread. `channel` is an ID, "#name", or a user ID (for a DM). Same `sendId`, same message. */
  send(sendId: string, input: { channel: string; text: string; threadTs?: string }): Promise<SendResult>;
  react(input: { channel: string; ts: string; emoji: string; remove?: boolean }): Promise<void>;
  /** Run one read-only SQL statement on the log. */
  query(sql: string, params: readonly SqlValue[]): Promise<Record<string, unknown>[]>;
  /** Replace the pending patrol. Returns the due time in ms. */
  schedulePatrol(minutes: number, note: string): Promise<number>;
  nextPatrol(): Promise<{ dueAt: number; note: string } | undefined>;
}
