/**
 * cline2api v2 · Vercel Edge Function 入口
 *
 * 部署：
 *   vercel --prod
 *   vercel env add CLINE_REFRESH_TOKEN production
 *   vercel env add API_KEY production
 *   vercel --prod          # 改完环境变量必须重新部署才生效
 *
 * 路由由根目录 vercel.json 的 rewrites 把 /v1/* 指到这里。
 * Vercel 域名对 User-Agent 不挑剔（CF Workers 默认域名会 1010），适合做 CF 的备份通道。
 */
import { handleRequest } from "../core.js";

export const config = { runtime: "edge", regions: ["iad1", "sfo1"] };

export default async function handler(request) {
  const env = {
    CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || "",
    CLINE_ACCESS_TOKEN: process.env.CLINE_ACCESS_TOKEN || "",
    API_KEY: process.env.API_KEY || "",
    DEFAULT_MODEL: process.env.DEFAULT_MODEL || "",
    FALLBACK_TO_DEFAULT: process.env.FALLBACK_TO_DEFAULT || "",
    MIN_MAX_TOKENS: process.env.MIN_MAX_TOKENS || "",
    MAX_CONCURRENT: process.env.MAX_CONCURRENT || "",
    PROTECT_MODELS: process.env.PROTECT_MODELS || "",
  };
  return await handleRequest(request, env);
}
