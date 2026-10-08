# cline2api v2

把 [cline.bot](https://cline.bot) 的模型额度转成**标准 OpenAI / Anthropic 兼容 API**。
零依赖、单份核心逻辑、Node 与 Cloudflare Workers 双入口。

**默认模型：`cline-cloud/deepseek-v4.1-flash`** —— 1M 上下文、带 reasoning、**0 credits**。

```bash
node server.js
# → http://127.0.0.1:8787/v1   （OpenAI 与 Anthropic 双协议）
```

---

## 一、Cline 的三个层级（实测）

模型列表来自官方插件接口 `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`，
返回体里就是四个数组，对应三层：

| tier | 前缀 | 实测可用性 |
|---|---|---|
| `clineCloud` | `cline-cloud/` | ✅ **可用且 0 credits** —— 当前只有 `cline-cloud/deepseek-v4.1-flash` 一个模型 |
| `free` | `cline-free/` | ✅ 免费（`mimo-v2.6-flash` / `muse-spark-1.3-contributor` / `step-5-preview` / `solar-mini4`） |
| `clinePass` | `cline-pass/` | ❌ 未订阅返回 `403 ENTITLEMENT_ERROR: the user is not subscribed to required model plan` |
| `recommended` | 各家原厂前缀 | 付费/自带额度，按账号余额 |

> ⚠️ `cline-cloud/` **不是付费档**，只是 Cline 自家托管通道的命名前缀。
> 用 `credits used = 0.0000` 即可验证（Cline 后台 MY USAGE 页面）。
>
> ⚠️ 这些 `cline-*` 模型 ID **不在**公开的 `GET /api/v1/models`（467 个）里，
> 只能从 `recommended-models` 拿——所以任何 2api 都必须读这个接口。

---

## 二、为什么会有 v2（旧版为什么废）

旧实现（`cline2api-workers`）里的几条"铁律"在当前上游**已经不成立**，照着抄会直接跑不通：

| 旧仓库的结论 | 当前实测（2026-10） |
|---|---|
| 需要一整套 Cline 客户端指纹头（UA / HTTP-Referer / X-CLIENT-VERSION / X-PLATFORM …） | ❌ **只需要 `X-CLIENT-TYPE: cline-sdk`**；只加 UA 或什么都不加 → `403 only available via Cline product surfaces` |
| 请求体带 `max_tokens` 一律 500 `empty response content` | ⚠️ 只有**过小的值**才炸（1/16 → 500；100/500 → 200 且 `finish_reason="length"`） |
| 上游免费通道并发 > 1 必返回空响应，必须全局串行 + 800ms 间隔 | ❌ 并发 3 个全部 200，串行队列纯属自残 |
| 默认模型 `cline-free/deepseek-v4.1-flash` | ❌ 已下架（不在 free 数组里），主力是 `cline-cloud/deepseek-v4.1-flash` |
| `cline-cloud/` 是付费第三档、代码里没处理 | ❌ 它是免费主力通道，v2 的默认模型 |

v2 的做法：

- **模型解析三层动态拉取**，免费层（cloud + free）排在前面，pass 层标注不可用；
- **`max_tokens` 守卫**：小于 `MIN_MAX_TOKENS`（默认 100）的值直接丢弃 → GUI 的"测试模型"（固定发 `max_tokens:1`）也能测通；
- **不串行**，只按账号限制并发（`MAX_CONCURRENT`，默认 8）；
- **流式兜底**：上游偶发"整条流只有 reasoning、没有 content"时，把 reasoning 作为 content 补一个 chunk，避免客户端静默不回复；
- **双协议**：`/v1/chat/completions`（OpenAI）与 `/v1/messages`（Anthropic），含 tools/function calling 双向转换；
- **模型名兜底**：客户端硬编码的 `gpt-4o` / `claude-3-5-sonnet-*` 等自动映射到默认模型，任何客户端都能直接用。

---

## 三、快速开始

### 1. 拿 refreshToken

```bash
node get-token.js
```

走 Cline 官方的 WorkOS 设备授权码流程：打印授权链接 → 浏览器登录授权 → 自动换回 `refreshToken`。
手机上操作可加 Telegram 推送（配了 TG 时 token 只推 TG、不打印到终端）：

```bash
TG_BOT_TOKEN=xxx TG_CHAT_ID=123456 node get-token.js
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，至少填 CLINE_REFRESH_TOKEN
```

多账号（额度用尽自动切号）就在 `CLINE_REFRESH_TOKEN` 里一行一个：

```
第一个账号的refreshToken
第二个账号的refreshToken
```

### 3. 启动

```bash
node server.js            # 默认 127.0.0.1:8787
PORT=9000 HOST=0.0.0.0 node server.js
```

### 4. 验证

```bash
curl http://127.0.0.1:8787/v1/health

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"cline-cloud/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

端到端自测（真实请求上游，28 项）：

```bash
bash test/smoke.sh
```

---

## 四、客户端接入

统一写法：

```text
Base URL : http://<你的地址>:8787/v1     （OpenAI 兼容；Anthropic 客户端去掉 /v1 由 SDK 自己拼）
API Key  : <你设的 API_KEY>（没设就随便填一个非空值）
Model    : cline-cloud/deepseek-v4.1-flash
```

| 客户端 | 配置要点 |
|---|---|
| OpenAI SDK / 通用 OpenAI 兼容 | `base_url="http://127.0.0.1:8787/v1"` |
| Cherry Studio / NextChat / LobeChat | 供应商选"OpenAI 兼容"，填上面 Base URL + Key + 模型 |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` + `ANTHROPIC_AUTH_TOKEN=<API_KEY>`（走 `/v1/messages`） |
| Cursor / Continue 等硬编码模型名的客户端 | 打开 `FALLBACK_TO_DEFAULT`（默认已开），随便填模型名都能用 |
| New API / one-api 中转 | 渠道类型选 OpenAI，Base URL 填 `/v1`，模型名填 `cline-cloud/deepseek-v4.1-flash` |

> `GET /v1/models` 返回三层模型列表，`usable: false` 表示需要 cline-pass 订阅。

---

## 五、部署

### 方式 A：本机 / VPS / Docker（推荐，无平台限制）

```bash
# 后台常驻（systemd / pm2 / nohup 任选）
nohup node server.js > cline2api.log 2>&1 &
```

> 公网暴露时**务必设置 `API_KEY`**，否则等于把你的 Cline 额度开放给所有人。

### 方式 B：Cloudflare Workers

```bash
npx wrangler deploy
npx wrangler secret put CLINE_REFRESH_TOKEN
npx wrangler secret put API_KEY
```

> ⚠️ Workers 默认域名对非浏览器 UA 会返回 `error code: 1010`，客户端需带浏览器 UA；
> 嫌麻烦就用方式 A 自托管（Node 版没有这个限制）。

---

## 六、环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `CLINE_REFRESH_TOKEN` | ✅ | — | Cline 账号 refreshToken，一行一个（多账号自动切号） |
| `CLINE_ACCESS_TOKEN` | — | — | 已有 accessToken 时可直接填（与上者二选一） |
| `API_KEY` | 建议 | 空 | 客户端访问密钥；**不设 = 不鉴权** |
| `DEFAULT_MODEL` | — | `cline-cloud/deepseek-v4.1-flash` | 覆盖默认模型 |
| `FALLBACK_TO_DEFAULT` | — | `true` | 未知模型名是否回落到默认模型；设 `false` 关闭 |
| `MIN_MAX_TOKENS` | — | `100` | 低于此值的 `max_tokens` 丢弃（上游对过小值返回 500） |
| `MAX_CONCURRENT` | — | `8` | 单账号并发上限 |
| `PROTECT_MODELS` | — | `false` | 设 `true` 则 `/v1/models` 也要求 API_KEY |
| `CLINE_API_BASE` | — | `https://api.cline.bot/api/v1` | 上游地址 |
| `PORT` / `HOST` | — | `8787` / `127.0.0.1` | Node 版监听地址 |

---

## 七、排错

| 现象 | 原因 / 处理 |
|---|---|
| `403 only available via Cline product surfaces` | 少了 `X-CLIENT-TYPE: cline-sdk`。本项目的上游请求头已内置，若你自己改过代码请补回 |
| `500 empty response content` | 请求的 `max_tokens` 太小（reasoning 吃光预算）。v2 已自动丢弃过小值；若手动调小了 `MIN_MAX_TOKENS` 就会重现 |
| `429 Daily free limit reached` / `Try again in 2h 51m` | 该账号当日免费额度用完。多账号（`CLINE_REFRESH_TOKEN` 多行）会自动切号，全部冷却时直接返回上游响应 |
| `403 ENTITLEMENT_ERROR: not subscribed to required model plan` | 用的是 `cline-pass/*` 模型，需要 Cline Pass 订阅；免费请用 `cline-cloud/deepseek-v4.1-flash` |
| 客户端能连上但**不回复** | 上游偶发"只有 reasoning 没有 content"。v2 已做兜底（把 reasoning 作为 content 补发）；若仍有，检查客户端是否忽略了 `reasoning_content` |
| CF Workers 返回 `error code: 1010` | Workers 默认域名挑 UA，客户端带浏览器 UA，或改用 Node 自托管 |
| 模型列表里没有 `cline-cloud/...` | 确认 `GET /v1/health` 里 `upstream.reachable=true`；列表来自 `recommended-models`，该接口不可达时会回落到内置列表 |

---

## 八、项目结构

```
cline2api/
├── core.js         # 核心逻辑（平台无关）：模型解析 / 账号池 / 双协议转换 / 路由
├── server.js       # Node 入口（零依赖，node server.js）
├── worker.js       # Cloudflare Workers 入口（复用同一份 core.js）
├── get-token.js    # 获取 CLINE_REFRESH_TOKEN（WorkOS 设备授权码流程）
├── test/smoke.sh   # 端到端冒烟测试（真实请求上游，28 项）
├── .env.example
└── wrangler.toml
```

## 许可

MIT。核心思路参考 [luawei1/cline2api](https://github.com/luawei1/cline2api) 与 [pingmike2/cline2api-workers](https://github.com/pingmike2/cline2api-workers) 的逆向结论，
但**已按当前上游实测全部重写**（见第二章差异表）。
