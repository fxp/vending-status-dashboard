/**
 * vending-status-dashboard —— 6 个外部服务的实时状态看板（Cloudflare Worker）。
 *
 *   GET /            → HTML 看板（SSE 实时推送，断线自动降级为轮询；含 24h uptime 迷你图）
 *   GET /api/status  → 经 Service Bindings 并发探测 6 服务 /health，聚合 JSON（一次性）
 *   GET /api/stream  → SSE，每 5s 推一帧实时状态
 *   GET /api/uptime  → 从 D1 聚合各服务 24h 可用率 + 近 60 点延迟序列
 *   GET /api/tick    → 手动跑一次「探测+落库+告警」周期（与 cron 同逻辑，用于联调/补数据）
 *   GET /health      → 看板自身健康
 *   cron(每分钟)     → 探测落 D1（uptime 历史）+ 连续失败告警（飞书 webhook）
 *
 * 设计要点：
 *  - 同账号 Worker 之间用 *.workers.dev 公网 URL 互 fetch 会被内部路由吞成 404 → 一律用 Service Bindings。
 *  - 告警走「飞书自定义机器人 webhook」(FEISHU_WEBHOOK_URL secret)，绕开 app-bot 的 im:message 权限；未设则静默。
 */

interface Env {
  UVM: Fetcher; VSC: Fetcher; PAY: Fetcher; WELFARE: Fetcher; IDENTITY: Fetcher; NOTIFY: Fetcher;
  DB: D1Database;
  FEISHU_WEBHOOK_URL?: string;
}

interface Svc { key: string; name: string; binding: keyof Env; host: string; extra?: string }

const SERVICES: Svc[] = [
  { key: "ucp-vending-machine",     name: "贩卖机 · UCP 商家", binding: "UVM",      host: "ucp-vending-machine.fxp007.workers.dev",     extra: "/catalog" },
  { key: "vending-supply-chain",    name: "供应链",            binding: "VSC",      host: "vending-supply-chain.fxp007.workers.dev",    extra: "/machines" },
  { key: "vending-payment-sandbox", name: "支付沙箱",          binding: "PAY",      host: "vending-payment-sandbox.fxp007.workers.dev" },
  { key: "vending-welfare-service", name: "福利账户",          binding: "WELFARE",  host: "vending-welfare-service.fxp007.workers.dev" },
  { key: "vending-identity-service", name: "人脸识别",         binding: "IDENTITY", host: "vending-identity-service.fxp007.workers.dev" },
  { key: "vending-notify-gateway",  name: "通知网关",          binding: "NOTIFY",   host: "vending-notify-gateway.fxp007.workers.dev" },
];

const ALERT_THRESHOLD = 2;          // 连续 N 次失败才告警（防抖）
const RETAIN_MS = 8 * 24 * 3600_000; // 探测历史保留 8 天

// ---------- 探测 ----------
async function timedFetch(fetcher: Fetcher, url: string, ms = 6000): Promise<{ status: number; ms: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const start = Date.now();
  try {
    const r = await fetcher.fetch(new Request(url, { signal: ctrl.signal }));
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, ms: Date.now() - start, json };
  } finally {
    clearTimeout(t);
  }
}

function summarize(key: string, h: any, extra: any): string {
  try {
    switch (key) {
      case "ucp-vending-machine":     return "vm " + (h?.machine_id ?? "?") + " · 在售 " + (extra?.products?.length ?? "–");
      case "vending-supply-chain": {
        const arr = Array.isArray(extra) ? extra : [];
        const low = arr.reduce((s: number, m: any) => s + (m?.low_stock_count || 0), 0);
        return "机器 " + arr.length + " · 缺货 " + low;
      }
      case "vending-payment-sandbox": return "providers " + ((h?.providers || []).join("/") || "–") + " · 订单 " + (h?.orders_in_memory ?? 0);
      case "vending-welfare-service": return "账户 " + (h?.accounts ?? "–");
      case "vending-identity-service": return "已登记 " + (h?.enrolled ?? "–");
      case "vending-notify-gateway":  return "消息 " + (h?.messages ?? 0);
    }
  } catch { /* ignore */ }
  return "online";
}

