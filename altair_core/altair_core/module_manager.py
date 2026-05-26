import json
import os
import struct
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup

# ROS2 標準 ＆ カスタムメッセージ
from can_msgs.msg import Frame
from altair_interfaces.msg import MddFeedback, MddCommand, ServoCommand, SolenoidCommand
from altair_interfaces.srv import TriggerControl

class ModuleManager(Node):
    def __init__(self):
        super().__init__('module_manager')
        self.callback_group = ReentrantCallbackGroup()

        # パブリッシャ: CAN送信用のトピック
        self.can_tx_pub = self.create_publisher(Frame, '/altair/can/tx', 100)

        # サブスクライバ: NUCからのCAN受信用のトピック
        self.can_rx_sub = self.create_subscription(
            Frame, '/altair/can/rx', self.handle_can_rx_callback, 100,
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

        # 動的生成したパブリッシャ/サブスクライバの保持用ディクショナリ
        self.publishers_dict = {}
        self.subscriptions_dict = {}
        
        # モータごとの最新フィードバックデータをキャッシュする（角度と速度を1つのトピックに統合するため）
        self.mdd_feedback_cache = {}

        # 制御システムの状態 (False = パラメータ送信待ち, True = 制御実行中)
        self.is_running = False

        # 設定ファイルのロードと動的初期化
        self.load_config_and_initialize()

        self.get_logger().info("Module Manager ノードが起動しました。初期設定ロード完了。")

    def load_config_and_initialize(self):
        """
        config/modules_config.json をロードし、動的トピックを構築する
        """
        # 一旦既存の動的トピックをクリア
        for sub in self.subscriptions_dict.values():
            self.destroy_subscription(sub)
        for pub in self.publishers_dict.values():
            self.destroy_publisher(pub)
        
        self.publishers_dict.clear()
        self.subscriptions_dict.clear()
        self.mdd_feedback_cache.clear()

        # パッケージのシェアディレクトリまたはローカルパスからロード
        config_path = self.get_config_path()
        self.get_logger().info(f"設定ファイルをロード中: {config_path}")

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)
        except Exception as e:
            self.get_logger().error(f"設定ファイルの読み込みに失敗しました: {str(e)}")
            return

        # 各モジュールをループ処理して動的トピックを作成
        for module in self.config.get('modules', []):
            name = module['name']
            mtype = module['type']
            base_id = int(module['base_id'], 16)

            self.get_logger().info(f"モジュールを登録: {name} (タイプ: {mtype}, BaseID: {hex(base_id)})")

            if mtype == 'mdd':
                # MDDモータ指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    MddCommand, topic_name,
                    self.make_mdd_cmd_callback(name, base_id), 10,
                    callback_group=self.callback_group
                )
                
                # MDDフィードバック用パブリッシャ
                feedback_topic = f"/altair/{name}/feedback"
                self.publishers_dict[feedback_topic] = self.create_publisher(
                    MddFeedback, feedback_topic, 10
                )

                # フィードバック用キャッシュの初期化
                self.mdd_feedback_cache[base_id] = {
                    'limit_switches': [False, False, False, False],
                    'error_code': 0,
                    'system_status': 0,
                    'angles': [0.0, 0.0, 0.0, 0.0],
                    'speeds': [0.0, 0.0, 0.0, 0.0]
                }

            elif mtype == 'servo':
                # サーボ指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    ServoCommand, topic_name,
                    self.make_servo_cmd_callback(name, base_id), 10,
                    callback_group=self.callback_group
                )

            elif mtype == 'solenoid':
                # 電磁弁指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    SolenoidCommand, topic_name,
                    self.make_solenoid_cmd_callback(name, base_id), 10,
                    callback_group=self.callback_group
                )

    def get_config_path(self):
        """
        モジュール構成ファイルの絶対パスを探索して返す
        """
        paths = [
            # 1. ワークスペースのローカルソースパス
            "c:/Users/106no/Documents/GitHub/altair_framework/altair_core/config/modules_config.json",
            # 2. ROS2インストールシェアディレクトリ
            os.path.join(os.path.expanduser('~'), 'ros2_ws/install/altair_core/share/altair_core/config/modules_config.json'),
            # 3. 相対パスフォールバック
            "./src/altair_framework/altair_core/config/modules_config.json"
        ]
        for p in paths:
            if os.path.exists(p):
                return p
        return "modules_config.json"  # 最終フォールバック

    # --- 1. MDDモータ指令の送信処理 (ROS2 ➔ CAN) ---
    def make_mdd_cmd_callback(self, name, base_id):
        def callback(msg):
            # 制御実行中でない場合は、指令の送信を無視する（ユーザーがStartを押すまで動かさない）
            if not self.is_running:
                return

            cmd_id = base_id + 0x20  # 指令ID (例: 0x200 + 0x20 = 0x220)
            
            # 各モータの目標値を生データの10倍にして little-endian int16 配列にパッキング
            try:
                targets_int = [int(t * 10) for t in msg.targets]
                payload = struct.pack('<hhhh', *targets_int)
            except Exception as e:
                self.get_logger().error(f"MDD目標値のエンコード失敗: {str(e)}")
                return

            frame = Frame()
            frame.header.stamp = self.get_clock().now().to_msg()
            frame.id = cmd_id
            frame.dlc = 8
            frame.is_extended = False
            frame.is_rtr = False
            frame.data = list(payload)

            self.can_tx_pub.publish(frame)
        return callback

    # --- 2. サーボ指令の送信処理 (ROS2 ➔ CAN) ---
    def make_servo_cmd_callback(self, name, base_id):
        def callback(msg):
            # サーボは即時制御可能 (パラメータ待機がないため)
            payload = list(msg.angles[:6])
            # 180度制限
            payload = [min(a, 180) for a in payload]
            # パッドして6バイトにする
            while len(payload) < 6:
                payload.append(90)

            frame = Frame()
            frame.header.stamp = self.get_clock().now().to_msg()
            frame.id = base_id  # 通常 0x100
            frame.dlc = 6
            frame.is_extended = False
            frame.is_rtr = False
            frame.data = payload + [0]*(8-len(payload)) # 8Bに補完

            self.can_tx_pub.publish(frame)
        return callback

    # --- 3. 電磁弁指令の送信処理 (ROS2 ➔ CAN) ---
    def make_solenoid_cmd_callback(self, name, base_id):
        def callback(msg):
            # 電磁弁も即時制御可能
            # 12チャネルのON/OFFを2バイトのビットマップにパッキング
            byte0 = 0
            byte1 = 0
            for i in range(min(len(msg.valves), 12)):
                if msg.valves[i]:
                    if i < 8:
                        byte0 |= (1 << i)
                    else:
                        byte1 |= (1 << (i - 8))

            frame = Frame()
            frame.header.stamp = self.get_clock().now().to_msg()
            frame.id = base_id  # 通常 0x300
            frame.dlc = 2
            frame.is_extended = False
            frame.is_rtr = False
            frame.data = [byte0, byte1] + [0]*6 # 8Bに補完

            self.can_tx_pub.publish(frame)
        return callback

    # --- 4. CAN ➔ ROS2 フィードバック変換処理 (NUC ➔ PC) ---
    def handle_can_rx_callback(self, frame):
        can_id = frame.id

        # 現在キャッシュに登録されているMDD Base IDを走査
        for base_id, cache in self.mdd_feedback_cache.items():
            # A. ステータス返信 (Base ID + 0x30 = 0x230)
            if can_id == (base_id + 0x30):
                if frame.dlc < 6:
                    continue
                data = bytes(frame.data[:6])
                # アンパック (Limit SW1-4, Error Code, System Status)
                cache['limit_switches'] = [bool(b) for b in data[0:4]]
                cache['error_code'] = data[4]
                cache['system_status'] = data[5]
                
                self.publish_mdd_feedback(base_id)

            # B. エンコーダ角度 (Base ID + 0x40 = 0x240)
            elif can_id == (base_id + 0x40):
                if frame.dlc < 8:
                    continue
                # int16_t * 4 のデコード (リトルエンディアン)
                angles_raw = struct.unpack('<hhhh', bytes(frame.data[:8]))
                # 0.1 deg 単位を度(degree)に変換
                cache['angles'] = [float(a) / 10.0 for a in angles_raw]
                
                self.publish_mdd_feedback(base_id)

            # C. エンコーダ回転速度 (Base ID + 0x50 = 0x250)
            elif can_id == (base_id + 0x50):
                if frame.dlc < 8:
                    continue
                # int16_t * 4 のデコード
                speeds_raw = struct.unpack('<hhhh', bytes(frame.data[:8]))
                # 0.01 rps 単位を rps に変換
                cache['speeds'] = [float(s) / 100.0 for s in speeds_raw]
                
                self.publish_mdd_feedback(base_id)

    def publish_mdd_feedback(self, base_id):
        """
        キャッシュされたMDDフィードバックデータを結合してROS2トピックに配信する
        """
        # base_idに対応するモジュール名を探す
        module_name = ""
        for module in self.config.get('modules', []):
            if int(module['base_id'], 16) == base_id:
                module_name = module['name']
                break
        
        if not module_name:
            return

        cache = self.mdd_feedback_cache[base_id]
        
        msg = MddFeedback()
        msg.limit_switches = cache['limit_switches']
        msg.error_code = cache['error_code']
        msg.system_status = cache['system_status']
        msg.angles = cache['angles']
        msg.speeds = cache['speeds']

        topic_name = f"/altair/{module_name}/feedback"
        if topic_name in self.publishers_dict:
            self.publishers_dict[topic_name].publish(msg)

    # --- 5. パラメータ送信 ＆ 制御実行モード遷移トリガーサービス ---
    def handle_start_control_service(self, request, response):
        # 未使用の引数を明示的に無視
        _ = request
        self.get_logger().info("スタート制御要求を受信しました。パラメータの送信を開始します。")

        try:
            # 構成ファイル内のすべてのmddモジュールに対してパラメータを順次送信
            for module in self.config.get('modules', []):
                if module['type'] != 'mdd':
                    continue

                base_id = int(module['base_id'], 16)
                params = module.get('parameters', {})

                # 4つのモータ (m1〜m4) のゲイン・直径・方向を送信
                for idx, motor_key in enumerate(['m1', 'm2', 'm3', 'm4']):
                    m_param = params.get(motor_key, {"p": 1.0, "i": 0.0, "d": 0.0, "diameter": 100.0, "direction": 1})
                    
                    p_gain = int(m_param['p'] * 1000)
                    i_gain = int(m_param['i'] * 1000)
                    d_gain = int(m_param['d'] * 1000)
                    
                    # 直径に方向の符号をかける (例: 100 * 1 = 100, 100 * -1 = -100)
                    diameter_dir = int(m_param['diameter'] * m_param['direction'])
                    
                    payload = struct.pack('<hhhh', p_gain, i_gain, d_gain, diameter_dir)
                    
                    # 送信先のCAN ID: 0x200 + モータインデックス (0x200, 0x201, 0x202, 0x203)
                    motor_id = base_id + idx
                    
                    frame = Frame()
                    frame.id = motor_id
                    frame.dlc = 8
                    frame.data = list(payload)
                    self.can_tx_pub.publish(frame)
                    
                    self.get_logger().info(f"パラメータ送信: モータ{idx+1} (ID:{hex(motor_id)}) P={p_gain}, I={i_gain}, D={d_gain}, 車輪={diameter_dir}")
                    # マイコン側の受信バッファ溢れを防ぐため微小な遅延を挟む
                    os.system("sleep 0.02")

                # 4ch モード設定 (0x210) の送信
                modes = [
                    params.get('m1', {}).get('mode', 0),
                    params.get('m2', {}).get('mode', 0),
                    params.get('m3', {}).get('mode', 0),
                    params.get('m4', {}).get('mode', 0)
                ]
                
                # Payload 4B: 各モータのモード (0=速度, 1=角度, 2=位置)
                mode_payload = list(modes) + [0]*4 # 8Bにアライン
                
                mode_frame = Frame()
                mode_frame.id = base_id + 0x10  # 例: 0x210
                mode_frame.dlc = 4
                mode_frame.data = mode_payload
                self.can_tx_pub.publish(mode_frame)
                
                self.get_logger().info(f"モード設定送信 (ID:{hex(base_id + 0x10)}): モード={modes}")

            # 制御実行中フラグをONにする
            self.is_running = True
            response.success = True
            response.message = "パラメータが正常に送信され、制御システムが実行状態に遷移しました。"
            self.get_logger().info("システムが『制御実行中』になりました。")
        
        except Exception as e:
            self.is_running = False
            response.success = False
            response.message = f"パラメータ送信中にエラーが発生しました: {str(e)}"
            self.get_logger().error(f"パラメータ送信エラー: {str(e)}")

        return response

    def handle_reload_config_service(self, request, response):
        """
        設定ファイル更新時にトピックを動的再生成するサービスハンドラー
        """
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

def main(args=None):
    rclpy.init(args=args)
    node = ModuleManager()
    
    # ReentrantCallbackGroupを適切に動作させるため、MultiThreadedExecutorを使用
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
