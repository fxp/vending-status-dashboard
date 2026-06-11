-- vending-status-history —— 看板探测历史 + 告警状态。
-- 应用：wrangler d1 execute vending-status-history --remote --file=schema.sql

-- 每分钟 cron 写入一行/服务（uptime 曲线 + 延迟趋势的数据源）。
CREATE TABLE IF NOT EXISTS probes (
  ts         INTEGER NOT NULL,   -- 探测时刻（epoch ms）
  service    TEXT    NOT NULL,   -- 服务 key
  up         INTEGER NOT NULL,   -- 1=在线 0=离线
  latency_ms INTEGER,            -- /health 往返（离线为 NULL）
  http       INTEGER             -- HTTP 状态码
);
CREATE INDEX IF NOT EXISTS idx_probes_service_ts ON probes(service, ts);

-- 每服务一行，承载告警去重状态机（up/down + 连续失败计数 + 是否已告警）。
CREATE TABLE IF NOT EXISTS incidents (
  service  TEXT    PRIMARY KEY,
  state    TEXT    NOT NULL DEFAULT 'up',  -- 'up' | 'down'
  fails    INTEGER NOT NULL DEFAULT 0,     -- 当前连续失败次数
  since    INTEGER,                        -- 当前状态起始（epoch ms）
  alerted  INTEGER NOT NULL DEFAULT 0      -- 本次 down 是否已推过告警
);
