import json
import os
import time
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup

# メッセージ定義
from std_msgs.msg import String
from sensor_msgs.msg import Joy
from geometry_msgs.msg import Twist

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

        # 足回りヘルパーの初期化
        self.chassis = ChassisClient(self)

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

        self._ros_executor = rclpy.executors.MultiThreadedExecutor()
        self._ros_executor.add_node(self)

        try:
            self.get_logger().info(f"周期実行ループを開始します (周波数: {rate_hz} Hz)...")
            self._ros_executor.spin()
        except KeyboardInterrupt:
            pass
        finally:
            self.destroy_node()
