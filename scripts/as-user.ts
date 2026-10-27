// Test helper: act in Slack as the user, with SLACK_USER_TOKEN. Only for tests; the bot never gets this token.
//
//   node scripts/as-user.ts post <channel> <text> [thread_ts]
//   node scripts/as-user.ts dm <bot user ID> <text>
//   node scripts/as-user.ts edit <channel> <ts> <text>
//   node scripts/as-user.ts delete <channel> <ts>
//
// Prints the message ts. Never prints the token.
import { join } from "node:path";
import { CONFIG_DIR, requireKeys } from "../src/config.ts";

const { SLACK_USER_TOKEN: token } = requireKeys(join(CONFIG_DIR, "slack.env"), ["SLACK_USER_TOKEN"]);

async function api(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(params),
  });
  const body = (await response.json()) as Record<string, any>;
  if (!body.ok) throw new Error(`${method}: ${body.error}`);
  return body;
}

const [command, a, b, c] = process.argv.slice(2);
switch (command) {
  case "post": {
    const result = await api("chat.postMessage", { channel: a, text: b, ...(c ? { thread_ts: c } : {}) });
    console.log(result.ts);
    break;
  }
  case "dm": {
    const open = await api("conversations.open", { users: a });
    const result = await api("chat.postMessage", { channel: open.channel.id, text: b });
    console.log(open.channel.id, result.ts);
    break;
  }
  case "edit":
    await api("chat.update", { channel: a, ts: b, text: c });
    console.log(b);
    break;
  case "delete":
    await api("chat.delete", { channel: a, ts: b });
    console.log(b);
    break;
  default:
    console.error("usage: post|dm|edit|delete ...");
    process.exit(2);
}
