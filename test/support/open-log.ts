// Opens the message log in a database file, as a gateway does at its start, and exits 1 when that fails. With a second
// argument, it says "read" and waits that many ms after it reads the log's columns: another process can open the log in between.
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { openDatabase } from "../../src/agent/agent.ts";
import type { Sql, SqlExecutor } from "../../src/core/sql.ts";
import { MessageLog } from "../../src/gateway/log.ts";

const [path, pause] = process.argv.slice(2);
const db = await openDatabase(path!);
const slow = <T extends SqlExecutor>(sql: T): T =>
  Object.assign(Object.create(sql) as T, {
    all: async (query: string, ...params: never[]) => {
      const rows = await sql.all(query, ...params);
      if (pause && query.startsWith("PRAGMA table_info")) {
        process.stdout.write("read\n");
        await sleep(Number(pause));
      }
      return rows;
    },
  });
const sql: Sql = Object.assign(slow(db as Sql), { transaction: <T>(callback: (tx: SqlExecutor) => Promise<T>) => db.transaction((tx) => callback(slow(tx))) });
const result = await Effect.runPromise(Effect.result(MessageLog.pipe(Effect.provide(MessageLog.layer(sql)))));
await db.close();
if (result._tag === "Failure") {
  console.error(String(result.failure.message));
  process.exitCode = 1;
}
