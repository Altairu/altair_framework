import math
import struct
import time
from typing import Optional, Tuple
from can_msgs.msg import Frame
from altair_interfaces.msg import RobomasCommand, RobomasFeedback
from altair_core.modules.base_module import BaseModulePlugin, register_module


def parse_robomas_motor_id(base_id_raw, motor_model: str) -> Optional[int]:
    """
    RoboMaster のモーターID (1〜8, GM6020は1〜7) をパースする。
    "1"〜"8" の10進指定と "0x201"〜"0x20B" のフィードバックCAN ID指定の双方に対応する。
    """
    raw = str(base_id_raw or "").strip()
    max_id = 7 if motor_model == "gm6020" else 8
    try:
        if raw.lower().startswith("0x"):
            hex_val = int(raw, 16)
            if motor_model == "gm6020":
                if 0x205 <= hex_val <= 0x20B:
                    return hex_val - 0x204
                if 1 <= hex_val <= 7:
                    return hex_val
            else:
                if 0x201 <= hex_val <= 0x208:
                    return hex_val - 0x200
                if 1 <= hex_val <= 8:
                    return hex_val
        else:
            dec = int(raw, 10)
            if 1 <= dec <= max_id:
                return dec
    except ValueError:
        return None
    return None


def get_robomas_can_ids(motor_model: str, motor_id: int) -> Tuple[int, int, int]:
    """
    (送信CAN ID, スロット番号0..3, 受信フィードバックCAN ID) を返す。
    """
    if motor_model == "gm6020":
        if motor_id <= 4:
            return (0x1FF, motor_id - 1, 0x204 + motor_id)
        return (0x2FF, motor_id - 5, 0x204 + motor_id)
    if motor_id <= 4:
        return (0x200, motor_id - 1, 0x200 + motor_id)
    return (0x1FF, motor_id - 5, 0x200 + motor_id)


class RobomasClient:
    """
    RoboMaster モーター (M3508 / M2006 / GM6020) 制御用クライアントクラス
    """

    def __init__(self, node, name: str):
        self.node = node
        self.name = name
        self.latest_feedback = RobomasFeedback()
        self.cmd_pub = node.create_publisher(RobomasCommand, f"/altair/{name}/cmd", 10)
        self.feedback_sub = node.create_subscription(
            RobomasFeedback,
            f"/altair/{name}/feedback",
            self._feedback_callback,
            10,
            callback_group=node.callback_group,
        )

    def _feedback_callback(self, msg: RobomasFeedback):
        self.latest_feedback = msg

    def set_target(self, target: float, mode: Optional[str] = None):
        """目標値を設定する (mode 省略時はモジュール設定の制御モードを使用)"""
        val = float(target)
        if not math.isfinite(val):
            val = 0.0
        msg = RobomasCommand()
        msg.target = val
        msg.mode = str(mode) if mode else ""
        msg.reset_zero = False
        self.cmd_pub.publish(msg)

    def set_current(self, current_cmd: float):
        """電流指令値を設定する (-16384〜16384)"""
        self.set_target(current_cmd, mode="current")

    def set_voltage(self, voltage_cmd: float):
        """電圧指令値を設定する (-30000〜30000, GM6020用)"""
        self.set_target(voltage_cmd, mode="voltage")

    def set_speed(self, rpm: float):
        """速度PIDの目標回転数 [rpm] を設定する"""
        self.set_target(rpm, mode="speed_pid")

    def set_position(self, deg: float):
        """位置PIDの目標角度 [deg] を設定する"""
        self.set_target(deg, mode="position_pid")

    def reset_zero(self):
        """多回転累積角度の現在位置を 0° にリセットする"""
        msg = RobomasCommand()
        msg.target = 0.0
        msg.mode = ""
        msg.reset_zero = True
        self.cmd_pub.publish(msg)

    def stop(self):
        """出力をゼロにして停止する"""
        self.set_target(0.0, mode="current")

    def get_feedback(self) -> RobomasFeedback:
        """最新のフィードバックメッセージ (RobomasFeedback) を返す"""
        return self.latest_feedback


