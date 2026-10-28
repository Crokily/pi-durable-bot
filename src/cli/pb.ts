// pb: the bot's command line. Talks to the running bot over its control socket; tokens stay in the gateway.
//
//   pb send <address> <text|-> [--id <send ID>]
//   pb react <message address> <emoji> [--remove]
//   pb call <channel> <method> [<JSON params>|-]
//   pb wake [--in 30m | --at "2026-10-28 09:00"] [--note <text>]
//   pb wake --list
//   pb wake --cancel <id>
//   pb context
//   pb turn-page --note <text>
//   pb status
// Options for every command: --bot <id> (default: $PI_DURABLE_BOT_ID, or the only bot).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DATA_DIR } from "../bot/definition.ts";

const USAGE = `usage:
  pb send <address> <text|-> [--id <send ID>]
  pb react <message address> <emoji> [--remove]
  pb call <channel> <method> [<JSON params>|-]
  pb wake [--in 30m|2h|1d | --at "2026-10-28 09:00"] [--note <text>]
  pb wake --list | --cancel <id>
  pb context
  pb turn-page --note <text>
  pb status
options: --bot <id>`;

function parse(argv: string[]): { args: string[]; flags: Record<string, string | true> } {
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  const valued = new Set(["id", "in", "at", "note", "bot", "cancel"]);
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item.startsWith("--")) {
      const name = item.slice(2);
      if (valued.has(name)) {
        const value = argv[++i];
        if (value === undefined) fail(`--${name} needs a value`);
        flags[name] = value;
      } else flags[name] = true;
    } else args.push(item);
  }
  return { args, flags };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function socketFor(bot: string | undefined): string {
  let id = bot ?? process.env.PI_DURABLE_BOT_ID;
  if (!id) {
    const bots = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((name) => existsSync(join(DATA_DIR, name, "bot.json"))) : [];
    if (bots.length !== 1) fail(`say which bot with --bot <id> (bots: ${bots.join(", ") || "none"})`);
    id = bots[0]!;
  }
  return join(DATA_DIR, id, "control.sock");
}

function readText(value: string | undefined, name: string): string {
  if (value === undefined) fail(`${name} is required\n${USAGE}`);
  return value === "-" ? readFileSync(0, "utf8") : value;
}

function duration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  if (!match) fail(`bad duration ${JSON.stringify(text)}; use for example 90s, 30m, 2h or 1d`);
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

function time(text: string): number {
  const value = /^\d{12,}$/.test(text) ? Number(text) : Date.parse(text.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T"));
  if (!Number.isFinite(value)) fail(`bad time ${JSON.stringify(text)}; use for example "2026-10-28 09:00" (local time) or Unix ms`);
  return value;
}

async function call(socket: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const text = await new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: payload ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", (error) => reject(new Error(`cannot reach the bot at ${socket}: ${error.message}`)));
    req.end(payload);
  });
  const answer = JSON.parse(text) as { ok: boolean; result?: unknown; error?: string };
  if (!answer.ok) fail(answer.error ?? "failed");
  return answer.result;
}

const { args, flags } = parse(process.argv.slice(2));
const [command, ...rest] = args;
const socket = socketFor(typeof flags.bot === "string" ? flags.bot : undefined);
let result: unknown;
switch (command) {
  case "send":
    result = await call(socket, "POST", "/send", {
      to: rest[0] ?? fail(USAGE),
      text: readText(rest[1], "text"),
      ...(typeof flags.id === "string" ? { id: flags.id } : {}),
    });
    break;
  case "react":
    result = await call(socket, "POST", "/react", { message: rest[0] ?? fail(USAGE), emoji: rest[1] ?? fail(USAGE), remove: flags.remove === true });
    break;
  case "call": {
    const params = rest[2] === undefined ? {} : JSON.parse(readText(rest[2], "params"));
    result = await call(socket, "POST", "/call", { channel: rest[0] ?? fail(USAGE), method: rest[1] ?? fail(USAGE), params });
    break;
  }
  case "wake":
    if (flags.list) result = await call(socket, "GET", "/wakes");
    else if (typeof flags.cancel === "string") result = await call(socket, "POST", "/wakes/cancel", { id: Number(flags.cancel) });
    else {
      const at = typeof flags.in === "string" ? Date.now() + duration(flags.in) : typeof flags.at === "string" ? time(flags.at) : Date.now();
      result = await call(socket, "POST", "/wake", { at, note: typeof flags.note === "string" ? flags.note : "" });
    }
    break;
  case "context":
    result = await call(socket, "GET", "/context");
    break;
  case "turn-page":
    result = await call(socket, "POST", "/turn-page", { note: typeof flags.note === "string" ? flags.note : fail("--note is required") });
    break;
  case "status":
    result = await call(socket, "GET", "/status");
    break;
  default:
    fail(USAGE);
}
console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
