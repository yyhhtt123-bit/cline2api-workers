/**
 * cline2api v2 · 核心逻辑（平台无关，Node 18+ / Cloudflare Workers 通用）
 * =============================================================================
 * 把 https://cline.bot 的模型额度转成标准 OpenAI / Anthropic 兼容 API。
 *
 * 与旧版（yyhhtt123-bit/cline2api-workers）的关键差异，全部基于 2026-10 实测：
 *
 *  1. 默认模型 = `cline-cloud/deepseek-v4.1-flash`
 *     - 它是 Cline 三层里 `clineCloud` 层唯一的模型，实测 0 credits、1M 上下文、带 reasoning。
 *     - 旧的 `cline-free/deepseek-v4.1-flash` 已下架（不在 free 数组里），任何地方都不该再出现。
 *
 *  2. 上游"指纹头"只需一个：`X-CLIENT-TYPE: cline-sdk`
 *     - 实测：只加它就 200；只加 User-Agent 或什么都不加 → 403
 *       "only available via Cline product surfaces"。
 *     - 旧版那一堆 HTTP-Referer / X-CLIENT-VERSION / X-PLATFORM / X-CORE-VERSION 无用。
 *
 *  3. `max_tokens` 不是"带上就炸"，而是"太小才炸"
 *     - 实测 max_tokens=1/16 → 500 {"error":"empty response content"}（reasoning 吃光预算）；
 *       max_tokens=100/500 → 200 正常，finish_reason="length"。
 *     - 因此策略：小于 MIN_MAX_TOKENS 的值直接丢弃（GUI 的"测试模型"固定发 max_tokens:1，
 *       丢掉它反而能测通）；>= 阈值的原样透传。
 *
 *  4. 并发不需要串行
 *     - 旧版为"并发 >1 上游返回空响应"做了全局串行队列 + 800ms 间隔；实测当前并发 3 个全 200。
 *     - 新版不做全局串行，只保留按账号的并发上限（默认 8）。
 *
 *  5. 三层模型列表来自 recommended-models
 *     - GET /api/v1/ai/cline/recommended-models 返回 4 个数组：
 *       recommended / free(cline-free/*) / clinePass(cline-pass/*) / clineCloud(cline-cloud/*)
 *     - 这些 ID 不在公开的 GET /api/v1/models（467 个）里，只能从这里拿。
 *
 * 环境变量（全部可选，想真正白嫖需要 CLINE_REFRESH_TOKEN）：
 *  - CLINE_REFRESH_TOKEN  一行一个 refreshToken，支持多账号（额度用尽自动切号）
 *  - CLINE_ACCESS_TOKEN   已有 accessToken 时可直接填（与上者二选一）
 *  - API_KEY              客户端访问密钥；不设 = 不鉴权（开放模式）
 *  - DEFAULT_MODEL        覆盖默认模型
 *  - FALLBACK_TO_DEFAULT  "false" 时关闭"未知模型回落到默认模型"
 *  - MIN_MAX_TOKENS       默认 100，低于此值的 max_tokens 丢弃
 *  - CLINE_API_BASE       覆盖上游地址（默认 https://api.cline.bot/api/v1）
 * =============================================================================
 */

export const VERSION = "2.0.0";
export const DEFAULT_MODEL_ID = "cline-cloud/deepseek-v4.1-flash";
const DEFAULT_API_BASE = "https://api.cline.bot/api/v1";

// 内置兜底模型列表（recommended-models 拉取失败时用）
const BUILTIN_MODELS = [
  { id: "cline-cloud/deepseek-v4.1-flash", tier: "cloud", usable: true },
  { id: "cline-free/mimo-v2.6-flash", tier: "free", usable: true },
  { id: "cline-free/muse-spark-1.3-contributor", tier: "free", usable: true },
  { id: "cline-free/step-5-preview", tier: "free", usable: true },
  { id: "cline-free/solar-mini4", tier: "free", usable: true },
];

