# Altair Framework 動作プログラム記述仕様書

本ドキュメントは、Altair Module System において、人間やAIアシスタントがバグのない安全な自律動作プログラム（Pythonスクリプト）や外部連携ノードを記述するための API 仕様書です。

AIへコードの記述を指示する際は、このファイルの内容をそのままAIのプロンプトに貼り付けることで、システムの仕様を理解して動作するPython制御プログラムを作成させることができます。

---

## 動作プログラムの基本構造

すべての動作プログラムは、[`altair_core/altair_core/base_behavior.py`](file:///home/altair/altair_framework/altair_core/altair_core/base_behavior.py) に実装された `AltairBehavior` クラスを継承した単一のPythonクラスとして記述し、リポジトリルートの **`user_behaviors/`** ディレクトリに配置します。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import rclpy

# パスを設定します
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "altair_core"))
from altair_core.base_behavior import AltairBehavior

class MyCustomBehavior(AltairBehavior):
    def on_init(self):
        """起動時に一度だけ実行する初期化処理です。"""
        # get_moduleを使用してモジュールを取得します
        self.mdd = self.get_module("MDD1")
        self.servo = self.get_module("Servo1")
        self.valve = self.get_module("Solenoid1")

        # 初期ステートの設定
        self.set_state("START")

    def loop(self):
        """デフォルトで10ミリ秒 (100Hz) ごとに周期実行する処理です。"""
        pass

def main(args=None):
    rclpy.init(args=args)
    behavior = MyCustomBehavior("my_behavior_node")
    behavior.run(rate_hz=100.0)

if __name__ == '__main__':
    main()
```

---

## モジュール・足回り操作 API の仕様一覧

### 1. 足回り運動学・ステートマシン補助 API (`AltairBehavior` 組込メソッド)

※ 自己位置推定は外部ノードで行う設計のため、`AltairBehavior` は足回りの速度指令とステートマシン管理を提供します。

* `self.set_chassis_velocity(vx_mm_s, vy_mm_s, omega_rad_s)`
  * `modules_config.json` の `"chassis"` 設定（`3_OMNI`, `4_OMNI`, `4_MECANUM`, `2_DIFF`）に基づいて逆運動学計算を行い、走行用 MDD モジュールへ4輪の目標 `rps` を送信します。
  * `vx_mm_s`: 左右速度 [mm/s]（正 = 右移動、負 = 左移動）
  * `vy_mm_s`: 前後速度 [mm/s]（正 = 前進、負 = 後退）
  * `omega_rad_s`: 旋回角速度 [rad/s]（正 = 反時計回り / 左旋回）
* `self.stop_chassis()`
  * 足回りの全モータを即座に `0.0 rps` で停止します。
* `self.chassis.publish_cmd_vel(linear_x_m_s, linear_y_m_s, angular_z_rad_s)`
  * ROS 2 標準の `/altair/cmd_vel` (`geometry_msgs/msg/Twist`) トピックへ速度指令を配信します。
* `self.set_state(new_state: str)`
  * `self.state` を新しい状態名へ遷移させ、状態滞在タイマーを `0.0` 秒にリセットします。
* `self.elapsed_in_state() -> float`
  * 現在の `self.state` に遷移してからの経過秒数を返します。`time.sleep()` を使わずに秒数待機を行う際に使用します。
* `self.gamepad.get_axis(index: int) -> float` / `self.gamepad.get_button(index: int) -> bool`
  * `/altair/joy` (`sensor_msgs/msg/Joy`) または WebUI ゲームパッドの入力を取得します。

### 2. MDD モータドライバクライアント (`MddClient`)

4つのDCモータを一括で制御または監視するオブジェクトです。

* `set_targets(targets)`
  * 引数の `targets` には、4つのモータの目標値 `[m1, m2, m3, m4]` を配列で指定します。
  * 目標値は制御モードによって以下のように解釈されます：
    * 速度モード (`mode: 0`)：秒間回転数 (`rps`)
    * 角度モード (`mode: 1`)：度 (`deg`)
    * 位置モード (`mode: 2`)：ミリメートル (`mm`)
* `stop()`
  * 4チャンネルすべてに `[0.0, 0.0, 0.0, 0.0]` を送信します。
* `get_feedback() -> MddFeedback`
  * 最新の `MddFeedback` オブジェクトを返します：
    * `limit_switches`: 各リミットスイッチの状態を示す真偽値の配列 (`bool[4]`)。押下時は `True`。
    * `angles`: 各モータの現在角度 (`float32[4]`, 単位: `deg`)。
    * `speeds`: 各モータの現在回転速度 (`float32[4]`, 単位: `rps`)。
    * `error_code`: エラーコード（`0`=正常, `1`=初期化タイムアウト, `2`=CAN受信タイムアウト, `4`=送信失敗）。
    * `system_status`: 動作モード（`0`=パラメータ設定待ち, `1`=制御実行中）。

### 3. サーボモータクライアント (`ServoClient`)

最大6つのPWMサーボの角度を指定するオブジェクトです。

* `set_angles(angles)`: 6チャンネル分の目標角度 `[s1, s2, s3, s4, s5, s6]`（`0`〜`180`度）を一括指定します。
* `set_angle(channel, angle)`: 特定のチャンネル（`1`〜`6`）の角度のみを個別に変更します。

### 4. 電磁弁クライアント (`SolenoidClient`)

最大12チャンネルの電磁弁を一括または個別に制御するオブジェクトです。

* `set_valves(valves)`: 12チャンネルの動作状態を真偽値の配列（`bool[12]`）で一括指定します。
* `set_valve(channel, state)`: 特定のチャンネル（`1`〜`12`）を個別に制御します（`True`=開く/ON, `False`=閉じる/OFF）。

---

## ノンブロッキングステートマシン記述の厳守

ROS 2 は非同期通信をバックグラウンドで処理しています。動作プログラム内で `time.sleep(3.0)` のようなスレッド停止関数を実行すると、通信の送受信が停止する原因になります。
待機処理を組み込む場合は、組込の `self.set_state()` と `self.elapsed_in_state()` を使用して記述してください。

### 正しい記述例

```python
def on_init(self):
    self.mdd = self.get_module("MDD1")
    self.servo = self.get_module("Servo1")
    self.set_state("DRIVE_UNTIL_SWITCH")

def loop(self):
    fb = self.mdd.get_feedback()

    if self.state == "DRIVE_UNTIL_SWITCH":
        self.set_chassis_velocity(0.0, 500.0, 0.0)  # 500 mm/s で前進
        if fb.limit_switches[0]:
            self.stop_chassis()
            self.servo.set_angle(1, 120)
            self.set_state("WAIT_GRAB")

    elif self.state == "WAIT_GRAB":
        if self.elapsed_in_state() >= 2.0:  # ノンブロッキングで2秒待機
            self.servo.set_angle(1, 90)
            self.set_state("FINISHED")
```

---

## ファイル配置と実行方法

すべての動作プログラムは、リポジトリルートの **`user_behaviors/`** ディレクトリに `.py` ファイルとして保存してください。サーバーを再起動することなく、WebUI の **Programs** タブのドロップダウンリストに自動検出されます。
