/** Async SQLite access. pi-durable's NodeSqliteDatabase has this shape, so the gateway, the bot and pi-durable share one connection. */
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
