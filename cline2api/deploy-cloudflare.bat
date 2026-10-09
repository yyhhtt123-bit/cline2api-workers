@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo  cline2api - 一键部署到 Cloudflare Workers
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没装 Node.js，先去 https://nodejs.org 装 LTS 版。
  pause
  exit /b 1
)

call npx --yes wrangler@latest whoami >nul 2>nul
if errorlevel 1 (
  echo [*] 还没登录 Cloudflare，现在打开浏览器授权 ...
  call npx --yes wrangler@latest login
  if errorlevel 1 ( echo [X] 登录失败 & pause & exit /b 1 )
)

echo [*] 正在部署 Worker ...
call npx --yes wrangler@latest deploy
if errorlevel 1 ( echo [X] 部署失败，把上面的报错发出来 & pause & exit /b 1 )

echo.
echo [*] 设置机密变量 CLINE_REFRESH_TOKEN
 echo     （粘贴 token 后回车；多账号就一行一个。没 token 先跑 start-token-windows.bat）
call npx --yes wrangler@latest secret put CLINE_REFRESH_TOKEN

echo.
echo [*] 设置机密变量 API_KEY（客户端访问密钥，随便起一个，如 sk-cline-abc）
call npx --yes wrangler@latest secret put API_KEY

echo.
echo ============================================
echo  完成！你的地址形如：
echo     https://cline2api.你的子域.workers.dev/v1
echo  验证（PowerShell 里用 curl.exe）：
echo     curl.exe https://cline2api.你的子域.workers.dev/v1/health
echo  看到 "accounts": 1 和 "upstream": {"reachable": true ...} 就是成功。
echo ============================================
pause
