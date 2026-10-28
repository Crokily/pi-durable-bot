import { userInfo } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, ChannelConfig, ChannelEnv } from "../../core/channel.ts";
import { createChannel as createFileChannel } from "../test/index.ts";

/**
 * The person who set the bot up, talking to it in their terminal with `pots chat`. It needs no account, so a new bot
 * can talk before it has joined any chat app. It is the file channel of the test adapter with one DM: `pots chat`
 * appends what the person types to terminal/platform.jsonl in the bot folder and shows what the bot sends there.
 */
export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  return createFileChannel({ ...config, dir: typeof config.dir === "string" ? config.dir : terminalDir(env.botDir), me: "bot" }, env);
}

export function terminalDir(botDir: string): string {
  return join(botDir, "terminal");
}

/** The person at this terminal, as a test-channel name: the OS user name with only letters, digits, "_" and "-". */
export function terminalPerson(): string {
  return userInfo().username.toLowerCase().replace(/[^\w-]+/g, "-") || "you";
}
