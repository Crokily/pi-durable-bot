# personal-bot

自建的常驻 bot，像团队里的同事一样工作。基于 pi-durable 和 Vercel Chat SDK。

开发方案见 [docs/plan.md](docs/plan.md)。

## 代码结构

| 目录 | 层 | 内容 |
|---|---|---|
| `src/core/` | 接口 | 层之间的接口，只用通用的词：渠道、地方、线程、消息、人。地址是不透明的字符串。 |
| `src/channels/` | 渠道 adapter | 每种渠道一个文件夹，只做翻译。`slack/`：Slack（Chat SDK，socket mode）。`test/`：不连真实平台的测试渠道。加一种渠道就是加一个文件夹。 |
| `src/gateway/` | gateway 核心 | 收件箱、消息日志、唤醒（防抖、@ 和私信、Jev、steer）、发件箱（查了再发）。和平台无关。 |
| `src/bot/` | bot | bot 文件夹、定义、定时唤醒、翻篇、提示词、命令行接口。 |
| `src/agent/` | agent | pi-durable：一个长期 conversation，工具 read、write、edit、bash、send、react、call。 |
| `src/cli/`、`bin/pb` | 命令行 | `pb`：渠道动作、定时唤醒、翻篇、上下文用量。 |
| `src/main.ts` | | 按文件夹运行所有 bot，文件夹或 bot.json 变了就跟着变。 |

## 运行需要

- Node.js 24 或更新。
- `~/.config/personal-bot/jev.env`：`JEV_API_KEY`。
- 每个 Slack 账号一个 env 文件（例如 `~/.config/personal-bot/slack.env`）：`SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`。测试另需 `SLACK_USER_TOKEN`，只给测试脚本用。
- pi 已登录：`~/.pi/agent/auth.json`。
- Slack app 按 [docs/slack-app-manifest.yaml](docs/slack-app-manifest.yaml) 创建。

## bot 文件夹

每个 bot 一个文件夹：`~/.local/share/personal-bot/<id>/`。有 `bot.json` 的文件夹就会运行。

```sh
node scripts/new-bot.ts coly --name coly --slack ~/.config/personal-bot/slack.env \
  --persona "……" --responsibilities "……"
```

| 文件 | 内容 |
|---|---|
| `bot.json` | 名字、模型、渠道账号、设置（默认值见 `src/bot/definition.ts`）。运行中改了，几秒内生效；写错时错误写在 `bot.json.error`。 |
| `persona.md` | 人格和说话方式。agent 自己维护。 |
| `responsibilities.md` | 负责的事。Jev 用它判断。agent 自己维护。 |
| `notes.md` | 笔记。翻篇时全文放进新上下文的第一条消息。 |
| `workspace/` | agent 的工作目录。 |
| `bot.sqlite` | 消息日志（`gw_`）、bot（`bot_`）和 pi-durable（`pi_`）的表。 |
| `control.sock` | `pb` 用的本机接口。 |

`bot.json` 例子：

```json
{
  "name": "coly",
  "model": "openai/gpt-6.1-sol",
  "thinking": "medium",
  "channels": [{ "id": "slack", "type": "slack", "secrets": "~/.config/personal-bot/slack.env" }],
  "settings": { "fallbackWakeMinutes": 120 }
}
```

## 运行和部署

```sh
npm ci
npm start                 # 前台运行
./scripts/deploy.sh       # 复制到 ~/.local/lib/personal-bot，安装、enable 并重启 systemd 服务；装 ~/.local/bin/pb
journalctl -u personal-bot -f
```

## 测试小工具

```sh
node scripts/slack-test.ts post <channel> "<text>" [thread ts]   # 用用户令牌发消息
node scripts/slack-test.ts dm "<text>"                           # 用用户令牌给 bot 发私信
node scripts/slack-test.ts edit|delete <channel> <ts> ...
node scripts/slack-test.ts history <channel> [count]
node scripts/slack-test.ts cleanup <channel> [--dry-run] [--before <ts>]
node scripts/test-platform.ts <dir> say <place> <person> "<text>"  # 测试渠道
node scripts/log.ts <bot id> "<只读 SQL>"
node scripts/transcript.ts <bot id> [count]
```

发送中崩溃的测试：在 bot 文件夹里建一个空文件 `crash-after-send`。下一次发送在平台收下之后、发件箱记下之前，进程会被杀掉。
