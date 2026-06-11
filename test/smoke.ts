// 冒烟：不触网的静态分支（/ 与 /health）。/api/status 走真实网络，不在单测覆盖。
// 运行：node --experimental-strip-types test/smoke.ts
import worker from "../src/index.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); } }

const html = await worker.fetch(new Request("https://x/"), {} as any);
ok(html.status === 200, "/ 返回 200");
ok((html.headers.get("content-type") || "").includes("text/html"), "/ 是 HTML");
const body = await html.text();
ok(body.includes("外部服务实时看板"), "/ 含看板标题");
ok(body.includes("/api/status"), "/ 前端会轮询 /api/status");

const health = await worker.fetch(new Request("https://x/health"), {} as any);
ok(health.status === 200, "/health 返回 200");
const hj: any = await health.json();
ok(hj.ok === true && hj.watching === 6, "/health 报告监控 6 个服务");

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
