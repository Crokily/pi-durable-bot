import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./agent/agent.ts";
import { FileModelsStore, PiAuthFile } from "./agent/credentials.ts";
import { type BotConfig, loadBots, requireKeys } from "./config.ts";
import { Gateway } from "./gateway/gateway.ts";
import { LogStore, SCHEMA_DOC } from "./gateway/store.ts";

interface RunningBot {
  stop(): Promise<void>;
}

function logger(bot: string) {
  return (message: string, data?: Record<string, unknown>) => {
    console.log(JSON.stringify({ time: new Date().toISOString(), bot, message, ...data }));
  };
}

async function startBot(config: BotConfig): Promise<RunningBot> {
  const log = logger(config.id);
  const slack = requireKeys(config.slackEnv, ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  const jev = requireKeys(config.jevEnv, ["JEV_API_KEY"]);

  const paths = {
    notes: join(config.dataDir, "notes.md"),
    responsibilities: join(config.dataDir, "responsibilities.md"),
    workspace: join(config.dataDir, "workspace"),
  };
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.responsibilities)) await writeFile(paths.responsibilities, `${config.responsibilities}\n`);
  if (!existsSync(paths.notes)) await writeFile(paths.notes, "# 笔记\n");

  // One SQLite file: gateway tables (gw_) and pi-durable tables (pi_) on one connection.
  const dbPath = join(config.dataDir, "bot.sqlite");
  const db = await openNodeSqliteDatabase(dbPath);
  const store = await LogStore.open(db, dbPath);
  const storage = await SqliteStorage.open(db, { prefix: "pi_" });

  const models = createModels({
    credentials: new PiAuthFile(join(homedir(), ".pi/agent/auth.json")),
    modelsStore: new FileModelsStore(join(config.dataDir, "models-store.json")),
  });
  models.setProvider(openaiProvider());
  const [provider, ...rest] = config.model.split("/");
  const model = { provider: provider!, modelId: rest.join("/") };
  if (!models.getModel(model.provider, model.modelId)) {
    await models.refresh();
    if (!models.getModel(model.provider, model.modelId)) throw new Error(`unknown model ${config.model}`);
  }

  const gateway = new Gateway(store, {
    botName: config.name,
    slackAppToken: slack.SLACK_APP_TOKEN!,
    slackBotToken: slack.SLACK_BOT_TOKEN!,
    jevApiKey: jev.JEV_API_KEY!,
    jevThreshold: config.jevThreshold,
    debounceMs: config.debounceMs,
    debounceMaxMs: config.debounceMaxMs,
    responsibilitiesFile: paths.responsibilities,
    defaultPatrolMinutes: config.defaultPatrolMinutes,
    log,
  });
  const agent = await Agent.open({
    storage,
    models,
    model,
    thinking: config.thinking,
    gateway,
    logSchema: SCHEMA_DOC,
    personaFile: config.persona,
    paths,
    turnoverRatio: config.turnoverRatio,
    compaction: config.compaction,
    log,
  });
  await gateway.start(agent);
  log("started", { model: config.model, dataDir: config.dataDir });

  return {
    async stop() {
      await gateway.stop();
      await agent.close(); // closes the storage and the shared connection
      store.close();
      log("stopped");
    },
  };
}

const bots = await Promise.all(loadBots().map(startBot));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ time: new Date().toISOString(), message: "shutdown", signal }));
  const timer = setTimeout(() => process.exit(1), 20_000);
  await Promise.allSettled(bots.map((bot) => bot.stop()));
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => console.log(JSON.stringify({ time: new Date().toISOString(), message: "unhandled rejection", error: String(error) })));
