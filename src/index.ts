/**
 * vending-status-dashboard —— 6 个外部服务的实时状态看板（Cloudflare Worker）。
 *
 *   GET /            → HTML 看板（前端每 5s 轮询 /api/status，自动刷新）
 *   GET /api/status  → 经 Service Bindings 并发探测 6 个 Worker 的 /health，聚合 JSON
 *   GET /health      → 看板自身健康
 *
 * 为何用 Service Bindings 而非公网 URL：同账号 Worker 之间用 *.workers.dev 互 fetch 会被
 * 内部路由吞成 404（与 ucp-agent 的 env.SUPPLY_CHAIN 一致）。绑定见 wrangler.toml [[services]]。
 * 只读、无状态、无鉴权（仅展示在线状态与公开计数）。
 */

interface Env {
  UVM: Fetcher; VSC: Fetcher; PAY: Fetcher;
  WELFARE: Fetcher; IDENTITY: Fetcher; NOTIFY: Fetcher;
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
      try { extra = (await timedFetch(fetcher, base + svc.extra)).json; } catch { /* secondary best-effort */ }
    }
    return {
      key: svc.key, name: svc.name, url: base,
      up, http: health.status, latencyMs: health.ms,
      summary: up ? summarize(svc.key, health.json, extra) : "",
      error: null as string | null,
    };
  } catch (e: any) {
    return { key: svc.key, name: svc.name, url: base, up: false, http: 0, latencyMs: null, summary: "", error: String(e?.message || e) };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/status") {
      const services = await Promise.all(SERVICES.map((s) => probe(s, env)));
      const body = JSON.stringify({
        ts: new Date().toISOString(),
        up: services.filter((s) => s.up).length,
        total: services.length,
        services,
      });
      return new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vending-status-dashboard", watching: SERVICES.length }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
  body{ margin:0; background:var(--bg); color:var(--txt);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
  header{ display:flex; align-items:center; gap:16px; padding:20px 28px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1{ font-size:16px; font-weight:600; margin:0; letter-spacing:.2px; }
  header h1 small{ color:var(--dim); font-weight:400; margin-left:8px; }
  #head{ color:var(--dim); font-size:13px; }
  #head b{ color:var(--txt); }
  .spacer{ flex:1; }
  button{ background:var(--panel); color:var(--txt); border:1px solid var(--line); border-radius:7px;
          padding:6px 12px; font-size:13px; cursor:pointer; }
  button:hover{ border-color:var(--accent); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; padding:24px 28px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px;
         transition:border-color .2s, transform .12s; }
  .card.up{ border-left:3px solid var(--up); }
  .card.down{ border-left:3px solid var(--down); }
  .card.flash{ transform:translateY(-1px); border-color:var(--accent); }
  .row1{ display:flex; align-items:center; gap:9px; }
  .dot{ width:9px; height:9px; border-radius:50%; flex:none; }
  .dot.up{ background:var(--up); animation:pulse 2s infinite; }
  .dot.down{ background:var(--down); }
  @keyframes pulse{ 0%{ box-shadow:0 0 0 0 rgba(63,185,80,.5);} 70%{ box-shadow:0 0 0 7px rgba(63,185,80,0);} 100%{ box-shadow:0 0 0 0 rgba(63,185,80,0);} }
  .name{ font-weight:600; font-size:15px; }
  .lat{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--dim); }
  .url{ display:block; margin:9px 0 11px; font-family:var(--mono); font-size:12px; color:var(--accent); text-decoration:none; word-break:break-all; }
  .url:hover{ text-decoration:underline; }
  .metric{ font-family:var(--mono); font-size:13px; color:var(--txt); background:#0d1117; border:1px solid var(--line);
           border-radius:7px; padding:7px 10px; }
  .card.down .metric{ color:var(--down); }
  footer{ color:var(--dim); font-size:12px; padding:4px 28px 28px; }
</style>
</head>
<body>
  <header>
    <h1>Project Vend <small>外部服务实时看板</small></h1>
    <div class="spacer"></div>
    <div id="head">连接中…</div>
    <button id="pause">⏸ 暂停</button>
    <button id="refresh">↻ 刷新</button>
  </header>
  <div class="grid" id="grid"></div>
  <footer>每 5 秒自动轮询 · 服务端经 Service Bindings 并发探测 6 个 Worker 的 /health</footer>
<script>
  var POLL_MS = 5000;
  var paused = false, lastAt = 0, prevUp = {};
  var grid = document.getElementById('grid');
  var head = document.getElementById('head');

  function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function cardHTML(s){
    var cls = 'card ' + (s.up ? 'up' : 'down');
    if (prevUp[s.key] !== undefined && prevUp[s.key] !== s.up) cls += ' flash';
    var lat = (s.latencyMs == null) ? '—' : (s.latencyMs + ' ms');
    var body = s.up ? (s.summary || 'online') : (s.error ? ('ERR · ' + esc(s.error)) : ('HTTP ' + s.http));
    return '<div class="' + cls + '">'
      + '<div class="row1"><span class="dot ' + (s.up?'up':'down') + '"></span>'
      + '<span class="name">' + esc(s.name) + '</span>'
      + '<span class="lat">' + lat + '</span></div>'
      + '<a class="url" href="' + esc(s.url) + '/health" target="_blank" rel="noopener">' + esc(s.url.replace('https://','')) + '</a>'
      + '<div class="metric">' + body + '</div>'
      + '</div>';
  }

  function render(data){
    head.innerHTML = '<b>' + data.up + '/' + data.total + '</b> 在线 · 更新 <span id="ago">刚刚</span>';
    grid.innerHTML = data.services.map(cardHTML).join('');
    data.services.forEach(function(s){ prevUp[s.key] = s.up; });
    lastAt = Date.now();
  }

  function poll(){
    if (paused) return;
    fetch('/api/status', { cache:'no-store' })
      .then(function(r){ return r.json(); })
      .then(render)
      .catch(function(){ head.innerHTML = '<b style="color:#f85149">探测失败</b> · 重试中…'; });
  }

  function tickAgo(){
    if (!lastAt) return;
    var sec = Math.round((Date.now() - lastAt) / 1000);
    var el = document.getElementById('ago');
    if (el) el.textContent = sec <= 1 ? '刚刚' : (sec + 's 前');
  }

  document.getElementById('pause').onclick = function(){
    paused = !paused; this.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    if (!paused) poll();
  };
  document.getElementById('refresh').onclick = poll;

  poll();
  setInterval(poll, POLL_MS);
  setInterval(tickAgo, 1000);
</script>
</body>
</html>`;