// 常见客户端硬编码的模型名 → 统一映射到默认免费模型
const MODEL_ALIASES = {
  "gpt-4o": DEFAULT_MODEL_ID,
  "gpt-4o-mini": DEFAULT_MODEL_ID,
  "gpt-4.1": DEFAULT_MODEL_ID,
  "gpt-4-turbo": DEFAULT_MODEL_ID,
  "gpt-3.5-turbo": DEFAULT_MODEL_ID,
  "deepseek-chat": DEFAULT_MODEL_ID,
  "deepseek-reasoner": DEFAULT_MODEL_ID,
  "deepseek-v4.1-flash": DEFAULT_MODEL_ID,
  "claude-3-5-sonnet-20241022": DEFAULT_MODEL_ID,
  "claude-3-5-haiku-20241022": DEFAULT_MODEL_ID,
  "claude-sonnet-4-20250514": DEFAULT_MODEL_ID,
  "claude-3-opus-20240229": DEFAULT_MODEL_ID,
  "claude-sonnet-4.5": DEFAULT_MODEL_ID,
  "claude-haiku-4.5": DEFAULT_MODEL_ID,
};

const MODELS_TTL_MS = 10 * 60 * 1000; // 模型列表缓存 10 分钟

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function readEnv(env, key) {
  const v = env?.[key];
  return typeof v === "string" ? v.trim() : "";
}

export function getConfig(env) {
  const minMaxTokens = parseInt(readEnv(env, "MIN_MAX_TOKENS") || "100", 10);
  const maxConcurrent = parseInt(readEnv(env, "MAX_CONCURRENT") || "8", 10);
  return {
    apiBase: readEnv(env, "CLINE_API_BASE") || DEFAULT_API_BASE,
    defaultModel: readEnv(env, "DEFAULT_MODEL") || DEFAULT_MODEL_ID,
    apiKey: readEnv(env, "API_KEY"),
    fallbackToDefault: readEnv(env, "FALLBACK_TO_DEFAULT").toLowerCase() !== "false",
    minMaxTokens: Number.isFinite(minMaxTokens) && minMaxTokens > 0 ? minMaxTokens : 100,
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 8,
    // /v1/models 默认公开（方便 GUI 校验），设为 true 则一并要求 API_KEY
    protectModels: readEnv(env, "PROTECT_MODELS").toLowerCase() === "true",
  };
}

// ---------------------------------------------------------------------------
// 账号池：refreshToken → accessToken，自动刷新 / 轮换 / 冷却
// ---------------------------------------------------------------------------

let accounts = [];
let accountCursor = 0;

function parseRefreshTokens(env) {
  return readEnv(env, "CLINE_REFRESH_TOKEN")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

export function getAccountPool(env) {
  const tokens = parseRefreshTokens(env);
  const accessToken = readEnv(env, "CLINE_ACCESS_TOKEN");
  const want = tokens.length ? tokens : accessToken ? ["<direct-access-token>"] : [];
  const changed =
    accounts.length !== want.length || accounts.some((a, i) => a.refreshToken !== want[i]);
  if (changed) {
    accounts = want.map((rt) => ({
      refreshToken: rt,
      direct: rt === "<direct-access-token>",
      accessToken: rt === "<direct-access-token>" ? accessToken : null,
      expiry: rt === "<direct-access-token>" ? Date.now() + 365 * 24 * 3600 * 1000 : 0,
      cooldownUntil: 0,
      inflight: 0,
    }));
  }
  return accounts;
}

async function refreshAccountToken(account, cfg) {
  const now = Date.now();
  if (account.accessToken && now < account.expiry) return account.accessToken;
  if (account.direct) return account.accessToken;

  const resp = await fetch(cfg.apiBase + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: account.refreshToken, grantType: "refresh_token" }),
  });
  if (!resp.ok) {
    account.cooldownUntil = now + 60_000; // 刷新失败：冷却 60s，交给上层切号
    throw new Error("refresh_failed_" + resp.status);
  }
  const data = (await resp.json())?.data || {};
  if (!data.accessToken) {
    account.cooldownUntil = now + 60_000;
    throw new Error("refresh_no_token");
  }
  account.accessToken = data.accessToken;
  // Cline 刷新时会轮换 refreshToken，必须回写，否则下次 invalid_grant
  if (typeof data.refreshToken === "string" && data.refreshToken.trim()) {
    account.refreshToken = data.refreshToken.trim();
  }
  const expiresAt = data.expiresAt;
  let expiry = now + 10 * 60_000;
  if (typeof expiresAt === "number") expiry = expiresAt;
  else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!Number.isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60_000;
  return account.accessToken;
}

