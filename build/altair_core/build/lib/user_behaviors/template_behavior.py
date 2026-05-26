#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - 動作プログラム テンプレート
このファイルをコピーして新しい動作ロジック（ROS2ノード）を作成してください。
"""

import sys
import rclpy
# 親ディレクトリからインポート可能にするためのハック (ROS2で直接起動した際用)
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from altair_core.base_behavior import AltairBehavior

class TemplateBehavior(AltairBehavior):
    def on_init(self):
        """
        [初期化フェーズ]
        ノード起動時に1回だけ呼び出されます。
        使用する各アクチュエータモジュールのクライアントオブジェクトをここで設定・取得します。
        """
        # get_module には modules_config.json に定義した「name」を指定します。
        # 例：
        # self.mdd = self.get_module("drive_mdd")
        # self.servo = self.get_module("arm_servo")
        # self.solenoid = self.get_module("valve_controller")
        
        self.get_logger().info("TemplateBehavior が初期化されました。")

    def loop(self):
        """
        [周期実行フェーズ]
        一定周期 (デフォルト 20 Hz = 50ms 周期) で繰り返し呼び出されます。
        センサー（Limit SW、エンコーダ）のフィードバックを参照し、アクチュエータへ目標値を指示するロジックをここに記述します。
        """
        try:
            # 1. センサー情報の取得例 (MDDモータ)
            # mdd_feedback = self.mdd.get_feedback()
            # print(f"Limit SW: {mdd_feedback.limit_switches}")
            # print(f"Motor Angles: {mdd_feedback.angles}")

            # 2. 条件分岐 ＆ アクチュエータ制御例
            # if mdd_feedback.limit_switches[0]:  # SW1が押されたら
            #     self.mdd.set_targets([0.0, 0.0, 0.0, 0.0]) # モーター停止
            #     self.solenoid.set_valve(channel=1, state=True) # 電磁弁1を開く
            # else:
            #     self.mdd.set_targets([2.0, 2.0, 2.0, 2.0]) # 速度2.0 rpsで回転
            
            # デバッグログの出力
            # print("Loop executed successfully")
            pass

        except Exception as e:
            self.get_logger().error(f"ループ実行中にエラーが発生しました: {str(e)}")

def main(args=None):
    rclpy.init(args=args)
    
    # 動作プログラムインスタンスを作成
    behavior = TemplateBehavior("my_custom_behavior")
    
    # 周期ループを開始 (20 Hz = 50ms 周期)
    behavior.run(rate_hz=20.0)
    
    # 終了処理は自動で行われます

if __name__ == '__main__':
    main()
