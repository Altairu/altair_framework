#!/bin/bash
# ==========================================
# Altair Framework - ROS2ワークスペースビルドスクリプト
# ==========================================

show_help() {
    cat << 'EOF'
Usage: ./build.sh [--clean] [--help]

Options:
  -c, --clean   Build前に build/install/log を自動クリーンしてからビルド
  -h, --help    ヘルプを表示
EOF
}

DO_CLEAN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -c|--clean)
            DO_CLEAN=1
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "ERROR: 不明なオプションです: $1"
            show_help
            exit 1
            ;;
    esac
done

echo "====== Altair Framework: Bilduing ROS2 Workspace ======"

# ROS2環境変数がソースされているか確認
if [ -z "$ROS_DISTRO" ]; then
    echo "ERROR: ROS2環境変数がロードされていません。'source /opt/ros/<distro>/setup.bash' を実行してから再度お試しください。"
    exit 1
fi

# can_msgs 依存関係のチェックと自動インストール
ros2 pkg prefix can_msgs &>/dev/null
if [ $? -ne 0 ]; then
    echo "[WARNING] can_msgs パッケージがROS2環境内に見つかりません。"
    echo "altair_can_bridge のビルドに必須のため、ros-$ROS_DISTRO-can-msgs のインストールを試みます..."
    sudo apt-get update && sudo apt-get install -y ros-$ROS_DISTRO-can-msgs
    
    # 再チェック
    ros2 pkg prefix can_msgs &>/dev/null
    if [ $? -ne 0 ]; then
        echo "[ERROR] can_msgs のインストールに失敗しました。"
        echo "手動で 'sudo apt install ros-$ROS_DISTRO-can-msgs' を実行した後に再度ビルドしてください。"
        exit 1
    fi
    echo "[SUCCESS] can_msgs が正常にインストールされました！"
fi

if [ "$DO_CLEAN" -eq 1 ]; then
    echo "INFO: build/install/log をクリーンしています..."
    rm -rf build install log
fi

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
