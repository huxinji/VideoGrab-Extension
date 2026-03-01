@echo off
chcp 65001 >nul
title VideoGrab Pro - 服务安装

echo.
echo ╔══════════════════════════════════════════╗
echo ║   VideoGrab Pro - 本地服务安装程序      ║
echo ╚══════════════════════════════════════════╝
echo.

:: 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python！
    echo 请先安装 Python 3.8+ 并勾选 "Add Python to PATH"
    echo 下载地址：https://www.python.org/downloads/
    pause
    exit /b 1
)
echo [✓] Python 已检测到

:: 升级 pip
echo [*] 更新 pip...
python -m pip install --upgrade pip -q

:: 安装依赖
echo [*] 安装依赖 (flask, yt-dlp 等)...
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败！
    pause
    exit /b 1
)
echo [✓] 依赖安装完成

:: 检查 ffmpeg
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [提示] 未检测到 ffmpeg
    echo ffmpeg 用于视频合并和去水印，强烈建议安装：
    echo   1. 下载：https://ffmpeg.org/download.html
    echo   2. 解压后将 bin 目录添加到系统 PATH
    echo   或者使用 winget：winget install ffmpeg
    echo.
)

:: 创建启动脚本
echo @echo off > start_server.bat
echo title VideoGrab Pro 服务 >> start_server.bat
echo echo VideoGrab Pro 服务启动中... >> start_server.bat
echo python server.py >> start_server.bat
echo pause >> start_server.bat
echo [✓] 已创建启动脚本 start_server.bat

:: 创建后台启动脚本
echo @echo off > start_server_bg.bat  
echo start /B python server.py >> start_server_bg.bat
echo echo 服务已在后台启动！可以关闭此窗口 >> start_server_bg.bat

echo.
echo ══════════════════════════════════════════════
echo   安装完成！
echo   运行 start_server.bat 启动服务
echo   启动后请在浏览器扩展中刷新状态
echo ══════════════════════════════════════════════
echo.

set /p AUTOSTART="是否立即启动服务？(y/n): "
if /i "%AUTOSTART%"=="y" (
    python server.py
)
