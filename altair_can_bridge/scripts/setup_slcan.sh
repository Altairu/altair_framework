#!/bin/bash
# altair_can_bridge/scripts/setup_slcan.sh
# USB-to-CAN (slcanプロトコル, CANable2など) の接続セットアップスクリプト

PORT_ARG=$1
BITRATE_ARG=$2

# デフォルト設定
DEFAULT_BITRATE="1000000"  # 1 Mbps

if [ -z "$BITRATE_ARG" ]; then
    BITRATE_ARG=$DEFAULT_BITRATE
fi

# ビットレートをslcandのオプションに変換
# 1 Mbps = -s8
# 500 kbps = -s6
# 250 kbps = -s5
# 125 kbps = -s4
SLCAND_SPEED="-s8"
if [ "$BITRATE_ARG" = "1000000" ]; then
    SLCAND_SPEED="-s8"
elif [ "$BITRATE_ARG" = "500000" ]; then
    SLCAND_SPEED="-s6"
elif [ "$BITRATE_ARG" = "250000" ]; then
    SLCAND_SPEED="-s5"
elif [ "$BITRATE_ARG" = "125000" ]; then
    SLCAND_SPEED="-s4"
fi

echo "====== Altair CANable2 Auto Setup ======"
echo "引数ポート: ${PORT_ARG:-'未指定 (自動探索)'}"
echo "対象ビットレート: $BITRATE_ARG (slcand オプション: $SLCAND_SPEED)"

# 1. 必要カーネルモジュールのロード
echo "1. カーネルモジュールをロードしています..."
sudo modprobe slcan
sudo modprobe can
sudo modprobe can_raw
if [ $? -ne 0 ]; then
    echo "[ERROR] CANカーネルモジュールのロードに失敗しました。WSL環境等の場合はカーネルがサポートしているか確認してください。"
    exit 1
fi

# 2. ポートの決定
TARGET_PORT=""

if [ -n "$PORT_ARG" ] && [ "$PORT_ARG" != "auto" ]; then
    # 手動指定ポートの検証
    if [ -e "$PORT_ARG" ]; then
        TARGET_PORT=$PORT_ARG
        echo "指定されたポートを使用します: $TARGET_PORT"
    else
        echo "[ERROR] 指定されたポート $PORT_ARG が見つかりませんでした。"
        exit 1
    fi
else
    # 自動探索モード (ttyACM* をスキャン)
    echo "2. シリアルポート (ttyACM*) を自動探索しています..."
    for dev in /dev/ttyACM*; do
        if [ -e "$dev" ]; then
            TARGET_PORT=$dev
            echo "ポートが見つかりました: $TARGET_PORT"
            break
        fi
    done

    # ttyACMが見つからなければ ttyUSB も探す
    if [ -z "$TARGET_PORT" ]; then
        for dev in /dev/ttyUSB*; do
            if [ -e "$dev" ]; then
                TARGET_PORT=$dev
                echo "ポートが見つかりました: $TARGET_PORT"
                break
            fi
        done
    fi
fi

if [ -z "$TARGET_PORT" ]; then
    echo "[ERROR] 利用可能なシリアルポート (ttyACM* / ttyUSB*) が検出されませんでした。"
    exit 1
fi

# 3. 既存の slcand プロセスと can0 インターフェースのクリーンアップ
echo "3. 既存の slcan 接続をクリーンアップしています..."
sudo ip link set can0 down 2>/dev/null
sudo killall slcand 2>/dev/null
sleep 0.5

# 4. slcand の起動
echo "4. slcand を起動して $TARGET_PORT を can0 にマッピングします..."
# -o: 開いたポートを維持, -c: 接続完了後にデーモン化
sudo slcand -o -c $SLCAND_SPEED $TARGET_PORT can0
if [ $? -ne 0 ]; then
    echo "[ERROR] slcand の起動に失敗しました。"
    exit 1
fi
sleep 1

# 5. インターフェースの起動
echo "5. can0 インターフェースを起動します..."
sudo ip link set can0 txqueuelen 1000
sudo ip link set can0 up
if [ $? -ne 0 ]; then
    echo "[ERROR] can0 の起動 (ip link set can0 up) に失敗しました。"
    exit 1
fi

echo "========================================="
echo "SUCCESS: can0 が $TARGET_PORT にて正常に起動しました！"
echo "========================================="
exit 0
