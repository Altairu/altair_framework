from typing import List
from can_msgs.msg import Frame
from altair_interfaces.msg import SolenoidCommand
from altair_core.modules.base_module import BaseModulePlugin, register_module


class SolenoidClient:
    """
    Solenoid Valve (12ch 電磁弁) の制御用クライアントクラス
    """
    def __init__(self, node, name: str):
        self.node = node
        self.name = name
        self.valves_state = [False] * 12
        self.cmd_pub = node.create_publisher(SolenoidCommand, f"/altair/{name}/cmd", 10)

    def set_valves(self, valves):
        """
        12チャネルの電磁弁のON/OFFを一括で設定します。
        valves: boolの12要素配列 (True=ON, False=OFF)
        """
        padded = [bool(v) for v in list(valves)[:12]]
        while len(padded) < 12:
            padded.append(False)
        self.valves_state = padded
        msg = SolenoidCommand()
        msg.valves = self.valves_state
        self.cmd_pub.publish(msg)

    def set_valve(self, channel: int, state: bool):
        """
        特定のチャネル (1〜12) の電磁弁のON/OFFを設定します。
        """
        if 1 <= channel <= 12:
            self.valves_state[channel - 1] = bool(state)
            self.set_valves(self.valves_state)


@register_module("solenoid")
class SolenoidModulePlugin(BaseModulePlugin):
    """
    12ch 電磁弁モジュールプラグイン (標準 BaseID: 0x300)
    """
    def __init__(self, manager_node, module_config: dict):
        super().__init__(manager_node, module_config)
        self.valves = [False] * 12

    def setup_ros_interfaces(self):
        cmd_topic = f"/altair/{self.name}/cmd"
        self.create_module_subscription(SolenoidCommand, cmd_topic, self._on_cmd)
        self.node.solenoid_valves[self.name] = self.valves

    def _on_cmd(self, msg: SolenoidCommand):
        self.valves = [bool(v) for v in msg.valves[:12]]
        while len(self.valves) < 12:
            self.valves.append(False)
        self.node.solenoid_valves[self.name] = self.valves

    def build_periodic_tx_frames(self, is_running: bool) -> List[Frame]:
        _ = is_running
        byte0 = 0
        byte1 = 0
        for i in range(min(len(self.valves), 12)):
            if self.valves[i]:
                if i < 8:
                    byte0 |= 1 << i
                else:
                    byte1 |= 1 << (i - 8)

        frame = Frame()
        frame.header.stamp = self.node.get_clock().now().to_msg()
        frame.header.frame_id = self.can_channel
        frame.id = self.base_id
        frame.dlc = 2
        frame.is_extended = False
        frame.is_rtr = False
        frame.data = [byte0, byte1] + [0] * 6
        return [frame]

    @classmethod
    def create_behavior_client(cls, behavior_node, name: str, module_config: dict):
        return SolenoidClient(behavior_node, name)
