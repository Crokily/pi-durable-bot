#!/usr/bin/env node
import { readFileSync } from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Layer, Runtime } from "effect";
import { Command, Flag } from "effect/cli";
import { POTS_HOME, runningGateway } from "../core/home.ts";
import { agentCommands } from "./agent.ts";
import { botCommand } from "./bots.ts";
import { chatCommand } from "./chat.ts";
import { control, listBots, userError } from "./control.ts";
import { initCommand } from "./init.ts";
import * as ServiceLayer from "./service.ts";
import { traceCommand } from "./trace.ts";

// pots: one command for people and for the bots. People set up and run bots (init, chat, service, status); bots and
// their scripts act in their channels (send, react, call, wake, context, turn-page). Each command loads only what it
// uses: the agent's scripts run pots often, and only pots start needs the gateway and the agent.

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/** Set once the gateway runs in this process: from then on it owns SIGINT and SIGTERM and exits by itself. */
let gatewayRunning = false;

const start = Command.make("start", {}, () =>
  Effect.tryPromise({
    try: async () => {
      gatewayRunning = true;
      const { runGateway } = await import("../main.ts");
      await runGateway();
    },
    catch: (error) => {
      gatewayRunning = false;
      return userError(error instanceof Error ? error.message : String(error));
    },
  }).pipe(Effect.andThen(Effect.never)),
).pipe(Command.withDescription("Run the gateway in this terminal, for every bot. The service runs this too."));

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const service = yield* ServiceLayer.Service;
    const pid = runningGateway();
    yield* Console.log(`home: ${POTS_HOME}`);
    yield* Console.log(`gateway: ${pid === undefined ? "not running" : `running (process ${pid})`}`);
    yield* Console.log(`service: ${service.installed() ? `installed (${service.kind})` : "not installed"}`);
    for (const id of listBots()) {
      const line = yield* control(id, "GET", "/status").pipe(
        Effect.map((result) => {
          const bot = result as { name: string; model: string; busy: boolean; channels: { id: string }[]; lastError?: { at: number; error: string } };
          const error = bot.lastError ? `; last failed run ${new Date(bot.lastError.at).toLocaleString()}: ${bot.lastError.error}` : "";
          return `${id}: ${bot.name}, ${bot.model}, ${bot.busy ? "working" : "idle"}, channels ${bot.channels.map((channel) => channel.id).join(", ") || "none"}${error}`;
        }),
        Effect.orElseSucceed(() => `${id}: not running`),
      );
      yield* Console.log(line);
    }
  }),
).pipe(Command.withDescription("Show the gateway, the service and each bot."));

const serviceInstall = Command.make(
  "install",
  { system: Flag.Boolean("system").pipe(Flag.withDefault(false), Flag.withDescription("Linux: a system service (needs sudo) instead of a user service.")) },
  (input) =>
    Effect.gen(function* () {
      const service = yield* ServiceLayer.Service;
      yield* service.install(input);
      yield* Console.log(`Installed and started (${service.kind}).`);
    }),
).pipe(Command.withDescription("Run the gateway in the background, and again at every login. Restarts it when installed."));

const serviceUninstall = Command.make("uninstall", {}, () =>
  Effect.gen(function* () {
    const service = yield* ServiceLayer.Service;
    yield* service.uninstall();
    yield* Console.log("Stopped and removed. The bots' folders stay in place.");
  }),
).pipe(Command.withDescription("Stop the background gateway and remove the service."));

const serviceRestart = Command.make("restart", {}, () =>
  Effect.gen(function* () {
    const service = yield* ServiceLayer.Service;
    yield* service.restart();
  }),
).pipe(
  Command.withDescription("Restart the background gateway."),
);

const serviceLogs = Command.make(
  "logs",
  {
    lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(50)),
    follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
  },
  (input) =>
    Effect.gen(function* () {
      const service = yield* ServiceLayer.Service;
      yield* service.logs(input);
    }),
).pipe(Command.withDescription("Show the gateway's output."));

const service = Command.make("service").pipe(
  Command.withDescription("The gateway as a background service."),
  Command.withSubcommands([serviceInstall, serviceUninstall, serviceRestart, serviceLogs]),
);

const pots = Command.make("pots").pipe(
  Command.withDescription("Pots (pi-durable-bot): AI coworkers that live on this computer and work in your chat apps."),
  Command.withSubcommands([initCommand, chatCommand, start, status, service, botCommand, traceCommand, ...agentCommands]),
);

Command.run(pots, { version }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, ServiceLayer.layer)),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      if (!gatewayRunning) Runtime.defaultTeardown(exit, onExit);
    },
  }),
);