async function probe(svc: Svc, env: Env) {
  const base = "https://" + svc.host;
  const fetcher = env[svc.binding] as Fetcher;
  try {
    const health = await timedFetch(fetcher, base + "/health");
    const up = health.status === 200 && (health.json?.ok === true || health.json?.status === "ok");
    let extra: any = null;
    if (up && svc.extra) {
      try { extra = (await timedFetch(fetcher, base + svc.extra)).json; } catch { /* best-effort */ }
    }
    return { key: svc.key, name: svc.name, url: base, up, http: health.status, latencyMs: health.ms,
             summary: up ? summarize(svc.key, health.json, extra) : "", error: null as string | null };
  } catch (e: any) {
    return { key: svc.key, name: svc.name, url: base, up: false, http: 0, latencyMs: null, summary: "", error: String(e?.message || e) };
  }
}

async function probeAll(env: Env) {
  const services = await Promise.all(SERVICES.map((s) => probe(s, env)));
  return { ts: Date.now(), up: services.filter((s) => s.up).length, total: services.length, services };
}

// ---------- 告警（飞书自定义机器人 webhook）----------
async function feishuAlert(env: Env, title: string, lines: string[]) {
  const url = env.FEISHU_WEBHOOK_URL;
  if (!url) return; // 未配置 → 静默
  const body = {
    msg_type: "interactive",
    card: {
      header: { title: { tag: "plain_text", content: title }, template: title.includes("恢复") ? "green" : "red" },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
    },
  };
  try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { /* 告警尽力而为 */ }
}

// ---------- 一次「探测 + 落库 + 告警」周期（cron 与 /api/tick 共用）----------
async function runCycle(env: Env) {
  const snap = await probeAll(env);
  const now = snap.ts;

  // 1) 落探测行
  const inserts = snap.services.map((s) =>
    env.DB.prepare("INSERT INTO probes (ts, service, up, latency_ms, http) VALUES (?,?,?,?,?)")
      .bind(now, s.key, s.up ? 1 : 0, s.latencyMs, s.http));
  await env.DB.batch(inserts);

  // 2) 读告警状态 → 决策 → 发告警 → 写回
  const prev = await env.DB.prepare("SELECT service, state, fails, since, alerted FROM incidents").all();
  const prevMap: Record<string, any> = {};
  for (const row of (prev.results || [])) prevMap[(row as any).service] = row;

  const writes: D1PreparedStatement[] = [];
  for (const s of snap.services) {
    const p = prevMap[s.key] || { state: "up", fails: 0, since: now, alerted: 0 };
    let { state, fails, since, alerted } = p as any;
    if (s.up) {
      if (state === "down" && alerted) {
        const downMin = since ? Math.round((now - since) / 60000) : 0;
        await feishuAlert(env, "✅ 服务恢复 · " + s.name, ["**" + s.name + "** 已恢复", "中断约 **" + downMin + " 分钟**", s.url]);
      }
      state = "up"; fails = 0; alerted = 0; since = (p.state === "up" ? (since || now) : now);
    } else {
      fails = (fails || 0) + 1;
      if (fails >= ALERT_THRESHOLD && !alerted) {
        await feishuAlert(env, "🔴 服务掉线 · " + s.name, ["**" + s.name + "** 连续 " + fails + " 次探测失败",
          "状态：" + (s.error ? "ERR " + s.error : "HTTP " + s.http), s.url + "/health"]);
        alerted = 1; state = "down"; since = now;
      }
    }
    writes.push(env.DB.prepare(
      "INSERT INTO incidents (service,state,fails,since,alerted) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(service) DO UPDATE SET state=excluded.state, fails=excluded.fails, since=excluded.since, alerted=excluded.alerted")
      .bind(s.key, state, fails, since, alerted));
  }
  if (writes.length) await env.DB.batch(writes);

  // 3) 偶尔清理旧数据（每小时第 0 分钟）
  if (new Date(now).getUTCMinutes() === 0) {
    await env.DB.prepare("DELETE FROM probes WHERE ts < ?").bind(now - RETAIN_MS).run();
  }
  return snap;
}

// ---------- uptime 聚合 ----------
async function uptime(env: Env, windowMs: number) {
  const since = Date.now() - windowMs;
  const out: Record<string, any> = {};
  const batch: D1PreparedStatement[] = [];
  for (const s of SERVICES) {
    batch.push(env.DB.prepare("SELECT COUNT(*) total, COALESCE(SUM(up),0) ups, CAST(AVG(latency_ms) AS INTEGER) avglat FROM probes WHERE service=? AND ts>?").bind(s.key, since));
    batch.push(env.DB.prepare("SELECT ts, latency_ms, up FROM probes WHERE service=? AND ts>? ORDER BY ts DESC LIMIT 60").bind(s.key, since));
  }
  const res = await env.DB.batch(batch);
  for (let i = 0; i < SERVICES.length; i++) {
    const agg: any = (res[i * 2].results || [])[0] || { total: 0, ups: 0, avglat: null };
    const pts = ((res[i * 2 + 1].results || []) as any[]).map((r) => ({ t: r.ts, l: r.latency_ms, u: r.up })).reverse();
    const pct = agg.total > 0 ? (agg.ups / agg.total) * 100 : null;
    out[SERVICES[i].key] = { total: agg.total, pct: pct == null ? null : Math.round(pct * 10) / 10, avg: agg.avglat, points: pts };
  }
  return { windowMs, services: out };
}

