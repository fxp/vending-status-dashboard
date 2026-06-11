# vending-status-dashboard

Project Vend 外部服务**实时状态看板**（Cloudflare Worker）。服务端经 **Service Bindings** 并发探测 6 个 `*.fxp007.workers.dev` 的 `/health`，前端走 **SSE 实时推送**（断线自动降级轮询），每分钟 **cron** 落 **D1** 历史并对连续失败推**飞书告警**。

## 路由
| 路径 | 说明 |
|---|---|
| `GET /` | HTML 看板：SSE 实时 + 24h uptime 迷你图 + 暂停 |
| `GET /api/status` | 一次性聚合 `{ts, up, total, services[]}` |
| `GET /api/stream` | SSE，每 5s 推一帧（~2.5 分钟后结束，EventSource 自动重连）|
| `GET /api/uptime?window=<ms>` | 从 D1 聚合各服务可用率 + 近 60 点延迟序列（默认 24h）|
| `GET /api/tick` | 手动跑一次「探测+落库+告警」周期（与 cron 同逻辑，联调/补数据用）|
| `GET /health` | 看板自身健康 |
| cron `* * * * *` | 每分钟探测落 D1 + 连续失败告警 |

## 为什么用 Service Bindings
同账号 Worker 之间用 `*.workers.dev` 公网 URL 互相 `fetch()` 会被内部路由**吞成 404**（直接 curl 却 200）。所以经 `wrangler.toml [[services]]` 绑定 + `env.<BIND>.fetch()` 调用，与 `ucp-agent` 的 `env.SUPPLY_CHAIN` 一致。

## 监控对象（改 `src/index.ts` 的 `SERVICES` + `wrangler.toml [[services]]`）
贩卖机(UCP) · 供应链 · 支付沙箱 · 福利账户 · 人脸识别 · 通知网关。实时指标取自各 `/health`（+ 贩卖机 `/catalog`、供应链 `/machines`）。

## 飞书告警（可选，未配则静默 no-op）
连续 2 次探测失败推飞书、恢复时推恢复卡片。走**飞书自定义机器人 webhook**（绕开 app-bot 的 `im:message` 权限）：
1. 飞书群 → 设置 → 群机器人 → 添加「自定义机器人」→ 复制 webhook URL。
2. `wrangler secret put FEISHU_WEBHOOK_URL`（粘贴该 URL）。

## 持久层
独立 D1 `vending-status-history`（schema 见 `schema.sql`），与 harness 核心库 `vend-harness` 分离。探测历史保留 8 天，cron 每小时整点清理。

## 开发 / 部署
```bash
npm run typecheck                                      # tsc --noEmit
npm test                                               # 静态分支冒烟（不触网/D1）
wrangler d1 execute vending-status-history --remote --file=schema.sql   # 首次建表
npm run deploy                                         # → vending-status-dashboard.fxp007.workers.dev
```
