# Altair Framework 動作プログラム記述仕様書 (behavior_programming_guide.md)

本ドキュメントは、Altair Module System において、人間および **AIアシスタント（ChatGPT, Claude, Gemini等）** がバグのない安全な自律動作プログラム（Pythonスクリプト）を記述するためのAPI完全仕様書です。

AIにコードを書かせる際は、**「このマークダウンファイルの中身をそのままAIのプロンプトに貼り付ける」** ことで、AIがシステムの仕様を100%理解し、完全動作するPython制御プログラムを出力します。

---

## 1. 動作プログラムの基本構造

すべての動作プログラムは、`altair_core` の `base_behavior.py` に実装された **`AltairBehavior`** クラスを継承した単一のPythonクラスとして記述します。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import rclpy
import os

# パスハック
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class MyCustomBehavior(AltairBehavior):
    def on_init(self):
        """起動時の初期化処理（1回だけ実行）"""
        # ここで get_module を使ってモジュールを取得
        self.mdd = self.get_module("drive_mdd")
        self.servo = self.get_module("arm_servo")
        self.valve = self.get_module("valve_controller")

    def loop(self):
        """周期実行処理（デフォルト 20 Hz = 50msごとに実行）"""
        # ここに制御ロジックを記述
        pass

def main(args=None):
    rclpy.init(args=args)
    behavior = MyCustomBehavior("my_behavior_node")
    behavior.run(rate_hz=20.0)

if __name__ == '__main__':
    main()
```

---

## 2. モジュール操作 API 仕様一覧

`self.get_module("名前")` を呼び出すと、設定ファイルに基づいた各モジュール専用のクライアントオブジェクトが返されます。これらは以下のAPIを提供します。

### A. MDDモータドライバ・クライアント (`MddClient`)
4つのDCモータを一括制御・監視するオブジェクトです。

- **`set_targets(targets)`** (送信)
  - 引数 `targets`: 4つのモータの目標値の配列 (float `[m1, m2, m3, m4]`)。
  - **目標値の解釈 (制御モードによる)**:
    - 速度モード: `rps` (回転毎秒)
    - 角度モード: `degree` (度)
    - 位置モード: `mm` (ミリメートル)
- **`get_feedback()`** (受信)
  - 返り値の型: `MddFeedback` オブジェクト。
  - 提供される属性:
    - **`.limit_switches`**: `bool[4]` 配列。各Limitスイッチの状態 (True=ON/押されている, False=OFF)。
    - **`.angles`**: `float32[4]` 配列。各モータの現在角度 `[degree]`。
    - **`.speeds`**: `float32[4]` 配列。各モータの現在回転速度 `[rps]`。
    - **`.error_code`**: `uint8`。システムエラーコード (0=正常, 1=初期化タイムアウト, 2=CAN受信タイムアウト, 4=送信失敗)。
    - **`.system_status`**: `uint8`。動作モード状態 (0=パラメータ設定中, 1=制御中)。

### B. サーボモータ・クライアント (`ServoClient`)
最大6つのPWMサーボの角度を一括指定するオブジェクトです。

- **`set_angles(angles)`** (送信)
  - 引数 `angles`: 6ch分の目標角度の配列 (uint8 `[s1, s2, s3, s4, s5, s6]`)。
  - 設定可能範囲: `0` 〜 `180` 度。
  - (※ 180を超える値はマイコン側で180に自動でクリップされます)

### C. 電磁弁クライアント (`SolenoidClient`)
最大12チャネルの電磁弁(ソレノイド)をON/OFF制御するオブジェクトです。

- **`set_valves(valves)`** (一括送信)
  - 引数 `valves`: 12チャネルのON/OFF状態の配列 (bool `[v1, v2, ..., v12]`)。
- **`set_valve(channel, state)`** (個別送信)
  - 引数 `channel`: 設定するチャネル番号 (`1` 〜 `12`)。
  - 引数 `state`: `True` (ON/開く) または `False` (OFF/閉じる)。

---

## 3. ノンブロッキング・ステートマシン記述の厳守

ROS2は非同期通信をバックグラウンドで処理しています。そのため、動作プログラム内で `time.sleep(3.0)` のような **スレッドブロッキング（停止）関数を実行すると、トピックの送受信がすべて停止し、モータが暴走する原因** になります。

一定時間の遅延や待機をプログラムに組み込む場合は、必ず `time.time()` を用いた **「ノンブロッキングなステートマシン（状態遷移モデル）」** で記述してください。

### ❌ 悪い例（トピック送受信がフリーズする）
```python
def loop(self):
    self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
    time.sleep(3.0) # 絶対にNG！ループ全体がフリーズします
    self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
```

### ⭕ 正しい例（通信ループを妨げないノンブロッキング記述）
```python
def on_init(self):
    self.mdd = self.get_module("drive_mdd")
    self.state = "START"
    self.timer = 0.0

def loop(self):
    if self.state == "START":
        self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
        self.timer = time.time()  # 時刻を記録
        self.state = "WAITING"
        
    elif self.state == "WAITING":
        # 3秒経過したかをノンブロッキングで判定
        if time.time() - self.timer >= 3.0:
            self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
            self.state = "FINISHED"
```

---

## 🤖 AI向けコピペ用指示プロンプトテンプレート

AIにプログラムを記述させる際は、本ファイルをコピーしてAIに送信した後、以下のテンプレートを貼り付けて指示を出してください。

```text
【現在のシステム構成】
現在、システムは以下のモジュール構成です：
- MDDモータドライバ: 名前 "drive_mdd"
- Servoサーボモジュール: 名前 "arm_servo"
- Solenoid電磁弁モジュール: 名前 "valve_controller"

【記述したいシナリオ】
以下を実行する動作プログラムのコードを作成してください：
1. 最初に drive_mdd のモータ1〜4をすべて 1.5 rps で回転させて前進させます。
2. drive_mdd の Limitスイッチ1 (SW1) が押されたら、モータをすべて停止（0.0）します。
3. 停止後、arm_servo の サーボ1を 120度、サーボ2を 45度にしてアームを下降させます。
4. 下降完了と同時に valve_controller の 1ch と 2ch の電磁弁を ON にして吸引を開始します。
5. 吸引開始から 2秒間待機（※ノンブロッキングで実装すること）します。
6. 2秒後、arm_servo をホームポジション（すべて 90度）に上昇させ、吸引を維持したままプログラムを正常終了 (rclpy.shutdown) します。

これまでに共有した『動作プログラム記述仕様書 (behavior_programming_guide.md)』の仕様を厳格に守り、バグのないPythonコードを出力してください。
```
