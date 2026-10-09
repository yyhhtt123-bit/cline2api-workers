@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [*] 启动 Cline 授权流程，稍后会打印一个链接，在浏览器里登录授权即可。
echo.
node get-token.js
pause
