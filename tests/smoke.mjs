/**
 * cline2api 冒烟测试（无需 refreshToken、无需联网真调上游）
 *
 * 跑法：
 *   node tests/smoke.mjs
 *
 * 覆盖点：
 *   1. /v1/health 返回默认模型
 *   2. /v1/models 能列出 cline-cloud / cline-free / cline-pass 三段模型
 *   3. OpenAI 路径（/v1/chat/completions）：cline-cloud 模型原样透传给上游，
 *      非流式被强制走上游 stream，max_tokens 被剥离，chunks 聚合后返回非流式
 *   4. Anthropic 路径（/v1/messages）：非流式同样强制上游 stream，再转回 Anthropic 格式
 *
 * 说明：worker.js 是 ESM，但仓库没有 package.json（Vercel/CF 都按原样部署），
 * Node 默认按 CJS 解析 .js，所以这里把源码复制成 .mjs 再动态 import；全局 fetch 被替换成 stub。
 */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(path.join(tmpdir(), "cline2api-"));
const modPath = path.join(dir, "worker.mjs");
await writeFile(modPath, await readFile(path.join(root, "worker.js"), "utf8"));
const mod = await import(pathToFileURL(modPath).href);

const API_KEY = "cline2api-default-key";
const ENV = { CLINE_REFRESH_TOKEN: "smoke-test-refresh-token-0123456789" };
const TARGET = "cline-cloud/deepseek-v4.1-flash";

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`);
  if (!ok) failures++;
}

// ---- 上游 stub ----
const upstream = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const json = (o) =>
    new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

  if (url.endsWith("/auth/refresh")) {
    return json({ data: { accessToken: "smoke-token", refreshToken: "rotated", expiresAt: Date.now() + 600000 } });
  }
  if (url.endsWith("/ai/cline/recommended-models")) {
    return json({
      recommended: [{ id: "anthropic/claude-sonnet-5.5" }],
      free: [{ id: "cline-free/mimo-v2.6-flash" }],
      clineCloud: [{ id: TARGET }],
      clinePass: [{ id: "cline-pass/glm-5.3" }],
    });
  }
  if (url.endsWith("/models")) {
    return json({ object: "list", data: [{ id: "deepseek/deepseek-v4-flash" }] });
  }
  if (url.endsWith("/chat/completions")) {
    upstream.push({ url, headers: init.headers || {}, body: JSON.parse(init.body) });
    const chunk = (delta) =>
      "data: " + JSON.stringify({ data: { id: "gen_smoke", model: TARGET, choices: [{ index: 0, delta }] } }) + "\n\n";
    return new Response(chunk({ content: "hello " }) + chunk({ content: "world" }) + "data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  throw new Error("unexpected upstream call: " + url);
};

const post = (pathname, body, headers = {}) =>
  mod.default.fetch(
    new Request("https://smoke.test" + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY, ...headers },
      body: JSON.stringify(body),
    }),
    ENV
  );

// ---- 1. health ----
let res = await mod.default.fetch(new Request("https://smoke.test/v1/health"), ENV);
let health = await res.json();
check("health 200", res.status === 200, JSON.stringify(health));
check("health 默认模型 = " + TARGET, health.model === TARGET);

// ---- 2. /v1/models ----
res = await mod.default.fetch(new Request("https://smoke.test/v1/models"), ENV);
const ids = (await res.json()).data.map((m) => m.id);
check("模型列表含 " + TARGET, ids.includes(TARGET));
check("模型列表含 cline-free/*", ids.some((i) => i.startsWith("cline-free/")));
check("模型列表含 cline-pass/*", ids.some((i) => i.startsWith("cline-pass/")));
check("模型列表无重复", new Set(ids).size === ids.length, `count=${ids.length}`);

// ---- 3. OpenAI 路径 ----
res = await post("/v1/chat/completions", { model: TARGET, messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
const openai = await res.json();
check("OpenAI 非流式 200", res.status === 200);
check(
  "OpenAI 非流式聚合了流式 chunks",
  openai.choices?.[0]?.message?.content === "hello world",
  JSON.stringify(openai.choices?.[0]?.message)
);
check("返回给客户端的 model = " + TARGET, openai.model === TARGET);
const chat = upstream.find((c) => c.url.endsWith("/chat/completions"));
check("上游 model 原样透传", chat?.body?.model === TARGET, chat?.body?.model);
check("上游被强制 stream", chat?.body?.stream === true);
check("max_tokens 被剥离", !("max_tokens" in (chat?.body || {})));
check("上游鉴权用 workos 前缀", String(chat?.headers?.Authorization).startsWith("Bearer workos:"));
check("带上 Cline 客户端指纹头", chat?.headers?.["X-CLIENT-TYPE"] === "cline-sdk");

// ---- 4. Anthropic 路径 ----
upstream.length = 0;
res = await post(
  "/v1/messages",
  { model: TARGET, max_tokens: 16, system: "be brief", messages: [{ role: "user", content: "hi" }] },
  { "x-api-key": API_KEY }
);
const anthropic = await res.json();
check("Anthropic 非流式 200", res.status === 200);
check(
  "Anthropic 响应结构正确",
  anthropic.type === "message" && anthropic.role === "assistant" && anthropic.content?.[0]?.text === "hello world",
  JSON.stringify(anthropic.content)
);
const chat2 = upstream.find((c) => c.url.endsWith("/chat/completions"));
check("Anthropic 路径上游也强制 stream", chat2?.body?.stream === true);

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
