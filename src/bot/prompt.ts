import type { ContextStatus } from "../agent/agent.ts";
import type { PersonInfo } from "../core/channel.ts";
import type { PlaceWake, WakeEvent } from "../core/wake.ts";
import { LOG_SCHEMA } from "../gateway/log.ts";
import type { BotPaths } from "./definition.ts";
import type { Timer } from "./timers.ts";

// Everything the agent is told. Facts and mechanisms only; the judgment is the agent's.

export interface PromptFacts {
  id: string;
  name: string;
  paths: BotPaths;
  dataDir: string;
  pb: string;
  /** The node binary, for running pb where PATH has no node (cron). */
  node: string;
  fallbackWakeMinutes: number;
  /** This bot's own person address in each channel account. */
  accounts: readonly { channel: string; me?: PersonInfo }[];
}

export function identitySection(facts: PromptFacts, persona: string): string {
  return `# 你是谁\n你是 ${facts.name}。\n\n${persona.trim()}`;
}

export function workSection(facts: PromptFacts): string {
  const accounts = facts.accounts.map((account) => `  - ${account.channel}：${account.me ? account.me.address : "（还没连上）"}`).join("\n");
  return `# 你怎样工作
- 你是团队里的同事。你在被邀请进去的地方（频道、私信、群聊）旁听全部消息。所有事件都记在消息日志里：没有 @ 你的消息、编辑、删除、reaction、有人加入，也包括你自己发的消息。
- 有事时你会被唤醒：有人 @ 你或给你发私信；Jev 判断有人在聊你负责的事、需要你回应；到了你设的时间；或者兜底巡视。唤醒消息只说在哪里、是谁、为什么，以及每个新事件的时间和现在的时间。内容你自己去日志里读。
- 你正在处理一个地方时，那里的新事件会作为"[新事件]"交给正在工作的你。
- 说不说、说什么、在哪里说、什么时候说，由你判断。消息是不是已经过时、还要不要处理，也由你判断。同事不需要秒回，可以先想、先做事，再回复。
- 你的回答文字不会发给任何人。要在渠道里说话，用 send。加 reaction 用 react。其他平台功能用 call。

# 地址
- 地址是不透明的字符串，指向一个地方、线程、消息或人，开头是渠道账号。从唤醒消息或日志里复制地址，不要自己拼。
- send 的 to：地方 → 一条新消息；线程或消息 → 在那个线程里回复；人 → 私信。
- 在文字里把人的地址放进尖括号，写成 <人的地址>，就会 @ 这个人。
- 你在各渠道账号里的地址：
${accounts}

# 工具和命令行
- 工具：read、write、edit、bash，以及 send、react、call。
- 命令行 ${facts.pb} 做同样的渠道动作，另外管定时唤醒、翻篇和上下文用量。你写的脚本和定时任务也能用它：
  pb send <地址> <文字，或 - 从标准输入读> [--id <发送ID>]   同一个发送 ID 只发一次；重做时用同一个 ID
  pb react <消息地址> <emoji> [--remove]
  pb call <渠道> <方法> [JSON 参数，或 -]
  pb wake --in 30m | --at "2026-10-28 09:00" [--note <文字>]   定时唤醒；不给时间就是现在
  pb wake --list | --cancel <id>
  pb context
  pb turn-page --note <文字>
  在你自己的 bash 以外（例如 cron）运行时，写全：PERSONAL_BOT_NODE=${facts.node} ${facts.pb} --bot ${facts.id} <命令>
- 你在这台机器上有 sudo 和全部权限，操作不需要审批。工作目录：${facts.paths.workspace}`;
}

export function logSection(facts: PromptFacts): string {
  const db = facts.paths.db;
  return `# 消息日志
- SQLite 文件：${db}。只读打开。例如：
  node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare(process.argv[2]).all())' ${db} "SELECT ..."
- 表：
${LOG_SCHEMA}
- bot_wakes(id, at, reason, place, text, submission)：每次唤醒你的记录和唤醒消息全文。
- bot_timers(id, due_at, note, state, set_by, created_at, fired_at)：定时唤醒。set_by 是 agent（你设的）或 fallback（兜底）。
- pi_ 开头的表是你的对话存储（pi-durable）。`;
}

export function folderSection(facts: PromptFacts): string {
  const paths = facts.paths;
  return `# 你的文件夹：${paths.dir}
- bot.json：你的定义：name、model、thinking、channels（渠道账号）、settings。改了以后几秒内自动生效。写错时，错误写在 bot.json.error，旧的定义继续用。
- persona.md：你的人格和说话方式。每次请求前都会读，改了马上生效。
- responsibilities.md：你负责的事。Jev 用它判断没有 @ 你的事件和你有没有关系。你负责的事变了，就更新它。
- notes.md：你的笔记。翻篇后靠它和消息日志找回需要的内容。
- workspace/：工作目录。
- 其他 bot 在 ${facts.dataDir} 下，每个子文件夹一个 bot。你可以改它们的定义；加一个带 bot.json 的文件夹，就多一个 bot。`;
}