/** 取一个可用账号（round-robin，跳过冷却中/满载的） */
function pickAccount(env, cfg) {
  const pool = getAccountPool(env);
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const acc = pool[accountCursor % pool.length];
    accountCursor = (accountCursor + 1) % pool.length;
    if ((!acc.cooldownUntil || acc.cooldownUntil <= now) && acc.inflight < cfg.maxConcurrent) {
      return acc;
    }
  }
  // 全都在冷却/满载 → 返回冷却时间最短的（不空转，交给上游返回真实错误）
  return pool.slice().sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0] || null;
}

function cooldownAccount(account, ms) {
  if (!account) return;
  account.cooldownUntil = Date.now() + ms;
  if (!account.direct) {
    account.accessToken = null;
    account.expiry = 0;
  }
}

/** 解析上游 429 里的等待时长："Try again in 2h 51m" */
export function parseCooldownMs(text, status) {
  const m = /try again in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text || "");
  if (m) {
    const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600_000);
  }
  return status === 429 ? 5 * 60_000 : 60_000;
}


// ---------------------------------------------------------------------------
// 模型列表：三层（free / pass / cloud）全部来自 recommended-models
// ---------------------------------------------------------------------------

let modelsCache = null;
let modelsCacheAt = 0;

function mapTier(list, tier, usable) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({ id: m.id, name: m.name || m.id, tier, usable }));
}

/**
 * 拉取三层模型列表。
 * clineCloud / cline-free 实测可用（0 credits），cline-pass 需要订阅（403 ENTITLEMENT_ERROR）。
 */
export async function getModels(env, force = false) {
  const cfg = getConfig(env);
  const now = Date.now();
  if (!force && modelsCache && now - modelsCacheAt < MODELS_TTL_MS) return modelsCache;
  try {
    const resp = await fetch(cfg.apiBase + "/ai/cline/recommended-models", {
      headers: upstreamHeaders(null, null, env),
    });
    if (!resp.ok) throw new Error("http_" + resp.status);
    const data = await resp.json();
    const list = [
      ...mapTier(data.clineCloud, "cloud", true),
      ...mapTier(data.free, "free", true),
      ...mapTier(data.clinePass, "pass", false),
      ...mapTier(data.recommended, "paid", true),
    ];
    if (list.length === 0) throw new Error("empty_list");
    // 去重（同名模型保留第一个）
    const seen = new Set();
    modelsCache = list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    modelsCacheAt = now;
    return modelsCache;
  } catch (e) {
    if (!modelsCache) modelsCache = BUILTIN_MODELS.map((m) => ({ ...m, name: m.id }));
    return modelsCache;
  }
}

/**
 * 把客户端传来的模型名解析成上游真实模型 ID。
 * 顺序：精确命中 → 别名 → 前缀模糊（如只写 deepseek-v4.1-flash）→ 回落默认模型。
 */
export async function resolveModel(env, requested) {
  const cfg = getConfig(env);
  const req = (requested || "").trim();
  if (!req) return { upstream: cfg.defaultModel, tier: "cloud" };
  const models = await getModels(env);
  const exact = models.find((m) => m.id === req);
  if (exact) return { upstream: exact.id, tier: exact.tier, usable: exact.usable };
  if (MODEL_ALIASES[req]) return { upstream: MODEL_ALIASES[req], tier: "cloud", aliased: true };
  const fuzzy = models.find((m) => m.id.endsWith("/" + req) || m.id.split("/").pop() === req);
  if (fuzzy) return { upstream: fuzzy.id, tier: fuzzy.tier, usable: fuzzy.usable, fuzzy: true };
  if (cfg.fallbackToDefault) return { upstream: cfg.defaultModel, tier: "cloud", fallback: true };
  return { upstream: req, tier: "unknown" };
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

export function upstreamHeaders(accessToken, sessionId, env) {
  // 官方客户端头集合（取自 cline/cline 仓库 sdk/packages/llms/src/providers/request-headers.ts
  // 的 DEFAULT_CLINE_REQUEST_HEADERS + buildClineRequestHeaders）。
  // ⚠️ 少发这些头会被上游拒绝（实测 403 "This request is not supported" 或
  //    "only available via Cline product surfaces"）。版本号可随官方更新，用环境变量覆盖：
  //    CLINE_CLIENT_VERSION / CLINE_CLIENT_TYPE / CLINE_CORE_VERSION
  const version = readEnv(env, "CLINE_CLIENT_VERSION") || "3.0.70";
  const clientType = readEnv(env, "CLINE_CLIENT_TYPE") || "cline-sdk";
  const coreVersion = readEnv(env, "CLINE_CORE_VERSION") || "0.0.92";
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Cline/" + version,
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": clientType,
    "X-CLIENT-VERSION": version,
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": version,
    "X-CORE-VERSION": coreVersion,
  };
  if (sessionId) headers["X-Task-ID"] = sessionId;
  if (accessToken) headers.Authorization = "Bearer workos:" + accessToken;
  return headers;
}

