#!/usr/bin/env node
/**
 * cline2api v2 · 获取 CLINE_REFRESH_TOKEN（WorkOS 设备授权码流程，零依赖）
 *
 *   node get-token.js
 *
 * 流程（逆向自 Cline 官方客户端的 auth 流程）：
 *   1. POST https://api.workos.com/user_management/authorize/device  → 拿授权链接
 *   2. 浏览器打开链接、用 Google/GitHub/邮箱登录授权
 *   3. 轮询 https://api.workos.com/user_management/authenticate       → 拿 WorkOS token
 *   4. POST https://api.cline.bot/api/v1/auth/register                → 换 Cline refreshToken
 *
 * 可选 Telegram 推送（手机上也能拿 token）：
 *   TG_BOT_TOKEN=xxx TG_CHAT_ID=123 node get-token.js
 * 配置了 TG 时，refreshToken 只推 TG、不打印到终端。
 */
import readline from "node:readline";

const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";
const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";
const CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postForm(url, form) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return resp.json();
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function sendTg(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
    });
    return resp.ok;
  } catch (e) {
    console.error("   ⚠️ TG 推送失败:", e.message);
    return false;
  }
}

async function main() {
  console.log("🚀 启动 Cline WorkOS 设备授权流程...\n");
  const dev = await postForm(WORKOS_DEVICE, { client_id: CLIENT_ID });
  if (!dev.device_code) {
    console.error("❌ 设备授权初始化失败:", JSON.stringify(dev).slice(0, 300));
    process.exit(1);
  }
  const authUrl = dev.verification_uri_complete || dev.verification_uri;
  let interval = Math.max(dev.interval || 5, 5);
  const expiresIn = dev.expires_in || 300;

  const useTg = !!(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID);
  console.log("=".repeat(60));
  console.log("1️⃣  浏览器打开：");
  console.log("    " + authUrl);
  console.log("2️⃣  设备码：" + dev.user_code);
  console.log("3️⃣  用 Google / GitHub / 邮箱登录并授权");
  console.log("=".repeat(60));

  if (useTg) {
    const ok = await sendTg(
      "🔑 *Cline 授权请求*\n\n打开链接完成授权（设备码已带好）：\n" + authUrl + "\n\n设备码：`" + dev.user_code + "`"
    );
    if (!ok) {
      console.error("❌ 授权链接推送 TG 失败，已中止（不会把 token 打到日志）");
      process.exit(1);
    }
    console.log("📨 授权链接已推送到 Telegram。");
  }

  console.log(`\n🔄 等待授权（最多 ${expiresIn} 秒）...`);
  const deadline = Date.now() + expiresIn * 1000;
  let workos = null;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let a;
    try {
      a = await postForm(WORKOS_AUTH, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dev.device_code,
        client_id: CLIENT_ID,
      });
    } catch (e) {
      console.error("   轮询出错:", e.message);
      continue;
    }
    if (a.access_token) {
      workos = a;
      break;
    }
    if (a.error === "slow_down") interval += 5;
    else if (a.error && a.error !== "authorization_pending") console.error(`   [${a.error}] ${a.error_description || ""}`);
  }
  if (!workos) {
    console.error("❌ 授权超时，请重新运行");
    process.exit(1);
  }
  console.log("✅ WorkOS 授权成功，正在换取 Cline refreshToken...");

  const cline = await postJson(CLINE_REGISTER, {
    accessToken: workos.access_token,
    refreshToken: workos.refresh_token,
  });
  const data = cline.data || {};
  const rt = data.refreshToken;
  if (!rt) {
    console.error("❌ 注册失败:", JSON.stringify(cline).slice(0, 400));
    process.exit(1);
  }
  const email = (data.userInfo || {}).email || "unknown";

  console.log("\n" + "=".repeat(60));
  console.log(`✅ 账号: ${email}`);
  if (useTg) {
    const ok = await sendTg(
      "🔑 *Cline refreshToken 已获取*\n\n账号：`" + email + "`\n\n填进 `CLINE_REFRESH_TOKEN`：\n`" + rt + "`"
    );
    if (!ok) {
      console.error("❌ refreshToken 推送 TG 失败；为避免泄漏，未打印到终端。");
      process.exit(1);
    }
    console.log("🔑 refreshToken 已通过 Telegram 私密发送（未打印到终端）。");
  } else {
    console.log("\n🔑 把它填进 .env 的 CLINE_REFRESH_TOKEN：\n");
    console.log("    " + rt);
    console.log("\n（想避免 token 出现在终端，可配 TG_BOT_TOKEN / TG_CHAT_ID 改用 Telegram 收取）");
  }
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("❌ 失败:", e);
  process.exit(1);
});
