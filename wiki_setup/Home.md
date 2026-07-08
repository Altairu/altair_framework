**Altair Framework** は、CANバス（1 Mbps）で統一されたアクチュエータ制御モジュール群を、ROS2およびブラウザからシームレスに一括制御・管理するための統合ROS2パッケージです。

---

## クイックスタート

### セットアップ
- **[NUCセットアップガイド](NUC-Setup-Guide)** - NUCロボット側の初期設定

### ビルドと起動
```bash
./build.sh          # ビルド実行
./run_nuc.sh        # NUC側の起動
./run_operator.sh   # 操縦PC側の起動
```

起動後、ブラウザから `http://<NUC IP>:8000/` にアクセスしてWebUIを利用できます。

---

## ドキュメント

### 設計・仕様
- **[アーキテクチャ設計書](Architecture)** - システム全体の構成とデータフロー
- **[CAN仕様書](CAN-Specification)** - CANバスメッセージフォーマットと制御仕様
- **[ロボット運動学ガイド](Kinematics-Guide)** - 各種駆動系のキネマティクス

### プログラミング
- **[動作プログラム作成ガイド](Behavior-Programming-Guide)** - 自律動作プログラムのAPI仕様とAIプロンプト

---

## 主な特徴

- **ロボット側の完全固定化** - NUCのコード変更不要、操縦PC側で動的に制御構成を変更
- **WebUIダッシュボード** - スマートフォン・PC上から直感的に操作
- **Pythonプログラム動的実行** - `user_behaviors/` に追加するだけで自動検出・実行
- **Blockly自動化** - ビジュアルプログラミングで複雑なシーケンスを構築
- **リアルタイムデバッグ** - コンソール出力やログをリアルタイム表示

---

## 関連リンク

- **GitHub**: [Altairu/altair_framework](https://github.com/Altairu/altair_framework)
- **ライセンス**: MIT License
