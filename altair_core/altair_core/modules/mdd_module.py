import struct
import time
from typing import List
from can_msgs.msg import Frame
from altair_interfaces.msg import MddCommand, MddFeedback
from altair_core.modules.base_module import BaseModulePlugin, register_module


class MddClient:
    """
    MDD (4ch モータドライバ) の制御・フィードバック取得用クライアントクラス
    """
    def __init__(self, node, name: str):
        self.node = node
        self.name = name
        self.latest_feedback = MddFeedback()

        self.cmd_pub = node.create_publisher(MddCommand, f"/altair/{name}/cmd", 10)
        self.feedback_sub = node.create_subscription(
            MddFeedback,
            f"/altair/{name}/feedback",
            self._feedback_callback,
            10,
            callback_group=node.callback_group,
        )

    def _feedback_callback(self, msg: MddFeedback):
        self.latest_feedback = msg

    def set_targets(self, targets):
        """
        4つのモータの目標値を設定します。
        targets: [m1, m2, m3, m4] (floatの配列。単位はモードに応じる: rps / deg / mm)
        """
        msg = MddCommand()
        padded = list(targets)[:4]
        while len(padded) < 4:
            padded.append(0.0)
        msg.targets = [float(t) for t in padded]
        self.cmd_pub.publish(msg)

    def stop(self):
        """全4chのモータ目標値を0にして即時停止します。"""
        self.set_targets([0.0, 0.0, 0.0, 0.0])

    def get_feedback(self) -> MddFeedback:
        """最新のフィードバックメッセージ (MddFeedback) を返します。"""
        return self.latest_feedback


@register_module("mdd")
class MddModulePlugin(BaseModulePlugin):
    """
    MDD (4ch DCモータドライバ) モジュールプラグイン
    """
    def __init__(self, manager_node, module_config: dict):
        super().__init__(manager_node, module_config)
        self.targets = [0.0, 0.0, 0.0, 0.0]
        self.last_cmd_time = 0.0
        self.param_confirmed = False
        self.param_sent_at = 0.0
        self.feedback_cache = {
            "limit_switches": [False, False, False, False],
            "error_code": 0,
            "system_status": 0,
            "angles": [0.0, 0.0, 0.0, 0.0],
            "speeds": [0.0, 0.0, 0.0, 0.0],
        }
        self.feedback_pub = None

    def setup_ros_interfaces(self):
        cmd_topic = f"/altair/{self.name}/cmd"
        fb_topic = f"/altair/{self.name}/feedback"

        self.create_module_subscription(MddCommand, cmd_topic, self._on_cmd)
        self.feedback_pub = self.create_module_publisher(MddFeedback, fb_topic)

        # ModuleManager 側の互換辞書にも参照を保持
        self.node.mdd_targets[self.name] = self.targets
        self.node.mdd_feedback_cache[self.base_id] = self.feedback_cache
        self.node.mdd_param_confirmed[self.base_id] = False
        self.node.mdd_param_sent_at[self.base_id] = 0.0

    def _on_cmd(self, msg: MddCommand):
        self.targets = [float(t) for t in msg.targets[:4]]
        while len(self.targets) < 4:
            self.targets.append(0.0)
        self.last_cmd_time = time.monotonic()
        self.node.mdd_targets[self.name] = self.targets

    def set_targets_direct(self, targets: List[float]):
        """ModuleManager 内部 (cmd_vel 運動学変換など) から直接目標値を更新する"""
        self.targets = [float(t) for t in targets[:4]]
        while len(self.targets) < 4:
            self.targets.append(0.0)
        self.last_cmd_time = time.monotonic()
        self.node.mdd_targets[self.name] = self.targets

    def build_periodic_tx_frames(self, is_running: bool) -> List[Frame]:
        # 制御実行中(is_running == True)でないときは、不要なバス負荷と上書きを避けるため0x220を送信しない
        if not is_running:
            return []

        targets = self.targets
        try:
            targets_int = [max(-32768, min(32767, int(t * 10))) for t in targets]
            payload = struct.pack("<hhhh", *targets_int)
        except Exception as e:
            self.node.get_logger().error(f"MDD目標値の周期エンコード失敗 ({self.name}): {str(e)}")
            return []

        frame = Frame()
        frame.header.stamp = self.node.get_clock().now().to_msg()
        frame.id = self.base_id + 0x20
        frame.dlc = 8
        frame.is_extended = False
        frame.is_rtr = False
        frame.data = list(payload)
        return [frame]

    def handle_can_rx(self, frame: Frame) -> bool:
        can_id = frame.id
        # A. ステータス返信 (Base ID + 0x30)
        if can_id == (self.base_id + 0x30):
            if frame.dlc < 6:
                return True
            data = bytes(frame.data[:6])
            self.feedback_cache["limit_switches"] = [bool(b) for b in data[0:4]]
            self.feedback_cache["error_code"] = data[4]

            prev_status = self.feedback_cache.get("system_status", 0)
            raw_status = int(data[5])
            self.feedback_cache["system_status"] = raw_status

            if raw_status == 1:
                self.param_confirmed = True
                self.node.mdd_param_confirmed[self.base_id] = True
            else:
                sent_at = self.node.mdd_param_sent_at.get(self.base_id, 0.0)
                in_grace_period = (time.monotonic() - sent_at) < 1.5
                if not self.node.is_sending_params and not in_grace_period:
                    if self.node.mdd_param_confirmed.get(self.base_id, False) or (
                        prev_status == 1 and self.node.is_running
                    ):
                        self.param_confirmed = False
                        self.node.mdd_param_confirmed[self.base_id] = False
                        self.node.is_running = False
                        for p in self.node.module_plugins.values():
                            if isinstance(p, MddModulePlugin):
                                p.set_targets_direct([0.0, 0.0, 0.0, 0.0])
                        warn_msg = (
                            f"マイコン '{self.name}' ({hex(self.base_id)}) の待機状態へのリセットを検知したため、"
                            f"PC側の制御フラグを安全にリセットしました。"
                        )
                        self.node.get_logger().warn(warn_msg)
                        self.node.publish_ui_log(f"[SYSTEM] {warn_msg}")

            self._publish_feedback()
            return True

        # B. エンコーダ角度 (Base ID + 0x40)
        if can_id == (self.base_id + 0x40):
            if frame.dlc < 8:
                return True
            angles_raw = struct.unpack("<hhhh", bytes(frame.data[:8]))
            self.feedback_cache["angles"] = [float(a) / 10.0 for a in angles_raw]
            self._publish_feedback()
            return True

        # C. エンコーダ回転速度 (Base ID + 0x50)
        if can_id == (self.base_id + 0x50):
            if frame.dlc < 8:
                return True
            speeds_raw = struct.unpack("<hhhh", bytes(frame.data[:8]))
            self.feedback_cache["speeds"] = [float(s) / 100.0 for s in speeds_raw]
            self._publish_feedback()
            return True

        return False

    def _publish_feedback(self):
        if not self.feedback_pub:
            return
        msg = MddFeedback()
        msg.limit_switches = self.feedback_cache["limit_switches"]
        msg.error_code = self.feedback_cache["error_code"]
        msg.system_status = self.feedback_cache["system_status"]
        msg.angles = self.feedback_cache["angles"]
        msg.speeds = self.feedback_cache["speeds"]
        self.feedback_pub.publish(msg)

    @classmethod
    def create_behavior_client(cls, behavior_node, name: str, module_config: dict):
        return MddClient(behavior_node, name)
