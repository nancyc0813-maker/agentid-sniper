@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agent ID Sniper 一键安装
echo.
echo ==============================================
echo   Agent ID Sniper 一键安装
echo   官方 TG 群：t.me/nancy_c0813
echo ==============================================
echo.
echo 开始前请确认：币安 App 里已开通 Agentic Wallet、领了 .ai Agent ID，并开启「开发者模式」
echo.
pause

REM ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [1/5] 没有找到 Node.js，正在安装...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js 安装完成。请【关掉这个窗口，再重新双击 一键安装.bat】继续。
  echo 如果安装失败，请到 https://nodejs.org 下载 LTS 版手动安装后再执行一次。
  pause
  exit /b
)
echo [1/5] Node.js 已安装

REM ---- 2. 币安 baw ----
where baw >nul 2>nul
if errorlevel 1 (
  echo [2/5] 正在安装币安 Agentic Wallet 工具（baw）...
  call npm install -g @binance/agentic-wallet
)
where baw >nul 2>nul
if errorlevel 1 (
  echo baw 安装失败，请检查网络后重新执行，或手动执行：npm install -g @binance/agentic-wallet
  pause
  exit /b
)
echo [2/5] baw 已安装

REM ---- 3. 设定 ----
if not exist data mkdir data
echo [3/5] 设定钱包和通知
node setup.mjs
if not exist config.json (
  echo 没有完成设定，请重新执行一次
  pause
  exit /b
)

REM ---- 4. 登录钱包 ----
echo.
echo [4/5] 登录第 1 个钱包：等一下会出现一个连结，用这个钱包的币安 App 打开并确认（5 分钟内）
node login.mjs 1
set /p NW=<data_wallets.txt
if "%NW%"=="2" (
  echo.
  echo 登录第 2 个钱包：用第 2 个钱包的币安账号打开连结确认
  call setup_wallet2.bat
)
del data_wallets.txt >nul 2>nul

REM ---- 5. 开机自动启动 + 现在启动 ----
echo.
echo [5/5] 设定开机自动启动
node -e "const p=require('path'),fs=require('fs');const f=p.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','agentid-sniper.vbs');const t='CreateObject(\"WScript.Shell\").Run \"\"\"'+p.join(process.cwd(),'start_hidden.vbs')+'\"\"\", 0, False\r\n';fs.writeFileSync(f,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(t,'utf16le')]));console.log('已设定开机自动启动')"
start "" wscript "%~dp0start_hidden.vbs"
echo.
echo ==============================================
echo   ✅ 安装完成，工具已在背景运行
echo   - 日志：data\watch.log
echo   - 停止：在这个资料夹建立一个叫 WATCH_STOP 的文件
echo   - 以后有新版会在 TG 提醒，回 /update 才会更新
echo   - 加入官方 TG 群：t.me/nancy_c0813
echo ==============================================
pause
