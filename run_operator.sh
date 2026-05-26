#!/bin/bash
# ==========================================
# Altair Framework - 操縦者PC側 一括起動スクリプト
# ==========================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

echo "====== Altair Framework: Starting Operator Nodes ======"

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

ros2 run altair_web_server web_server_node

# 終了時処理
cleanup
