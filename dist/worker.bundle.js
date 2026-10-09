var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// core.js
var VERSION = "2.0.0";
var DEFAULT_MODEL_ID = "cline-cloud/deepseek-v4.1-flash";
var DEFAULT_API_BASE = "https://api.cline.bot/api/v1";
var BUILTIN_MODELS = [
  { id: "cline-cloud/deepseek-v4.1-flash", tier: "cloud", usable: true },
  { id: "cline-free/mimo-v2.6-flash", tier: "free", usable: true },
  { id: "cline-free/muse-spark-1.3-contributor", tier: "free", usable: true },
  { id: "cline-free/step-5-preview", tier: "free", usable: true },
  { id: "cline-free/solar-mini4", tier: "free", usable: true }
];
var MODEL_ALIASES = {
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
  "claude-haiku-4.5": DEFAULT_MODEL_ID
};
var MODELS_TTL_MS = 10 * 60 * 1e3;
function readEnv(env, key) {
  const v = env?.[key];
  return typeof v === "string" ? v.trim() : "";
}
__name(readEnv, "readEnv");
function getConfig(env) {
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
    protectModels: readEnv(env, "PROTECT_MODELS").toLowerCase() === "true"
  };
}
__name(getConfig, "getConfig");
var accounts = [];
var accountCursor = 0;
function parseRefreshTokens(env) {
  return readEnv(env, "CLINE_REFRESH_TOKEN").split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.length > 8);
}
__name(parseRefreshTokens, "parseRefreshTokens");
function getAccountPool(env) {
  const tokens = parseRefreshTokens(env);
  const accessToken = readEnv(env, "CLINE_ACCESS_TOKEN");
  const want = tokens.length ? tokens : accessToken ? ["<direct-access-token>"] : [];
  const changed = accounts.length !== want.length || accounts.some((a, i) => a.refreshToken !== want[i]);
  if (changed) {
    accounts = want.map((rt) => ({
      refreshToken: rt,
      direct: rt === "<direct-access-token>",
      accessToken: rt === "<direct-access-token>" ? accessToken : null,
      expiry: rt === "<direct-access-token>" ? Date.now() + 365 * 24 * 3600 * 1e3 : 0,
      cooldownUntil: 0,
      inflight: 0
    }));
  }
  return accounts;
}
__name(getAccountPool, "getAccountPool");
async function refreshAccountToken(account, cfg) {
  const now = Date.now();
  if (account.accessToken && now < account.expiry) return account.accessToken;
  if (account.direct) return account.accessToken;
  const resp = await fetch(cfg.apiBase + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: account.refreshToken, grantType: "refresh_token" })
  });
  if (!resp.ok) {
    account.cooldownUntil = now + 6e4;
    throw new Error("refresh_failed_" + resp.status);
  }
  const data = (await resp.json())?.data || {};
  if (!data.accessToken) {
    account.cooldownUntil = now + 6e4;
    throw new Error("refresh_no_token");
  }
  account.accessToken = data.accessToken;
  if (typeof data.refreshToken === "string" && data.refreshToken.trim()) {
    account.refreshToken = data.refreshToken.trim();
  }
  const expiresAt = data.expiresAt;
  let expiry = now + 10 * 6e4;
  if (typeof expiresAt === "number") expiry = expiresAt;
  else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!Number.isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 6e4;
  return account.accessToken;
}
__name(refreshAccountToken, "refreshAccountToken");
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
  return pool.slice().sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0] || null;
}
__name(pickAccount, "pickAccount");
function cooldownAccount(account, ms) {
  if (!account) return;
  account.cooldownUntil = Date.now() + ms;
  if (!account.direct) {
    account.accessToken = null;
    account.expiry = 0;
  }
}
__name(cooldownAccount, "cooldownAccount");
function parseCooldownMs(text, status) {
  const m = /try again in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text || "");
  if (m) {
    const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1e3;
    if (ms > 0) return Math.min(ms, 6 * 36e5);
  }
  return status === 429 ? 5 * 6e4 : 6e4;
}
__name(parseCooldownMs, "parseCooldownMs");
var modelsCache = null;
var modelsCacheAt = 0;
function mapTier(list, tier, usable) {
  return (Array.isArray(list) ? list : []).filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, name: m.name || m.id, tier, usable }));
}
__name(mapTier, "mapTier");
async function getModels(env, force = false) {
  const cfg = getConfig(env);
  const now = Date.now();
  if (!force && modelsCache && now - modelsCacheAt < MODELS_TTL_MS) return modelsCache;
  try {
    const resp = await fetch(cfg.apiBase + "/ai/cline/recommended-models", {
      headers: upstreamHeaders(null)
    });
    if (!resp.ok) throw new Error("http_" + resp.status);
    const data = await resp.json();
    const list = [
      ...mapTier(data.clineCloud, "cloud", true),
      ...mapTier(data.free, "free", true),
      ...mapTier(data.clinePass, "pass", false),
      ...mapTier(data.recommended, "paid", true)
    ];
    if (list.length === 0) throw new Error("empty_list");
    const seen = /* @__PURE__ */ new Set();
    modelsCache = list.filter((m) => seen.has(m.id) ? false : (seen.add(m.id), true));
    modelsCacheAt = now;
    return modelsCache;
  } catch (e) {
    if (!modelsCache) modelsCache = BUILTIN_MODELS.map((m) => ({ ...m, name: m.id }));
    return modelsCache;
  }
}
__name(getModels, "getModels");
async function resolveModel(env, requested) {
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
__name(resolveModel, "resolveModel");
function upstreamHeaders(accessToken, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "X-CLIENT-TYPE": "cline-sdk",
    "User-Agent": "Cline/3.0.47"
  };
  if (sessionId) headers["X-Task-ID"] = sessionId;
  if (accessToken) headers.Authorization = "Bearer workos:" + accessToken;
  return headers;
}
__name(upstreamHeaders, "upstreamHeaders");
function sanitizeBody(body, cfg, notes) {
  const out = { ...body };
  const mt = out.max_tokens;
  if (typeof mt === "number" && mt > 0 && mt < cfg.minMaxTokens) {
    delete out.max_tokens;
    notes.push(`max_tokens=${mt} < ${cfg.minMaxTokens}\uFF0C\u5DF2\u4E22\u5F03\u4EE5\u907F\u514D\u4E0A\u6E38 500`);
  }
  if (out.max_tokens === void 0 && typeof out.max_completion_tokens === "number") {
    if (out.max_completion_tokens < cfg.minMaxTokens) delete out.max_completion_tokens;
    else {
      out.max_tokens = out.max_completion_tokens;
      delete out.max_completion_tokens;
    }
  }
  delete out.stream_options;
  return out;
}
__name(sanitizeBody, "sanitizeBody");
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
      headers: upstreamHeaders(token, sessionId),
      body: JSON.stringify(body)
    });
    if (resp.status === 401 && account && attempt < 1) {
      cooldownAccount(account, 3e4);
      return null;
    }
    return { resp, account };
  } finally {
    if (account) account.inflight--;
  }
}
__name(clineFetchOnce, "clineFetchOnce");
async function callUpstream(env, cfg, body, sessionId, { maxAttempts = 3 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await clineFetchOnce(env, cfg, body, sessionId, 0);
    if (!r) continue;
    last = r;
    const { resp, account } = r;
    if (resp.ok) return r;
    let text = "";
    try {
      text = await resp.clone().text();
    } catch {
    }
    const retriable = resp.status === 429 || resp.status >= 500 && text.includes("empty response content") || resp.status >= 500 && !text;
    if (!retriable) return r;
    cooldownAccount(account, parseCooldownMs(text, resp.status));
    const pool = getAccountPool(env);
    const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
    if (!hasOther) return r;
    await sleep(300 + Math.floor(Math.random() * 400));
  }
  return last;
}
__name(callUpstream, "callUpstream");
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
__name(sleep, "sleep");
function unwrapData(obj) {
  if (obj && typeof obj === "object" && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}
__name(unwrapData, "unwrapData");
function withReasoningAlias(msg) {
  if (msg && typeof msg.reasoning === "string" && msg.reasoning && !msg.reasoning_content) {
    msg.reasoning_content = msg.reasoning;
  }
  return msg;
}
__name(withReasoningAlias, "withReasoningAlias");
function normalizeCompletion(raw, externalModel) {
  const out = { ...unwrapData(raw) };
  if (externalModel) out.model = externalModel;
  if (!out.object) out.object = "chat.completion";
  if (!out.id) out.id = "gen_" + Date.now();
  if (!out.created) out.created = Math.floor(Date.now() / 1e3);
  for (const choice of out.choices || []) withReasoningAlias(choice.message);
  return out;
}
__name(normalizeCompletion, "normalizeCompletion");
function normalizeChunk(obj, externalModel) {
  const out = { ...unwrapData(obj) };
  if (externalModel) out.model = externalModel;
  for (const choice of out.choices || []) {
    const d = choice.delta;
    if (d) withReasoningAlias(d);
  }
  return out;
}
__name(normalizeChunk, "normalizeChunk");
function sseTransform(upstream, externalModel, onUsage) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let sawDone = false;
  let sawContent = false;
  let reasoningText = "";
  let pendingFinish = null;
  const emit = /* @__PURE__ */ __name((controller, obj) => controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n")), "emit");
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
          continue;
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
        if (choice && choice.finish_reason) {
          pendingFinish = obj;
          continue;
        }
        emit(controller, obj);
      }
    },
    flush(controller) {
      if (!sawContent && reasoningText) {
        emit(controller, {
          id: pendingFinish?.id || "gen_" + Date.now(),
          object: "chat.completion.chunk",
          created: pendingFinish?.created || Math.floor(Date.now() / 1e3),
          model: externalModel || pendingFinish?.model || DEFAULT_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: reasoningText, reasoning: reasoningText, reasoning_content: reasoningText, reasoning_used_as_content: true },
              finish_reason: null
            }
          ]
        });
      }
      if (pendingFinish) emit(controller, pendingFinish);
      if (!sawDone) sawDone = true;
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
  });
}
__name(sseTransform, "sseTransform");
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
      choices: [{ index: 0, delta, finish_reason: null }]
    });
    chunks.push({
      id: normalized.id,
      object: "chat.completion.chunk",
      created: normalized.created,
      model: normalized.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
      usage: normalized.usage
    });
  }
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode("data: " + JSON.stringify(c) + "\n\n"));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
__name(jsonToSse, "jsonToSse");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...extra }
  });
}
__name(jsonResponse, "jsonResponse");
function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders()
  };
}
__name(sseHeaders, "sseHeaders");
function checkAuth(request, cfg) {
  if (cfg.apiKey === "") return null;
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xKey = (request.headers.get("x-api-key") || "").trim();
  if (bearer === cfg.apiKey || xKey === cfg.apiKey) return null;
  return jsonResponse(
    { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } },
    401
  );
}
__name(checkAuth, "checkAuth");
async function handleModels(env, url) {
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
        usable: m.usable !== false
      }))
    },
    200,
    { "X-Cline2api-Version": VERSION }
  );
}
__name(handleModels, "handleModels");
async function handleHealth(env) {
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
        pass: models.filter((m) => m.tier === "pass").length
      }
    };
  } catch (e) {
    upstream = { reachable: false, error: String(e && e.message ? e.message : e) };
  }
  return jsonResponse({
    ok: true,
    version: VERSION,
    default_model: cfg.defaultModel,
    auth: cfg.apiKey === "" ? "disabled(open)" : "api_key",
    fallback_to_default: cfg.fallbackToDefault,
    min_max_tokens: cfg.minMaxTokens,
    accounts: pool.length,
    // 诊断用：只看有没有、多长，绝不回显 token 本身
    refresh_token: {
      configured: parseRefreshTokens(env).length > 0,
      count: parseRefreshTokens(env).length,
      first_length: (parseRefreshTokens(env)[0] || "").length
    },
    upstream
  });
}
__name(handleHealth, "handleHealth");
async function handleChatCompletions(request, env) {
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
        headers: sseHeaders()
      });
    }
    const raw2 = await resp.json().catch(() => null);
    if (!raw2) return jsonResponse({ error: { message: "empty upstream body", type: "api_error" } }, 502);
    return new Response(jsonToSse(raw2, displayModel), { status: 200, headers: sseHeaders() });
  }
  if (ct.includes("text/event-stream")) {
    const raw2 = await aggregateStream(resp.body);
    return jsonResponse(normalizeCompletion(raw2, displayModel), 200, { "X-Cline2api-Version": VERSION });
  }
  const raw = await resp.json().catch(() => null);
  if (!raw) return jsonResponse({ error: { message: "empty upstream body", type: "api_error" } }, 502);
  const normalized = normalizeCompletion(raw, displayModel);
  if (notes.length) normalized.cline2api_notes = notes;
  return jsonResponse(normalized, 200, { "X-Cline2api-Version": VERSION });
}
__name(handleChatCompletions, "handleChatCompletions");
async function aggregateStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;
  const toolCalls = /* @__PURE__ */ new Map();
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
    message.content = reasoning;
    message.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: model || DEFAULT_MODEL_ID,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || (toolCalls.size ? "tool_calls" : "stop"),
        logprobs: null
      }
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}
__name(aggregateStream, "aggregateStream");
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
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    } else if (block.type === "tool_result") {
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content))
        text = block.content.map((c) => c.type === "text" ? c.text : "").join("");
      toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
    }
  }
  const hasImages = parts.some((p) => typeof p !== "string");
  const textOnly = parts.filter((p) => typeof p === "string").join("");
  return {
    content: hasImages ? parts : textOnly,
    toolCalls,
    toolResults
  };
}
__name(anthropicContentToOpenAI, "anthropicContentToOpenAI");
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : "";
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
  if (body.temperature !== void 0) out.temperature = body.temperature;
  if (body.top_p !== void 0) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } }
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice = tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : "auto";
  }
  return out;
}
__name(anthropicToOpenAI, "anthropicToOpenAI");
var STOP_REASON_MAP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
function openAIToAnthropic(completion, requestedModel) {
  const choice = (completion.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
    }
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
      output_tokens: completion.usage?.completion_tokens || 0
    }
  };
}
__name(openAIToAnthropic, "openAIToAnthropic");
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
  const toolBlocks = /* @__PURE__ */ new Map();
  const send = /* @__PURE__ */ __name((c, obj) => c.enqueue(encoder.encode(`event: ${obj.type}
data: ${JSON.stringify(obj)}

`)), "send");
  const startMessage = /* @__PURE__ */ __name((c) => {
    if (started) return;
    started = true;
    send(c, {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model: displayModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
  }, "startMessage");
  const closeText = /* @__PURE__ */ __name((c) => {
    if (!textOpen) return;
    send(c, { type: "content_block_stop", index: blockIndex });
    textOpen = false;
  }, "closeText");
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
              content_block: { type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function?.name || "", input: {} }
            });
          }
          if (tc.function?.arguments) {
            send(c, {
              type: "content_block_delta",
              index: toolBlocks.get(key),
              delta: { type: "input_json_delta", partial_json: tc.function.arguments }
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
    }
  });
}
__name(anthropicSseTransform, "anthropicSseTransform");
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
      for (const e of events) c.enqueue(enc.encode(`event: ${e.type}
data: ${JSON.stringify(e)}

`));
      c.close();
    }
  });
}
__name(anthropicJsonToSse, "anthropicJsonToSse");
async function handleMessages(request, env) {
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
        headers: sseHeaders()
      });
    }
    const raw2 = await resp.json().catch(() => null);
    if (!raw2) return jsonResponse({ type: "error", error: { type: "api_error", message: "empty upstream body" } }, 502);
    return new Response(anthropicJsonToSse(openAIToAnthropic(normalizeCompletion(raw2, displayModel), displayModel)), {
      status: 200,
      headers: sseHeaders()
    });
  }
  const raw = ct.includes("text/event-stream") ? await aggregateStream(resp.body) : await resp.json().catch(() => null);
  if (!raw) return jsonResponse({ type: "error", error: { type: "api_error", message: "empty upstream body" } }, 502);
  const completion = normalizeCompletion(raw, displayModel);
  return jsonResponse(openAIToAnthropic(completion, displayModel), 200, { "X-Cline2api-Version": VERSION });
}
__name(handleMessages, "handleMessages");
var CHAT_PATHS = /* @__PURE__ */ new Set(["/v1/chat/completions", "/chat/completions"]);
var MESSAGE_PATHS = /* @__PURE__ */ new Set(["/v1/messages", "/messages"]);
var MODEL_PATHS = /* @__PURE__ */ new Set(["/v1/models", "/models"]);
var HEALTH_PATHS = /* @__PURE__ */ new Set(["/v1/health", "/health"]);
async function handleRequest(request, env) {
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
          "POST /v1/messages"
        ]
      });
    }
    return jsonResponse({ error: { message: "Not found: " + request.method + " " + path, type: "not_found" } }, 404);
  } catch (e) {
    return jsonResponse({ error: { message: String(e && e.message ? e.message : e), type: "internal_error" } }, 500);
  }
}
__name(handleRequest, "handleRequest");

// worker.js
var worker_default = {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
