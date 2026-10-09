/**
 * cline2api 真实链路测试（会真连 https://api.cline.bot，无需 refreshToken）
 *
 * 跑法：
 *   node tests/live.mjs
 *
 * 它做两件事：
 *   A. 直接打上游，验证"只加 X-CLIENT-TYPE 头就能用"的门槛到底是什么
 *      （无头 → 403；只带 UA → 403；带 X-CLIENT-TYPE → 200，且完全不需要 Authorization）
 *   B. 用这份代码起本地 worker，无 token 模式走完整链路（health / models / 非流式 / 流式）
 *
 * 需要能访问 api.cline.bot。只读探测，不会改任何东西。
 */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UPSTREAM = "https://api.cline.bot/api/v1/chat/completions";
const TARGET = "cline-cloud/deepseek-v4.1-flash";
const body = (stream) =>
  JSON.stringify({
    model: TARGET,
    session_id: "sess_live",
    messages: [{ role: "user", content: "reply with exactly: PONG" }],
    ...(stream ? { stream: true } : {}),
  });

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`);
  if (!ok) failures++;
};

// ---------------- A. 上游门槛探测 ----------------
console.log("=== A. 直接打上游：到底哪个头决定放行 ===");
const probes = [
  ["裸请求（无任何头）", {}, false],
  ["只带 User-Agent: Cline/3.0.47", { "User-Agent": "Cline/3.0.47" }, false],
  ["带 X-CLIENT-TYPE: cline-cli", { "X-CLIENT-TYPE": "cline-cli" }, false],
  ["X-CLIENT-TYPE + 假 Authorization", { "X-CLIENT-TYPE": "cline-cli", Authorization: "Bearer workos:bogus" }, false],
];
for (const [label, headers, want403] of probes) {
  const resp = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body(false),
  });
  const text = await resp.text();
  const unlocked = resp.status === 200;
  console.log(`   ${label} -> ${resp.status} ${unlocked ? "(放行)" : "(被拦)"} ${text.slice(0, 90).replace(/\n/g, " ")}`);
  if (label.includes("X-CLIENT-TYPE") && !label.includes("假")) check(`『${label}』可放行且不需要鉴权`, unlocked);
  if (label.includes("裸请求") || label.includes("只带 User-Agent")) check(`『${label}』被 403 拦截`, resp.status === 403);
}

// ---------------- B. 本地 worker 全链路（无 token） ----------------
console.log("\n=== B. 本地 worker 无 token 模式全链路 ===");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(path.join(tmpdir(), "cline2api-live-"));
const modPath = path.join(dir, "worker.mjs");
await writeFile(modPath, await readFile(path.join(root, "worker.js"), "utf8"));
const mod = await import(pathToFileURL(modPath).href);

const ENV = {}; // 故意不给 refreshToken
const BASE = "https://live.test";
const KEY = "cline2api-default-key";
const auth = { "Content-Type": "application/json", Authorization: "Bearer " + KEY };

let res = await mod.default.fetch(new Request(BASE + "/v1/health"), ENV);
const health = await res.json();
console.log("   health:", JSON.stringify(health));
check("health 报告 no-token 模式", health.token_mode === "no-token");

res = await mod.default.fetch(new Request(BASE + "/v1/models"), ENV);
const ids = (await res.json()).data.map((m) => m.id);
check("模型列表含 " + TARGET, ids.includes(TARGET), `count=${ids.length}`);

res = await mod.default.fetch(
  new Request(BASE + "/v1/chat/completions", { method: "POST", headers: auth, body: body(false) }),
  ENV
);
const j = await res.json();
console.log("   非流式:", res.status, JSON.stringify(j.choices?.[0]?.message?.content)?.slice(0, 80), "| usage:", JSON.stringify(j.usage?.total_tokens));
check("非流式真实调用 200", res.status === 200, "content=" + JSON.stringify(j.choices?.[0]?.message?.content));
check("返回给客户端的 model 是外部名", j.model === TARGET);

res = await mod.default.fetch(
  new Request(BASE + "/v1/chat/completions", { method: "POST", headers: auth, body: body(true) }),
  ENV
);
const sse = await res.text();
const lines = sse.split("\n").filter((l) => l.startsWith("data:"));
check("流式真实调用 200", res.status === 200, `sse lines=${lines.length}` + (sse.includes("[DONE]") ? " + [DONE]" : ""));
check("流式有 content 增量", lines.some((l) => (l.match(/"content":"[^"]+"/) || [])[0]));

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
