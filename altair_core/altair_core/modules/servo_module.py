from typing import List
from can_msgs.msg import Frame
from altair_interfaces.msg import ServoCommand
from altair_core.modules.base_module import BaseModulePlugin, register_module


class ServoClient:
    """
    Servo (6ch サーボモジュール) の制御用クライアントクラス
    """
    def __init__(self, node, name: str):
        self.node = node
        self.name = name
        self.angles_state = [90, 90, 90, 90, 90, 90]
        self.cmd_pub = node.create_publisher(ServoCommand, f"/altair/{name}/cmd", 10)

    def set_angles(self, angles):
        """
        6チャネルのサーボの目標角度を一括設定します。
        angles: [s1, s2, s3, s4, s5, s6] (0〜180度)
        """
        padded = [max(0, min(180, int(a))) for a in list(angles)[:6]]
        while len(padded) < 6:
            padded.append(90)
        self.angles_state = padded
        msg = ServoCommand()
        msg.angles = self.angles_state
        self.cmd_pub.publish(msg)

    def set_angle(self, channel: int, angle: int):
        """
        特定のチャネル (1〜6) のサーボ角度を個別に設定します。
        """
        if 1 <= channel <= 6:
            self.angles_state[channel - 1] = max(0, min(180, int(angle)))
            self.set_angles(self.angles_state)


@register_module("servo")
class ServoModulePlugin(BaseModulePlugin):
    """
    6ch PWM サーボモジュールプラグイン (標準 BaseID: 0x100)
    """
    def __init__(self, manager_node, module_config: dict):
        super().__init__(manager_node, module_config)
        self.angles = [90, 90, 90, 90, 90, 90]

    def setup_ros_interfaces(self):
        cmd_topic = f"/altair/{self.name}/cmd"
        self.create_module_subscription(ServoCommand, cmd_topic, self._on_cmd)
        self.node.servo_angles[self.name] = self.angles

    def _on_cmd(self, msg: ServoCommand):
        self.angles = [int(a) for a in msg.angles[:6]]
        while len(self.angles) < 6:
            self.angles.append(90)
        self.node.servo_angles[self.name] = self.angles

    def build_periodic_tx_frames(self, is_running: bool) -> List[Frame]:
        _ = is_running
        payload = [max(0, min(180, int(a))) for a in self.angles[:6]]
        while len(payload) < 6:
            payload.append(90)

        frame = Frame()
        frame.header.stamp = self.node.get_clock().now().to_msg()
        frame.header.frame_id = self.can_channel
        frame.id = self.base_id
        frame.dlc = 6
        frame.is_extended = False
        frame.is_rtr = False
        frame.data = payload + [0] * (8 - len(payload))
        return [frame]

    @classmethod
    def create_behavior_client(cls, behavior_node, name: str, module_config: dict):
        return ServoClient(behavior_node, name)