@register_module("robomas")
class RobomasModulePlugin(BaseModulePlugin):
    """
    RoboMaster モーター (M3508 / M2006 / GM6020) モジュールプラグイン
    """

    def __init__(self, manager_node, module_config: dict):
        super().__init__(manager_node, module_config)
        rm_cfg = module_config.get("robomas") or {}
        self.motor_model = str(rm_cfg.get("motor_model", "m3508")).lower()
        self.control_mode = str(
            rm_cfg.get("control_mode", "voltage" if self.motor_model == "gm6020" else "current")
        ).lower()
        self.vel_kp = float(rm_cfg.get("vel_kp", 20.0))
        self.vel_ki = float(rm_cfg.get("vel_ki", 0.5))
        self.vel_kd = float(rm_cfg.get("vel_kd", 0.0))
        self.pos_kp = float(rm_cfg.get("pos_kp", 3.0))
        self.pos_ki = float(rm_cfg.get("pos_ki", 0.0))
        self.pos_kd = float(rm_cfg.get("pos_kd", 0.0))
        self.max_speed_rpm = float(rm_cfg.get("max_speed_rpm", 300.0))
        default_max_out = 25000.0 if (self.motor_model == "gm6020" and self.control_mode != "current") else 10000.0
        self.max_output = float(rm_cfg.get("max_output", default_max_out))
        self.direction = -1.0 if int(rm_cfg.get("direction", 1)) < 0 else 1.0

        self.motor_id = parse_robomas_motor_id(module_config.get("base_id", "1"), self.motor_model)
        if self.motor_id is not None:
            self.tx_can_id, self.slot_idx, self.rx_can_id = get_robomas_can_ids(
                self.motor_model, self.motor_id
            )
        else:
            self.tx_can_id = None
            self.slot_idx = 0
            self.rx_can_id = None

        self.target = 0.0
        self.mode_override = ""
        self.force_stop = False

        # エンコーダ多回転累積状態
        self.angle_initialized = False
        self.last_raw_angle = 0
        self.total_counts = 0

        # 最新フィードバック値
        self.raw_angle = 0
        self.single_angle_deg = 0.0
        self.angle_deg = 0.0
        self.speed_rpm = 0
        self.torque_current = 0
        self.current_a = 0.0
        self.temperature = 0
        self.output_cmd = 0

        # PID内部状態
        self.vel_integral = 0.0
        self.vel_prev_error = 0.0
        self.pos_integral = 0.0
        self.pos_prev_error = 0.0
        self.last_pid_time: Optional[float] = None

        self.feedback_pub = None

    def setup_ros_interfaces(self):
        cmd_topic = f"/altair/{self.name}/cmd"
        fb_topic = f"/altair/{self.name}/feedback"
        self.create_module_subscription(RobomasCommand, cmd_topic, self._on_cmd)
        self.feedback_pub = self.create_module_publisher(RobomasFeedback, fb_topic)

    def reset_pid(self):
        self.vel_integral = 0.0
        self.vel_prev_error = 0.0
        self.pos_integral = 0.0
        self.pos_prev_error = 0.0
        self.last_pid_time = None

    def stop_immediately(self):
        self.force_stop = True
        self.target = 0.0
        self.output_cmd = 0
        self.reset_pid()

    def _on_cmd(self, msg: RobomasCommand):
        if msg.reset_zero:
            self.total_counts = 0
            self.angle_deg = 0.0
            self.reset_pid()
            return

        val = float(msg.target)
        if not math.isfinite(val):
            val = 0.0
        new_mode = (msg.mode or "").strip().lower()
        if new_mode != self.mode_override:
            self.reset_pid()
            self.mode_override = new_mode
        self.force_stop = False
        self.target = val

    def is_manually_active(self) -> bool:
        if self.force_stop:
            return False
        mode = self.mode_override if self.mode_override else self.control_mode
        if mode == "position_pid" and abs(self.angle_deg) > 0.5:
            return True
        return abs(self.target) > 0.0001

    def compute_output(self, now_monotonic: float) -> int:
        if self.last_pid_time is None:
            dt = 0.01
        else:
            dt = max(0.0005, min(0.1, now_monotonic - self.last_pid_time))
        self.last_pid_time = now_monotonic

        if self.force_stop:
            self.output_cmd = 0
            return 0

        mode = self.mode_override if self.mode_override else self.control_mode
        target = self.target * self.direction
        hard_limit = 30000.0 if (self.motor_model == "gm6020" and mode != "current") else 16384.0
        max_out = max(0.0, min(hard_limit, abs(self.max_output)))

        if mode in ("current", "voltage"):
            self.vel_integral = 0.0
            self.pos_integral = 0.0
            raw_out = max(-max_out, min(max_out, target))
        elif mode == "speed_pid":
            self.pos_integral = 0.0
            err = target - float(self.speed_rpm)
            deriv = (err - self.vel_prev_error) / dt
            self.vel_prev_error = err
            if abs(self.vel_ki) > 1e-9:
                max_i = max_out / abs(self.vel_ki)
                self.vel_integral = max(-max_i, min(max_i, self.vel_integral + err * dt))
            else:
                self.vel_integral = 0.0
            raw_out = self.vel_kp * err + self.vel_ki * self.vel_integral + self.vel_kd * deriv
            raw_out = max(-max_out, min(max_out, raw_out))
        elif mode == "position_pid":
            pos_err = target - self.angle_deg
            pos_deriv = (pos_err - self.pos_prev_error) / dt
            self.pos_prev_error = pos_err
            max_spd = max(1.0, abs(self.max_speed_rpm))
            if abs(self.pos_ki) > 1e-9:
                max_pi = max_spd / abs(self.pos_ki)
                self.pos_integral = max(-max_pi, min(max_pi, self.pos_integral + pos_err * dt))
            else:
                self.pos_integral = 0.0
            target_rpm = self.pos_kp * pos_err + self.pos_ki * self.pos_integral + self.pos_kd * pos_deriv
            target_rpm = max(-max_spd, min(max_spd, target_rpm))

            vel_err = target_rpm - float(self.speed_rpm)
            vel_deriv = (vel_err - self.vel_prev_error) / dt
            self.vel_prev_error = vel_err
            if abs(self.vel_ki) > 1e-9:
                max_i = max_out / abs(self.vel_ki)
                self.vel_integral = max(-max_i, min(max_i, self.vel_integral + vel_err * dt))
            else:
                self.vel_integral = 0.0
            raw_out = self.vel_kp * vel_err + self.vel_ki * self.vel_integral + self.vel_kd * vel_deriv
            raw_out = max(-max_out, min(max_out, raw_out))
        else:
            raw_out = 0.0

        out_int = int(max(-hard_limit, min(hard_limit, round(raw_out))))
        self.output_cmd = out_int
        return out_int

    def handle_can_rx(self, frame: Frame) -> bool:
        if self.rx_can_id is None or frame.id != self.rx_can_id:
            return False
        if not self.matches_rx_channel(frame):
            return False
        data = bytes(frame.data)
        if len(data) < 6:
            return False

        raw_angle = (data[0] << 8) | data[1]
        speed_rpm, torque_current = struct.unpack(">hh", data[2:6])
        temp = int(data[6]) if len(data) > 6 else 0

        if not self.angle_initialized:
            self.angle_initialized = True
            self.last_raw_angle = raw_angle
            self.total_counts = 0
        else:
            diff = raw_angle - self.last_raw_angle
            if diff > 4096:
                diff -= 8192
            elif diff < -4096:
                diff += 8192
            self.total_counts += diff
            self.last_raw_angle = raw_angle

        self.raw_angle = raw_angle
        self.single_angle_deg = raw_angle * 360.0 / 8192.0
        self.angle_deg = self.total_counts * 360.0 / 8192.0
        self.speed_rpm = speed_rpm
        self.torque_current = torque_current
        self.temperature = temp

        if self.motor_model == "m3508":
            self.current_a = torque_current * 20.0 / 16384.0
        elif self.motor_model == "m2006":
            self.current_a = torque_current * 10.0 / 16384.0
        elif self.motor_model == "gm6020":
            self.current_a = torque_current * 1.62 / 16384.0
        else:
            self.current_a = torque_current * 20.0 / 16384.0

        if self.feedback_pub is not None:
            fb_msg = RobomasFeedback()
            fb_msg.raw_angle = self.raw_angle
            fb_msg.single_angle_deg = float(self.single_angle_deg)
            fb_msg.angle_deg = float(self.angle_deg)
            fb_msg.speed_rpm = int(self.speed_rpm)
            fb_msg.torque_current = int(self.torque_current)
            fb_msg.current_a = float(self.current_a)
            fb_msg.temperature = int(self.temperature)
            fb_msg.output_cmd = int(self.output_cmd)
            fb_msg.target = float(self.target)
            fb_msg.control_mode = self.mode_override if self.mode_override else self.control_mode
            self.feedback_pub.publish(fb_msg)

        return True

    @classmethod
    def create_behavior_client(cls, behavior_node, name: str, module_config: dict):
        _ = module_config
        return RobomasClient(behavior_node, name)
