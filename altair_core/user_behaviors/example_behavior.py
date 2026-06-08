#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - ピック＆プレース動作サンプル
モータ（MDD）、サーボ（Servo）、電磁弁（Solenoid）の3種をセンサーフィードバックを用いて協調制御します。

【シナリオ】
1. 初期状態: 全モータを正転 (1.0 rps) させて走行開始。
2. 検出: 進行方向のリミットスイッチ (SW1) が押されたら、即座にモータを停止。
3. 吸引開始: アームサーボを下ろし（角度を変化）、電磁弁1を開いてワークを吸引。
4. 退避: 3秒間吸引を維持した後、アームサーボを上げて安全位置へ戻し、電磁弁を閉じて終了。
"""

import sys
import rclpy
import os
import time

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class PickAndPlaceBehavior(AltairBehavior):
    def on_init(self):
        # 1. 各モジュールの取得
        # (modules_config.json の "name" と一致させます)
        self.mdd = self.get_module("drive_mdd")
        self.servo = self.get_module("arm_servo")
        self.valve = self.get_module("valve_controller")

        # 2. 状態遷移用ステートの定義
        self.STATE_DRIVING = "DRIVING"
        self.STATE_STOPPED = "STOPPED"
        self.STATE_ARM_DOWN = "ARM_DOWN"
        self.STATE_RETRACT = "RETRACT"
        self.STATE_FINISHED = "FINISHED"
        
        self.current_state = self.STATE_DRIVING
        self.state_timer = 0.0 # 簡易タイマー用

        self.get_logger().info("★★★ サンプル動作プログラム (Pick & Place) が起動しました。 ★★★")
        self.get_logger().info("初期状態: 走行開始 (モータ正転 1.0 rps)")

        # 初期状態でサーボをホームポジション(全軸 90度)に設定、電磁弁はすべてOFF
        self.servo.set_angles([90, 90, 90, 90, 90, 90])
        self.valve.set_valves([False] * 12)

    def loop(self):
        """
        100 Hzで動作するメインループ。10ミリ秒周期です。
        ROS2の通信スレッドをブロッキング（time.sleep等）させないよう、ノンブロッキングなステートマシンで記述します。
        """
        try:
            # MDDのフィードバックを取得
            mdd_feedback = self.mdd.get_feedback()
            
            # --- 状態遷移 (State Machine) ---
            
            if self.current_state == self.STATE_DRIVING:
                # 走行中: モータ 1〜4 を 1.0 rps で正転させる
                self.mdd.set_targets([1.0, 1.0, 1.0, 1.0])

                # リミットスイッチ1 (SW1) が押されたら、停止ステートへ遷移
                if mdd_feedback.limit_switches[0]:
                    self.get_logger().info("[DETECT] Limit SW1 を検知しました！走行を停止し、アーム動作に移行します。")
                    # 即座にモータ停止指令
                    self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
                    
                    self.current_state = self.STATE_ARM_DOWN
                    self.state_timer = time.time()  # ステート遷移時刻を記録

            elif self.current_state == self.STATE_ARM_DOWN:
                # 走行停止 ＆ アーム下降: サーボ1を45度、サーボ2を120度に設定して下降させる
                self.servo.set_angles([45, 120, 90, 90, 90, 90])
                
                # 同時に、電磁弁の1chをONにして吸引を開始
                self.valve.set_valve(channel=1, state=True)

                # アームが下がりきって吸引が安定するまで3秒間待つ (時間監視)
                elapsed_time = time.time() - self.state_timer
                if elapsed_time >= 3.0:
                    self.get_logger().info("[ACTION] 3秒間経過。アームを安全位置へ退避します。")
                    self.current_state = self.STATE_RETRACT
                    self.state_timer = time.time()

            elif self.current_state == self.STATE_RETRACT:
                # アーム上昇: サーボをすべてホームポジション(90度)に戻す
                self.servo.set_angles([90, 90, 90, 90, 90, 90])

                # 2秒かけてアームを戻す
                elapsed_time = time.time() - self.state_timer
                if elapsed_time >= 2.0:
                    self.get_logger().info("[ACTION] アームの安全退避完了。吸引を終了し、プログラムを終了します。")
                    
                    # 電磁弁をすべてOFFにして吸引を解除
                    self.valve.set_valves([False] * 12)
                    
                    self.current_state = self.STATE_FINISHED

            elif self.current_state == self.STATE_FINISHED:
                # 終了状態: 安全にすべての指示値を0にし、スピンを終了させる
                self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])
                self.get_logger().info("★★★ 動作完了！ノードを安全にシャットダウンします。 ★★★")
                
                # 自立シャットダウン要求
                rclpy.shutdown()

        except Exception as e:
            self.get_logger().error(f"ループ内で例外が発生しました: {str(e)}")

def main(args=None):
    rclpy.init(args=args)
    behavior = PickAndPlaceBehavior("example_behavior_node")
    behavior.run(rate_hz=100.0)

if __name__ == '__main__':
    main()