/** 上游请求体预处理：过小的 max_tokens 会让上游 500 "empty response content"，丢弃之 */
function sanitizeBody(body, cfg, notes) {
  const out = { ...body };
  const mt = out.max_tokens;
  if (typeof mt === "number" && mt > 0 && mt < cfg.minMaxTokens) {
    delete out.max_tokens;
    notes.push(`max_tokens=${mt} < ${cfg.minMaxTokens}，已丢弃以避免上游 500`);
  }
  if (out.max_tokens === undefined && typeof out.max_completion_tokens === "number") {
    if (out.max_completion_tokens < cfg.minMaxTokens) delete out.max_completion_tokens;
    else {
      out.max_tokens = out.max_completion_tokens;
      delete out.max_completion_tokens;
    }
  }
  delete out.stream_options; // 上游不认，且我们自行补齐 usage
  return out;
}

/** 单次上游调用（含账号获取）；401 时换号重试一次 */
async function clineFetchOnce(env, cfg, body, sessionId, attempt = 0) {
  const account = pickAccount(env, cfg);
  let token = null;
  if (account) {
    try {
      token = await refreshAccountToken(account, cfg);
    } catch (e) {
      token = account.accessToken || null;
    }
  }
  if (account) account.inflight++;
  try {
    const resp = await fetch(cfg.apiBase + "/chat/completions", {
      method: "POST",
      headers: upstreamHeaders(token, sessionId, env),
      body: JSON.stringify(body),
    });
    if (resp.status === 401 && account && attempt < 1) {
      cooldownAccount(account, 30_000);
      return null; // 交给上层换号重试
    }
    return { resp, account };
  } finally {
    if (account) account.inflight--;
  }
}

/**
 * 带换号重试的上游调用。
 * 触发换号的信号：401（token 失效）/ 429（日额度或限流）/ 5xx 且 body 含
 * "empty response content"（免费通道偶发空响应）。
 * 所有账号都在冷却时直接返回最后一次响应，不空转。
 */