export function memorySection(facts: PromptFacts): string {
  return `# 上下文和翻篇
- 你只有一个长期的对话，所有渠道的事件都进这一个对话。
- 每次唤醒都会告诉你：上下文已用多少 token、窗口多大、用到多少时 pi 会自动压缩。也可以随时用 pb context 查。
- 自动压缩会把旧对话变成 pi 写的摘要，细节会丢。什么时候翻篇由你判断。翻篇：先把以后要用的内容写进 ${facts.paths.notes}，再运行 pb turn-page --note "<给新上下文的自己的话>"。新上下文的第一条消息是这段话和笔记全文。翻篇后旧的对话就看不到了，消息日志还在。
- 翻篇在这一轮工具调用结束后生效，这一轮也随之结束。

# 定时唤醒
- 用 pb wake 设定时唤醒，可以同时有多个，时间由你决定：时不时去看大家聊了什么，或者到点去做答应过的事。
- 你一个定时唤醒都没有时，每 ${facts.fallbackWakeMinutes} 分钟兜底巡视一次。`;
}

/** "2026-10-27 17:04:07 星期二 (GMT+11)", in the machine's time zone. */
export function formatTime(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
      hour12: false,
      timeZoneName: "short",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.weekday} (${parts.timeZoneName})`;
}

export function renderContext(status: ContextStatus): string {
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  return `上下文：已用约 ${k(status.used)} tokens，窗口 ${k(status.window)}；用到约 ${k(status.compactAt)} 时 pi 会自动压缩。`;
}

const KINDS: Record<string, string> = {
  message: "消息",
  edit: "编辑",
  delete: "删除",
  reaction_added: "加 reaction",
  reaction_removed: "去掉 reaction",
  join: "加入",
  leave: "离开",
  update: "消息变化（不是文字）",
};

const PLACE_KINDS = { channel: "频道", dm: "私信", group: "群聊" } as const;

function renderEvent(event: WakeEvent): string {
  const parts = [`${formatTime(event.at)} ${KINDS[event.kind] ?? event.kind}`];
  if (event.person) parts.push(`${event.person.name ?? "?"}（${event.person.address}）`);
  if (event.message) parts.push(`消息 ${event.message}`);
  if (event.thread && event.thread !== event.message) parts.push(`线程 ${event.thread}`);
  if (event.mentionsMe) parts.push("@ 了你");
  return `- ${parts.join("，")}`;
}

export function renderPlaceWake(wake: PlaceWake, status: ContextStatus): string {
  let why: string;
  switch (wake.reason) {
    case "mention":
      why = "有人 @ 你";
      break;
    case "dm":
      why = "私信";
      break;
    case "steer":
      why = "你正在处理的地方有新事件";
      break;
    case "relevant":
      why =
        wake.jev && "error" in wake.jev
          ? `没有 @ 你。Jev 这次没能判断（${wake.jev.error}），所以交给你`
          : `没有 @ 你，Jev 判断和你负责的事有关、需要你回应（有关 ${wake.jev?.related.toFixed(2)}，需要回应 ${wake.jev?.respond.toFixed(2)}）`;
      break;
  }
  const place = wake.place;
  const lines = [
    `${wake.reason === "steer" ? "[新事件]" : "[唤醒]"} ${why}`,
    `现在：${formatTime(Date.now())}`,
    `地方：${place.name ?? "?"}（${place.address}，${PLACE_KINDS[place.kind]}）`,
    `新事件（${wake.events.length}）：`,
    ...wake.events.map(renderEvent),
    renderContext(status),
  ];
  return lines.join("\n");
}

export function renderTimerWake(timer: Timer, status: ContextStatus, fallbackMinutes: number): string {
  const why =
    timer.set_by === "fallback"
      ? `兜底巡视：你没有设定时唤醒，默认每 ${fallbackMinutes} 分钟一次`
      : `定时唤醒（你在 ${formatTime(timer.created_at)} 设的）`;
  const lines = [`[唤醒] ${why}`, `现在：${formatTime(Date.now())}`, `计划时间：${formatTime(timer.due_at)}`];
  if (timer.note) lines.push(`备注：${timer.note}`);
  lines.push(renderContext(status));
  return lines.join("\n");
}

export function renderHandoff(note: string, notes: string, notesPath: string): string {
  return `[翻篇] 新的上下文从这里开始。上一段上下文是你自己结束的。
现在：${formatTime(Date.now())}

## 你翻篇时写给自己的话
${note.trim() || "（空）"}

## 笔记全文（${notesPath}）
${notes.trim() || "（笔记是空的）"}`;
}
