本ドキュメントは、Altair Module System において、人間や AI アシスタントがバグのない安全な自律動作プログラムとして動作する Python スクリプトを記述するための API 仕様書です。

AI へコードの記述を指示する際は、このファイルの内容をそのまま AI のプロンプトに貼り付けることで、システムの仕様を理解して動作する Python 制御プログラムを作成させることができます。

---

## 基本構造

すべての動作プログラムは、`altair_core` の `base_behavior.py` に実装された `AltairBehavior` クラスを継承した単一の Python クラスとして記述します。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import rclpy
import os

# パスを設定します
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class MyCustomBehavior(AltairBehavior):
    def on_init(self):
        """起動時に一度だけ実行する初期化処理です。"""
        self.mdd = self.get_module("drive_mdd")
        self.servo = self.get_module("arm_servo")
        self.valve = self.get_module("valve_controller")

    def loop(self):
        """デフォルトで100Hzで周期実行する処理です。"""
        # 制御ロジックを記述します
        pass

def main(args=None):
    rclpy.init(args=args)
    behavior = MyCustomBehavior("my_behavior_node")
    behavior.run(rate_hz=100.0)

if __name__ == '__main__':
    main()
```

---

## モジュール操作 API

`self.get_module()` を呼び出すと、設定ファイルに基づいた各モジュール専用のクライアントオブジェクトが返されます。

### MDDモータドライバ

4つの DC モータを一括で制御または監視するオブジェクトです。クラス名は `MddClient` です。

#### メソッド

- **set_targets(targets)** - モータの目標値を設定
  - 引数: 4つのモータの目標値を配列で指定
  - 解釈: 制御モードにより解釈が異なります
    - 速度モード: 秒間回転数 (rps)
    - 角度モード: 度 (deg)
    - 位置モード: ミリメートル (mm)

- **get_feedback()** - モータの状態を取得
  - 戻り値: `MddFeedback` オブジェクト
  - 属性:
    - `limit_switches`: 各リミットスイッチの状態 (配列)
    - `angles`: 各モータの現在角度 (度)
    - `speeds`: 各モータの現在速度 (rps)
    - `error_code`: システムのエラーコード
    - `system_status`: 動作モード (0=設定中、1=制御中)

---

### サーボモータ

最大 6 つの PWM サーボの角度を制御するオブジェクトです。クラス名は `ServoClient` です。

#### メソッド

- **set_angles(angles)** - サーボ角度を設定
  - 引数: 6チャンネル分の目標角度を配列で指定 (0～180度)
  - 注意: 180度を超える値は自動的に 180 度に調整されます

---

### 電磁弁

最大 12 チャンネルの電磁弁を制御するオブジェクトです。クラス名は `SolenoidClient` です。

#### メソッド

- **set_valves(valves)** - 複数チャンネルを一括制御
  - 引数: 12チャンネルの動作状態を真偽値の配列で指定

- **set_valve(channel, state)** - 特定チャンネルを個別制御
  - 第1引数: チャンネル番号 (1～12)
  - 第2引数: True=開く、False=閉じる

---

## ノンブロッキング実装の重要性

ROS2 は非同期通信をバックグラウンドで処理しています。`time.sleep()` を使用するとループ全体がフリーズし、通信が停止してモータが暴走する原因になります。

### 悪い例

```python
def loop(self):
    self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
    time.sleep(3.0)  # NG: ループがフリーズ
    self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
```

### 正しい例

```python
def on_init(self):
    self.mdd = self.get_module("drive_mdd")
    self.state = "START"
    self.timer = 0.0

def loop(self):
    if self.state == "START":
        self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])
        self.timer = time.time()
        self.state = "WAITING"
        
    elif self.state == "WAITING":
        if time.time() - self.timer >= 3.0:
            self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
            self.state = "FINISHED"
```

---

## ファイル配置と実行

### 保存場所

すべての動作プログラムは `user_behaviors/` ディレクトリに `.py` ファイルとして保存してください。

```text
altair_framework/
├── user_behaviors/
│   ├── blockly_behavior.py
│   ├── my_custom_behavior.py
│   └── another_program.py
└── ...
```

### WebUI から実行

1. Web UI の「Python Program」タブを開く
2. ドロップダウンメニューから対象ファイルを選択
3. 「起動」ボタンをクリック

**注意**: サーバー再起動不要です。ファイルの追加・削除は自動検出されます。

---

## AI プロンプトテンプレート

本ファイルの内容を AI に送信した後、以下のテンプレートを貼り付けてください。

```text
現在のシステム構成は以下の通りです。
* MDDモータドライバの名前は drive_mdd です。
* サーボモジュールの名前は arm_servo です。
* 電磁弁モジュールの名前は valve_controller です。

以下の動作を行うプログラムを作成してください。
* 最初に drive_mdd のモータをすべて 1.5 rps で回転させて前進させます。
* drive_mdd のリミットスイッチの1番が押されたら、すべてのモータを停止します。
* 停止した後に、arm_servo のサーボの1番を120度、2番を45度にしてアームを下降させます。
* 下降した直後に、valve_controller の1番と2番の電磁弁を開いて吸引を開始します。
* 吸引を開始してから2秒間待機します。待機処理はノンブロッキングで実装してください。
* 2秒が経過した後に、arm_servo のサーボをすべて90度にしてホームポジションへ上昇させます。吸引は維持したままプログラムを正常に終了してください。

動作プログラム記述仕様書に従い、プログラムを作成してください。
```

---

## 関連リンク

- [ホーム](Home)
- [アーキテクチャ設計書](Architecture)
- [CAN仕様書](CAN-Specification)