export async function callUpstream(env, cfg, body, sessionId, { maxAttempts = 3 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await clineFetchOnce(env, cfg, body, sessionId, 0);
    if (!r) continue; // 401 已冷却，换号
    last = r;
    const { resp, account } = r;
    if (resp.ok) return r;

    let text = "";
    try {
      text = await resp.clone().text();
    } catch {}
    const retriable =
      resp.status === 429 ||
      (resp.status >= 500 && text.includes("empty response content")) ||
      (resp.status >= 500 && !text);
    if (!retriable) return r;

    cooldownAccount(account, parseCooldownMs(text, resp.status));
    const pool = getAccountPool(env);
    const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
    if (!hasOther) return r; // 全冷却：把上游真实错误返回给客户端
    await sleep(300 + Math.floor(Math.random() * 400));
  }
  return last;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 响应归一化
// ---------------------------------------------------------------------------

/** 剥掉上游 {data:{...}} 包装（非流式响应会包一层，流式不会，两种都要兼容） */
export function unwrapData(obj) {
  if (obj && typeof obj === "object" && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

/** 补上 OpenAI 生态约定的 reasoning_content 字段（DeepSeek/OpenAI SDK 认这个） */
function withReasoningAlias(msg) {
  if (msg && typeof msg.reasoning === "string" && msg.reasoning && !msg.reasoning_content) {
    msg.reasoning_content = msg.reasoning;
  }
  return msg;
}

/** 非流式响应归一化 */
export function normalizeCompletion(raw, externalModel) {
  const out = { ...unwrapData(raw) };
  if (externalModel) out.model = externalModel;
  if (!out.object) out.object = "chat.completion";
  if (!out.id) out.id = "gen_" + Date.now();
  if (!out.created) out.created = Math.floor(Date.now() / 1000);
  for (const choice of out.choices || []) withReasoningAlias(choice.message);
  return out;
}

/** 流式 chunk 归一化 */
function normalizeChunk(obj, externalModel) {
  const out = { ...unwrapData(obj) };
  if (externalModel) out.model = externalModel;
  for (const choice of out.choices || []) {
    const d = choice.delta;
    if (d) withReasoningAlias(d);
  }
  return out;
}

/**
 * 把上游 SSE 转成标准 OpenAI SSE 透传给客户端。
 * 处理：剥 data 包装、改写 model 名、补 reasoning_content、保证以 [DONE] 收尾。
 */
export function sseTransform(upstream, externalModel, onUsage) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let sawDone = false;
  let sawContent = false;
  let reasoningText = "";
  let pendingFinish = null;
  const emit = (controller, obj) => controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) {
          if (line.trim() !== "") controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          continue; // [DONE] 统一在 flush 里发，保证"兜底内容"排在它前面
        }
        if (!payload) continue;
        let obj;
        try {
          obj = normalizeChunk(JSON.parse(payload), externalModel);
        } catch {
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        if (onUsage && obj.usage) onUsage(obj.usage);
        const choice = (obj.choices || [])[0];
        if (choice && choice.delta && typeof choice.delta.content === "string" && choice.delta.content) {
          sawContent = true;
        }
        if (choice && choice.delta && typeof choice.delta.reasoning === "string") {
          reasoningText += choice.delta.reasoning;
        }
        // 带 finish_reason 的收尾 chunk 先扣住，等 flush 时决定要不要补兜底内容
        if (choice && choice.finish_reason) {
          pendingFinish = obj;
          continue;
        }
        emit(controller, obj);
      }
    },
    flush(controller) {
      // 上游偶发"整条流只有 reasoning、没有 content"（HTTP 200 但客户端会静默不回复）：
      // 这里把 reasoning 作为 content 补一个 chunk，保证客户端一定看得到输出。
      if (!sawContent && reasoningText) {
        emit(controller, {
          id: pendingFinish?.id || "gen_" + Date.now(),
          object: "chat.completion.chunk",
          created: pendingFinish?.created || Math.floor(Date.now() / 1000),
          model: externalModel || pendingFinish?.model || DEFAULT_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: reasoningText, reasoning: reasoningText, reasoning_content: reasoningText, reasoning_used_as_content: true },
              finish_reason: null,
            },
          ],
        });
      }
      if (pendingFinish) emit(controller, pendingFinish);
      if (!sawDone) sawDone = true;
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

/** 上游没按 SSE 返回（返回了 JSON）时，把它包成一个 SSE chunk + [DONE] */
function jsonToSse(obj, externalModel) {
  const enc = new TextEncoder();
  const normalized = normalizeCompletion(obj, externalModel);
  const chunks = [];
  const choice = (normalized.choices || [])[0];
  if (choice) {
    const msg = choice.message || {};
    const delta = { role: "assistant" };
    if (msg.content) delta.content = msg.content;
    if (msg.reasoning) delta.reasoning = msg.reasoning;
    withReasoningAlias(delta);
    chunks.push({
      id: normalized.id,
      object: "chat.completion.chunk",
      created: normalized.created,
      model: normalized.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    chunks.push({
      id: normalized.id,
      object: "chat.completion.chunk",
      created: normalized.created,
      model: normalized.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
      usage: normalized.usage,
    });
  }
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode("data: " + JSON.stringify(c) + "\n\n"));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// 鉴权 / 通用响应
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  };
}

function checkAuth(request, cfg) {
  if (cfg.apiKey === "") return null; // 开放模式
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xKey = (request.headers.get("x-api-key") || "").trim();
  if (bearer === cfg.apiKey || xKey === cfg.apiKey) return null;
  return jsonResponse(
    { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } },
    401
  );
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

export async function handleModels(env, url) {
  const tierFilter = url?.searchParams?.get("tier") || "";
  let models = await getModels(env);
  if (tierFilter) models = models.filter((m) => m.tier === tierFilter);
  return jsonResponse(
    {
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: 1791478516,
        owned_by: "cline-" + m.tier,
        tier: m.tier,
        usable: m.usable !== false,
      })),
    },
    200,
    { "X-Cline2api-Version": VERSION }
  );
}

// ---------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------

