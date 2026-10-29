// Slack test helper. Acts as the user with SLACK_USER_TOKEN (tests only; the bot never gets this token), and reads
// or cleans test places with the bot token. Never prints a token.
// The user token needs user scopes the bot's manifest does not ask for: add chat:write and im:write under OAuth &
// Permissions → User Token Scopes, reinstall the app, and put the User OAuth Token (xoxp-…) in slack.env as SLACK_USER_TOKEN.
//
//   node scripts/slack-test.ts post <channel ID> <text> [thread ts]     prints the message ts
//   node scripts/slack-test.ts dm <text>                                 to the bot, prints "<channel> <ts>"
//   node scripts/slack-test.ts edit <channel ID> <ts> <text>
//   node scripts/slack-test.ts delete <channel ID> <ts>
//   node scripts/slack-test.ts history <channel ID> [count]              newest last, with thread replies
//   node scripts/slack-test.ts cleanup <channel ID> [--dry-run] [--before <ts>] [--keep <ts>]...
//       delete the user's and the bot's messages (older than ts, except kept ones); join and leave notices stay
import { join } from "node:path";
import { SECRETS_DIR } from "../src/core/home.ts";
import { readSecrets } from "../src/core/env-file.ts";

const secrets = readSecrets(join(SECRETS_DIR, "slack.env"), ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"]);
type Who = "user" | "bot";

async function api(who: Who, method: string, params: Record<string, string | number | boolean | undefined>): Promise<Record<string, any>> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form.set(key, String(value));
  const token = who === "user" ? secrets.SLACK_USER_TOKEN : secrets.SLACK_BOT_TOKEN;
  for (;;) {
    const response = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Number(response.headers.get("retry-after") ?? 2)));
      continue;
    }
    const body = (await response.json()) as Record<string, any>;
    if (!body.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  }
}

async function ids(): Promise<{ user: string; bot: string }> {
  const [user, bot] = await Promise.all([api("user", "auth.test", {}), api("bot", "auth.test", {})]);
  return { user: user.user_id, bot: bot.user_id };
}

/** Every message of a channel with its thread replies, oldest first. */
async function everything(channel: string): Promise<Record<string, any>[]> {
  const all: Record<string, any>[] = [];
  let cursor: string | undefined;
  do {
    const page = await api("bot", "conversations.history", { channel, limit: 200, cursor });
    for (const message of page.messages as Record<string, any>[]) {
      all.push(message);
      if (message.reply_count) {
        const replies = await api("bot", "conversations.replies", { channel, ts: message.ts, limit: 200 });
        for (const reply of replies.messages as Record<string, any>[]) if (reply.ts !== message.ts) all.push(reply);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return all.sort((a, b) => Number(a.ts) - Number(b.ts));
}

const [command, a, b, c] = process.argv.slice(2);
switch (command) {
  case "post":
    console.log((await api("user", "chat.postMessage", { channel: a, text: b, thread_ts: c })).ts);
    break;
  case "dm": {
    const { bot } = await ids();
    const open = await api("user", "conversations.open", { users: bot });
    const posted = await api("user", "chat.postMessage", { channel: open.channel.id, text: a });
    console.log(open.channel.id, posted.ts);
    break;
  }
  case "edit":
    await api("user", "chat.update", { channel: a, ts: b, text: c });
    console.log(b);
    break;
  case "delete":
    await api("user", "chat.delete", { channel: a, ts: b });
    console.log(b);
    break;
  case "history": {
    const { user, bot } = await ids();
    const who = (id: string | undefined) => (id === user ? "user" : id === bot ? "bot" : (id ?? "?"));
    for (const message of (await everything(a!)).slice(-Number(b ?? 20))) {
      const reactions = (message.reactions ?? []).map((reaction: any) => `:${reaction.name}:`).join("");
      console.log(`${message.ts}${message.thread_ts && message.thread_ts !== message.ts ? ` (in ${message.thread_ts})` : ""} ${who(message.user)}${message.subtype ? ` [${message.subtype}]` : ""}: ${String(message.text ?? "").replace(/\n/g, " ").slice(0, 160)} ${reactions}`);
    }
    break;
  }
  case "cleanup": {
    const options = process.argv.slice(4);
    const dry = options.includes("--dry-run");
    const before = options.includes("--before") ? options[options.indexOf("--before") + 1] : undefined;
    const keep = new Set(options.flatMap((option, index) => (option === "--keep" ? [options[index + 1]] : [])));
    const { user, bot } = await ids();
    let deleted = 0;
    const skipped: string[] = [];
    for (const message of (await everything(a!)).reverse()) {
      const owner: Who | undefined = message.user === user ? "user" : message.user === bot ? "bot" : undefined;
      const notice = message.subtype === "channel_join" || message.subtype === "channel_leave";
      if (!owner || notice || keep.has(message.ts) || (before && Number(message.ts) >= Number(before))) {
        skipped.push(`${message.ts} ${message.user ?? message.bot_id ?? "?"} ${message.subtype ?? ""}`);
        continue;
      }
      if (!dry) await api(owner, "chat.delete", { channel: a, ts: message.ts });
      deleted++;
    }
    console.log(`${dry ? "would delete" : "deleted"} ${deleted}; not ours: ${skipped.length}`);
    for (const line of skipped) console.log(`  ${line}`);
    break;
  }
  default:
    console.error("usage: post|dm|edit|delete|history|cleanup ...");
    process.exit(2);
}
