import json
import math
import os
import struct
from typing import Dict, List, Optional

import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from can_msgs.msg import Frame
from nav_msgs.msg import Odometry
from geometry_msgs.msg import TransformStamped, Quaternion
from std_msgs.msg import String, Empty
from altair_interfaces.msg import CanStatus
from altair_interfaces.srv import ConnectCan, ConnectEthCan, GetAvailablePorts
from altair_core.paths import get_config_path
from altair_core.kinematics import ChassisKinematics

try:
    import tf2_ros
    HAS_TF2 = True
except ImportError:
    HAS_TF2 = False


def euler_to_quaternion(roll: float, pitch: float, yaw: float) -> Quaternion:
    """オイラー角 (rad) から geometry_msgs/msg/Quaternion を作成"""
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)

    q = Quaternion()
    q.w = cr * cp * cy + sr * sp * sy
    q.x = sr * cp * cy - cr * sp * sy
    q.y = cr * sp * cy + sr * cp * sy
    q.z = cr * cp * sy - sr * sp * cy
    return q


class VirtualMddState:
    """仮想 MDD モジュール1台分の内部状態"""
    def __init__(self, name: str, base_id: int):
        self.name = name
        self.base_id = base_id
        self.system_status = 0  # 0: Setup待ち, 1: 制御実行中
        self.error_code = 0
        self.limit_switches = [False, False, False, False]
        self.modes = [0, 0, 0, 0]  # 0: Speed(rps), 1: Angle(deg), 2: Pos(mm)
        self.diameters = [100.0, 100.0, 100.0, 100.0]
        self.targets = [0.0, 0.0, 0.0, 0.0]
        self.angles = [0.0, 0.0, 0.0, 0.0]  # deg
        self.speeds = [0.0, 0.0, 0.0, 0.0]  # rps

    def step(self, dt: float):
        if self.system_status != 1:
            self.speeds = [0.0, 0.0, 0.0, 0.0]
            return

        for i in range(4):
            mode = self.modes[i]
            target = self.targets[i]
            if mode == 0:
                # 速度制御モード: 1次遅れで目標速度(rps)へ追従
                self.speeds[i] += (target - self.speeds[i]) * min(1.0, dt * 20.0)
                self.angles[i] += self.speeds[i] * 360.0 * dt
            elif mode == 1:
                # 角度制御モード: 目標角度(deg)へ比例追従
                err_deg = target - self.angles[i]
                rps = max(-5.0, min(5.0, (err_deg / 360.0) * 5.0))
                self.speeds[i] = rps
                self.angles[i] += rps * 360.0 * dt
            else:
                # 位置制御モード (mm)
                dia = max(10.0, abs(self.diameters[i]))
                target_deg = (target / (math.pi * dia)) * 360.0
                err_deg = target_deg - self.angles[i]
                rps = max(-5.0, min(5.0, (err_deg / 360.0) * 5.0))
                self.speeds[i] = rps
                self.angles[i] += rps * 360.0 * dt

            # int16_t (0.1deg単位: -3276.8〜+3276.7 deg) 範囲内にラップ
            if self.angles[i] > 3200.0:
                self.angles[i] -= 6400.0
            elif self.angles[i] < -3200.0:
                self.angles[i] += 6400.0


class VirtualServoState:
    """仮想 6ch サーボモジュール1台分の内部状態"""
    def __init__(self, name: str, base_id: int):
        self.name = name
        self.base_id = base_id
        self.angles = [90, 90, 90, 90, 90, 90]


class VirtualSolenoidState:
    """仮想 12ch 電磁弁モジュール1台分の内部状態"""
    def __init__(self, name: str, base_id: int):
        self.name = name
        self.base_id = base_id
        self.valves = [False] * 12