export async function handleHealth(env) {
  const cfg = getConfig(env);
  const pool = getAccountPool(env);
  let upstream = { reachable: false };
  try {
    const models = await getModels(env, true);
    upstream = {
      reachable: true,
      models: models.length,
      tiers: {
        cloud: models.filter((m) => m.tier === "cloud").map((m) => m.id),
        free: models.filter((m) => m.tier === "free").map((m) => m.id),
        pass: models.filter((m) => m.tier === "pass").length,
      },
    };
  } catch (e) {
    upstream = { reachable: false, error: String(e && e.message ? e.message : e) };
  }
  return jsonResponse({
    ok: true,
    version: VERSION,
    default_model: cfg.defaultModel,
    auth: cfg.apiKey === "" ? "disabled(open)" : "api_key",
    api_key_configured: cfg.apiKey !== "",
    api_key_length: cfg.apiKey.length,
    fallback_to_default: cfg.fallbackToDefault,
    min_max_tokens: cfg.minMaxTokens,
    accounts: pool.length,
    // 诊断用：只看有没有、多长，绝不回显 token 本身
    refresh_token: {
      configured: parseRefreshTokens(env).length > 0,
      count: parseRefreshTokens(env).length,
      first_length: (parseRefreshTokens(env)[0] || "").length,
    },
    upstream,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions （OpenAI 兼容）
// ---------------------------------------------------------------------------

export async function handleChatCompletions(request, env) {
  const cfg = getConfig(env);
  const authErr = checkAuth(request, cfg);
  if (authErr) return authErr;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  const requestedModel = (body.model || cfg.defaultModel).trim();
  const resolved = await resolveModel(env, requestedModel);
  const wantStream = body.stream === true;
  const notes = [];
  const upstreamBody = sanitizeBody({ ...body, model: resolved.upstream }, cfg, notes);
  if (wantStream) upstreamBody.stream = true;

  const sessionId = "sess_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  const r = await callUpstream(env, cfg, upstreamBody, sessionId);
  if (!r) {
    return jsonResponse({ error: { message: "no account available", type: "api_error" } }, 503);
  }
  const { resp } = r;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return jsonResponse(
      { error: { message: text.slice(0, 800) || "upstream error", type: "upstream_error", code: resp.status } },
      resp.status
    );
  }

  const ct = resp.headers.get("content-type") || "";
  const displayModel = requestedModel || resolved.upstream;

  if (wantStream) {
    if (ct.includes("text/event-stream")) {
      return new Response(resp.body.pipeThrough(sseTransform(resp.body, displayModel)), {
        status: 200,
        headers: sseHeaders(),
      });
    }
    // 上游没给 SSE（偶发）→ 包装成 SSE，客户端仍能正常收流
    const raw = await resp.json().catch(() => null);
    if (!raw) return jsonResponse({ error: { message: "empty upstream body", type: "api_error" } }, 502);
    return new Response(jsonToSse(raw, displayModel), { status: 200, headers: sseHeaders() });
  }

  if (ct.includes("text/event-stream")) {
    // 客户端要非流式但上游给了流：聚合成完整响应
    const raw = await aggregateStream(resp.body);
    return jsonResponse(normalizeCompletion(raw, displayModel), 200, { "X-Cline2api-Version": VERSION });
  }

  const raw = await resp.json().catch(() => null);
  if (!raw) return jsonResponse({ error: { message: "empty upstream body", type: "api_error" } }, 502);
  const normalized = normalizeCompletion(raw, displayModel);
  if (notes.length) normalized.cline2api_notes = notes;
  return jsonResponse(normalized, 200, { "X-Cline2api-Version": VERSION });
}

/** 把上游 SSE 聚合成一个完整的 OpenAI 非流式响应对象 */
export async function aggregateStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;
  const toolCalls = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try {
        obj = normalizeChunk(JSON.parse(payload));
      } catch {
        continue;
      }
      const choice = (obj.choices || [])[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.content) content += d.content;
      if (d.reasoning) reasoning += d.reasoning;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.id) id = obj.id;
      if (obj.model) model = obj.model;
      if (obj.usage) usage = obj.usage;
      for (const tc of d.tool_calls || []) {
        const key = tc.index ?? toolCalls.size;
        const prev = toolCalls.get(key) || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.function.name += tc.function.name;
        if (tc.function?.arguments) prev.function.arguments += tc.function.arguments;
        toolCalls.set(key, prev);
      }
    }
  }

  const message = { role: "assistant", content };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()];
  if (!content && reasoning && !toolCalls.size) {
    // 上游偶发"只有 reasoning 没有 content"：兜底塞进 content，避免客户端静默不回复
    message.content = reasoning;
    message.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL_ID,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || (toolCalls.size ? "tool_calls" : "stop"),
        logprobs: null,
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// POST /v1/messages （Anthropic 兼容，给 Claude Code / 各类 Anthropic SDK 用）
// ---------------------------------------------------------------------------

function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return { content, toolCalls: [], toolResults: [] };
  const parts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") parts.push(block.text || "");
    else if (block.type === "image" && block.source) {
      const s = block.source;
      const url = s.type === "base64" ? `data:${s.media_type};base64,${s.data}` : s.url;
      parts.push({ type: "image_url", image_url: { url } });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === "tool_result") {
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content))
        text = block.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
    }
  }
  const hasImages = parts.some((p) => typeof p !== "string");
  const textOnly = parts.filter((p) => typeof p === "string").join("");
  return {
    content: hasImages ? parts : textOnly,
    toolCalls,
    toolResults,
  };
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string"
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : "");
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    const conv = anthropicContentToOpenAI(m.content);
    if (m.role === "assistant") {
      const msg = { role: "assistant", content: conv.content || "" };
      if (conv.toolCalls.length) msg.tool_calls = conv.toolCalls;
      messages.push(msg);
    } else {
      for (const tr of conv.toolResults) messages.push(tr);
      if (conv.content && (typeof conv.content === "string" ? conv.content : conv.content.length))
        messages.push({ role: "user", content: conv.content });
    }
  }

  const out = { messages };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice = tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : "auto";
  }
  return out;
}

