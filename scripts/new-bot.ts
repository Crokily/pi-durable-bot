// Make a bot folder. The running gateway starts it within a few seconds.
//
//   node scripts/new-bot.ts <id> --name <name> [--slack <env file with SLACK_APP_TOKEN and SLACK_BOT_TOKEN>]
//                           [--persona <text>] [--responsibilities <text>] [--model provider/modelId]
//
// The persona and responsibilities are only a start: the agent maintains them.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_MODEL } from "../src/bot/definition.ts";

const [id, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i]!.replace(/^--/, "")] = rest[i + 1] ?? "";
if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || !flags.name) {
  console.error("usage: <id> --name <name> [--slack <env file>] [--persona <text>] [--responsibilities <text>] [--model provider/modelId]");
  process.exit(2);
}
const dir = join(DATA_DIR, id);
if (existsSync(join(dir, "bot.json"))) {
  console.error(`${dir} already has a bot.json`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const channels = flags.slack ? [{ id: "slack", type: "slack", secrets: flags.slack }] : [];
writeFileSync(join(dir, "persona.md"), `${flags.persona ?? ""}\n`);
writeFileSync(join(dir, "responsibilities.md"), `${flags.responsibilities ?? ""}\n`);
writeFileSync(join(dir, "notes.md"), "");
// bot.json last: the gateway starts a folder once it has one.
writeFileSync(join(dir, "bot.json"), `${JSON.stringify({ name: flags.name, model: flags.model ?? DEFAULT_MODEL, thinking: "medium", channels }, null, 2)}\n`);
console.log(dir);
