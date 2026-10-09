# Windows 部署指南

全程不需要 Docker、不需要 WSL、不需要 Linux —— Node 是跨平台的。

---

## 路线 0：先在自己 Windows 上跑起来（5 分钟，推荐先做这个）

### 第 1 步：装 Node.js

- 打开 <https://nodejs.org> → 下载 **LTS** 版 → 一路下一步安装。
- 或者用 winget（Windows 10/11 自带）：

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

- 装完**新开一个** PowerShell 窗口验证：

  ```powershell
  node -v      # 应输出 v20.x / v22.x 之类
  ```

### 第 2 步：把代码拿到本地

装了 Git（**推荐，根目录就是项目本身，不带旧代码**）：

```powershell
git clone -b cline2api https://github.com/yyhhtt123-bit/cline2api-workers.git
cd cline2api-workers
```

没装 Git：在 GitHub 页面把分支切到 **`cline2api`** → 右上角 **Code → Download ZIP** → 解压。

> 旧分支 `cline/32dp414j` 里项目在 `cline2api/` 子目录下（工作分支，会持续加东西）；
> `cline2api` 分支是干净快照，给部署用。

### 第 3 步：拿 refreshToken

```powershell
node get-token.js
```

或者直接**双击 `start-token-windows.bat`**。

终端会打印一个链接（类似 `https://authkit.cline.bot/device?user_code=XXXX-XXXX`）：
在浏览器打开 → 用 Google / GitHub / 邮箱登录授权 → 终端自动打印出 `refreshToken`。

> 手机操作更方便的话，可以配 Telegram 推送（token 只推 TG、不打印在终端）：
> ```powershell
> $env:TG_BOT_TOKEN="你的bot token"; $env:TG_CHAT_ID="你的chat id"; node get-token.js
> ```

### 第 4 步：写配置

```powershell
copy .env.example .env
notepad .env
```

填这两行（**注意不要有引号、不要有空格**）：

```
CLINE_REFRESH_TOKEN=刚刚拿到的token
API_KEY=sk-cline-随便起一个
```

> `API_KEY` 不填 = 不鉴权。**只在本机用**可以不填；一旦要让手机/局域网/公网访问，**必须填**，否则等于把你的 Cline 额度对外开放。

### 第 5 步：启动

**双击 `start-windows.bat`**（会顺手检测 Node、.env、并打开浏览器），或者手动：

```powershell
node server.js
```

看到这段就成功了：

```
cline2api v2.0.0  http://127.0.0.1:8787
  默认模型 : cline-cloud/deepseek-v4.1-flash
```

⚠️ **这个黑窗口关掉 = 服务停止**。想常驻见下面「后台常驻」。

### 第 6 步：验证

PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，参数不兼容，**用 `curl.exe`**：

```powershell
curl.exe http://127.0.0.1:8787/v1/health
```

发一次聊天（PowerShell 里转义麻烦，写进文件最稳）：

```powershell
'{"model":"cline-cloud/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}' | Out-File -Encoding utf8 body.json
curl.exe http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d "@body.json"
```

拿到回复就通了。客户端里填：

```text
Base URL : http://127.0.0.1:8787/v1
API Key  : <你设的 API_KEY>
Model    : cline-cloud/deepseek-v4.1-flash
```

---

## 让手机 / 局域网也能用

默认只监听 `127.0.0.1`（只有本机能连）。要局域网访问：

```powershell
$env:HOST="0.0.0.0"; node server.js
```

然后放行端口（**管理员** PowerShell）：

```powershell
netsh advfirewall firewall add rule name="cline2api" dir=in action=allow protocol=TCP localport=8787
```

查本机 IP：`ipconfig`，找「IPv4 地址」，比如 `192.168.1.20`，客户端就填 `http://192.168.1.20:8787/v1`。

---

## 后台常驻（开机自启、不占窗口）

### 方案 A：任务计划程序（系统自带，推荐）

