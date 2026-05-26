#!/bin/bash
# ==========================================
# Altair Framework - ROS2ワークスペースビルドスクリプト
# ==========================================

echo "====== Altair Framework: Bilduing ROS2 Workspace ======"

# 1. ワークスペースのビルドを実行 (シンボリックリンクインストールを有効化)
colcon build --symlink-install

if [ $? -eq 0 ]; then
    echo "========================================="
    echo "SUCCESS: ビルドが正常に完了しました！"
    echo "環境変数を適用するには以下を実行してください:"
    echo "source install/setup.bash"
    echo "========================================="
    
    # 開発用に自動的にソースする
    source install/setup.bash
    exit 0
else
    echo "========================================="
    echo "ERROR: ビルド中にエラーが発生しました。"
    echo "========================================="
    exit 1
fi
