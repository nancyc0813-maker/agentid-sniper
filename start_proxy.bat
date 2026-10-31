@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 这台机器访问 BSC 公共节点要走本地代理，所以启动前先设好代理变量
set NODE_USE_ENV_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:10808
set HTTP_PROXY=http://127.0.0.1:10808
echo 代理已设置: %HTTPS_PROXY%
echo 启动 watch.mjs（关闭此窗口不会停止进程；要停止请在本资料夹建立 WATCH_STOP 文件）
call start_loop.bat
