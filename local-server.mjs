/**
 * cline2api 本地/VPS 运行入口（把 worker.js 包成一个普通 Node HTTP 服务）
 *
 * 用途：Cloudflare Workers 的出口 IP 被上游限制时（实测 403 "This request is not supported."），
 *       可以把这个服务跑在一台"上游放行"的服务器上（实测 Google Cloud 出口可以），
 *       再把客户端指到 http://<那台机器>:8787/v1 。
 *
 * 用法（需要 Node 18+）：
 *   Windows CMD:
 *     set CLINE_REFRESH_TOKEN=你的refreshToken
 *     set API_KEY=sk-cline-123
 *     node local-server.mjs
 *
 *   Linux / macOS:
 *     CLINE_REFRESH_TOKEN=xxx API_KEY=sk-cline-123 node local-server.mjs
 *
 * 可选环境变量：PORT（默认 8787）
 *
 * ⚠️ 安全：这个服务没有任何 TLS，别直接暴露到公网；要用就套 Nginx/Caddy 加上 HTTPS 与访问控制。
 */
import http from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// worker.js 是 ESM，但没有 package.json（CF/Vercel 都按原样部署），
// Node 默认把 .js 当 CJS 解析，所以复制成 .mjs 再动态 import。
const dir = await mkdtemp(path.join(tmpdir(), "cline2api-local-"));
const modPath = path.join(dir, "worker.mjs");
await writeFile(modPath, await readFile(path.join(root, "worker.js"), "utf8"));
const worker = await import(pathToFileURL(modPath).href);

const PORT = Number(process.env.PORT || 8787);
const env = {
  CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || "",
  API_KEY: process.env.API_KEY || "",
};

const accounts = env.CLINE_REFRESH_TOKEN.split("\n").map((s) => s.trim()).filter(Boolean).length;
console.log(`cline2api 本地服务启动: http://127.0.0.1:${PORT}/v1`);
console.log(`  API_KEY          : ${env.API_KEY ? "已设置" : "未设置（用默认 cline2api-default-key）"}`);
console.log(`  CLINE_REFRESH_TOKEN: ${accounts || 0} 个账号（0 = 匿名/无账号模式）`);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const request = new Request(`http://${req.headers.host || "127.0.0.1"}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    const response = await worker.default.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error("[error]", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err?.message || err), type: "internal_error" } }));
  }
});

server.listen(PORT, () => {
  console.log(`就绪。客户端 Base URL 填 http://<本机IP>:${PORT}/v1 ，API Key 填上面那个。`);
});
