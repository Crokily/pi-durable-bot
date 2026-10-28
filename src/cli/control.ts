import { existsSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Console, Effect, Option } from "effect";
import { CliError } from "effect/cli";
import { BOT_ID, botPaths } from "../bot/definition.ts";
import { BOTS_DIR } from "../core/home.ts";

// What every command needs: the bots on this machine, which one a command is for, and its control endpoint.

/** A failure the user can act on, shown as one line. */
export const userError = (message: string) => new CliError.UserError({ cause: message, userMessage: message });

export function listBots(): string[] {
  if (!existsSync(BOTS_DIR)) return [];
  return readdirSync(BOTS_DIR)
    .filter((name) => BOT_ID.test(name) && existsSync(join(BOTS_DIR, name, "bot.json")))
    .sort();
}

export const botDir = (id: string) => join(BOTS_DIR, id);

/** The bot a command is for: --bot, then $POTS_BOT (set in the bot's own shell), then the only bot. */
export const resolveBot = (flag: Option.Option<string>) =>
  Effect.suspend(() => {
    const id = Option.getOrUndefined(flag) ?? process.env.POTS_BOT;
    if (id) return existsSync(join(botDir(id), "bot.json")) ? Effect.succeed(id) : Effect.fail(userError(`there is no bot "${id}" in ${BOTS_DIR}`));
    const bots = listBots();
    if (bots.length === 1) return Effect.succeed(bots[0]!);
    return Effect.fail(userError(bots.length === 0 ? "there are no bots yet; run pots init" : `say which bot with --bot <id> (bots: ${bots.join(", ")})`));
  });

/** Call a running bot's control endpoint. */
export const control = (bot: string, method: "GET" | "POST", path: string, body?: unknown) =>
  Effect.tryPromise({
    try: () => callEndpoint(botPaths(botDir(bot)).socket, method, path, body),
    catch: (error) => userError(error instanceof Error ? error.message : String(error)),
  });

/** Print a command's result: text as it is, anything else as JSON. */
export const printResult = (result: unknown) => Console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));

async function callEndpoint(socketPath: string, method: string, path: string, body: unknown): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const text = await new Promise<string>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: payload ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", (error) => reject(new Error(`the bot is not running (${error.message}); start it with pots service install or pots start`)));
    req.end(payload);
  });
  const answer = JSON.parse(text) as { ok: boolean; result?: unknown; error?: string };
  if (!answer.ok) throw new Error(answer.error ?? "failed");
  return answer.result;
}
