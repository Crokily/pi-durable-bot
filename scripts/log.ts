// Read-only SQL on a bot's database, for checks by hand.
//   node scripts/log.ts <bot id> "<sql>"
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BOTS_DIR } from "../src/core/home.ts";

const [bot, sql = "SELECT id, kind, place, person, wake, text FROM gw_events ORDER BY id DESC LIMIT 20"] = process.argv.slice(2);
if (!bot) {
  console.error("usage: node scripts/log.ts <bot id> [sql]");
  process.exit(2);
}
const db = new DatabaseSync(join(BOTS_DIR, bot, "bot.sqlite"), { readOnly: true });
for (const row of db.prepare(sql).all()) console.log(JSON.stringify(row));
