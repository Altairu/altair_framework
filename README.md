# Altair Framework (altair_framework)

CANバス（1 Mbps）で統一されたアクチュエータ制御モジュール群「Altair Module System」を、ROS2およびブラウザ（PC/スマホ）からシームレスに一括制御・管理するための統合ROS2パッケージです。

ロボット（NUC）側のプログラムを完全に固定したまま、操縦者PC側でモジュール構成の動的変更やプロファイル（アームテスト、足回りのみ等）の瞬時切り替え、PS5コントローラー連携、およびPython/Blocklyによる自律動作プログラムの動的起動・リアルタイムデバッグをサポートします。

---

## 📁 ディレクトリとドキュメントの配置

本リポジトリは、以下のマルチパッケージ構造および専用ドキュメントフォルダで構成されています。

```text
altair_framework/
├── README.md (本ファイル)
├── build.sh ( colcon ビルド用簡単スクリプト)
├── run_nuc.sh (NUCロボット側：CAN自動セットアップ ＆ ブリッジノード起動用)
├── run_operator.sh (操縦PC側：ModuleManager ＆ WebUIサーバー一括起動用)
│
├── docs/ (専用ドキュメントフォルダ)
│   ├── architecture.md (全体アーキテクチャ・状態遷移・データフロー設計書)
│   ├── can_specification.md (モジュール別CAN IDおよび詳細パケット構造仕様書)
│   ├── setup_guide_nuc.md (NUC側udevルール名固定、sudoersパスワード省略設定ガイド)
│   └── behavior_programming_guide.md (AI/人間向け動作プログラムAPI仕様 ＆ プロンプト)
│
├── altair_interfaces/ (カスタムメッセージ・サービス定義パッケージ)
├── altair_can_bridge/ (NUC側：USBポート自動認識・SocketCAN ⇔ ROS2ブリッジ)
├── altair_core/ (操縦PC側：動的トピック生成 ＆ 動作プログラムランナー)
└── altair_web_server/ (操縦PC側：FastAPI Web/WebSocketサーバー ＆ Glassmorphism WebUI)
```

---

## 🛠️ 前提条件 ＆ 導入手順

本パッケージは、**Ubuntu 22.04 + ROS2 Humble** 環境での動作を確認しています。

### 1. 依存パッケージのインストール
物理CANフレームをROS2上で扱うための標準パッケージ `can_msgs` およびビルドツールをインストールします。
```bash
sudo apt update
sudo apt install ros-humble-can-msgs python3-colcon-common-extensions
```

### 2. Python依存ライブラリのインストール (WebUI用)
FastAPI Webサーバーの稼働に必要なライブラリをインストールします。
```bash
pip install fastapi uvicorn websockets
```

### 3. リポジトリのビルド
ワークスペースのトップでビルドスクリプトを実行します。
```bash
# 実行権限の付与 (初回のみ)
chmod +x build.sh run_nuc.sh run_operator.sh
chmod +x altair_can_bridge/scripts/setup_slcan.sh

# ビルドの実行
./build.sh
```

---

## 🚀 起動・運用コマンド

### A. NUCロボット側 (物理接続されているPC)
USB-to-CAN (CANable 2) の自動探索・SocketCAN `can0` インターフェースの1 Mbpsでの自動起動、およびブリッジノードの立ち上げをワンクリックで行います。
```bash
./run_nuc.sh
```
> 💡 物理ポート名の固定化や、パスワード不要でのSocketCAN自動起動、ロボット電源ON時の完全自動起動(systemd)の設定方法は、[docs/setup_guide_nuc.md](docs/setup_guide_nuc.md) を参照してください。

### B. 操縦PC側 (WiFi経由で操作するPC)
モジュールマネージャー、動作プログラムランナー、およびWebUIサーバーノードを一括で起動します。Ctrl+Cを押すとバックグラウンドノードも安全に同時終了します。
```bash
./run_operator.sh
```

起動後、同一WiFiネットワーク内のPCやスマートフォンのブラウザから、以下のURLにアクセスします。
- **URL**: `http://<NUC_の_IP_アドレス>:8000/`

---

## 🎮 WebUI のプレミアム機能

- **Dashboard**: MDD, Servo, Solenoid のモジュールカードが動的に生成され、スライダーやトグルボタンで低遅延の直接操作が可能。Limit SWの状態やエンコーダ実測データもリアルタイムで描画。
- **Profiles**: 「アームテスト用」「足回り用」などのモジュール構成をワンクリックで切り替え。JSONファイルとしてローカルにエクスポート/インポートが可能。
- **Controller**: スマホやPCにBluetooth接続された **PS5コントローラー** 等を自動検出し、アナログ軸（走行用モータ等）やボタン（電磁弁等）への割り当てを設定。
- **Programs**: Pythonで書かれた自律動作スクリプトを選択してWebUI上から「起動/停止」が可能。スクリプト内の `print()` やエラー出力がターミナル風にリアルタイムストリーミングされます。
- **Automation**: Google Blockly CDN を用いて、ブラウザ上でブロックを組み合わせて自動化マクロを簡単に作成・実行。

---

## 🤖 AI (ChatGPT, Claude, Gemini等) を用いた動作プログラムの自動作成

本パッケージでは、AIに動作プログラム（`user_behaviors/` 配下）をバグなく記述させるための専用プロンプト仕様書を用意しています。

1. **[docs/behavior_programming_guide.md](docs/behavior_programming_guide.md)** の中身を丸ごとコピーします。
2. お使いのAIチャットの入力欄に貼り付けます。
3. 同ファイルの最下部にある「AI向けコピペ用指示プロンプトテンプレート」に、自分の動かしたいシナリオ（例：「SW1が押されたらアームを下ろして吸引する...」）を追記してAIに送信します。
4. AIが出力したPythonコードを `altair_core/user_behaviors/` フォルダ内に保存するだけで、即座にWebUIから実行・動作可能になります。

---

## 📄 ライセンス

本プロジェクトは **MIT License** の元で公開されています。詳細は [LICENSE](LICENSE) ファイルを参照してください。
