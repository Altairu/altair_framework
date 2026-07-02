[English](#english-version) / [日本語](#japanese-version)

<a name="japanese-version"></a>
# Altair Framework (altair_framework)

CANバス（1 Mbps）で統一されたアクチュエータ制御モジュール群「Altair Module System」を、ROS2およびブラウザ（PC/スマホ）からシームレスに一括制御・管理するための統合ROS2パッケージです。

ロボット側のプログラムを完全に固定したまま、操縦者PC側でモジュール構成の動的変更やプロファイルの瞬時切り替え、PS5コントローラー連携、およびPython/Blocklyによる自律動作プログラムの動的起動とリアルタイムデバッグをサポートします。

---

## ディレクトリとドキュメントの配置

本リポジトリは、以下のマルチパッケージ構造および専用ドキュメントフォルダで構成されています。

```text
altair_framework/
├── README.md
├── build.sh / colconビルド用スクリプト
├── run_nuc.sh / NUCロボット側の起動スクリプト
├── run_operator.sh / 操縦PC側の起動スクリプト
│
├── docs/ / ドキュメントフォルダ
│   ├── architecture.md / アーキテクチャ設計書
│   ├── can_specification.md / CAN仕様書
│   ├── setup_guide_nuc.md / NUCセットアップガイド
│   └── behavior_programming_guide.md / 動作プログラム作成ガイド
│
├── altair_interfaces/ / カスタムメッセージとサービス定義
├── altair_can_bridge/ / NUC側SocketCANブリッジ
├── altair_core/ / 操縦PC側システム制御とプログラムランナー
├── altair_web_server/ / FastAPIサーバーとWebUI
└── user_behaviors/ / 自律動作プログラムの配置場所
```

---

## 前提条件と導入手順

本パッケージは、Ubuntu 22.04 + ROS2 Humble 環境での動作を確認しています。

### 依存パッケージのインストール
物理CANフレームをROS2上で扱うための標準パッケージ `can_msgs` / ビルドツールをインストールします。
```bash
sudo apt update
sudo apt install ros-humble-can-msgs python3-colcon-common-extensions
```

### Python依存ライブラリのインストール
FastAPIサーバーの稼働に必要なライブラリをインストールします。
```bash
pip install fastapi uvicorn websockets
```

### リポジトリのビルド
ワークスペースのトップでビルドスクリプトを実行します。
```bash
# 実行権限の付与
chmod +x build.sh run_nuc.sh run_operator.sh
chmod +x altair_can_bridge/scripts/setup_slcan.sh

# ビルドの実行
./build.sh

# キャッシュをクリーンして再ビルド
./build.sh --clean
```

別PCやUbuntu間でワークスペースを移動した直後は、古いCMakeキャッシュとの不整合を避けるため `./build.sh --clean` を推奨します。

---

## トラブルシュート

### CMakeCache.txt のパス不一致エラーが出る場合

エラー内容：
* `CMake Error: The current CMakeCache.txt directory ... is different than the directory ... where CMakeCache.txt was created`
* `CMake Error: The source "..." does not match the source "..." used to generate cache`

原因：
以前の別パスで生成された `build/` キャッシュが残っていることが原因です。たとえばWindows側の `/mnt/c/...` などでビルドした場合に発生します。

対処：
```bash
./build.sh --clean
```
上記を実行すると `build/` / `install/` / `log/` を削除してから再ビルドするため、パス不一致を解消できます。

---

## 起動と運用コマンド

### NUCロボット側
物理接続されているPCで実行します。

* **USB-to-CAN 接続の場合**
  USB-to-CAN / CANable 2の自動探索 / SocketCAN `can0` インターフェースの1 Mbpsでの自動起動 / ブリッジノードの立ち上げを一括で行います。
  ```bash
  ./run_nuc.sh
  ```
  物理ポート名の固定化や、パスワード不要でのSocketCAN自動起動、ロボット電源起動時の完全自動起動の設定方法は、[docs/setup_guide_nuc.md](docs/setup_guide_nuc.md) を参照してください。

* **Ethernet-CAN 接続の場合**
  TCP経由でイーサネット-CAN変換モジュールと通信します。以下のようにROS2パラメータを指定して起動します。
  ```bash
  ros2 run altair_can_bridge can_bridge_node --ros-args -p connection_mode:=ethernet -p ethernet_ip:=192.168.2.123 -p ethernet_port:=5000
  ```

### 操縦PC側
WiFi経由で操作するPCで実行します。モジュールマネージャー / 動作プログラムランナー / WebUIサーバーノードを一括で起動します。Ctrl+Cを押すとバックグラウンドノードも同時に終了します。
```bash
./run_operator.sh
```

起動後、同一WiFiネットワーク内のPCやスマートフォンのブラウザから、以下のURLにアクセスします。
* URL: `http://<NUCのIPアドレス>:8000/`

---

## WebUIの機能

* Dashboard: drive_mdd / arm_servo / valve_controller のモジュールカードが動的に生成され、スライダーやトグルボタンで低遅延の直接操作が可能です。リミットスイッチの状態やエンコーダ実測データもリアルタイムで描画します。
* Profiles: `profiles/hoge.json` などのモジュール構成をワンクリックで切り替えます。JSONファイルとしてローカルにエクスポート / インポートが可能です。
* Controller: スマートフォンやPCにBluetooth接続されたPS5コントローラーなどを自動検出し、アナログ軸やボタンへの割り当てを設定します。
* Programs: Pythonで書かれた自律動作スクリプトを選択してWebUI上から起動や停止が可能です。スクリプト内の `print()` やエラー出力がリアルタイムでストリーミングされます。
* Automation: Google Blocklyを用いて、ブラウザ上でブロックを組み合わせて自動化マクロを作成して実行します。差動二輪やメカナムやオムニなどのロボット運動学制御もサポートしています。

---

## AIを用いた動作プログラムの自動作成

本パッケージでは、AIに動作プログラムを記述させるための専用プロンプト仕様書を用意しています。

* [docs/behavior_programming_guide.md](docs/behavior_programming_guide.md) の中身をコピーします。
* 使用するAIチャットの入力欄に貼り付けます。
* 同ファイルの最下部にあるテンプレートに、動かしたいシナリオを追記してAIに送信します。たとえばスイッチが押されたらアームを下ろして吸引するなどの指示を書きます。
* AIが出力したPythonコードを `user_behaviors/` フォルダ内に保存するだけで、即座にWebUIから実行できるようになります。

---

## ライセンス

本プロジェクトは MIT License の元で公開されています。詳細は [LICENSE](LICENSE) ファイルを参照してください。

---

<a name="english-version"></a>
# Altair Framework (altair_framework)

An integrated ROS2 package designed to seamlessly control and manage the actuator control module group "Altair Module System" unified by CAN bus (1 Mbps) from ROS2 and web browsers (PC / smartphone).

While keeping the robot side program completely fixed, it supports dynamic configuration changes, instant profile switching, PS5 controller integration, and dynamic launching and real-time debugging of autonomous behavior programs written in Python / Blockly.

---

## Directory and Document Layout

This repository consists of the following multi-package structure and dedicated document folders.

```text
altair_framework/
├── README.md
├── build.sh / Simple script for colcon build
├── run_nuc.sh / Startup script for the NUC robot side
├── run_operator.sh / Startup script for the operator PC side
│
├── docs/ / Documentation folder
│   ├── architecture.md / Architecture, state transitions, and data flow design
│   ├── can_specification.md / Detailed CAN packet structure specification
│   ├── setup_guide_nuc.md / Guide for persistent udev rules and sudoers setting on NUC
│   └── behavior_programming_guide.md / API specification and prompt template for behavior programming
│
├── altair_interfaces/ / Custom messages and services package
├── altair_can_bridge/ / NUC side SocketCAN bridge with auto-detection
├── altair_core/ / Operator PC side system control and behavior runner
├── altair_web_server/ / Operator PC side FastAPI web/websocket server and dashboard UI
└── user_behaviors/ / Directory for autonomous behavior scripts
```

---

## Prerequisites and Setup Guide

Tested environment: Ubuntu 22.04 + ROS2 Humble.

### Install Dependency Packages
Install `can_msgs` package and colcon build tools.
```bash
sudo apt update
sudo apt install ros-humble-can-msgs python3-colcon-common-extensions
```

### Install Python Libraries
Install libraries required for FastAPI web server.
```bash
pip install fastapi uvicorn websockets
```

### Build Repository
Run the build script at the workspace root.
```bash
# Grant execution permissions
chmod +x build.sh run_nuc.sh run_operator.sh
chmod +x altair_can_bridge/scripts/setup_slcan.sh

# Run build
./build.sh

# Clean build
./build.sh --clean
```

When moving the workspace between PCs or WSL, `./build.sh --clean` is recommended to avoid CMake cache conflicts.

---

## Troubleshooting

### Path Mismatch in CMakeCache.txt

Error message:
* `CMake Error: The current CMakeCache.txt directory ... is different than the directory ... where CMakeCache.txt was created`
* `CMake Error: The source "..." does not match the source "..." used to generate cache`

Cause:
Remaining build cache from a different path (such as Windows `/mnt/c/...` path).

Solution:
```bash
./build.sh --clean
```
This command removes `build/`, `install/`, and `log/` directories, and then rebuilds the workspace to resolve path conflicts.

---

## Execution and Operations

### NUC Robot Side
Run on the PC connected to the CAN bus or Ethernet network.

* **USB-to-CAN Connection**
  It handles auto-detection of USB-to-CAN adapter, brings up SocketCAN `can0` interface at 1 Mbps, and starts the bridge node.
  ```bash
  ./run_nuc.sh
  ```
  Refer to [docs/setup_guide_nuc.md](docs/setup_guide_nuc.md) for persistent port naming, passwordless SocketCAN setup, and auto-start on boot.

* **Ethernet-CAN Connection**
  It communicates with the Ethernet-CAN converter module via TCP. Run the node with ROS2 parameters:
  ```bash
  ros2 run altair_can_bridge can_bridge_node --ros-args -p connection_mode:=ethernet -p ethernet_ip:=192.168.2.123 -p ethernet_port:=5000
  ```

### Operator PC Side
Run on the PC operating the robot over WiFi. It launches Module Manager, Behavior Runner, and WebUI Server. Press Ctrl+C to terminate all background nodes safely.
```bash
./run_operator.sh
```

After startup, access the following URL from a PC or smartphone browser on the same WiFi network.
* URL: `http://<NUC_IP_ADDRESS>:8000/`

---

## WebUI Features

* Dashboard: Module cards for drive_mdd, arm_servo, and valve_controller are dynamically generated, enabling low-latency operation via sliders and toggles. Limit switch status and encoder data are displayed in real-time.
* Profiles: Switch module configurations using profiles like `profiles/hoge.json` with a single click. Support local JSON export and import.
* Controller: Auto-detects Bluetooth connected PS5 controllers to map analog sticks and buttons.
* Programs: Select and execute autonomous scripts written in Python. Terminal logs are streamed in real-time.
* Automation: Build automation macros using Google Blockly. Supports robot kinematics control for differential drive, mecanum, and omni systems.

---

## Autonomous Programming with AI

This package provides a prompt template to help AI generate behavior scripts without bugs.

* Copy the contents of [docs/behavior_programming_guide.md](docs/behavior_programming_guide.md).
* Paste it into your AI chat interface.
* Append your target scenario to the prompt template at the bottom of the file and send it.
* Save the generated Python code to the `user_behaviors/` directory to run it instantly from the WebUI.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
