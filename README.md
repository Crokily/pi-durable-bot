# personal-bot

自建的常驻 bot，像团队里的同事一样在 Slack 里工作。基于 pi-durable 和 Vercel Chat SDK。

开发方案见 [docs/plan.md](docs/plan.md)。

## 代码结构

| 目录 | 内容 |
|---|---|
| `src/core/` | 中间适配层：gateway 和 agent 共用的类型。不引用 pi-durable 或 Chat SDK。 |
| `src/gateway/` | 消息渠道（Chat SDK）：收消息并写日志、防抖、Jev、唤醒和 steer、巡视计时、发送类工具。 |
| `src/agent/` | agent（pi-durable）：长期 conversation、code mode、工具、提示词、翻篇。 |
| `src/main.ts` | 按配置启动每个 bot。 |
| `scripts/` | 部署和测试用的小工具。 |

## 运行需要

- Node.js 24 或更新。
- `~/.config/personal-bot/slack.env`：`SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`（测试另需 `SLACK_USER_TOKEN`）。
- `~/.config/personal-bot/jev.env`：`JEV_API_KEY`。
- pi 已登录：`~/.pi/agent/auth.json`。
- Slack app 按 [docs/slack-app-manifest.yaml](docs/slack-app-manifest.yaml) 创建。

## 配置

没有 `~/.config/personal-bot/bots.json` 时，只跑一个个人 bot（coly）。要跑多个 bot，或改参数，参考 [config/bots.example.json](config/bots.example.json)。可选字段和默认值见 `src/config.ts`。

每个 bot 的运行数据在 `~/.local/share/personal-bot/<id>/`：

- `bot.sqlite`：消息日志（`gw_` 表）和 pi-durable 存储（`pi_` 表）。
- `notes.md`：agent 的笔记。翻篇后靠它找回内容。
- `responsibilities.md`：bot 负责什么。agent 自己维护，Jev 用它判断。
- `workspace/`：agent 的工作目录。

## 运行和部署

```sh
npm ci
npm start                 # 前台运行
./scripts/deploy.sh       # 复制到 ~/.local/lib/personal-bot，安装并重启 systemd 服务
journalctl -u personal-bot -f
```

## 测试小工具

```sh
node scripts/as-user.ts post <channel> "<text>" [thread_ts]   # 用用户令牌发消息
node scripts/as-user.ts dm <bot user ID> "<text>"
node scripts/as-user.ts edit <channel> <ts> "<text>"
node scripts/as-user.ts delete <channel> <ts>
node scripts/log.ts personal "<只读 SQL>"                      # 查消息日志
node scripts/transcript.ts personal 30                        # 看 agent 最近的上下文
```
