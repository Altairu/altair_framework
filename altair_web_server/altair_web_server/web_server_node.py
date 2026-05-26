import os
import json
import shutil
import threading
import asyncio
from pathlib import Path
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ROS2 ヘッダー
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from ament_index_python.packages import PackageNotFoundError, get_package_share_directory

# ROS2 メッセージ・サービス
from std_msgs.msg import String
from can_msgs.msg import Frame
from altair_interfaces.msg import CanStatus, MddFeedback, MddCommand, ServoCommand, SolenoidCommand
from altair_interfaces.srv import ConnectCan, GetAvailablePorts, TriggerControl, StartBehavior
from std_srvs.srv import Trigger

app = FastAPI()

# 接続中の WebSocket クライアント管理
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                # 切れていたらスキップ
                pass

manager = ConnectionManager()


# --- ROS2 ノード定義 (Webサーバー内部で動作) ---
class WebServerROSNode(Node):
    def __init__(self, loop):
        super().__init__('web_server_ros_node')
        self.loop = loop
        self.callback_group = ReentrantCallbackGroup()

        # 各種サブスクライバ (テレメトリをブラウザに流す用)
        self.can_status_sub = self.create_subscription(
            CanStatus, '/altair/can/status', self.can_status_callback, 10,
            callback_group=self.callback_group
        )
        self.behavior_status_sub = self.create_subscription(
            String, '/altair/behavior/status', self.behavior_status_callback, 10,
            callback_group=self.callback_group
        )
        self.behavior_log_sub = self.create_subscription(
            String, '/altair/behavior/log', self.behavior_log_callback, 100,
            callback_group=self.callback_group
        )

        # 汎用的に動的生成されたMDDフィードバックをキャプチャするサブスクライバ
        self.mdd_feedbacks = {}
        
        # サービスクライアントの作成
        self.get_ports_client = self.create_client(GetAvailablePorts, '/altair/can/get_ports')
        self.connect_can_client = self.create_client(ConnectCan, '/altair/can/connect')
        self.start_control_client = self.create_client(TriggerControl, '/altair/start_control')
        self.start_behavior_client = self.create_client(StartBehavior, '/altair/behavior/start')
        self.stop_behavior_client = self.create_client(Trigger, '/altair/behavior/stop')

        # パブリッシャ辞書 (ブラウザからの操作指令をROS2トピックへ投げる用)
        self.publishers_dict = {}

        # ゲームコントローラー状態のパブリッシャ
        self.gamepad_pub = self.create_publisher(String, '/altair/gamepad/state', 10)

        # 1秒周期でモジュール設定ファイルを監視し、動的にMDDフィードバックサブスクライバを作成
        self.create_timer(2.0, self.sync_mdd_subscriptions, callback_group=self.callback_group)

    def sync_mdd_subscriptions(self):
        """
        modules_config.json のモジュール定義に基づいて、
        自動的に各MDDモジュールのフィードバックトピックをサブスクライブする
        """
        config_path = self.get_config_path()
        if not os.path.exists(config_path):
            return

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            for module in config.get('modules', []):
                if module['type'] == 'mdd':
                    name = module['name']
                    topic = f"/altair/{name}/feedback"
                    
                    if topic not in self.mdd_feedbacks:
                        self.get_logger().info(f"[WebNode] MDDフィードバック購読を開始: {topic}")
                        self.mdd_feedbacks[topic] = self.create_subscription(
                            MddFeedback, topic,
                            self.make_mdd_feedback_callback(name), 10,
                            callback_group=self.callback_group
                        )
        except Exception as e:
            self.get_logger().error(f"MDDトピック同期失敗: {str(e)}")

    def make_mdd_feedback_callback(self, name):
        def callback(msg):
            # WebSocket経由でブラウザに配信
            telemetry_data = {
                "type": "mdd_feedback",
                "name": name,
                "data": {
                    "limit_switches": list(msg.limit_switches),
                    "error_code": msg.error_code,
                    "system_status": msg.system_status,
                    "angles": list(msg.angles),
                    "speeds": list(msg.speeds)
                }
            }
            # asyncio イベントループを通じて WebSocket 送信を実行
            asyncio.run_coroutine_threadsafe(
                manager.broadcast(telemetry_data),
                self.loop
            )
        return callback

    def can_status_callback(self, msg):
        status_data = {
            "type": "can_status",
            "data": {
                "is_connected": msg.is_connected,
                "active_port": msg.active_port,
                "bitrate": msg.bitrate,
                "error_message": msg.error_message
            }
        }
        asyncio.run_coroutine_threadsafe(manager.broadcast(status_data), self.loop)

    def behavior_status_callback(self, msg):
        status_data = {
            "type": "behavior_status",
            "data": msg.data
        }
        asyncio.run_coroutine_threadsafe(manager.broadcast(status_data), self.loop)

    def behavior_log_callback(self, msg):
        log_data = {
            "type": "behavior_log",
            "data": msg.data
        }
        asyncio.run_coroutine_threadsafe(manager.broadcast(log_data), self.loop)

    def get_config_path(self):
        paths = [
            "c:/Users/106no/Documents/GitHub/altair_framework/altair_core/config/modules_config.json",
            os.path.join(os.path.expanduser('~'), 'ros2_ws/install/altair_core/share/altair_core/config/modules_config.json'),
            "./src/altair_framework/altair_core/config/modules_config.json",
            "modules_config.json"
        ]
        for p in paths:
            if os.path.exists(p):
                return p
        return "modules_config.json"

    # --- コマンドパブリッシュヘルパー ---
    def publish_mdd_cmd(self, name, targets):
        topic = f"/altair/{name}/cmd"
        if topic not in self.publishers_dict:
            self.publishers_dict[topic] = self.create_publisher(MddCommand, topic, 10)
        
        msg = MddCommand()
        msg.targets = [float(t) for t in targets]
        self.publishers_dict[topic].publish(msg)

    def publish_servo_cmd(self, name, angles):
        topic = f"/altair/{name}/cmd"
        if topic not in self.publishers_dict:
            self.publishers_dict[topic] = self.create_publisher(ServoCommand, topic, 10)
        
        msg = ServoCommand()
        msg.angles = [int(a) for a in angles]
        self.publishers_dict[topic].publish(msg)

    def publish_solenoid_cmd(self, name, valves):
        topic = f"/altair/{name}/cmd"
        if topic not in self.publishers_dict:
            self.publishers_dict[topic] = self.create_publisher(SolenoidCommand, topic, 10)
        
        msg = SolenoidCommand()
        msg.valves = [bool(v) for v in valves]
        self.publishers_dict[topic].publish(msg)


