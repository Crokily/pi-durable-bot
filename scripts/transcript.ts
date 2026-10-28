// Print the newest entries of a bot's pi-durable transcript, shortened. Read-only.
//   node scripts/transcript.ts <bot id> [count]
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BOTS_DIR } from "../src/core/home.ts";

const [bot, count = "30"] = process.argv.slice(2);
if (!bot) {
  console.error("usage: node scripts/transcript.ts <bot id> [count]");
  process.exit(2);
}
const db = new DatabaseSync(join(BOTS_DIR, bot, "bot.sqlite"), { readOnly: true });
const rows = db.prepare("SELECT id, record FROM pi_entries ORDER BY id DESC LIMIT ?").all(Number(count)) as { id: number; record: string }[];

const short = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

for (const { id, record } of rows.reverse()) {
  const entry = JSON.parse(record) as { kind: string; data?: unknown; model?: { role: string; content: unknown }[] };
  const parts: string[] = [];
  for (const message of entry.model ?? []) {
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    for (const block of content as Record<string, any>[]) {
      if (block.type === "text") parts.push(`${message.role}: ${short(block.text)}`);
      else if (block.type === "toolCall") parts.push(`${message.role} → ${block.name}: ${short(block.arguments?.code ?? block.arguments, 1500)}`);
      else if (block.type === "thinking") parts.push(`${message.role} (thinking ${String(block.thinking ?? "").length} chars)`);
      else parts.push(`${message.role}: [${block.type}]`);
    }
  }
  console.log(`#${id} ${entry.kind}${parts.length ? `\n  ${parts.join("\n  ")}` : entry.data ? ` ${short(entry.data, 200)}` : ""}`);
}
