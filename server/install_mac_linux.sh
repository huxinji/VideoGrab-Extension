#!/bin/bash
# VideoGrab Pro - 本地服务安装脚本 (macOS / Linux)

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   VideoGrab Pro - 本地服务安装程序      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检测 Python
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        VER=$("$cmd" -c "import sys; print(sys.version_info >= (3,8))" 2>/dev/null)
        if [ "$VER" = "True" ]; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "❌ 未检测到 Python 3.8+"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "请运行：brew install python"
    else
        echo "请运行：sudo apt install python3 python3-pip"
    fi
    exit 1
fi

echo "✅ Python: $($PYTHON --version)"

# 检测 ffmpeg
if command -v ffmpeg &>/dev/null; then
    echo "✅ ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
else
    echo "⚠️  未检测到 ffmpeg（建议安装以支持去水印功能）"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "   运行：brew install ffmpeg"
    else
        echo "   运行：sudo apt install ffmpeg"
    fi
fi

echo ""
echo "[*] 安装 Python 依赖..."
$PYTHON -m pip install --upgrade pip -q
$PYTHON -m pip install -r requirements.txt

echo ""
echo "✅ 依赖安装完成"

# 创建启动脚本
cat > start_server.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
echo "VideoGrab Pro 服务启动中..."
python3 server.py
EOF
chmod +x start_server.sh

# 后台启动
cat > start_server_bg.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
nohup python3 server.py > videograb.log 2>&1 &
echo "服务已在后台启动 (PID: $!)，日志: videograb.log"
EOF
chmod +x start_server_bg.sh

# macOS 开机自启动（可选）
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/com.videograb.service.plist"
    cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.videograb.service</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$SCRIPT_DIR/server.py</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$HOME/.videograb.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.videograb.log</string>
</dict>
</plist>
EOF
    echo "📌 已创建 macOS LaunchAgent（可选开机自启动）"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  安装完成！"
echo "  运行方式："
echo "  前台运行：./start_server.sh"
echo "  后台运行：./start_server_bg.sh"
echo "  停止服务：pkill -f server.py"
echo "══════════════════════════════════════════════"
echo ""

read -p "是否立即启动服务？(y/n): " AUTOSTART
if [[ "$AUTOSTART" =~ ^[Yy]$ ]]; then
    $PYTHON server.py
fi