# --- グローバルなROSノードインスタンスの初期化 ---
ros_node: WebServerROSNode = None

# --- REST API リクエストモデル ---
class ConnectRequest(BaseModel):
    port: str
    auto_connect: bool

class StartBehaviorRequest(BaseModel):
    behavior_name: str

class MddCmdRequest(BaseModel):
    name: str
    targets: list[float]

class ServoCmdRequest(BaseModel):
    name: str
    angles: list[int]

class SolenoidCmdRequest(BaseModel):
    name: str
    valves: list[bool]

class SaveBlocklyRequest(BaseModel):
    code: str

# --- REST API ルーティング ---

@app.get("/api/ports")
async def get_ports():
    """NUC側の利用可能なシリアルポート一覧を取得"""
    if not ros_node.get_ports_client.wait_for_service(timeout_sec=1.0):
        raise HTTPException(status_code=503, detail="NUCのポート検出サービスが利用できません。")
    
    req = GetAvailablePorts.Request()
    future = ros_node.get_ports_client.call_async(req)
    
    # ROS2非同期コールを待機
    while not future.done():
        await asyncio.sleep(0.05)
    
    res = future.result()
    return {"ports": list(res.ports)}

@app.post("/api/connect")
async def connect_can(req_data: ConnectRequest):
    """シリアルポート接続（手動/自動）の指示"""
    if not ros_node.connect_can_client.wait_for_service(timeout_sec=1.0):
        raise HTTPException(status_code=503, detail="NUCのCAN接続サービスが利用できません。")
    
    req = ConnectCan.Request()
    req.port = req_data.port
    req.auto_connect = req_data.auto_connect
    
    future = ros_node.connect_can_client.call_async(req)
    while not future.done():
        await asyncio.sleep(0.05)
        
    res = future.result()
    return {"success": res.success, "message": res.message}

