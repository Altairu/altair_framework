#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - 動作プログラム テンプレート
このファイルをコピーして新しい動作ロジック（ROS2ノード）を作成してください。
"""

import os
import sys
import rclpy

sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "altair_core"))
from altair_core.base_behavior import AltairBehavior


class TemplateBehavior(AltairBehavior):
    def on_init(self):
        """
        [初期化フェーズ]
        ノード起動時に1回だけ呼び出されます。
        使用する各アクチュエータモジュールのクライアントオブジェクトをここで取得します。
        """
        # get_module には modules_config.json に定義した「name」を指定します。
        # self.mdd = self.get_module("MDD1")
        # self.servo = self.get_module("Servo1")
        # self.solenoid = self.get_module("Solenoid1")

        # ステートマシンの初期状態を設定
        self.set_state("DRIVE_FORWARD")
        self.get_logger().info("TemplateBehavior が初期化されました。")

    def loop(self):
        """
        [周期実行フェーズ]
        デフォルト 100 Hz (10ms周期) で繰り返し呼び出されます。
        time.sleep() は使用せず、self.set_state() と self.elapsed_in_state() で記述します。
        """
        try:
            # --- ステートマシン記述例 ---
            # if self.state == "DRIVE_FORWARD":
            #     # 足回りヘルパーで前進 (vx=0 mm/s, vy=500 mm/s, omega=0 rad/s)
            #     self.set_chassis_velocity(0.0, 500.0, 0.0)
            #     if self.elapsed_in_state() >= 2.0:
            #         self.stop_chassis()
            #         self.set_state("DONE")
            #
            # elif self.state == "DONE":
            #     pass
            pass

        except Exception as e:
            self.get_logger().error(f"ループ実行中にエラーが発生しました: {str(e)}")


def main(args=None):
    rclpy.init(args=args)
    behavior = TemplateBehavior("my_custom_behavior")
    behavior.run(rate_hz=100.0)


if __name__ == '__main__':
    main()
