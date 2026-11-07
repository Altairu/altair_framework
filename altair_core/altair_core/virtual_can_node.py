import json
import os
import struct
from typing import Dict

import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from can_msgs.msg import Frame
from altair_interfaces.msg import CanStatus
from altair_interfaces.srv import ConnectCan, ConnectEthCan, GetAvailablePorts
from altair_core.paths import get_config_path


class VirtualMddState:
    """仮想 MDD モジュール1台分の内部状態"""
    def __init__(self, base_id: int):
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
                target_deg = (target / (3.14159265 * dia)) * 360.0
                err_deg = target_deg - self.angles[i]
                rps = max(-5.0, min(5.0, (err_deg / 360.0) * 5.0))
                self.speeds[i] = rps
                self.angles[i] += rps * 360.0 * dt

            # int16_t (0.1deg単位: -3276.8〜+3276.7 deg) 範囲内にラップ
            if self.angles[i] > 3200.0:
                self.angles[i] -= 6400.0
            elif self.angles[i] < -3200.0:
                self.angles[i] += 6400.0


class VirtualCanNode(Node):
    """
    実機レス（ハードウェアなし）で Altair Framework 全体の動作確認・デバッグを可能にする
    仮想 CAN バスシミュレータノード (`--sim` モード用)。
    """
    def __init__(self):
        super().__init__("virtual_can_node")
        self.callback_group = ReentrantCallbackGroup()

        self.can_rx_pub = self.create_publisher(Frame, "/altair/can/rx", 100)
        self.can_status_pub = self.create_publisher(CanStatus, "/altair/can/status", 10)
        self.can_tx_sub = self.create_subscription(
            Frame, "/altair/can/tx", self.on_can_tx, 100, callback_group=self.callback_group
        )

        # WebUI からの接続要求サービスにも応答できるようにする
        self.create_service(GetAvailablePorts, "/altair/can/get_ports", self.handle_get_ports)
        self.create_service(ConnectCan, "/altair/can/connect", self.handle_connect_can)
        self.create_service(ConnectEthCan, "/altair/eth_can/connect", self.handle_connect_eth)

        self.virtual_mdds: Dict[int, VirtualMddState] = {}
        self._load_configured_mdds()

        # 100Hz 仮想マイコン更新・フィードバック送信タイマー
        self.sim_timer = self.create_timer(0.01, self.sim_step, callback_group=self.callback_group)
        # 1Hz CANステータス配信タイマー
        self.status_timer = self.create_timer(1.0, self.publish_status, callback_group=self.callback_group)

        self.get_logger().info("Virtual CAN Simulator ノードが起動しました (実機レス・シミュレータモード)。")

    def _load_configured_mdds(self):
        config_path = get_config_path()
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                for mod in cfg.get("modules", []):
                    if mod.get("type") == "mdd":
                        base_id = int(str(mod.get("base_id", "0x200")), 16)
                        if base_id not in self.virtual_mdds:
                            self.virtual_mdds[base_id] = VirtualMddState(base_id)
            except Exception:
                pass
        if not self.virtual_mdds:
            self.virtual_mdds[0x200] = VirtualMddState(0x200)

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

    def on_can_tx(self, frame: Frame):
        can_id = frame.id
        # 対象となり得る base_id を探索 (あるいは 0x200 番台なら自動生成)
        base_id = can_id & 0xFF00
        if 0x200 <= can_id <= 0x2FF and base_id not in self.virtual_mdds:
            self.virtual_mdds[base_id] = VirtualMddState(base_id)

        for b_id, mdd in list(self.virtual_mdds.items()):
            # 1. PID パラメータ設定 (base_id + 0..3)
            if b_id <= can_id <= b_id + 3 and frame.dlc >= 8:
                motor_idx = can_id - b_id
                _, _, _, dia_dir = struct.unpack("<hhhh", bytes(frame.data[:8]))
                mdd.diameters[motor_idx] = float(dia_dir)
                return

            # 2. モード設定 (base_id + 0x10) -> 制御実行状態(1)へ遷移
            if can_id == b_id + 0x10 and frame.dlc >= 4:
                mdd.modes = [int(x) for x in frame.data[:4]]
                mdd.system_status = 1
                self.get_logger().info(
                    f"[VirtualMDD {hex(b_id)}] パラメータ受信完了 ➔ 制御実行モード(Running)に遷移しました (modes={mdd.modes})"
                )
                return

            # 3. 目標値指令 (base_id + 0x20)
            if can_id == b_id + 0x20 and frame.dlc >= 8:
                raw_targets = struct.unpack("<hhhh", bytes(frame.data[:8]))
                mdd.targets = [float(t) / 10.0 for t in raw_targets]
                return

    def sim_step(self):
        now_msg = self.get_clock().now().to_msg()
        for b_id, mdd in list(self.virtual_mdds.items()):
            mdd.step(0.01)

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
