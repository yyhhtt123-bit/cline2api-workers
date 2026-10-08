#!/usr/bin/env node
/**
 * cline2api v2 · Node 入口（零依赖，Node 18+）
 *
 * 用法：
 *   node server.js                 # 默认 127.0.0.1:8787
 *   PORT=9000 node server.js       # 换端口
 *   HOST=0.0.0.0 node server.js    # 对外暴露
 *
 * 环境变量从 .env 文件（当前目录，可选）和 process.env 读取，process.env 优先。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest, VERSION, DEFAULT_MODEL_ID, getConfig, getAccountPool } from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 极简 .env 解析（零依赖）：KEY=VALUE，支持 # 注释与引号 */
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 允许用 \n 在一行里写多个 refreshToken
    out[key] = val.replace(/\\n/g, "\n");
  }
  return out;
}

const env = { ...loadDotEnv(path.join(process.cwd(), ".env")), ...process.env };
const PORT = parseInt(env.PORT || "8787", 10);
const HOST = env.HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  const url = "http://" + (req.headers.host || HOST + ":" + PORT) + req.url;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const hasBody = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  let request;
  try {
    request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad request: " + e.message } }));
    return;
  }

  try {
    const response = await handleRequest(request, env);
    const headers = {};
    response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(response.status, headers);
    res.flushHeaders?.();
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e && e.message ? e.message : e) } }));
  }
});

server.listen(PORT, HOST, () => {
  const cfg = getConfig(env);
  const pool = getAccountPool(env);
  console.log(`cline2api v${VERSION}  http://${HOST}:${PORT}`);
  console.log(`  默认模型 : ${cfg.defaultModel}`);
  console.log(`  鉴权     : ${cfg.apiKey === "" ? "关闭（开放模式）" : "API_KEY 已启用"}`);
  console.log(`  账号数   : ${pool.length}${pool.length === 0 ? "（无 token，将不带 Authorization 直连上游）" : ""}`);
  console.log(`  上游     : ${cfg.apiBase}`);
  console.log("");
  console.log(`  curl http://${HOST}:${PORT}/v1/health`);
  console.log(
    `  curl http://${HOST}:${PORT}/v1/chat/completions -H 'Content-Type: application/json' ` +
      `-d '{"model":"${DEFAULT_MODEL_ID}","messages":[{"role":"user","content":"hi"}]}'`
  );
});
