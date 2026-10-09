@echo off
chcp 65001 >nul
setlocal

set /p URL=请输入你的 Worker 地址（如 https://cline2api.yht2801673206.workers.dev）: 
echo.
echo [*] 正在检查 %URL%/v1/health ...
echo.

curl.exe -s --max-time 30 "%URL%/v1/health" -o "%TEMP%\cline2api_health.json"
if errorlevel 1 (
  echo [X] 连不上。检查地址写对没、Worker 是否已部署。
  pause
  exit /b 1
)

type "%TEMP%\cline2api_health.json"
echo.
echo ---------------------------------------------
findstr /c:"\"accounts\": 0" "%TEMP%\cline2api_health.json" >nul
if not errorlevel 1 (
  echo [X] accounts = 0 ：Worker 里没有可用的 refreshToken！
  echo     修复一：npx wrangler secret put CLINE_REFRESH_TOKEN  （粘贴时用右键或 Ctrl+Shift+V，Ctrl+V 常无效）
  echo     修复二：Cloudflare 面板 -^> Workers -^> cline2api -^> Settings -^> Variables and Secrets -^> 添加 Secret
  echo     改完再跑一次本脚本。
) else (
  echo [OK] accounts 正常，refreshToken 已生效
)

findstr /c:"\"reachable\": true" "%TEMP%\cline2api_health.json" >nul
if not errorlevel 1 (echo [OK] 上游可达，模型列表已拉到) else (echo [X] 上游不可达)

echo ---------------------------------------------
pause