@app.post("/api/start_control")
async def start_control():
    """パラメータ送信と制御開始のトリガー"""
    if not ros_node.start_control_client.wait_for_service(timeout_sec=1.0):
        raise HTTPException(status_code=503, detail="Module Managerの制御開始サービスが利用できません。")
    
    req = TriggerControl.Request()
    future = ros_node.start_control_client.call_async(req)
    while not future.done():
        await asyncio.sleep(0.05)
        
    res = future.result()
    return {"success": res.success, "message": res.message}

@app.post("/api/behavior/start")
async def start_behavior(req_data: StartBehaviorRequest):
    """Python動作プログラムの起動"""
    if not ros_node.start_behavior_client.wait_for_service(timeout_sec=1.0):
        raise HTTPException(status_code=503, detail="Behavior Runnerが起動していません。")
    
    req = StartBehavior.Request()
    req.behavior_name = req_data.behavior_name
    
    future = ros_node.start_behavior_client.call_async(req)
    while not future.done():
        await asyncio.sleep(0.05)
        
    res = future.result()
    return {"success": res.success, "message": res.message}

@app.post("/api/behavior/stop")
async def stop_behavior():
    """Python動作プログラムの停止"""
    if not ros_node.stop_behavior_client.wait_for_service(timeout_sec=1.0):
        raise HTTPException(status_code=503, detail="Behavior Runnerが起動していません。")
    
    req = Trigger.Request()
    future = ros_node.stop_behavior_client.call_async(req)
    while not future.done():
        await asyncio.sleep(0.05)
        
    res = future.result()
    return {"success": res.success, "message": res.message}

@app.post("/api/behavior/save_blockly")
async def save_blockly(req_data: SaveBlocklyRequest):
    """Blocklyで生成されたPythonコードをファイルとして保存"""
    paths = [
        "c:/Users/106no/Documents/GitHub/altair_framework/altair_core/user_behaviors",
        os.path.join(os.path.expanduser('~'), "ros2_ws/src/altair_framework/altair_core/user_behaviors"),
        "./src/altair_framework/altair_core/user_behaviors",
        "user_behaviors"
    ]
    dest_dir = None
    for p in paths:
        if os.path.exists(p):
            dest_dir = p
            break
    if not dest_dir:
        dest_dir = "user_behaviors"
        os.makedirs(dest_dir, exist_ok=True)
        
    dest_file = os.path.join(dest_dir, "blockly_behavior.py")
    try:
        with open(dest_file, "w", encoding="utf-8") as f:
            f.write(req_data.code)
        return {"success": True, "message": "Blocklyコードを blockly_behavior.py として保存しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存に失敗しました: {str(e)}")

# --- 📁 プロファイル管理 (REST API) ---

