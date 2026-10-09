/**
 * cline2api v2 · Cloudflare Workers 入口
 *
 * 部署：
 *   npx wrangler deploy
 *   npx wrangler secret put CLINE_REFRESH_TOKEN   # 一行一个，支持多账号
 *   npx wrangler secret put API_KEY               # 可选；不设 = 不鉴权
 *
 * 逻辑全部在 core.js（与 Node 版共用同一份），这里只做入口适配。
 * 注意：Workers 免费档默认域名对非浏览器 UA 会返回 1010，客户端建议带浏览器 UA，
 * 或改用 Node 版自托管（Node 版无此限制）。
 */
import { handleRequest } from "./core.js";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
