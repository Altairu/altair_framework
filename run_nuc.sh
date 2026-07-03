#!/bin/bash
# ==========================================
# Altair Framework - NUCロボット側 起動スクリプト
# ==========================================

# ワークスペースディレクトリを特定
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

echo "====== Altair Framework: Starting NUC Node ======"

# 1. ROS2環境変数のソース ＆ 実行ファイル存在チェック
SHOULD_BUILD=0
if [ ! -f "install/setup.bash" ]; then
    SHOULD_BUILD=1
elif [ ! -f "install/altair_can_bridge/lib/altair_can_bridge/can_bridge_node" ]; then
    echo "[INFO] can_bridge_node 実行ファイルが見つかりません。ビルドが必要です。"
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

# 2. 接続モードの解析と起動
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

if [ "$CONNECTION_MODE" = "ethernet" ]; then
    echo "Ethernet-CANブリッジノードを起動します (IP: ${ETHERNET_IP}, ポート: ${ETHERNET_PORT})..."
    ros2 run altair_can_bridge can_bridge_node --ros-args -p connection_mode:=ethernet -p ethernet_ip:="${ETHERNET_IP}" -p ethernet_port:="${ETHERNET_PORT}"
else
    # 内部で setup_slcan.sh が自動的に呼ばれてポートをマッピングします
    echo "SocketCANブリッジノードを起動します..."
    ros2 run altair_can_bridge can_bridge_node
fi

