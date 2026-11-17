import json
import math
import os
import struct
import threading
import time
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup

# メッセージ定義
from std_msgs.msg import String
from sensor_msgs.msg import Joy
from geometry_msgs.msg import Twist
from can_msgs.msg import Frame

from altair_core.paths import get_config_path
from altair_core.kinematics import ChassisKinematics
from altair_core.modules import (
    MddClient,
    ServoClient,
    SolenoidClient,
    RobomasClient,
    discover_module_plugins,
    get_module_plugin_class,
)


class GamepadState:
    """
    ゲームコントローラーの各スイッチやスティックの入力を変数として保持するクラス。
    /altair/joy (sensor_msgs/msg/Joy) と /altair/gamepad/state (JSON) の双方に対応します。
    """
    def __init__(self):
        self.axes = [0.0] * 8
        self.buttons = [False] * 16

    def get_button(self, index: int) -> bool:
        """指定インデックスのボタン状態 (True=ON, False=OFF) を取得します。"""
        if 0 <= index < len(self.buttons):
            return bool(self.buttons[index])
        return False

    def get_axis(self, index: int) -> float:
        """指定インデックスのアナログスティック軸状態 (-1.0〜1.0) を取得します。"""
        if 0 <= index < len(self.axes):
            return float(self.axes[index])
        return 0.0


class ChassisClient:
    """
    足回り運動学制御クライアント。
    自己位置推定は外部ノードに委ね、ロボット座標系での速度指令 (Vx, Vy, Omega) や
    ROS 2 標準の /altair/cmd_vel (geometry_msgs/msg/Twist) 送出を簡便化します。
    """
    def __init__(self, behavior_node: "AltairBehavior"):
        self.node = behavior_node
        self.kinematics = ChassisKinematics(behavior_node.config)
        self.cmd_vel_pub = behavior_node.create_publisher(Twist, "/altair/cmd_vel", 10)

    def set_velocity(self, vx_mm_s: float, vy_mm_s: float, omega_rad_s: float):
        """
        Altair 座標系で足回りの移動速度を指令します。
        - vx_mm_s     : 左右速度 [mm/s] (正=右移動, 負=左移動)
        - vy_mm_s     : 前後速度 [mm/s] (正=前進, 負=後退)
        - omega_rad_s : 旋回角速度 [rad/s] (正=左旋回/反時計回り)
        """
        wheel_rps = self.kinematics.compute_from_altair_vel(vx_mm_s, vy_mm_s, omega_rad_s)
        mdd = self.node.get_module(self.kinematics.drive_module_name)
        mdd.set_targets(wheel_rps)

    def publish_cmd_vel(self, linear_x_m_s: float, linear_y_m_s: float = 0.0, angular_z_rad_s: float = 0.0):
        """
        ROS 2 標準の /altair/cmd_vel (geometry_msgs/msg/Twist) トピックへ速度指令を配信します。
        - linear_x_m_s  : 前後速度 [m/s] (正=前進)
        - linear_y_m_s  : 左右速度 [m/s] (正=左移動)
        - angular_z_rad_s: 旋回角速度 [rad/s] (正=左旋回)
        """
        msg = Twist()
        msg.linear.x = float(linear_x_m_s)
        msg.linear.y = float(linear_y_m_s)
        msg.angular.z = float(angular_z_rad_s)
        self.cmd_vel_pub.publish(msg)

    def stop(self):
        """足回りを即時停止します。"""
        self.set_velocity(0.0, 0.0, 0.0)


