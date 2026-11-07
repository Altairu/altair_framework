#!/bin/bash
# ==========================================
# Altair Framework - シミュレータ用 RViz2 起動スクリプト
# ==========================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

if [ -f "/opt/ros/humble/setup.bash" ]; then
    source /opt/ros/humble/setup.bash
fi
if [ -f "install/setup.bash" ]; then
    source install/setup.bash
fi

export ROS_DOMAIN_ID=0

RVIZ_CONFIG="config/rviz/altair_sim.rviz"

if [ ! -f "$RVIZ_CONFIG" ]; then
    echo "[WARNING] $RVIZ_CONFIG が見つかりません。デフォルト設定で起動します。"
    rviz2
else
    echo "====== Altair Framework: RViz2 を起動します (設定: $RVIZ_CONFIG) ======"
    echo "Fixed Frame: odom | トピック: /odom, /tf"
    rviz2 -d "$RVIZ_CONFIG"
fi
