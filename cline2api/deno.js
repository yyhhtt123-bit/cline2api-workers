/**
 * cline2api v2 · Deno Deploy 入口（也可本地 deno run --allow-net deno.js）
 *
 * 部署：https://dash.deno.com → New Project → 指向本文件（入口 deno.js）
 * 环境变量在 Dashboard 的 Environment Variables 里配 CLINE_REFRESH_TOKEN / API_KEY。
 *
 * Deno Deploy 免费、域名不挑 User-Agent，是 CF Workers 之外最省心的边缘选项。
 */
import { handleRequest } from "./core.js";

const env = {
  CLINE_REFRESH_TOKEN: Deno.env.get("CLINE_REFRESH_TOKEN") || "",
  CLINE_ACCESS_TOKEN: Deno.env.get("CLINE_ACCESS_TOKEN") || "",
  API_KEY: Deno.env.get("API_KEY") || "",
  DEFAULT_MODEL: Deno.env.get("DEFAULT_MODEL") || "",
  FALLBACK_TO_DEFAULT: Deno.env.get("FALLBACK_TO_DEFAULT") || "",
  MIN_MAX_TOKENS: Deno.env.get("MIN_MAX_TOKENS") || "",
  MAX_CONCURRENT: Deno.env.get("MAX_CONCURRENT") || "",
  PROTECT_MODELS: Deno.env.get("PROTECT_MODELS") || "",
};

Deno.serve((request) => handleRequest(request, env));