def get_profiles_dir():
    # プロファイル保存ディレクトリの探索
    paths = [
        "c:/Users/106no/Documents/GitHub/altair_framework/altair_core/profiles",
        os.path.join(os.path.expanduser('~'), 'ros2_ws/src/altair_framework/altair_core/profiles'),
        "./src/altair_framework/altair_core/profiles",
        "profiles"
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    os.makedirs("profiles", exist_ok=True)
    return "profiles"

@app.get("/api/profiles")
async def list_profiles():
    """保存されているプロファイル一覧を取得"""
    pdir = get_profiles_dir()
    profiles = []
    for f in os.listdir(pdir):
        if f.endswith('.json'):
            profiles.append(f.replace('.json', ''))
    return {"profiles": profiles}

@app.post("/api/profiles/load")
async def load_profile(name: str):
    """指定されたプロファイルをロードして modules_config.json を上書き"""
    pdir = get_profiles_dir()
    src = os.path.join(pdir, f"{name}.json")
    
    if not os.path.exists(src):
        raise HTTPException(status_code=404, detail="プロファイルが見つかりません。")

    dest = ros_node.get_config_path()
    try:
        shutil.copy2(src, dest)
        
        # モジュール構成リロードサービスを呼ぶ (ROS2側のリロード)
        # 後ほど /altair/reload_config サービスをmodule_managerに実装します
        std_srv = ros_node.create_client(Trigger, '/altair/reload_config')
        if std_srv.wait_for_service(timeout_sec=1.0):
            req = Trigger.Request()
            std_srv.call_async(req)

        # WebServerノード内のMDDサブスクライバも再構築
        ros_node.mdd_feedbacks.clear()
        ros_node.sync_mdd_subscriptions()

        return {"success": True, "message": f"プロファイル '{name}' を正常に適用しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"適用に失敗しました: {str(e)}")

@app.post("/api/profiles/save")
async def save_profile(name: str):
    """現在のモジュール設定を新しいプロファイル名で保存"""
    dest_dir = get_profiles_dir()
    dest = os.path.join(dest_dir, f"{name}.json")
    src = ros_node.get_config_path()
    
    if not os.path.exists(src):
        raise HTTPException(status_code=404, detail="現在の設定ファイルが見つかりません。")

    try:
        shutil.copy2(src, dest)
        return {"success": True, "message": f"現在の設定をプロファイル '{name}' として保存しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存に失敗しました: {str(e)}")

@app.get("/api/config")
async def get_current_config():
    """現在の modules_config.json の中身を直接返す"""
    config_path = ros_node.get_config_path()
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"modules": []}

@app.post("/api/config/update")
async def update_current_config(config_data: dict):
    """ブラウザからの設定変更を受け取り、modules_config.json を直接上書き保存"""
    dest = ros_node.get_config_path()
    try:
        with open(dest, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, indent=2, ensure_ascii=False)
            
        # ROS2側にリロード要求を送る
        std_srv = ros_node.create_client(Trigger, '/altair/reload_config')
        if std_srv.wait_for_service(timeout_sec=1.0):
            req = Trigger.Request()
            std_srv.call_async(req)

        # WebServerノード内のMDDサブスクライバも再構築
        ros_node.mdd_feedbacks.clear()
        ros_node.sync_mdd_subscriptions()

        return {"success": True, "message": "設定ファイルを更新しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存に失敗しました: {str(e)}")


# --- WebSocket リアルタイム通信 (双方向) ---

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # クライアントからの操作指示をリアルタイムで受信
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            msg_type = msg.get("type")
            name = msg.get("name")
            
            if msg_type == "mdd_cmd":
                ros_node.publish_mdd_cmd(name, msg.get("targets", []))
            elif msg_type == "servo_cmd":
                ros_node.publish_servo_cmd(name, msg.get("angles", []))
            elif msg_type == "solenoid_cmd":
                ros_node.publish_solenoid_cmd(name, msg.get("valves", []))
            elif msg_type == "gamepad_state":
                ros_msg = String()
                ros_msg.data = json.dumps({
                    "axes": msg.get("axes", []),
                    "buttons": msg.get("buttons", [])
                })
                ros_node.gamepad_pub.publish(ros_msg)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        manager.disconnect(websocket)


# --- 静的フロントエンドファイルの配備 ---

def get_frontend_dir():
    candidates = []

    # ROS2インストール先のshareディレクトリを最優先
    try:
        share_dir = Path(get_package_share_directory('altair_web_server'))
        candidates.append(share_dir / 'frontend')
    except PackageNotFoundError:
        pass

    cwd = Path.cwd()
    candidates.append(cwd / 'altair_web_server' / 'frontend')
    candidates.append(cwd / 'frontend')

    this_file = Path(__file__).resolve()
    candidates.append(this_file.parents[1] / 'frontend')

    if len(this_file.parents) >= 5:
        candidates.append(this_file.parents[4] / 'altair_web_server' / 'frontend')

    for path in candidates:
        if path.exists():
            return str(path)

    return str(candidates[0]) if candidates else 'frontend'

frontend_dir = get_frontend_dir()
if os.path.exists(frontend_dir):
    # html=True で / -> index.html と配下静的ファイルを一括配信
    app.mount("/", StaticFiles(directory=frontend_dir, html=True, follow_symlink=True), name="frontend")


# --- ROS2 ノードスピン実行スレッドの管理 ---
def run_ros2_spin(node):
    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    executor.spin()

def main(args=None):
    rclpy.init(args=args)

    # FastAPI用の非同期イベントループを取得
    loop = asyncio.get_event_loop()

    # グローバルなROS2ノードの作成
    global ros_node
    ros_node = WebServerROSNode(loop)

    # ROS2のスピンを別スレッドで開始
    ros_thread = threading.Thread(target=run_ros2_spin, args=(ros_node,))
    ros_thread.daemon = True
    ros_thread.start()

    # Webサーバーの起動 (すべてのWiFiネットワークからアクセス可能にするため 0.0.0.0 でバインド)
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")

    # 終了処理
    rclpy.shutdown()

if __name__ == '__main__':
    main()