class RawCanClient:
    """
    任意の CAN ID に対する汎用バイト列送受信クライアント (Windows / ROS2 共通API)
    """

    _DTYPE_SPECS = {
        "uint8": ("<B", 1, 0, 255),
        "int8": ("<b", 1, -128, 127),
        "uint16_le": ("<H", 2, 0, 65535),
        "int16_le": ("<h", 2, -32768, 32767),
        "uint16_be": (">H", 2, 0, 65535),
        "int16_be": (">h", 2, -32768, 32767),
        "uint32_le": ("<I", 4, 0, 4294967295),
        "int32_le": ("<i", 4, -2147483648, 2147483647),
        "uint32_be": (">I", 4, 0, 4294967295),
        "int32_be": (">i", 4, -2147483648, 2147483647),
        "float32_le": ("<f", 4, None, None),
        "float32_be": (">f", 4, None, None),
    }

    def __init__(self, behavior: "AltairBehavior"):
        self.behavior = behavior
        self._lock = threading.Lock()
        self._rx_frames = {}
        self._warned_keys = set()
        self._last_send_times = {}

    def _warn_once(self, key: str, msg: str):
        with self._lock:
            if key in self._warned_keys:
                return
            self._warned_keys.add(key)
        self.behavior.get_logger().warn(msg)

    def _parse_can_id(self, can_id):
        try:
            if isinstance(can_id, bool):
                raise ValueError("bool is not valid CAN ID")
            if isinstance(can_id, int):
                sid = int(can_id)
            elif isinstance(can_id, float):
                if not math.isfinite(can_id) or not can_id.is_integer():
                    raise ValueError("non-integer float CAN ID")
                sid = int(can_id)
            else:
                sid = int(str(can_id).strip(), 0)
            if 1 <= sid <= 0x7FF:
                return sid
        except Exception:
            pass
        self._warn_once(
            f"bad_id_{can_id}",
            f"無効な CAN ID '{can_id}' が指定されました (0x001〜0x7FF の標準IDを指定してください)。",
        )
        return None

    def _normalize_channel(self, channel: str) -> str:
        ch = str(channel or "default").strip().lower()
        if ch in ("can1", "can2", "both"):
            return ch
        return "default"

    def _update_rx_frame(self, can_id: int, data_bytes: bytes):
        sid = int(can_id) & 0x7FF
        if sid == 0:
            return
        with self._lock:
            self._rx_frames[sid] = bytes(data_bytes)[:8]

    def has_frame(self, can_id) -> bool:
        sid = self._parse_can_id(can_id)
        if sid is None:
            return False
        with self._lock:
            return sid in self._rx_frames

    def read_bytes(self, can_id) -> list:
        sid = self._parse_can_id(can_id)
        if sid is None:
            return []
        with self._lock:
            raw = self._rx_frames.get(sid)
        return list(raw) if raw is not None else []

    def read_byte(self, can_id, offset=0, default=0) -> int:
        return int(self.read_value(can_id, offset=offset, dtype="uint8", scale=1.0, default=default))

    def read_bit(self, can_id, offset=0, bit_idx=0) -> bool:
        try:
            off = int(offset)
            bit = int(bit_idx)
        except Exception:
            return False
        if not (0 <= off < 8 and 0 <= bit < 8):
            return False
        sid = self._parse_can_id(can_id)
        if sid is None:
            return False
        with self._lock:
            raw = self._rx_frames.get(sid)
        if raw is None or len(raw) <= off:
            return False
        return bool((raw[off] >> bit) & 1)

    def read_value(self, can_id, offset=0, dtype="uint8", scale=1.0, default=0.0) -> float:
        sid = self._parse_can_id(can_id)
        if sid is None:
            return default
        spec = self._DTYPE_SPECS.get(str(dtype).strip().lower())
        if spec is None:
            self._warn_once(f"bad_dtype_{dtype}", f"未知のデータ型 '{dtype}' が指定されました。")
            return default
        fmt, size, _, _ = spec
        try:
            off = int(offset)
            sc = float(scale)
        except Exception:
            return default
        if off < 0 or off + size > 8:
            self._warn_once(
                f"bad_range_{off}_{size}",
                f"バイト位置の範囲外です (offset={off}, size={size} は 0〜7 バイトに収まる必要があります)。",
            )
            return default

        with self._lock:
            raw = self._rx_frames.get(sid)
        if raw is None or len(raw) < off + size:
            return default
        try:
            val = struct.unpack_from(fmt, raw, off)[0] * sc
            if not math.isfinite(val):
                return default
            return val
        except Exception:
            return default

    def send_bytes(self, can_id, data, channel="default"):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return
        if isinstance(data, bool) or isinstance(data, (str, dict)):
            self._warn_once(
                "bad_tx_data_type",
                "send_bytes の data にはバイト配列 (list/tuple/bytes) を指定してください。",
            )
            return
        if isinstance(data, (int, float)):
            seq = [data]
        elif isinstance(data, (list, tuple, bytes, bytearray)):
            seq = list(data)
        else:
            self._warn_once(
                "bad_tx_data_type",
                "send_bytes の data にはバイト配列 (list/tuple/bytes) を指定してください。",
            )
            return
        payload = []
        for item in seq[:8]:
            try:
                if isinstance(item, bool):
                    v = int(item)
                else:
                    f = float(item)
                    if not math.isfinite(f):
                        v = 0
                    else:
                        v = int(round(f))
            except Exception:
                v = 0
            payload.append(max(0, min(255, v)))

        ch = self._normalize_channel(channel)
        rate_key = (sid, ch)
        sleep_sec = 0.0
        now = time.monotonic()
        with self._lock:
            next_allowed = self._last_send_times.get(rate_key, 0.0) + 0.0005
            if now < next_allowed:
                sleep_sec = next_allowed - now
                self._last_send_times[rate_key] = next_allowed
            else:
                self._last_send_times[rate_key] = now
        if sleep_sec > 0.0:
            time.sleep(sleep_sec)

        msg = Frame()
        msg.header.stamp = self.behavior.get_clock().now().to_msg()
        msg.header.frame_id = "" if ch == "default" else ch
        msg.id = sid
        msg.is_rtr = False
        msg.is_extended = False
        msg.is_error = False
        msg.dlc = len(payload)
        msg.data = payload + [0] * (8 - len(payload))
        self.behavior.can_tx_pub.publish(msg)

    def send_value(self, can_id, value, offset=0, dtype="int16_le", dlc=8, channel="default"):
        sid = self._parse_can_id(can_id)
        if sid is None:
            return
        spec = self._DTYPE_SPECS.get(str(dtype).strip().lower())
        if spec is None:
            self._warn_once(f"bad_dtype_{dtype}", f"未知のデータ型 '{dtype}' が指定されました。")
            return
        fmt, size, min_v, max_v = spec
        try:
            off = int(offset)
            req_dlc = int(dlc)
            fval = float(value)
        except Exception:
            return
        if off < 0 or off + size > 8:
            self._warn_once(
                f"bad_range_{off}_{size}",
                f"バイト位置の範囲外です (offset={off}, size={size} は 0〜7 バイトに収まる必要があります)。",
            )
            return
        if not math.isfinite(fval):
            fval = 0.0

        eff_dlc = max(off + size, min(8, req_dlc))
        buf = bytearray(eff_dlc)
        if min_v is not None and max_v is not None:
            ival = int(round(fval))
            ival = max(min_v, min(max_v, ival))
            struct.pack_into(fmt, buf, off, ival)
        else:
            struct.pack_into(fmt, buf, off, fval)

        self.send_bytes(sid, list(buf), channel=channel)


