// Act as a person on a test channel platform (src/channels/test). For tests only.
//
//   node scripts/test-platform.ts <dir> say <place> <person> <text> [thread message id]
//   node scripts/test-platform.ts <dir> edit <place> <person> <message id> <text>
//   node scripts/test-platform.ts <dir> delete <place> <person> <message id>
//   node scripts/test-platform.ts <dir> react <place> <person> <message id> <emoji>
//   node scripts/test-platform.ts <dir> join <place> <person>
//   node scripts/test-platform.ts <dir> show [count]
//
// Prints the new record's ID.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { platformFile, readPlatform } from "../src/channels/test/index.ts";

const [dir, command, place, person, a, b] = process.argv.slice(2);
if (!dir || !command) {
  console.error("usage: <dir> say|edit|delete|react|join|show ...");
  process.exit(2);
}

function append(record: Record<string, unknown>): void {
  const file = platformFile(dir!);
  mkdirSync(dirname(file), { recursive: true });
  const full = { id: `${record.type === "message" ? "m" : "e"}-${randomUUID()}`, at: Date.now(), place, person, ...record };
  appendFileSync(file, `${JSON.stringify(full)}\n`);
  console.log(full.id);
}

switch (command) {
  case "say":
    append({ type: "message", text: a, ...(b ? { thread: b } : {}) });
    break;
  case "edit":
    append({ type: "edit", message: a, text: b });
    break;
  case "delete":
    append({ type: "delete", message: a });
    break;
  case "react":
    append({ type: "reaction_added", message: a, emoji: b });
    break;
  case "join":
    append({ type: "join" });
    break;
  case "show":
    for (const record of readPlatform(dir).slice(-Number(place ?? 20))) console.log(JSON.stringify(record));
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
