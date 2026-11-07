import math
from typing import Dict, List


class ChassisKinematics:
    """
    ロボット足回りの逆運動学計算クラス。
    4つの構成タイプ (3_OMNI, 4_OMNI, 4_MECANUM, 2_DIFF) に対応し、
    ロボット移動速度指令から MDD 4チャンネル分の目標回転速度 [rps] を算出します。
    ※ 自己位置推定（オドメトリ）は本クラスでは保持せず、外部ノードに委ねる設計です。
    """

    def __init__(self, full_config: dict):
        self.full_config = full_config
        chassis_cfg = full_config.get("chassis", {})

        self.chassis_type: str = chassis_cfg.get("type", "4_MECANUM")
        self.turning_diameter_mm: float = float(chassis_cfg.get("turning_diameter_mm", 300.0))
        self.coord_frame: str = chassis_cfg.get("coord_frame", "ros")  # "ros" (REP-103) or "altair"

        # 対象 MDD モジュール名の解決 (指定がなければ最初の mdd モジュール)
        self.drive_module_name: str = chassis_cfg.get("drive_module", "")
        if not self.drive_module_name:
            for mod in full_config.get("modules", []):
                if mod.get("type") == "mdd":
                    self.drive_module_name = mod.get("name", "MDD1")
                    break
        if not self.drive_module_name:
            self.drive_module_name = "MDD1"

        self.motor_mapping: Dict[str, str] = chassis_cfg.get(
            "motor_mapping",
            {"lf": "m1", "rf": "m2", "lr": "m3", "rr": "m4"},
        )
        self.motor_inverted: Dict[str, bool] = chassis_cfg.get(
            "motor_inverted",
            {"lf": False, "rf": False, "lr": False, "rr": False},
        )

    def _get_motor_diameter_mm(self, slot_name: str) -> float:
        if slot_name == "none":
            return 100.0
        for mod in self.full_config.get("modules", []):
            if mod.get("name") == self.drive_module_name:
                return float(
                    mod.get("parameters", {}).get(slot_name, {}).get("diameter", 100.0)
                )
        return 100.0

    def compute_from_altair_vel(
        self, vx_mm_s: float, vy_mm_s: float, omega_rad_s: float
    ) -> List[float]:
        """
        Altair 座標系での速度指令から各モータの目標回転速度 [rps] を計算します。
        - vx_mm_s     : 左右速度 [mm/s] (正 = 右移動)
        - vy_mm_s     : 前後速度 [mm/s] (正 = 前進)
        - omega_rad_s : 旋回角速度 [rad/s] (正 = 反時計回り / 左旋回)
        """
        vx_m_s = float(vx_mm_s) / 1000.0
        vy_m_s = float(vy_mm_s) / 1000.0
        omega = float(omega_rad_s)
        r_t = self.turning_diameter_mm / 2000.0

        slot_lf = self.motor_mapping.get("lf", "m1")
        slot_rf = self.motor_mapping.get("rf", "m2")
        slot_lr = self.motor_mapping.get("lr", "m3")
        slot_rr = self.motor_mapping.get("rr", "m4")

        inv_lf = -1.0 if self.motor_inverted.get("lf", False) else 1.0
        inv_rf = -1.0 if self.motor_inverted.get("rf", False) else 1.0
        inv_lr = -1.0 if self.motor_inverted.get("lr", False) else 1.0
        inv_rr = -1.0 if self.motor_inverted.get("rr", False) else 1.0

        dia_lf = self._get_motor_diameter_mm(slot_lf)
        dia_rf = self._get_motor_diameter_mm(slot_rf)
        dia_lr = self._get_motor_diameter_mm(slot_lr)
        dia_rr = self._get_motor_diameter_mm(slot_rr)

        k_lf = (1000.0 / (math.pi * dia_lf)) if dia_lf > 0 else 1.0
        k_rf = (1000.0 / (math.pi * dia_rf)) if dia_rf > 0 else 1.0
        k_lr = (1000.0 / (math.pi * dia_lr)) if dia_lr > 0 else 1.0
        k_rr = (1000.0 / (math.pi * dia_rr)) if dia_rr > 0 else 1.0

        target_speeds = [0.0, 0.0, 0.0, 0.0]

        def assign_slot(slot: str, rps_value: float):
            if slot in ("m1", "m2", "m3", "m4"):
                idx = int(slot[1]) - 1
                target_speeds[idx] = float(rps_value)

        if self.chassis_type == "3_OMNI":
            v1 = (vy_m_s + r_t * omega) * inv_lf
            v2 = (-0.8660254 * vx_m_s - 0.5 * vy_m_s + r_t * omega) * inv_rf
            v3 = (0.8660254 * vx_m_s - 0.5 * vy_m_s + r_t * omega) * inv_lr

            assign_slot(slot_lf, v1 * k_lf)
            assign_slot(slot_rf, v2 * k_rf)
            assign_slot(slot_lr, v3 * k_lr)

        elif self.chassis_type == "4_OMNI":
            c45 = 0.70710678
            v_lf = (-c45 * vx_m_s + c45 * vy_m_s - r_t * omega) * inv_lf
            v_rf = (c45 * vx_m_s + c45 * vy_m_s + r_t * omega) * inv_rf
            v_lr = (-c45 * vx_m_s - c45 * vy_m_s + r_t * omega) * inv_lr
            v_rr = (c45 * vx_m_s - c45 * vy_m_s - r_t * omega) * inv_rr

            assign_slot(slot_lf, v_lf * k_lf)
            assign_slot(slot_rf, v_rf * k_rf)
            assign_slot(slot_lr, v_lr * k_lr)
            assign_slot(slot_rr, v_rr * k_rr)

        elif self.chassis_type == "4_MECANUM":
            v_lf = (vy_m_s - vx_m_s - r_t * omega) * inv_lf
            v_rf = (vy_m_s + vx_m_s + r_t * omega) * inv_rf
            v_lr = (vy_m_s + vx_m_s - r_t * omega) * inv_lr
            v_rr = (vy_m_s - vx_m_s + r_t * omega) * inv_rr

            assign_slot(slot_lf, v_lf * k_lf)
            assign_slot(slot_rf, v_rf * k_rf)
            assign_slot(slot_lr, v_lr * k_lr)
            assign_slot(slot_rr, v_rr * k_rr)

        elif self.chassis_type == "2_DIFF":
            v_l = vy_m_s - r_t * omega
            v_r = vy_m_s + r_t * omega

            assign_slot(slot_lf, v_l * k_lf * inv_lf)
            assign_slot(slot_lr, v_l * k_lr * inv_lr)
            assign_slot(slot_rf, v_r * k_rf * inv_rf)
            assign_slot(slot_rr, v_r * k_rr * inv_rr)

        return target_speeds

    def compute_from_ros_twist(
        self, linear_x_m_s: float, linear_y_m_s: float, angular_z_rad_s: float
    ) -> List[float]:
        """
        ROS 2 標準 geometry_msgs/msg/Twist から目標回転速度 [rps] を計算します。
        - デフォルト (coord_frame="ros", REP-103準拠):
          - linear.x  [m/s]   : 前進が正 (+Vy)
          - linear.y  [m/s]   : 左移動が正 (-Vx)
          - angular.z [rad/s] : 左旋回（反時計回り）が正 (+Omega)
        - coord_frame="altair" 指定時:
          - linear.x  [m/s]   : 右移動が正 (+Vx)
          - linear.y  [m/s]   : 前進が正 (+Vy)
          - angular.z [rad/s] : 左旋回が正 (+Omega)
        """
        if self.coord_frame == "altair":
            vx_mm_s = float(linear_x_m_s) * 1000.0
            vy_mm_s = float(linear_y_m_s) * 1000.0
        else:
            vy_mm_s = float(linear_x_m_s) * 1000.0
            vx_mm_s = -float(linear_y_m_s) * 1000.0

        return self.compute_from_altair_vel(vx_mm_s, vy_mm_s, float(angular_z_rad_s))
