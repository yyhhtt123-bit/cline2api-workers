#!/usr/bin/env node
/**
 * cline2api v2 · 上游鉴权诊断脚本（在你本机跑，直打上游，绕开 Worker）
 *
 *   node debug-token.js                      # 自动读 .env 里的 CLINE_REFRESH_TOKEN
 *   node debug-token.js <refreshToken>       # 或命令行传入
 *
 * 它会：
 *   1. 用 refreshToken 换 accessToken（并告诉你 token 有没有被轮换）
 *   2. 用 4 种「请求头 / 鉴权」组合直打上游 /chat/completions
 *   3. 打印每种的 HTTP 状态码和上游原文
 *
 * 用途：定位 403 到底是「头不完整」还是「鉴权格式不对」还是「账号没权限」。
 * 注意：如果它提示 refreshToken 已轮换，请把新值更新到 Worker 的 secret 里。
 */
import fs from "node:fs";

const API = "https://api.cline.bot/api/v1";
const MODEL = "cline-cloud/deepseek-v4.1-flash";

function loadEnvToken() {
  for (const f of [".env", "../.env"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*CLINE_REFRESH_TOKEN\s*=\s*(.+)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function jwtClaims(token) {
  try {
    const part = token.replace(/^workos:/, "").split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    const p = JSON.parse(json);
    return { sub: p.sub, exp: p.exp ? new Date(p.exp * 1000).toISOString() : undefined };
  } catch {
    return { note: "不是 JWT（或无法解析）" };
  }
}

function officialHeaders(sessionId) {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.70",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.70",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.70",
    "X-CORE-VERSION": "0.0.92",
    "X-Task-ID": sessionId,
  };
}

const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: "user", content: "say ok" }],
  stream: false,
});

async function probe(label, headers) {
  try {
    const resp = await fetch(API + "/chat/completions", { method: "POST", headers, body });
    const text = await resp.text();
    console.log(`\n--- ${label}`);
    console.log(`    HTTP ${resp.status}`);
    console.log("    " + text.replace(/\s+/g, " ").slice(0, 260));
    return resp.status;
  } catch (e) {
    console.log(`\n--- ${label}\n    请求异常: ${e.message}`);
    return 0;
  }
}

async function main() {
  const refreshToken = (process.argv[2] || loadEnvToken()).trim();
  if (!refreshToken) {
    console.error("❌ 没找到 refreshToken：放到 .env 的 CLINE_REFRESH_TOKEN= 里，或作为参数传入。");
    process.exit(1);
  }
  console.log("① 用 refreshToken 换 accessToken ...");
  const r = await fetch(API + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  const data = j?.data || {};
  if (!data.accessToken) {
    console.log(`   ❌ 刷新失败 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    process.exit(1);
  }
  const accessToken = data.accessToken;
  console.log(`   ✅ 拿到 accessToken（HTTP ${r.status}）`);
  console.log("   声明:", JSON.stringify(jwtClaims(accessToken)));
  if (data.refreshToken && data.refreshToken.trim() !== refreshToken) {
    console.log("   ⚠️ refreshToken 已被轮换，新值如下（若 Worker 里还是旧的，请更新 secret）：");
    console.log("      " + data.refreshToken.trim());
  } else {
    console.log("   ℹ️ refreshToken 未轮换");
  }

  const sessionId = "sess_debug_" + Date.now().toString(36);
  console.log("\n② 开始 4 种组合直打上游 ...");

  await probe("A. 官方完整头 + Bearer workos:<token>（当前实现）", {
    ...officialHeaders(sessionId),
    Authorization: "Bearer workos:" + accessToken,
  });
  await probe("B. 官方完整头 + Bearer <token>（不带 workos: 前缀）", {
    ...officialHeaders(sessionId),
    Authorization: "Bearer " + accessToken,
  });
  await probe("C. 最小头（只 X-CLIENT-TYPE）+ Bearer workos:<token>", {
    "Content-Type": "application/json",
    "X-CLIENT-TYPE": "cline-sdk",
    Authorization: "Bearer workos:" + accessToken,
  });
  await probe("D. 官方完整头 + 完全不带 Authorization（对照）", officialHeaders(sessionId));

  console.log("\n③ 判读方法：");
  console.log("   A=200            → 头与鉴权都对，问题在别处（比如 Worker 里 token 没存对）");
  console.log("   A=403 B=200      → 应该去掉 workos: 前缀，告诉我，我改代码");
  console.log("   A=403 C=200      → 头集合要求不同，告诉我，我调头");
  console.log("   A/B/C 全 403     → 账号/额度层面被拒（把原文贴给我）");
}

main().catch((e) => {
  console.error("❌ 失败:", e);
  process.exit(1);
});