const J = (o: any, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/status") return J(await probeAll(env));

    if (path === "/api/uptime") {
      const w = Number(url.searchParams.get("window") || 86_400_000);
      return J(await uptime(env, isFinite(w) && w > 0 ? w : 86_400_000));
    }

    if (path === "/api/tick") return J(await runCycle(env));

    if (path === "/api/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const loop = (async () => {
        try {
          for (let i = 0; i < 30; i++) { // ~2.5 分钟后结束，EventSource 自动重连
            const snap = await probeAll(env);
            await writer.write(enc.encode("data: " + JSON.stringify(snap) + "\n\n"));
            await new Promise((r) => setTimeout(r, 5000));
          }
        } catch { /* 客户端断开 */ } finally { try { await writer.close(); } catch { /* noop */ } }
      })();
      ctx.waitUntil(loop);
      return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "connection": "keep-alive", "access-control-allow-origin": "*" } });
    }

    if (path === "/health") return J({ ok: true, service: "vending-status-dashboard", watching: SERVICES.length });

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env));
  },
};

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Vend · 外部服务实时看板</title>
<style>
  :root{ --bg:#0b0e14; --panel:#11161f; --line:#222b39; --txt:#e6edf3; --dim:#8b97a7;
         --up:#3fb950; --down:#f85149; --accent:#58a6ff; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--txt); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
  header{ display:flex; align-items:center; gap:14px; padding:20px 28px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1{ font-size:16px; font-weight:600; margin:0; }
  header h1 small{ color:var(--dim); font-weight:400; margin-left:8px; }
  #head{ color:var(--dim); font-size:13px; } #head b{ color:var(--txt); }
  .live{ font-family:var(--mono); font-size:11px; padding:2px 7px; border-radius:5px; border:1px solid var(--line); color:var(--dim); }
  .live.on{ color:var(--up); border-color:rgba(63,185,80,.4); } .live.off{ color:var(--dim); }
  .spacer{ flex:1; }
  button{ background:var(--panel); color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:6px 12px; font-size:13px; cursor:pointer; }
  button:hover{ border-color:var(--accent); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; padding:24px 28px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; transition:border-color .2s, transform .12s; }
  .card.up{ border-left:3px solid var(--up); } .card.down{ border-left:3px solid var(--down); }
  .card.flash{ transform:translateY(-1px); border-color:var(--accent); }
  .row1{ display:flex; align-items:center; gap:9px; }
  .dot{ width:9px; height:9px; border-radius:50%; flex:none; }
  .dot.up{ background:var(--up); animation:pulse 2s infinite; } .dot.down{ background:var(--down); }
  @keyframes pulse{ 0%{ box-shadow:0 0 0 0 rgba(63,185,80,.5);} 70%{ box-shadow:0 0 0 7px rgba(63,185,80,0);} 100%{ box-shadow:0 0 0 0 rgba(63,185,80,0);} }
  .name{ font-weight:600; font-size:15px; } .lat{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--dim); }
  .url{ display:block; margin:9px 0 11px; font-family:var(--mono); font-size:12px; color:var(--accent); text-decoration:none; word-break:break-all; }
  .url:hover{ text-decoration:underline; }
  .metric{ font-family:var(--mono); font-size:13px; color:var(--txt); background:#0d1117; border:1px solid var(--line); border-radius:7px; padding:7px 10px; }
  .card.down .metric{ color:var(--down); }
  .spark{ display:flex; align-items:center; gap:8px; margin-top:11px; }
  .spark svg{ display:block; } .uptime{ font-family:var(--mono); font-size:11px; color:var(--dim); white-space:nowrap; }
  footer{ color:var(--dim); font-size:12px; padding:4px 28px 28px; }
</style>
</head>
<body>
  <header>
    <h1>Project Vend <small>外部服务实时看板</small></h1>
    <span id="live" class="live off">○ 连接中</span>
    <div class="spacer"></div>
    <div id="head">连接中…</div>
    <button id="pause">⏸ 暂停</button>
  </header>
  <div class="grid" id="grid"></div>
  <footer>SSE 实时推送（断线降级轮询）· 每分钟落 D1 历史 · 连续失败推飞书告警</footer>
<script>
  var paused = false, lastAt = 0, prevUp = {}, up24 = {}, es = null, pollTimer = null;
  var grid = document.getElementById('grid'), head = document.getElementById('head'), liveEl = document.getElementById('live');

  function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function sparkline(pts){
    if (!pts || !pts.length) return '';
    var w = 120, h = 22, n = pts.length;
    var lats = pts.map(function(p){ return p.l == null ? 0 : p.l; });
    var max = Math.max.apply(null, lats.concat([1]));
    var d = '';
    for (var i = 0; i < n; i++){
      var x = (n === 1) ? 0 : (i / (n - 1)) * w;
      var y = h - 2 - (lats[i] / max) * (h - 4);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    var dots = '';
    for (var j = 0; j < n; j++){
      if (!pts[j].u){
        var dx = (n === 1) ? 0 : (j / (n - 1)) * w;
        dots += '<circle cx="' + dx.toFixed(1) + '" cy="' + (h-3) + '" r="1.6" fill="#f85149"/>';
      }
    }
    return '<svg class="spark-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
      + '<path d="' + d + '" fill="none" stroke="#58a6ff" stroke-width="1.3"/>' + dots + '</svg>';
  }

  function cardHTML(s){
    var cls = 'card ' + (s.up ? 'up' : 'down');
    if (prevUp[s.key] !== undefined && prevUp[s.key] !== s.up) cls += ' flash';
    var lat = (s.latencyMs == null) ? '—' : (s.latencyMs + ' ms');
    var body = s.up ? (s.summary || 'online') : (s.error ? ('ERR · ' + esc(s.error)) : ('HTTP ' + s.http));
    var u = up24[s.key];
    var sparkRow = '';
    if (u){
      var pctTxt = (u.pct == null ? '—' : u.pct + '%');
      sparkRow = '<div class="spark">' + sparkline(u.points)
        + '<span class="uptime">24h ' + pctTxt + (u.avg != null ? ' · p̄ ' + u.avg + 'ms' : '') + '</span></div>';
    }
    return '<div class="' + cls + '">'
      + '<div class="row1"><span class="dot ' + (s.up?'up':'down') + '"></span>'
      + '<span class="name">' + esc(s.name) + '</span><span class="lat">' + lat + '</span></div>'
      + '<a class="url" href="' + esc(s.url) + '/health" target="_blank" rel="noopener">' + esc(s.url.replace('https://','')) + '</a>'
      + '<div class="metric">' + body + '</div>' + sparkRow + '</div>';
  }

  function render(data){
    head.innerHTML = '<b>' + data.up + '/' + data.total + '</b> 在线 · 更新 <span id="ago">刚刚</span>';
    grid.innerHTML = data.services.map(cardHTML).join('');
    data.services.forEach(function(s){ prevUp[s.key] = s.up; });
    lastAt = Date.now();
  }

  function setLive(on){ liveEl.className = 'live ' + (on ? 'on' : 'off'); liveEl.textContent = on ? '● SSE 实时' : '○ 轮询'; }

  function loadUptime(){
    fetch('/api/uptime', { cache:'no-store' }).then(function(r){ return r.json(); }).then(function(d){
      up24 = d.services || {};
    }).catch(function(){});
  }

  function startSSE(){
    try { es = new EventSource('/api/stream'); } catch(e){ return startPoll(); }
    es.onmessage = function(ev){ if (!paused){ render(JSON.parse(ev.data)); setLive(true); } };
    es.onerror = function(){ setLive(false); /* EventSource 会自动重连；若彻底失败则轮询兜底 */
      if (es.readyState === 2){ es.close(); es = null; startPoll(); } };
  }
  function startPoll(){
    if (pollTimer) return; setLive(false);
    function tick(){ if (paused) return; fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(render).catch(function(){}); }
    tick(); pollTimer = setInterval(tick, 5000);
  }

  function tickAgo(){ if (!lastAt) return; var s = Math.round((Date.now()-lastAt)/1000); var el = document.getElementById('ago'); if (el) el.textContent = s<=1?'刚刚':(s+'s 前'); }

  document.getElementById('pause').onclick = function(){ paused = !paused; this.textContent = paused ? '▶ 继续' : '⏸ 暂停'; };

  loadUptime(); setInterval(loadUptime, 60000);
  startSSE(); setInterval(tickAgo, 1000);
</script>
</body>
</html>`;
