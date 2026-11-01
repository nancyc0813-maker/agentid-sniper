@echo off
cd /d "%~dp0"
chcp 65001 >nul
node watch.mjs --tg-login
pause
