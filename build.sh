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
