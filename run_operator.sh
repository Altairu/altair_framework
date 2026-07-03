#!/bin/bash
# ==========================================
# Altair Framework - 操縦者PC側 一括起動スクリプト
# ==========================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

echo "====== Altair Framework: Starting Operator Nodes ======"

# 1. ROS2環境変数のソース ＆ 実行ファイル存在チェック
SHOULD_BUILD=0
if [ ! -f "install/setup.bash" ]; then
    SHOULD_BUILD=1
elif [ ! -f "install/altair_core/lib/altair_core/module_manager" ] || [ ! -f "install/altair_web_server/lib/altair_web_server/web_server_node" ]; then
    echo "[INFO] 実行ファイルが見つかりません。ビルドが必要です。"
    SHOULD_BUILD=1
fi

if [ "$SHOULD_BUILD" -eq 1 ]; then
    echo "[WARNING] ワークスペースをビルドまたは再ビルドします..."
    ./build.sh
    if [ $? -ne 0 ]; then
        echo "[ERROR] ビルド失敗のため起動を中止します。"
        exit 1
    fi
fi

if [ -f "/opt/ros/humble/setup.bash" ]; then
    source /opt/ros/humble/setup.bash
fi
source install/setup.bash

export ROS_DOMAIN_ID=0

# 接続モードの解析と取得
CONNECTION_MODE="usb"
ETHERNET_IP="192.168.2.123"
ETHERNET_PORT=5000

while [[ $# -gt 0 ]]; do
    case $1 in
        ethernet|-e|--ethernet)
            CONNECTION_MODE="ethernet"
            shift
            # IPアドレスの簡易的なバリデーションと取得
            if [[ -n "$1" && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                ETHERNET_IP="$1"
                shift
            fi
            # ポート番号のバリデーションと取得
            if [[ -n "$1" && "$1" =~ ^[0-9]+$ ]]; then
                ETHERNET_PORT="$1"
                shift
            fi
            ;;
        *)
            echo "使用方法: $0 [ethernet [IP] [PORT]]"
            echo "  - ethernet, -e, --ethernet : Ethernet-CAN接続を使用する (デフォルトIP: 192.168.2.123, ポート: 5000)"
            echo "  例: $0 ethernet 192.168.2.100 5000"
            exit 1
            ;;
    esac
done

# 2. シグナルトラップの設定 (Ctrl+C時にバックグラウンドプロセスを安全にキル)
cleanup() {
    echo "バックグラウンドノードを安全に終了しています..."
    kill $PID_MGR $PID_RUNNER 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# 3. Module Manager をバックグラウンドで起動
echo "1. Module Managerを起動中..."
ros2 run altair_core module_manager &
PID_MGR=$!
sleep 1

# 4. Behavior Runner をバックグラウンドで起動
echo "2. Behavior Runnerを起動中..."
ros2 run altair_core behavior_runner &
PID_RUNNER=$!
sleep 1

# 5. Web Server / Dashboard UI をフォアグラウンドで起動
echo "3. Web Server & Dashboard をポート8000で起動中..."
echo "同じWiFi上のPCやスマホから、以下のURLでアクセスできます:"
echo "👉 http://<NUC_IP_ADDRESS>:8000/"
echo "====================================================="

if [ "$CONNECTION_MODE" = "ethernet" ]; then
    ros2 run altair_web_server web_server_node --ros-args -p connection_mode:=ethernet -p ethernet_ip:="${ETHERNET_IP}" -p ethernet_port:="${ETHERNET_PORT}"
else
    ros2 run altair_web_server web_server_node
fi

# 終了時処理
cleanup