const STOP_REASON_MAP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };

function openAIToAnthropic(completion, requestedModel) {
  const choice = (completion.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {}
    content.push({ type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function?.name || "", input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: completion.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: requestedModel || completion.model || DEFAULT_MODEL_ID,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens || 0,
      output_tokens: completion.usage?.completion_tokens || 0,
    },
  };
}

/** OpenAI SSE → Anthropic SSE（Claude Code / Anthropic SDK 用） */
function anthropicSseTransform(upstream, displayModel) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let started = false;
  let textOpen = false;
  let blockIndex = -1;
  let msgId = "msg_" + Date.now();
  let stopReason = "end_turn";
  let outputTokens = 0;
  let inputTokens = 0;
  const toolBlocks = new Map();

  const send = (c, obj) => c.enqueue(encoder.encode(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`));
  const startMessage = (c) => {
    if (started) return;
    started = true;
    send(c, {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model: displayModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  };
  const closeText = (c) => {
    if (!textOpen) return;
    send(c, { type: "content_block_stop", index: blockIndex });
    textOpen = false;
  };

  return new TransformStream({
    transform(chunk, c) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          closeText(c);
          for (const [, bi] of toolBlocks) send(c, { type: "content_block_stop", index: bi });
          toolBlocks.clear();
          send(c, { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
          send(c, { type: "message_stop" });
          continue;
        }
        if (!payload) continue;
        let obj;
        try {
          obj = normalizeChunk(JSON.parse(payload));
        } catch {
          continue;
        }
        if (obj.id) msgId = obj.id;
        if (obj.usage) {
          outputTokens = obj.usage.completion_tokens || outputTokens;
          inputTokens = obj.usage.prompt_tokens || inputTokens;
        }
        const choice = (obj.choices || [])[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (choice.finish_reason) stopReason = STOP_REASON_MAP[choice.finish_reason] || "end_turn";
        if (d.content) {
          startMessage(c);
          if (!textOpen) {
            blockIndex += 1;
            textOpen = true;
            send(c, { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
          }
          send(c, { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: d.content } });
        }
        for (const tc of d.tool_calls || []) {
          startMessage(c);
          closeText(c);
          const key = tc.index ?? 0;
          if (!toolBlocks.has(key)) {
            blockIndex += 1;
            toolBlocks.set(key, blockIndex);
            send(c, {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function?.name || "", input: {} },
            });
          }
          if (tc.function?.arguments) {
            send(c, {
              type: "content_block_delta",
              index: toolBlocks.get(key),
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
      }
    },
    flush(c) {
      startMessage(c);
      if (!started) return;
      if (!textOpen && toolBlocks.size === 0) {
        blockIndex += 1;
        send(c, { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
        send(c, { type: "content_block_stop", index: blockIndex });
      } else {
        closeText(c);
        for (const [, bi] of toolBlocks) send(c, { type: "content_block_stop", index: bi });
        toolBlocks.clear();
      }
      send(c, { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
      send(c, { type: "message_stop" });
    },
  });
}

function anthropicJsonToSse(anthropicMsg) {
  const enc = new TextEncoder();
  const events = [];
  events.push({ type: "message_start", message: { ...anthropicMsg, content: [], stop_reason: null, usage: { input_tokens: anthropicMsg.usage.input_tokens, output_tokens: 0 } } });
  anthropicMsg.content.forEach((block, i) => {
    events.push({ type: "content_block_start", index: i, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    if (block.type === "text" && block.text) events.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    if (block.type === "tool_use") events.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    events.push({ type: "content_block_stop", index: i });
  });
  events.push({ type: "message_delta", delta: { stop_reason: anthropicMsg.stop_reason, stop_sequence: null }, usage: { output_tokens: anthropicMsg.usage.output_tokens } });
  events.push({ type: "message_stop" });
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

export async function handleMessages(request, env) {
  const cfg = getConfig(env);
  const authErr = checkAuth(request, cfg);
  if (authErr) return authErr;

  let req;
  try {
    req = await request.json();
  } catch {
    return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  const requestedModel = (req.model || cfg.defaultModel).trim();
  const resolved = await resolveModel(env, requestedModel);
  const wantStream = req.stream === true;
  const notes = [];
  const openAIBody = { ...anthropicToOpenAI(req), model: resolved.upstream };
  const upstreamBody = sanitizeBody(openAIBody, cfg, notes);
  if (wantStream) upstreamBody.stream = true;

  const sessionId = "sess_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  const r = await callUpstream(env, cfg, upstreamBody, sessionId);
  if (!r) return jsonResponse({ type: "error", error: { type: "api_error", message: "no account available" } }, 503);
  const { resp } = r;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return jsonResponse({ type: "error", error: { type: "api_error", message: text.slice(0, 800) || "upstream error" } }, resp.status);
  }

  const ct = resp.headers.get("content-type") || "";
  const displayModel = requestedModel || resolved.upstream;

  if (wantStream) {
    if (ct.includes("text/event-stream")) {
      return new Response(resp.body.pipeThrough(anthropicSseTransform(resp.body, displayModel)), {
        status: 200,
        headers: sseHeaders(),
      });
    }
    const raw = await resp.json().catch(() => null);
    if (!raw) return jsonResponse({ type: "error", error: { type: "api_error", message: "empty upstream body" } }, 502);
    return new Response(anthropicJsonToSse(openAIToAnthropic(normalizeCompletion(raw, displayModel), displayModel)), {
      status: 200,
      headers: sseHeaders(),
    });
  }

  const raw = ct.includes("text/event-stream") ? await aggregateStream(resp.body) : await resp.json().catch(() => null);
  if (!raw) return jsonResponse({ type: "error", error: { type: "api_error", message: "empty upstream body" } }, 502);
  const completion = normalizeCompletion(raw, displayModel);
  return jsonResponse(openAIToAnthropic(completion, displayModel), 200, { "X-Cline2api-Version": VERSION });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions"]);
const MESSAGE_PATHS = new Set(["/v1/messages", "/messages"]);
const MODEL_PATHS = new Set(["/v1/models", "/models"]);
const HEALTH_PATHS = new Set(["/v1/health", "/health"]);

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  try {
    if (request.method === "GET" && HEALTH_PATHS.has(path)) return await handleHealth(env);
    if (request.method === "GET" && MODEL_PATHS.has(path)) {
      const cfg = getConfig(env);
      if (cfg.protectModels) {
        const authErr = checkAuth(request, cfg);
        if (authErr) return authErr;
      }
      return await handleModels(env, url);
    }
    if (request.method === "POST" && CHAT_PATHS.has(path)) return await handleChatCompletions(request, env);
    if (request.method === "POST" && MESSAGE_PATHS.has(path)) return await handleMessages(request, env);
    if (request.method === "GET" && (path === "/" || path === "/v1")) {
      const cfg = getConfig(env);
      return jsonResponse({
        name: "cline2api",
        version: VERSION,
        default_model: cfg.defaultModel,
        endpoints: [
          "GET  /v1/models",
          "GET  /v1/health",
          "POST /v1/chat/completions",
          "POST /v1/messages",
        ],
      });
    }
    return jsonResponse({ error: { message: "Not found: " + request.method + " " + path, type: "not_found" } }, 404);
  } catch (e) {
    return jsonResponse({ error: { message: String(e && e.message ? e.message : e), type: "internal_error" } }, 500);
  }
}
