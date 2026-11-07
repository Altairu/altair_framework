import json
import os
import struct
import time
from pathlib import Path
from typing import Dict

import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from std_srvs.srv import Trigger

# ROS2 標準 ＆ カスタムメッセージ
from std_msgs.msg import Bool, String
from geometry_msgs.msg import Twist
from can_msgs.msg import Frame
from altair_interfaces.srv import TriggerControl

from altair_core.paths import get_config_path
from altair_core.kinematics import ChassisKinematics
from altair_core.modules import BaseModulePlugin, discover_module_plugins, get_module_plugin_class
from altair_core.modules.mdd_module import MddModulePlugin


class ModuleManager(Node):
    def __init__(self):
        super().__init__('module_manager')
        self.callback_group = ReentrantCallbackGroup()

        # パブリッシャ: CAN送信用のトピック
        self.can_tx_pub = self.create_publisher(Frame, '/altair/can/tx', 100)

        # パブリッシャ: Web UIコンソールへのシステムログ通知用
        self.behavior_log_pub = self.create_publisher(String, '/altair/behavior/log', 50)

        # サブスクライバ: NUC/ブリッジからのCAN受信用のトピック
        self.can_rx_sub = self.create_subscription(
            Frame, '/altair/can/rx', self.handle_can_rx_callback, 100,
            callback_group=self.callback_group
        )

        # サブスクライバ: 構成ファイル同期用トピック
        self.config_sync_sub = self.create_subscription(
            String, '/altair/config_sync', self.handle_config_sync_callback, 10,
            callback_group=self.callback_group
        )

        # サブスクライバ: 外部操縦・自律移動用 /altair/cmd_vel および /cmd_vel (geometry_msgs/Twist)
        self.altair_cmd_vel_sub = self.create_subscription(
            Twist, '/altair/cmd_vel', self.handle_cmd_vel_callback, 10,
            callback_group=self.callback_group
        )
        self.std_cmd_vel_sub = self.create_subscription(
            Twist, '/cmd_vel', self.handle_cmd_vel_callback, 10,
            callback_group=self.callback_group
        )

        # サブスクライバ: 緊急停止用トピック (/altair/emergency_stop)
        self.estop_sub = self.create_subscription(
            Bool, '/altair/emergency_stop', self.handle_emergency_stop_callback, 10,
            callback_group=self.callback_group
        )

        # サービスサーバー: パラメータ送信トリガー
        self.trigger_srv = self.create_service(
            TriggerControl, '/altair/start_control', self.handle_start_control_service,
            callback_group=self.callback_group
        )

        # サービスサーバー: 設定ファイルリロードトリガー
        self.reload_srv = self.create_service(
            Trigger, '/altair/reload_config', self.handle_reload_config_service,
            callback_group=self.callback_group
        )

        # 動的生成したパブリッシャ/サブスクライバおよびモジュールプラグインインスタンスの保持
        self.publishers_dict = {}
        self.subscriptions_dict = {}
        self.module_plugins: Dict[str, BaseModulePlugin] = {}

        # 互換性維持およびMDDパラメータ確認用のキャッシュ辞書
        self.mdd_feedback_cache = {}
        self.mdd_param_confirmed = {}
        self.mdd_param_sent_at = {}
        self.mdd_targets = {}
        self.servo_angles = {}
        self.solenoid_valves = {}

        # 制御システムの状態 (False = パラメータ送信待ち, True = 制御実行中)
        self.is_running = False
        self.is_sending_params = False
        self.control_start_monotonic = 0.0
        self.emergency_stopped = False

        # Cmd Mux (優先度調停・ウォッチドッグ) 用状態
        self.config = {"modules": []}
        self.kinematics = ChassisKinematics(self.config)
        self.last_cmd_vel_time = 0.0
        self.cmd_vel_active = False
        self.cmd_vel_timeout_sec = 0.5
        self.manual_override_window_sec = 0.5

        # プラグインの自動検出と設定ロード
        discover_module_plugins()
        self.load_config_and_initialize()

        # 10ms周期のCANコマンド送信タイマー (100Hz: マイコンの制御周期およびEthernet-CANの1msポーリングに適合)
        self.control_timer = self.create_timer(
            0.01, self.publish_all_control_commands,
            callback_group=self.callback_group
        )

        self.get_logger().info("Module Manager ノードが起動しました (プラグイン・/cmd_vel・CmdMux対応)。")

    def publish_ui_log(self, text: str):
        msg = String()
        msg.data = text
        self.behavior_log_pub.publish(msg)

    def load_config_and_initialize(self):
        """
        modules_config.json をロードし、モジュールプラグインおよび動的トピックを構築する
        """
        for plugin in self.module_plugins.values():
            plugin.destroy_ros_interfaces()
        self.module_plugins.clear()
        self.publishers_dict.clear()
        self.subscriptions_dict.clear()
        self.mdd_feedback_cache.clear()
        self.mdd_param_confirmed.clear()
        self.mdd_param_sent_at.clear()

        config_path = self.get_config_path()
        self.get_logger().info(f"設定ファイルをロード中: {config_path}")

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)
        except Exception as e:
            self.get_logger().error(f"設定ファイルの読み込みに失敗しました: {str(e)}")
            return

        # 運動学計算器の初期化
        self.kinematics = ChassisKinematics(self.config)
        chassis_cfg = self.config.get("chassis", {})
        self.cmd_vel_timeout_sec = float(chassis_cfg.get("cmd_vel_timeout_sec", 0.5))

        # 各モジュールをプラグインレジストリから生成・初期化
        for module_cfg in self.config.get('modules', []):
            name = module_cfg['name']
            mtype = module_cfg['type']
            base_id = int(str(module_cfg['base_id']), 16)

            plugin_cls = get_module_plugin_class(mtype)
            if plugin_cls is None:
                self.get_logger().error(f"未登録のモジュールタイプです: '{mtype}' (モジュール名: {name})")
                continue

            plugin = plugin_cls(self, module_cfg)
            plugin.setup_ros_interfaces()
            self.module_plugins[name] = plugin
            self.get_logger().info(f"モジュールプラグインを登録: {name} (タイプ: {mtype}, BaseID: {hex(base_id)})")

    def get_config_path(self):
        """モジュール構成ファイルの絶対パスを探索して返す"""
        return get_config_path()

    # --- 1. 外部速度指令 (/altair/cmd_vel, /cmd_vel) & 緊急停止コールバック ---
    def handle_emergency_stop_callback(self, msg: Bool):
        self.emergency_stopped = bool(msg.data)
        if self.emergency_stopped:
            self.is_running = False
            for plugin in self.module_plugins.values():
                if isinstance(plugin, MddModulePlugin):
                    plugin.set_targets_direct([0.0, 0.0, 0.0, 0.0])
            self.get_logger().warn("[E-STOP] 緊急停止信号を受信しました。全MDD出力を即時停止しました。")
            self.publish_ui_log("[E-STOP] 緊急停止信号を受信しました。")
        else:
            self.get_logger().info("[E-STOP] 緊急停止が解除されました。再開するには /altair/start_control を呼んでください。")

    def handle_cmd_vel_callback(self, msg: Twist):
        """
        外部の操縦ノードや自律移動ノードからの Twist 指令を逆運動学変換し、
        手動操作 (直接 /cmd) と競合しない場合に対象MDDへ反映する (Cmd Mux)。
        """
        target_mdd_name = self.kinematics.drive_module_name
        plugin = self.module_plugins.get(target_mdd_name)
        if not isinstance(plugin, MddModulePlugin):
            return

        now = time.monotonic()
        # 手動/直接指令が直近 (0.5秒以内) に来ており、それが cmd_vel 由来でない場合は手動優先
        if not self.cmd_vel_active and (now - plugin.last_cmd_time) < self.manual_override_window_sec:
            return

        wheel_rps = self.kinematics.compute_from_ros_twist(
            msg.linear.x, msg.linear.y, msg.angular.z
        )
        plugin.set_targets_direct(wheel_rps)
        self.last_cmd_vel_time = now
        self.cmd_vel_active = True

    # --- 2. 10ms周期 CANコマンド一括送信タイマー (100Hz) ---
    def publish_all_control_commands(self):
        """
        登録されているすべてのモジュールプラグインに対して、10ms（100Hz）周期でCANバスへ送信する
        """
        if self.is_sending_params:
            return

        # cmd_vel ウォッチドッグ: 外部 cmd_vel が途絶えたら安全のため足回りを0停止
        if self.cmd_vel_active and self.cmd_vel_timeout_sec > 0:
            if (time.monotonic() - self.last_cmd_vel_time) > self.cmd_vel_timeout_sec:
                target_mdd_name = self.kinematics.drive_module_name
                plugin = self.module_plugins.get(target_mdd_name)
                if isinstance(plugin, MddModulePlugin):
                    plugin.set_targets_direct([0.0, 0.0, 0.0, 0.0])
                self.cmd_vel_active = False

        active_running = self.is_running and (not self.emergency_stopped)
        for plugin in self.module_plugins.values():
            frames = plugin.build_periodic_tx_frames(active_running)
            for frame in frames:
                self.can_tx_pub.publish(frame)

    # --- 3. CAN ➔ ROS2 フィードバック変換処理 ---
    def handle_can_rx_callback(self, frame: Frame):
        try:
            for plugin in self.module_plugins.values():
                if plugin.handle_can_rx(frame):
                    break
        except Exception as e:
            self.get_logger().error(f"CAN受信コールバック処理中にエラーが発生しました: {str(e)}")

    # --- 4. 複数MDD構成時のKeepaliveおよび個別MDDパラメータ送信ヘルパー ---
    def send_keepalive_to_mdds(self, mdd_modules):
        """他のMDDのパラメータ送信中に、既に制御開始したMDDがCAN受信タイムアウト(500ms)しないよう0x22xを送る"""
        for mod in mdd_modules:
            base_id = int(str(mod['base_id']), 16)
            if self.mdd_param_confirmed.get(base_id, False) or self.mdd_param_sent_at.get(base_id, 0.0) > 0.0:
                frame = Frame()
                frame.header.stamp = self.get_clock().now().to_msg()
                frame.id = base_id + 0x20
                frame.dlc = 8
                frame.is_extended = False
                frame.is_rtr = False
                frame.data = [0] * 8
                self.can_tx_pub.publish(frame)

    def send_single_mdd_params(self, module, all_mdd_modules):
        base_id = int(str(module['base_id']), 16)
        params = module.get('parameters', {})

        # 4つのモータ (m1〜m4) のゲイン・直径・方向を送信 (35ms間隔)
        for idx, motor_key in enumerate(['m1', 'm2', 'm3', 'm4']):
            m_param = params.get(motor_key, {"p": 1.0, "i": 0.0, "d": 0.0, "diameter": 100.0, "direction": 1})

            p_gain = max(-32768, min(32767, int(float(m_param.get('p', 1.0)) * 1000)))
            i_gain = max(-32768, min(32767, int(float(m_param.get('i', 0.0)) * 1000)))
            d_gain = max(-32768, min(32767, int(float(m_param.get('d', 0.0)) * 1000)))

            diameter = float(m_param.get('diameter', 100.0))
            direction = float(m_param.get('direction', 1.0))
            diameter_dir = max(-32768, min(32767, int(diameter * direction)))

            payload = struct.pack('<hhhh', p_gain, i_gain, d_gain, diameter_dir)
            motor_id = base_id + idx

            frame = Frame()
            frame.header.stamp = self.get_clock().now().to_msg()
            frame.id = motor_id
            frame.dlc = 8
            frame.is_extended = False
            frame.is_rtr = False
            frame.data = list(payload)
            self.can_tx_pub.publish(frame)

            self.get_logger().info(
                f"パラメータ送信: {module['name']} M{idx+1} (ID:{hex(motor_id)}) "
                f"P={p_gain}, I={i_gain}, D={d_gain}, 車輪={diameter_dir}"
            )
            time.sleep(0.035)
            self.send_keepalive_to_mdds(all_mdd_modules)

        # 4ch モード設定 (Base ID + 0x10 = 例: 0x210) の送信
        modes = [
            int(params.get('m1', {}).get('mode', 0)),
            int(params.get('m2', {}).get('mode', 0)),
            int(params.get('m3', {}).get('mode', 0)),
            int(params.get('m4', {}).get('mode', 0))
        ]
        mode_payload = modes + [0] * 4

        mode_frame = Frame()
        mode_frame.header.stamp = self.get_clock().now().to_msg()
        mode_frame.id = base_id + 0x10
        mode_frame.dlc = 4
        mode_frame.is_extended = False
        mode_frame.is_rtr = False
        mode_frame.data = mode_payload
        self.can_tx_pub.publish(mode_frame)

        self.mdd_param_sent_at[base_id] = time.monotonic()
        self.get_logger().info(f"モード設定送信: {module['name']} (ID:{hex(base_id + 0x10)}) モード={modes}")
        time.sleep(0.040)

        # 起動直後のマイコンのCAN受信タイムアウト防止用として初期目標値(0)を即座に送信
        zero_frame = Frame()
        zero_frame.header.stamp = self.get_clock().now().to_msg()
        zero_frame.id = base_id + 0x20
        zero_frame.dlc = 8
        zero_frame.is_extended = False
        zero_frame.is_rtr = False
        zero_frame.data = [0] * 8
        self.can_tx_pub.publish(zero_frame)
        self.send_keepalive_to_mdds(all_mdd_modules)

    # --- 5. パラメータ送信 ＆ 制御実行モード遷移トリガーサービス ---
    def handle_start_control_service(self, request, response):
        _ = request
        self.get_logger().info("スタート制御要求を受信しました。パラメータの送信を開始します。")

        self.is_sending_params = True
        self.emergency_stopped = False
        try:
            config_path = self.get_config_path()
            if os.path.exists(config_path):
                with open(config_path, 'r', encoding='utf-8') as f:
                    self.config = json.load(f)

            # 非MDDカスタムプラグインで初期化フレームを持つものがあれば送出
            for plugin in self.module_plugins.values():
                if not isinstance(plugin, MddModulePlugin):
                    for frame in plugin.build_init_frames():
                        self.can_tx_pub.publish(frame)
                        time.sleep(0.02)

            mdd_modules = [m for m in self.config.get('modules', []) if m.get('type') == 'mdd']
            if not mdd_modules:
                self.control_start_monotonic = time.monotonic()
                self.is_running = True
                response.success = True
                response.message = "MDDモジュールが登録されていないため、即時制御モードを開始しました。"
                return response

            for mod in mdd_modules:
                base_id = int(str(mod['base_id']), 16)
                self.mdd_param_confirmed[base_id] = False
                self.mdd_param_sent_at[base_id] = 0.0
                if base_id in self.mdd_feedback_cache:
                    self.mdd_feedback_cache[base_id]['system_status'] = 0

            max_rounds = 6
            for round_num in range(1, max_rounds + 1):
                pending_mdds = [
                    mod for mod in mdd_modules
                    if not self.mdd_param_confirmed.get(int(str(mod['base_id']), 16), False)
                ]
                if not pending_mdds:
                    break

                pending_names = ", ".join(f"{m['name']}({m['base_id']})" for m in pending_mdds)
                log_msg = f"[PARAM] パラメータ送信ラウンド {round_num} (未完了: {pending_names})"
                self.get_logger().info(log_msg)
                self.publish_ui_log(log_msg)

                for mod in pending_mdds:
                    self.send_single_mdd_params(mod, mdd_modules)

                wait_start = time.monotonic()
                while (time.monotonic() - wait_start) < 0.40:
                    if all(self.mdd_param_confirmed.get(int(str(m['base_id']), 16), False) for m in mdd_modules):
                        break
                    self.send_keepalive_to_mdds(mdd_modules)
                    time.sleep(0.040)

                if all(self.mdd_param_confirmed.get(int(str(m['base_id']), 16), False) for m in mdd_modules):
                    break

            unconfirmed_mdds = [
                f"{m['name']}({m['base_id']})"
                for m in mdd_modules
                if not self.mdd_param_confirmed.get(int(str(m['base_id']), 16), False)
            ]
            confirmed_count = len(mdd_modules) - len(unconfirmed_mdds)

            if not unconfirmed_mdds:
                self.control_start_monotonic = time.monotonic()
                self.is_running = True
                msg = f"全 {len(mdd_modules)} 台のMDDマイコンの設定完了を確認し、制御システムが実行状態に遷移しました。"
                self.get_logger().info(msg)
                self.publish_ui_log(f"[SYSTEM] {msg}")
                response.success = True
                response.message = msg
            else:
                if confirmed_count > 0:
                    self.control_start_monotonic = time.monotonic()
                    self.is_running = True
                warn_msg = (
                    f"未応答のMDDがあります ({', '.join(unconfirmed_mdds)})。"
                    f"CANチャンネル選択 (CAN1 / CAN2) または基板の電源・配線を確認してください。"
                )
                self.get_logger().warn(warn_msg)
                self.publish_ui_log(f"[WARNING] {warn_msg}")
                response.success = False
                response.message = warn_msg

        except Exception as e:
            self.is_running = False
            response.success = False
            response.message = f"パラメータ送信中にエラーが発生しました: {str(e)}"
            self.get_logger().error(f"パラメータ送信エラー: {str(e)}")
        finally:
            self.is_sending_params = False

        return response

    def handle_reload_config_service(self, request, response):
        """設定ファイル更新時にトピックを動的再生成するサービスハンドラー"""
        _ = request
        self.get_logger().info("モジュール設定のリロード要求を受信しました。トピックを再生成します。")
        try:
            self.load_config_and_initialize()
            response.success = True
            response.message = "モジュール構成を正常に再読み込みしました。"
        except Exception as e:
            response.success = False
            response.message = f"リロード失敗: {str(e)}"
            self.get_logger().error(f"リロード失敗: {str(e)}")
        return response

    def handle_config_sync_callback(self, msg):
        """
        WebServerから送信された最新のモジュール構成設定を受信し、
        modules_config.json に上書き保存する
        """
        self.get_logger().info("モジュール構成同期メッセージを受信しました。")
        try:
            config_data = json.loads(msg.data)
            config_path = self.get_config_path()
            Path(config_path).parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            self.get_logger().info(f"設定ファイルを同期保存しました: {config_path}")
        except Exception as e:
            self.get_logger().error(f"構成同期データの保存に失敗しました: {str(e)}")


def main(args=None):
    rclpy.init(args=args)
    node = ModuleManager()

    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
