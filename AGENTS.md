# AGENTS.md — vending-status-dashboard

> 外部服务实时状态看板（Cloudflare Worker）。监控 Project Vend 的 6 个服务，实时 + 历史 + 告警。
> 本文件供**独立开发本 repo 的 Agent** 上手；运行说明见 [README.md](README.md)。

## 角色定位
- ops 工具，**不被 harness 消费**——它监控其余服务，不参与购买闭环。
- 服务端经 **Service Bindings** 并发探测 6 个 worker 的 `/health`，前端 SSE 实时推送，cron 落 D1 做 uptime 历史，连续失败推飞书告警。

## 技术栈 / 绑定（`wrangler.toml`）
- TS + Cloudflare Worker，单文件 `src/index.ts`。
- **Service Bindings**：`UVM/VSC/PAY/WELFARE/IDENTITY/NOTIFY` → 6 个被监控 worker。
- **D1**：`DB` → `vending-status-history`（探测历史 + 告警状态，schema 见 `schema.sql`）。
- **Cron**：`* * * * *`（每分钟探测落库 + 告警）。
- **Secret**：`FEISHU_WEBHOOK_URL`（可选，告警通道；未设则静默 no-op）。`wrangler secret put FEISHU_WEBHOOK_URL`。

## 路由
`/`(看板 HTML) · `/api/status`(一次性聚合) · `/api/stream`(SSE，每 5s 一帧) · `/api/uptime?window=ms`(D1 聚合) · `/api/tick`(手动跑一次探测+落库+告警，联调用) · `/health`。

## ⚠️ 核心设计坑：Service Bindings 而非公网 URL
**同账号 Worker 之间用 `*.workers.dev` 公网 URL 互相 `fetch()` 会被内部路由吞成 404**（直接 curl 却 200）。
所以必须经 `wrangler.toml [[services]]` 绑定 + `env.<BIND>.fetch(...)` 调用。新增/下线被监控服务 → 同步改
`[[services]]` 与 `src/index.ts` 的 `SERVICES` 数组（两处一致）。

## 开发 / 测试 / 部署
```bash
npm install
npm test          # 静态分支冒烟（/ 与 /health，不触网/不触 D1）
wrangler d1 execute vending-status-history --remote --file=schema.sql   # 首次建表
npm run dev
npm run deploy
```
D1 无交互式事务；本 repo 写入用 prepared statement，量小无需 batch。

## CI/CD（GitHub Actions，`.github/workflows/ci.yml`）
- push `main` → typecheck → deploy（含 D1/cron/service bindings）→ curl `/health` 冒烟；PR 只 typecheck。
- secret **`CLOUDFLARE_API_TOKEN`**（需 Workers Scripts + KV + **D1** Edit——本 repo 有 D1 绑定）；workflow 显式给 `CLOUDFLARE_ACCOUNT_ID`；缺 token 守卫优雅跳过。

## 不可破坏的契约
- `GET /health` 返回 `{"ok":true,"service":"vending-status-dashboard","watching":N}`（CI 冒烟断言 `ok:true`）。
- `/api/status` 的 `{ts,up,total,services[{key,name,url,up,http,latencyMs,summary,error}]}` 形状是前端渲染依赖。

## 关系
被监控：`ucp-vending-machine` · `vending-supply-chain` · `vending-payment-sandbox` · `vending-welfare-service` · `vending-identity-service` · `vending-notify-gateway`。
