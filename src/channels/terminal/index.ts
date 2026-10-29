import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, ChannelConfig, ChannelEnv } from "../../core/channel.ts";
import { createChannel as createFileChannel, platformFile } from "../test/index.ts";

/**
 * The person who set the bot up, talking to it in their terminal with `pots chat`. It needs no account, so a new bot
 * can talk before it has joined any chat app. It is the file channel of the test adapter with one DM: `pots chat`
 * appends what the person types to terminal/platform.jsonl in the bot folder and shows what the bot sends there.
 *
 * One more platform method: ask-secret { text, file, keys } sends text that asks for secrets, such as a chat app's
 * tokens. `pots chat` asks for each key without showing what is typed, writes them to that file in the secrets folder
 * and answers with a message that names the keys it wrote, never their values.
 */
export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  const dir = typeof config.dir === "string" ? config.dir : terminalDir(env.botDir);
  const channel = createFileChannel({ ...config, dir, me: "bot" }, env);
  const call = channel.call.bind(channel);
  channel.call = async (method, params) => {
    if (method !== "ask-secret") return call(method, params);
    const secret = secretRequest(params);
    const record = { id: `m-${randomUUID()}`, type: "message", at: Date.now(), place: `dm-${terminalPerson()}`, person: "bot", text: String(params.text ?? ""), secret };
    await appendFile(platformFile(dir), `${JSON.stringify(record)}\n`);
    return { message: `${config.id}:#${record.place}/${record.id}`, asked: secret };
  };
  return channel;
}

export function terminalDir(botDir: string): string {
  return join(botDir, "terminal");
}

/** The person at this terminal, as a test-channel name: the OS user name with only letters, digits, "_" and "-". */
export function terminalPerson(): string {
  return userInfo().username.toLowerCase().replace(/[^\w-]+/g, "-") || "you";
}

export interface SecretRequest {
  /** A file name in the secrets folder, such as slack.env. */
  file: string;
  /** The keys to ask for, such as SLACK_BOT_TOKEN. */
  keys: string[];
}

/** Check the file and keys of an ask-secret, so it can only write KEY=value lines to a file in the secrets folder. */
export function secretRequest(params: Record<string, unknown>): SecretRequest {
  const { file, keys } = params;
  if (typeof file !== "string" || !/^\w[\w.-]*$/.test(file)) throw new Error('ask-secret: "file" must be a file name in the secrets folder, such as "slack.env"');
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === "string" && /^[A-Za-z_]\w*$/.test(key))) {
    throw new Error('ask-secret: "keys" must be a list of names such as ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]');
  }
  return { file, keys: keys as string[] };
}