class AltairBehavior(Node):
    """
    すべてのユーザー動作プログラム（Behavior）のベースとなるROS2ノードクラス。
    ユーザーやAIは、このクラスを継承して on_init() や loop() をオーバーライドします。
    """
    def __init__(self, node_name="user_behavior_node"):
        super().__init__(node_name)
        self.callback_group = ReentrantCallbackGroup()
        self._module_clients = {}

        # ステートマシン記述補助用タイマー・状態変数
        self.state = "INIT"
        self._state_entered_at = time.monotonic()

        # プラグインの検出と設定のロード
        discover_module_plugins()
        self.config = self._load_config()

        # 足回りヘルパーおよび汎用CANクライアントの初期化
        self.chassis = ChassisClient(self)
        self.can = RawCanClient(self)
        self.can_tx_pub = self.create_publisher(Frame, '/altair/can/tx', 100)
        self.can_rx_sub = self.create_subscription(
            Frame, '/altair/can/rx', self._can_rx_callback, 200,
            callback_group=self.callback_group
        )

        # ゲームコントローラー状態の自動購読 (ROS 2 標準 Joy & WebUI JSON 両対応)
        self.gamepad = GamepadState()
        self.joy_sub = self.create_subscription(
            Joy, '/altair/joy', self._joy_callback, 10,
            callback_group=self.callback_group
        )
        self.gamepad_sub = self.create_subscription(
            String, '/altair/gamepad/state', self._gamepad_callback, 10,
            callback_group=self.callback_group
        )

        # 派生クラスの初期化
        self.on_init()
        self.get_logger().info(f"動作プログラム {node_name} が初期化されました。")

    def _can_rx_callback(self, msg: Frame):
        if msg.is_extended or msg.is_rtr or msg.is_error:
            return
        dlc = max(0, min(8, int(msg.dlc)))
        self.can._update_rx_frame(msg.id, bytes(int(b) & 0xFF for b in msg.data[:dlc]))

    def _joy_callback(self, msg: Joy):
        self.gamepad.axes = [float(a) for a in msg.axes]
        self.gamepad.buttons = [bool(b) for b in msg.buttons]

    def _gamepad_callback(self, msg: String):
        try:
            data = json.loads(msg.data)
            self.gamepad.axes = [float(a) for a in data.get("axes", [])]
            self.gamepad.buttons = [bool(b) for b in data.get("buttons", [])]
        except Exception:
            pass

    def _load_config(self):
        config_path = get_config_path()
        if os.path.exists(config_path):
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                self.get_logger().error(f"設定ファイルの読み込みに失敗しました ({config_path}): {str(e)}")
        return {"modules": []}

    def get_module(self, name: str):
        """
        モジュール名から、そのモジュールを操作するためのクライアントオブジェクトを取得します。
        プラグイン登録された任意のカスタムモジュールにも対応します。
        """
        if name in self._module_clients:
            return self._module_clients[name]

        target_cfg = None
        for module_cfg in self.config.get('modules', []):
            if module_cfg.get('name') == name:
                target_cfg = module_cfg
                break

        if not target_cfg:
            self.get_logger().error(f"設定ファイル内にモジュール名 '{name}' が見つかりませんでした。")
            raise ValueError(f"Module '{name}' not found in configuration.")

        mtype = target_cfg.get('type')
        plugin_cls = get_module_plugin_class(mtype)
        if plugin_cls is None:
            self.get_logger().error(f"未知のモジュールタイプ: '{mtype}'")
            raise ValueError(f"Unknown module type '{mtype}'")

        client = plugin_cls.create_behavior_client(self, name, target_cfg)
        self._module_clients[name] = client
        return client

    # --- 足回り・ステートマシン記述用ヘルパーメソッド ---
    def set_chassis_velocity(self, vx_mm_s: float, vy_mm_s: float, omega_rad_s: float):
        """足回りの移動速度 (vx[mm/s], vy[mm/s], omega[rad/s]) を逆運動学計算して設定します。"""
        self.chassis.set_velocity(vx_mm_s, vy_mm_s, omega_rad_s)

    def stop_chassis(self):
        """足回りモータを即時停止します。"""
        self.chassis.stop()

    def set_state(self, new_state: str):
        """ステートマシンの状態を遷移し、経過時間タイマーをリセットします。"""
        if self.state != new_state:
            self.get_logger().info(f"[State] {self.state} -> {new_state}")
            self.state = new_state
            self._state_entered_at = time.monotonic()

    def elapsed_in_state(self) -> float:
        """現在のステートに遷移してからの経過秒数を返します（ノンブロッキング待機用）。"""
        return time.monotonic() - self._state_entered_at

    def on_init(self):
        """動作の初期化処理（派生クラスでオーバーライドします）"""
        pass

    def loop(self):
        """周期実行される動作処理（派生クラスでオーバーライドします）"""
        pass

    def run(self, rate_hz=100.0):
        """
        動作プログラムの周期実行ループを開始します。
        rate_hz: 周期の周波数で、デフォルトは100 Hzです。
        """
        self.timer = self.create_timer(
            1.0 / rate_hz, self.loop,
            callback_group=self.callback_group
        )

        self._ros_executor = rclpy.executors.MultiThreadedExecutor(
            num_threads=max(4, os.cpu_count() or 4)
        )
        self._ros_executor.add_node(self)

        try:
            self.get_logger().info(f"周期実行ループを開始します (周波数: {rate_hz} Hz)...")
            self._ros_executor.spin()
        except KeyboardInterrupt:
            pass
        finally:
            self.destroy_node()
