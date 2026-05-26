#!/bin/bash
# ==========================================
# Altair Framework - NUCロボット側 起動スクリプト
# ==========================================

# ワークスペースディレクトリを特定
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

echo "====== Altair Framework: Starting NUC Node ======"

# 1. ROS2環境変数のソース
if [ -f "install/setup.bash" ]; then
    source install/setup.bash
else
    echo "[WARNING] ワークスペースがビルドされていません。ビルドを実行します..."
    ./build.sh
    if [ $? -ne 0 ]; then
        echo "[ERROR] ビルド失敗のため起動を中止します。"
        exit 1
    fi
    source install/setup.bash
fi

# 2. CANブリッジノードの実行 (内部で setup_slcan.sh が自動的に呼ばれてポートをマッピングします)
echo "SocketCANブリッジノードを起動します..."
ros2 run altair_can_bridge can_bridge_node
