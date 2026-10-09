@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没有检测到 Node.js。
  echo     去 https://nodejs.org 下载 LTS 版安装，装完重开这个窗口再跑一次。
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [!] 已生成 .env，接下来用记事本填 CLINE_REFRESH_TOKEN（和可选的 API_KEY），保存关闭后重新双击本脚本。
  start notepad ".env"
  pause
  exit /b 0
)

findstr /r /c:"^CLINE_REFRESH_TOKEN=." ".env" >nul
if errorlevel 1 (
  echo [!] .env 里的 CLINE_REFRESH_TOKEN 还是空的。
  echo     先运行： node get-token.js   拿到 token 再填进 .env。
  pause
  exit /b 1
)

echo [*] 正在启动 cline2api ...
echo     地址: http://127.0.0.1:8787/v1
echo     关掉这个窗口 = 停止服务（想后台常驻见 docs\DEPLOY-WINDOWS.md）
echo.
timeout /t 2 >nul
start "" http://127.0.0.1:8787/v1/health
node server.js
pause