1. `Win + R` → 输入 `taskschd.msc` → 回车
2. 右侧 **创建任务**（不是「创建基本任务」）
3. **常规** 页：名称填 `cline2api`，勾选「不管用户是否登录都要运行」+「使用最高权限运行」
4. **触发器** 页：新建 → 开始任务选「登录时」（或「启动时」）→ 确定
5. **操作** 页：新建 → 程序或脚本填 `node`，添加参数填 `server.js`，起始于填 `D:\cline2api`（换成你的实际目录）
6. **设置** 页：勾「如果任务失败，按以下频率重启」
7. 确定保存，右键任务 → 运行，浏览器打开 `http://127.0.0.1:8787/v1/health` 验证

### 方案 B：pm2（带崩溃自动重启、日志）

```powershell
npm i -g pm2
cd D:\cline2api
pm2 start server.js --name cline2api
pm2 save
pm2 logs cline2api        # 看日志
```

开机自启用 `pm2-startup`（会提示你装一个 Windows 服务）或干脆配合方案 A 调用 `pm2 resurrect`。

---

## 部署到云端（Windows 上照样能做，不需要 Linux）

### Cloudflare Workers（免费，边缘）

```powershell
npm i -g wrangler
cd D:\cline2api
wrangler login                     # 弹出浏览器授权，点 Allow
wrangler deploy                    # 输出 https://cline2api.xxx.workers.dev
wrangler secret put CLINE_REFRESH_TOKEN    # 粘贴 token 回车
wrangler secret put API_KEY
```

> ⚠️ **在 `wrangler secret put` 的提示符下，cmd 的 `Ctrl+V` 经常无效**（看着像是粘了，其实存了空值）。
> 用 **右键粘贴** 或 Windows Terminal 的 `Ctrl+Shift+V`。存完用 `check-deploy.bat` 验一下 `accounts` 是不是 1。

> ⚠️ `*.workers.dev` 域名对非浏览器 UA 返回 `error code: 1010`，客户端要带浏览器 UA；受不了就用下面的 Vercel 或干脆跑本机。

### Vercel（免费，不挑 UA）

```powershell
npm i -g vercel
cd D:\cline2api
vercel login
vercel --prod                      # 首次会问项目名，Framework 选 Other
vercel env add CLINE_REFRESH_TOKEN production   # 粘贴 token
vercel env add API_KEY production
vercel --prod                      # 改完环境变量必须重新部署
```

### Deno Deploy（免费，纯网页操作）

1. 把代码推到你的 GitHub 仓库
2. 打开 <https://dash.deno.com> → **New Project** → 选那个仓库
3. 入口文件填 `deno.js`
4. 在项目的 **Environment Variables** 里加 `CLINE_REFRESH_TOKEN`、`API_KEY`
5. Deploy，拿到 `https://xxx.deno.dev`

### Render（免费档，Docker 一键）

1. <https://render.com> → New → **Blueprint** → 连仓库
2. 自动读 `render.yaml`；在面板填 `CLINE_REFRESH_TOKEN` / `API_KEY`
3. 部署完用 `https://<你的服务>.onrender.com/v1/health` 验证

> 容器平台都靠仓库里的 `Dockerfile`，不需要你本地装 Docker。

---

## Windows 常见坑

| 现象 | 解决 |
|---|---|
| `node : 无法将“node”项识别为 cmdlet...` | Node 没装好或没重开窗口。重开 PowerShell 再试 `node -v` |
| `curl` 报参数错误 / 一直卡住 | PowerShell 里 `curl` 是别名，改用 `curl.exe` |
| 中文输出乱码 | 脚本已 `chcp 65001`；手动跑时先执行 `chcp 65001` |
| `EADDRINUSE` 端口被占用 | `netstat -ano \| findstr :8787` 找到 PID，`taskkill /PID <pid> /F`；或改 `PORT=8788` |
| 防火墙弹窗 | 点「允许访问」。只给本机用则点「取消」也行 |
| 第一次被 Defender/杀软拦 | 加入白名单即可（就是普通的 node 进程） |
| `.env` 改完没生效 | 重启 `node server.js`（环境变量只在启动时读一次） |
| 目录里有中文/空格 | 能用，但建议放 `D:\cline2api` 这类纯英文短路径，少出怪问题 |
