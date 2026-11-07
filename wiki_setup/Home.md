**Altair Framework** は、CANバス（1 Mbps）で統一されたアクチュエータ制御モジュール群を、ROS 2 およびブラウザからシームレスに一括制御・管理するための統合 ROS 2 パッケージです。

「モジュールマイコンとの通信の簡便化」と「フォークして改造・拡張しやすい疎結合設計」を基本方針としています。

---

## クイックスタート

### セットアップ
- **[NUCセットアップガイド](NUC-Setup-Guide)** - NUCロボット側の初期設定

### ビルドと起動
```bash
./build.sh                  # ビルド実行
./run_standalone.sh         # 単一PC運用 (Ethernet-CAN / 推奨)
./run_standalone.sh --sim   # 実機レス・仮想CANシミュレータモード (開発・デバッグ用)
```

2台PC運用時：
```bash
./run_nuc.sh        # NUC側の起動 (--sim / --usb オプション可)
./run_operator.sh   # 操縦PC側の起動
```

起動後、ブラウザから `http://<ロボットPCのIP>:8000/` にアクセスしてWebUIを利用できます。

---

## ドキュメント

### 設計・仕様
- **[アーキテクチャ設計書](Architecture)** - システム全体の構成、プラグイン構造、Cmd Mux、データフロー
- **[CAN仕様書](CAN-Specification)** - CANバスメッセージフォーマットと制御仕様
- **[ロボット運動学ガイド](Kinematics-Guide)** - 各種駆動系のキネマティクスと `/altair/cmd_vel` 連携

### プログラミング・改造
- **[動作プログラム作成ガイド](Behavior-Programming-Guide)** - 自律動作プログラムのAPI仕様・ステートマシン記述法

---

## 主な特徴

- **外部ノード（自己位置推定・自律移動）との高い親和性** - `/altair/<mdd>/feedback` から100Hzでエンコーダ角度・速度を取得でき、外部から `/altair/cmd_vel` (`geometry_msgs/Twist`) や `/altair/joy` (`sensor_msgs/Joy`) で簡単に連携可能
- **モジュールプラグイン方式** - `altair_core/altair_core/modules/` に1ファイル追加するだけで新しい CAN マイコン基板を拡張可能
- **実機レス `--sim` モード** - ハードウェアがなくても仮想 CAN マイコンが応答し、PC 1台で WebUI や動作スクリプトをテスト可能
- **WebUIダッシュボード & Blockly自動化** - スマートフォン・PC上から直感的に操作・自動化マクロ作成が可能

---

## 関連リンク

- **GitHub**: [Altairu/altair_framework](https://github.com/Altairu/altair_framework)
- **ライセンス**: MIT License
