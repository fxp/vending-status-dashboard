# vending-status-dashboard

Project Vend 外部服务**实时状态看板**（Cloudflare Worker）。服务端并发探测 6 个 `*.fxp007.workers.dev` 的 `/health`，聚合后由前端每 5 秒轮询自动刷新——无 CORS 问题、无状态、无鉴权（仅展示在线状态与公开计数）。

## 路由
| 路径 | 说明 |
|---|---|
| `GET /` | HTML 看板（每 5s 轮询 `/api/status`，含暂停/手动刷新、"更新于 Ns 前"）|
| `GET /api/status` | 服务端并发抓 6 服务 `/health` → `{ts, up, total, services:[{key,name,url,up,http,latencyMs,summary,error}]}` |
| `GET /health` | 看板自身健康 |

## 监控对象（改 `src/index.ts` 的 `SERVICES`）
贩卖机(UCP) · 供应链 · 支付沙箱 · 福利账户 · 人脸识别 · 通知网关。每个服务的实时指标取自其 `/health`（+ 贩卖机 `/catalog`、供应链 `/machines`）。

## 开发 / 部署
```bash
npm run typecheck   # tsc --noEmit
npm test            # 静态分支冒烟（不触网）
npm run dev         # 本地 wrangler dev
npm run deploy      # → vending-status-dashboard.fxp007.workers.dev
```
