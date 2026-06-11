// 冒烟：不触网/不触 D1 的静态分支（/ 与 /health）。/api/* 走真实网络/D1，不在单测覆盖。
// 运行：node --experimental-strip-types test/smoke.ts
import worker from "../src/index.ts";

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); } }

const html = await worker.fetch(new Request("https://x/"), {} as any, ctx);
ok(html.status === 200, "/ 返回 200");
ok((html.headers.get("content-type") || "").includes("text/html"), "/ 是 HTML");
const body = await html.text();
ok(body.includes("外部服务实时看板"), "/ 含看板标题");
ok(body.includes("EventSource"), "/ 走 SSE");
ok(body.includes("/api/uptime"), "/ 拉 uptime");

const health = await worker.fetch(new Request("https://x/health"), {} as any, ctx);
ok(health.status === 200, "/health 返回 200");
const hj: any = await health.json();
ok(hj.ok === true && hj.watching === 6, "/health 报告监控 6 个服务");

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
