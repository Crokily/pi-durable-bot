// Read-only SQL on a bot's log, for checks by hand.
//   node scripts/log.ts <bot id> "<sql>"
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../src/config.ts";

const [bot = "personal", sql = "SELECT channel, ts, user_name, wake, text FROM gw_messages ORDER BY created_at DESC LIMIT 20"] = process.argv.slice(2);
const db = new DatabaseSync(join(DATA_DIR, bot, "bot.sqlite"), { readOnly: true });
console.table(db.prepare(sql).all());
