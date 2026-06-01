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
# 2. CANブリッジノードの実行 (内部で setup_slcan.sh が自動的に呼ばれてポートをマッピングします)
echo "SocketCANブリッジノードを起動します..."
ros2 run altair_can_bridge can_bridge_node