class VirtualCanNode(Node):
    """
    実機レス（ハードウェアなし）で Altair Framework 全体の動作確認・デバッグを可能にする
    仮想 CAN バス & ロボットシミュレータノード (`--sim` モード用)。
    
    機能:
    1. 仮想 CAN バス応答 (MDD, Servo, Solenoid の送受信)
    2. リミットスイッチ / エラー状態の動的注入
    3. ロボット足回り順運動学オドメトリ積算
    4. /odom (nav_msgs/msg/Odometry) 及び /tf (odom -> base_link) のパブリッシュ
    5. Web UI 連携用の /altair/sim/state 配信
    """
    def __init__(self):
        super().__init__("virtual_can_node")
        self.callback_group = ReentrantCallbackGroup()

        # CAN バス送受信インターフェース
        self.can_rx_pub = self.create_publisher(Frame, "/altair/can/rx", 100)
        self.can_status_pub = self.create_publisher(CanStatus, "/altair/can/status", 10)
        self.can_tx_sub = self.create_subscription(
            Frame, "/altair/can/tx", self.on_can_tx, 100, callback_group=self.callback_group
        )

        # オドメトリ & TF ブロードキャスト
        self.odom_pub = self.create_publisher(Odometry, "/odom", 20)
        if HAS_TF2:
            self.tf_broadcaster = tf2_ros.TransformBroadcaster(self)
        else:
            self.tf_broadcaster = None

        # シミュレータ状態配信用トピック (Web UI / 外部ノード用)
        self.sim_state_pub = self.create_publisher(String, "/altair/sim/state", 10)

        # シミュレータ操作用トピック (リミットスイッチ注入 / 位置リセット)
        self.create_subscription(
            String, "/altair/sim/set_limit_sw", self.on_set_limit_sw, 10, callback_group=self.callback_group
        )
        self.create_subscription(
            Empty, "/altair/sim/reset_pose", self.on_reset_pose, 10, callback_group=self.callback_group
        )

        # WebUI からの接続要求サービス応答
        self.create_service(GetAvailablePorts, "/altair/can/get_ports", self.handle_get_ports)
        self.create_service(ConnectCan, "/altair/can/connect", self.handle_connect_can)
        self.create_service(ConnectEthCan, "/altair/eth_can/connect", self.handle_connect_eth)

        # 仮想デバイス管理
        self.virtual_mdds: Dict[int, VirtualMddState] = {}
        self.virtual_servos: Dict[int, VirtualServoState] = {}
        self.virtual_solenoids: Dict[int, VirtualSolenoidState] = {}

        # 運動学 & オドメトリ状態
        self.kinematics: Optional[ChassisKinematics] = None
        self.drive_mdd_base_id: int = 0x200
        self.robot_x: float = 0.0
        self.robot_y: float = 0.0
        self.robot_theta: float = 0.0  # rad
        self.linear_x: float = 0.0
        self.linear_y: float = 0.0
        self.angular_z: float = 0.0

        self._load_configuration()

        # 100Hz 仮想マイコン更新 & CANフィードバック送信
        self.sim_timer = self.create_timer(0.01, self.sim_step, callback_group=self.callback_group)
        # 50Hz オドメトリ・TF 配信
        self.odom_timer = self.create_timer(0.02, self.publish_odometry, callback_group=self.callback_group)
        # 10Hz Web UI 向け総合ステータス配信
        self.ui_timer = self.create_timer(0.1, self.publish_sim_ui_state, callback_group=self.callback_group)
        # 1Hz CANステータス配信
        self.status_timer = self.create_timer(1.0, self.publish_status, callback_group=self.callback_group)

        self.get_logger().info(
            "Virtual CAN & Robot Simulator が起動しました (--sim モード)。"
            " /odom, /tf, /altair/sim/state をパブリッシュ中。"
        )

    def _load_configuration(self):
        config_path = get_config_path()
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)

                self.kinematics = ChassisKinematics(cfg)

                for mod in cfg.get("modules", []):
                    mod_type = mod.get("type")
                    mod_name = mod.get("name", "Module")
                    base_id_str = str(mod.get("base_id", "0x200"))
                    base_id = int(base_id_str, 16) if base_id_str.startswith("0x") else int(base_id_str)

                    if mod_type == "mdd":
                        self.virtual_mdds[base_id] = VirtualMddState(mod_name, base_id)
                        if mod_name == self.kinematics.drive_module_name:
                            self.drive_mdd_base_id = base_id
                    elif mod_type == "servo":
                        self.virtual_servos[base_id] = VirtualServoState(mod_name, base_id)
                    elif mod_type == "solenoid":
                        self.virtual_solenoids[base_id] = VirtualSolenoidState(mod_name, base_id)

            except Exception as e:
                self.get_logger().error(f"シミュレータ設定の読み込みに失敗しました: {e}")

        # デフォルト MDD のフォールバック
        if not self.virtual_mdds:
            self.virtual_mdds[0x200] = VirtualMddState("MDD1", 0x200)
            self.drive_mdd_base_id = 0x200
        if not self.virtual_servos:
            self.virtual_servos[0x100] = VirtualServoState("SERVO1", 0x100)
        if not self.virtual_solenoids:
            self.virtual_solenoids[0x300] = VirtualSolenoidState("VALVE1", 0x300)

    def handle_get_ports(self, request, response):
        _ = request
        response.ports = ["VIRTUAL_CAN_SIM"]
        return response

    def handle_connect_can(self, request, response):
        _ = request
        response.success = True
        response.message = "Connected to Virtual CAN Simulator"
        return response

    def handle_connect_eth(self, request, response):
        _ = request
        response.success = True
        response.message = "Connected to Virtual Ethernet-CAN Simulator"
        return response

    def publish_status(self):
        msg = CanStatus()
        msg.is_connected = True
        msg.active_port = "VIRTUAL_CAN_SIM"
        msg.bitrate = 1000000
        msg.error_message = ""
        self.can_status_pub.publish(msg)

    def on_set_limit_sw(self, msg: String):
        """Web UI や外部テストスクリプトからのリミットスイッチ状態注入"""
        try:
            data = json.loads(msg.data)
            # data: {"mdd": "MDD1" or base_id, "index": 0..3, "state": bool}
            target_id = None
            if "mdd" in data:
                m_ident = data["mdd"]
                if isinstance(m_ident, str) and not m_ident.startswith("0x"):
                    for b_id, m in self.virtual_mdds.items():
                        if m.name == m_ident:
                            target_id = b_id
                            break
                else:
                    target_id = int(str(m_ident), 16) if str(m_ident).startswith("0x") else int(m_ident)
            elif "base_id" in data:
                target_id = int(str(data["base_id"]), 16) if str(data["base_id"]).startswith("0x") else int(data["base_id"])

            if target_id is not None and target_id in self.virtual_mdds:
                idx = int(data.get("index", 0))
                state = bool(data.get("state", False))
                if 0 <= idx < 4:
                    self.virtual_mdds[target_id].limit_switches[idx] = state
                    self.get_logger().info(
                        f"[VirtualCAN] MDD({self.virtual_mdds[target_id].name}) SW{idx+1} を {state} に変更しました"
                    )
        except Exception as e:
            self.get_logger().error(f"リミットSW注入パース失敗: {e}")

    def on_reset_pose(self, msg: Empty):
        _ = msg
        self.robot_x = 0.0
        self.robot_y = 0.0
        self.robot_theta = 0.0
        self.linear_x = 0.0
        self.linear_y = 0.0
        self.angular_z = 0.0
        self.get_logger().info("[VirtualCAN] 仮想ロボットの自己位置を (0, 0, 0) にリセットしました。")

    def on_can_tx(self, frame: Frame):
        can_id = frame.id

        # 1. サーボモジュール (BaseID 一致)
        for b_id, srv in self.virtual_servos.items():
            if can_id == b_id and frame.dlc >= 6:
                srv.angles = [int(a) for a in frame.data[:6]]
                return

        # 2. 電磁弁モジュール (BaseID 一致)
        for b_id, sol in self.virtual_solenoids.items():
            if can_id == b_id and frame.dlc >= 2:
                b0 = frame.data[0]
                b1 = frame.data[1]
                for i in range(8):
                    sol.valves[i] = bool((b0 >> i) & 1)
                for i in range(4):
                    sol.valves[8 + i] = bool((b1 >> i) & 1)
                return

        # 3. MDD モジュール
        base_id = can_id & 0xFF00
        if 0x200 <= can_id <= 0x2FF and base_id not in self.virtual_mdds:
            self.virtual_mdds[base_id] = VirtualMddState(f"MDD_{hex(base_id)}", base_id)

        for b_id, mdd in list(self.virtual_mdds.items()):
            # PID パラメータ設定 (base_id + 0..3)
            if b_id <= can_id <= b_id + 3 and frame.dlc >= 8:
                motor_idx = can_id - b_id
                _, _, _, dia_dir = struct.unpack("<hhhh", bytes(frame.data[:8]))
                mdd.diameters[motor_idx] = float(dia_dir)
                return

            # モード設定 (base_id + 0x10) -> 制御実行状態(1)へ遷移
            if can_id == b_id + 0x10 and frame.dlc >= 4:
                mdd.modes = [int(x) for x in frame.data[:4]]
                mdd.system_status = 1
                return

            # 目標値指令 (base_id + 0x20)
            if can_id == b_id + 0x20 and frame.dlc >= 8:
                raw_targets = struct.unpack("<hhhh", bytes(frame.data[:8]))
                mdd.targets = [float(t) / 10.0 for t in raw_targets]
                return

    def sim_step(self):
        dt = 0.01
        now_msg = self.get_clock().now().to_msg()

        for b_id, mdd in list(self.virtual_mdds.items()):
            mdd.step(dt)

            # A. ステータスフレーム (base_id + 0x30)
            status_frame = Frame()
            status_frame.header.stamp = now_msg
            status_frame.id = b_id + 0x30
            status_frame.dlc = 8
            status_frame.data = [
                1 if mdd.limit_switches[0] else 0,
                1 if mdd.limit_switches[1] else 0,
                1 if mdd.limit_switches[2] else 0,
                1 if mdd.limit_switches[3] else 0,
                int(mdd.error_code),
                int(mdd.system_status),
                0,
                0,
            ]
            self.can_rx_pub.publish(status_frame)

            # B. エンコーダ現在角度フレーム (base_id + 0x40)
            angles_int = [max(-32768, min(32767, int(a * 10.0))) for a in mdd.angles]
            angle_frame = Frame()
            angle_frame.header.stamp = now_msg
            angle_frame.id = b_id + 0x40
            angle_frame.dlc = 8
            angle_frame.data = list(struct.pack("<hhhh", *angles_int))
            self.can_rx_pub.publish(angle_frame)

            # C. エンコーダ現在速度フレーム (base_id + 0x50)
            speeds_int = [max(-32768, min(32767, int(s * 100.0))) for s in mdd.speeds]
            speed_frame = Frame()
            speed_frame.header.stamp = now_msg
            speed_frame.id = b_id + 0x50
            speed_frame.dlc = 8
            speed_frame.data = list(struct.pack("<hhhh", *speeds_int))
            self.can_rx_pub.publish(speed_frame)

        # 足回りオドメトリ積算
        drive_mdd = self.virtual_mdds.get(self.drive_mdd_base_id)
        if drive_mdd and self.kinematics:
            # 順運動学で機体速度を計算
            self.linear_x, self.linear_y, self.angular_z = (
                self.kinematics.compute_forward_from_speeds(drive_mdd.speeds)
            )

            # ロボット座標系からワールド座標系への変換と積分
            # REP-103: linear_x = 前進 (ワールドX方向(theta=0時)), linear_y = 左進 (ワールドY方向(theta=0時))
            c = math.cos(self.robot_theta)
            s = math.sin(self.robot_theta)
            world_vx = self.linear_x * c - self.linear_y * s
            world_vy = self.linear_x * s + self.linear_y * c

            self.robot_x += world_vx * dt
            self.robot_y += world_vy * dt
            self.robot_theta += self.angular_z * dt
            # -pi ~ pi に正規化
            self.robot_theta = math.atan2(math.sin(self.robot_theta), math.cos(self.robot_theta))

    def publish_odometry(self):
        """/odom および /tf (odom -> base_link) のパブリッシュ"""
        now = self.get_clock().now()
        now_msg = now.to_msg()
        q = euler_to_quaternion(0.0, 0.0, self.robot_theta)

        # 1. nav_msgs/msg/Odometry
        odom = Odometry()
        odom.header.stamp = now_msg
        odom.header.frame_id = "odom"
        odom.child_frame_id = "base_link"

        odom.pose.pose.position.x = float(self.robot_x)
        odom.pose.pose.position.y = float(self.robot_y)
        odom.pose.pose.position.z = 0.0
        odom.pose.pose.orientation = q

        odom.twist.twist.linear.x = float(self.linear_x)
        odom.twist.twist.linear.y = float(self.linear_y)
        odom.twist.twist.linear.z = 0.0
        odom.twist.twist.angular.x = 0.0
        odom.twist.twist.angular.y = 0.0
        odom.twist.twist.angular.z = float(self.angular_z)

        self.odom_pub.publish(odom)

        # 2. tf2 (odom -> base_link)
        if self.tf_broadcaster:
            t = TransformStamped()
            t.header.stamp = now_msg
            t.header.frame_id = "odom"
            t.child_frame_id = "base_link"
            t.transform.translation.x = float(self.robot_x)
            t.transform.translation.y = float(self.robot_y)
            t.transform.translation.z = 0.0
            t.transform.rotation = q
            self.tf_broadcaster.sendTransform(t)

    def publish_sim_ui_state(self):
        """Web UI や外部可視化ツール向け総合ステータス配信"""
        data = {
            "pose": {
                "x": round(self.robot_x, 3),
                "y": round(self.robot_y, 3),
                "theta_deg": round(math.degrees(self.robot_theta), 1),
                "vx": round(self.linear_x, 3),
                "vy": round(self.linear_y, 3),
                "omega_deg": round(math.degrees(self.angular_z), 1),
            },
            "mdds": [
                {
                    "name": m.name,
                    "base_id": hex(m.base_id),
                    "limits": m.limit_switches,
                    "speeds": [round(s, 2) for s in m.speeds],
                    "angles": [round(a, 1) for a in m.angles],
                    "targets": [round(t, 2) for t in m.targets],
                    "status": m.system_status,
                }
                for m in self.virtual_mdds.values()
            ],
            "servos": [
                {
                    "name": s.name,
                    "base_id": hex(s.base_id),
                    "angles": s.angles,
                }
                for s in self.virtual_servos.values()
            ],
            "solenoids": [
                {
                    "name": s.name,
                    "base_id": hex(s.base_id),
                    "valves": s.valves,
                }
                for s in self.virtual_solenoids.values()
            ],
        }
        msg = String()
        msg.data = json.dumps(data)
        self.sim_state_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = VirtualCanNode()
    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
