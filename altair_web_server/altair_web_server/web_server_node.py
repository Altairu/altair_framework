import os
import json
import shutil
import threading
import asyncio
import subprocess
import platform
from pathlib import Path
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ROS2 ヘッダー
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from altair_core.paths import (
    get_config_path,
    get_frontend_dir as resolve_frontend_dir,
    get_network_config_path,
    get_profiles_dir as resolve_profiles_dir,
    get_user_behaviors_dir as resolve_user_behaviors_dir,
)

# ROS2 メッセージ・サービス
from std_msgs.msg import String
from sensor_msgs.msg import Joy
from can_msgs.msg import Frame
from altair_interfaces.msg import CanStatus, MddFeedback, MddCommand, ServoCommand, SolenoidCommand
from altair_interfaces.srv import ConnectCan, ConnectEthCan, GetAvailablePorts, TriggerControl, StartBehavior
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
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                pass


manager = ConnectionManager()


def normalize_can_channel(ch: str) -> str:
    val = (ch or "can1").strip().lower()
    if val in ("can2", "2"):
        return "can2"
    if val in ("both", "can1+2", "all"):
        return "both"
    return "can1"


# --- ROS2 ノード定義 (Webサーバー内部で動作) ---
class WebServerROSNode(Node):
    def __init__(self, loop):
        super().__init__('web_server_ros_node')
        self.loop = loop
        self.callback_group = ReentrantCallbackGroup()
        self.active_can_channel = "can1"

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

        # 生CAN送受信フレーム監視サブスクライバ (Web UI システム送受信CANログ用)
        self.can_rx_sub = self.create_subscription(
            Frame, '/altair/can/rx', self.can_rx_raw_callback, 200,
            callback_group=self.callback_group
        )
        self.can_tx_sub = self.create_subscription(
            Frame, '/altair/can/tx', self.can_tx_raw_callback, 200,
            callback_group=self.callback_group
        )

        # 汎用的に動的生成されたMDDフィードバックをキャプチャするサブスクライバ
        self.mdd_feedbacks = {}

        # サービスクライアントの作成
        self.get_ports_client = self.create_client(GetAvailablePorts, '/altair/can/get_ports')
        self.connect_can_client = self.create_client(ConnectCan, '/altair/can/connect')
        self.connect_eth_can_client = self.create_client(ConnectEthCan, '/altair/eth_can/connect')
        self.start_control_client = self.create_client(TriggerControl, '/altair/start_control')
        self.start_behavior_client = self.create_client(StartBehavior, '/altair/behavior/start')
        self.stop_behavior_client = self.create_client(Trigger, '/altair/behavior/stop')

        # パブリッシャ辞書 (ブラウザからの操作指令をROS2トピックへ投げる用)
        self.publishers_dict = {}

        # ゲームコントローラー状態のパブリッシャ (ROS2標準 Joy & 従来互換 JSON)
        self.joy_pub = self.create_publisher(Joy, '/altair/joy', 10)
        self.gamepad_pub = self.create_publisher(String, '/altair/gamepad/state', 10)

        # モジュール構成同期用パブリッシャ (操縦PCからNUCへの同期用)
        self.config_sync_pub = self.create_publisher(String, '/altair/config_sync', 10)

        # 初回同期 + 2秒周期でモジュール設定ファイルを監視し、動的にMDDフィードバックサブスクライバを作成
        self.sync_mdd_subscriptions()
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
            if not manager.active_connections:
                return
            telemetry_data = {
                "type": "mdd_feedback",
                "name": name,
                "data": {
                    "limit_switches": [bool(x) for x in msg.limit_switches],
                    "error_code": int(msg.error_code),
                    "system_status": int(msg.system_status),
                    "angles": [float(x) for x in msg.angles],
                    "speeds": [float(x) for x in msg.speeds]
                }
            }
            asyncio.run_coroutine_threadsafe(
                manager.broadcast(telemetry_data),
                self.loop
            )
        return callback

    def _format_raw_can_frame(self, direction: str, msg: Frame) -> str:
        ch = msg.header.frame_id if msg.header.frame_id else self.active_can_channel
        dlc = max(0, min(8, int(msg.dlc)))
        hex_str = " ".join(f"{int(b) & 0xFF:02X}" for b in msg.data[:dlc])
        return f"[{direction}] ({ch}) ID: 0x{int(msg.id):03X} [{dlc}] {hex_str}"

    def can_rx_raw_callback(self, msg: Frame):
        if not manager.active_connections:
            return
        line = self._format_raw_can_frame("RX", msg)
        asyncio.run_coroutine_threadsafe(
            manager.broadcast({"type": "raw_can_frame", "data": line}),
            self.loop
        )

    def can_tx_raw_callback(self, msg: Frame):
        if not manager.active_connections:
            return
        line = self._format_raw_can_frame("TX", msg)
        asyncio.run_coroutine_threadsafe(
            manager.broadcast({"type": "raw_can_frame", "data": line}),
            self.loop
        )

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
        """モジュール構成ファイルの絶対パスを探索して返す"""
        return get_config_path()

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


class ConnectRequest(BaseModel):
    port: str
    auto_connect: bool


class ConnectEthRequest(BaseModel):
    target_ip: str = "192.168.2.123"
    target_port: int = 5000
    can_channel: str = "can1"


class ChannelEthRequest(BaseModel):
    can_channel: str = "can1"


class StartBehaviorRequest(BaseModel):
    behavior_name: str


class BehaviorFileRequest(BaseModel):
    name: str


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
    xml: str = ""


def load_saved_eth_config() -> dict:
    default_cfg = {"target_ip": "192.168.2.123", "target_port": 5000, "can_channel": "can1"}
    config_file = get_network_config_path()
    if config_file.exists():
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {
                    "target_ip": data.get("target_ip", "192.168.2.123"),
                    "target_port": int(data.get("target_port", 5000)),
                    "can_channel": normalize_can_channel(data.get("can_channel", "can1")),
                }
        except Exception:
            pass
    return default_cfg


def save_eth_config(cfg: dict):
    config_file = get_network_config_path()
    try:
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"network_config.json の保存に失敗しました: {e}")


# --- REST API ルーティング ---

@app.get("/api/ports")
async def get_ports():
    """NUC側の利用可能なシリアルポート一覧を取得"""
    if not ros_node.get_ports_client.wait_for_service(timeout_sec=0.5):
        return {"ports": []}

    req = GetAvailablePorts.Request()
    future = ros_node.get_ports_client.call_async(req)

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


@app.get("/api/eth_can/config")
async def get_eth_can_config():
    """Ethernet-CAN の設定を取得"""
    cfg = load_saved_eth_config()
    if ros_node:
        ros_node.active_can_channel = cfg["can_channel"]
    return cfg


@app.post("/api/eth_can/connect")
async def connect_eth_can(req_data: ConnectEthRequest):
    """Ethernet-CAN 基板への接続・再接続指示"""
    can_channel = normalize_can_channel(req_data.can_channel)
    if ros_node:
        ros_node.active_can_channel = can_channel

    cfg = {
        "target_ip": req_data.target_ip,
        "target_port": req_data.target_port,
        "can_channel": can_channel,
    }
    save_eth_config(cfg)

    if not ros_node.connect_eth_can_client.wait_for_service(timeout_sec=1.0):
        if ros_node.connect_can_client.wait_for_service(timeout_sec=0.5):
            req = ConnectCan.Request()
            req.port = f"{req_data.target_ip}:{req_data.target_port}"
            req.auto_connect = False
            fut = ros_node.connect_can_client.call_async(req)
            while not fut.done():
                await asyncio.sleep(0.05)
            r = fut.result()
            return {"success": r.success, "message": r.message}
        raise HTTPException(status_code=503, detail="Ethernet-CAN ブリッジサービスが利用できません。")

    req = ConnectEthCan.Request()
    req.target_ip = req_data.target_ip
    req.target_port = req_data.target_port
    if hasattr(req, "can_channel"):
        req.can_channel = can_channel

    future = ros_node.connect_eth_can_client.call_async(req)
    while not future.done():
        await asyncio.sleep(0.05)

    res = future.result()
    return {"success": res.success, "message": res.message}


@app.post("/api/eth_can/channel")
async def set_eth_can_channel(req_data: ChannelEthRequest):
    """Ethernet-CAN の使用CANチャンネル (CAN1 / CAN2 / CAN1+2) を即時切替"""
    can_channel = normalize_can_channel(req_data.can_channel)
    if ros_node:
        ros_node.active_can_channel = can_channel

    cfg = load_saved_eth_config()
    cfg["can_channel"] = can_channel
    save_eth_config(cfg)

    if ros_node.connect_eth_can_client.wait_for_service(timeout_sec=0.8):
        req = ConnectEthCan.Request()
        req.target_ip = "__CHANNEL_ONLY__"
        req.target_port = int(cfg.get("target_port", 5000))
        if hasattr(req, "can_channel"):
            req.can_channel = can_channel
        future = ros_node.connect_eth_can_client.call_async(req)
        while not future.done():
            await asyncio.sleep(0.05)
        res = future.result()
        return {"success": res.success, "message": res.message}

    label = "CAN2" if can_channel == "can2" else ("CAN1+2" if can_channel == "both" else "CAN1")
    return {"success": True, "message": f"使用CANチャンネルを {label} に設定しました。"}


@app.post("/api/eth_can/disconnect")
async def disconnect_eth_can():
    """Ethernet-CAN 接続を切断"""
    if ros_node.connect_eth_can_client.wait_for_service(timeout_sec=0.8):
        req = ConnectEthCan.Request()
        req.target_ip = ""
        req.target_port = 0
        if hasattr(req, "can_channel"):
            req.can_channel = ""
        future = ros_node.connect_eth_can_client.call_async(req)
        while not future.done():
            await asyncio.sleep(0.05)
        res = future.result()
        return {"success": res.success, "message": res.message}

    if ros_node.connect_can_client.wait_for_service(timeout_sec=0.5):
        req = ConnectCan.Request()
        req.port = ""
        req.auto_connect = False
        future = ros_node.connect_can_client.call_async(req)
        while not future.done():
            await asyncio.sleep(0.05)
        res = future.result()
        return {"success": res.success, "message": res.message}

    return {"success": False, "message": "Ethernet-CAN ブリッジサービスが利用できません。"}


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


def get_user_behaviors_dir() -> str:
    return str(resolve_user_behaviors_dir())


@app.post("/api/behavior/save_blockly")
async def save_blockly(req_data: SaveBlocklyRequest):
    """Blocklyで生成されたPythonコードおよびブロックXMLレイアウトをファイルとして保存"""
    dest_dir = get_user_behaviors_dir()
    dest_file = os.path.join(dest_dir, "blockly_behavior.py")
    try:
        with open(dest_file, "w", encoding="utf-8") as f:
            f.write(req_data.code)

        if req_data.xml:
            xml_file = os.path.join(dest_dir, "blockly_workspace.xml")
            with open(xml_file, "w", encoding="utf-8") as f:
                f.write(req_data.xml)

        return {"success": True, "message": "Blocklyコードとレイアウトを正常に保存しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存に失敗しました: {str(e)}")


@app.get("/api/behavior/list")
async def list_behaviors():
    """user_behaviors/ ディレクトリ内の実行可能なPythonファイル一覧を取得"""
    user_behaviors_dir = get_user_behaviors_dir()
    try:
        behaviors = []
        for f in os.listdir(user_behaviors_dir):
            if f.endswith('.py') and not f.startswith('_'):
                behaviors.append(f)
        behaviors.sort()
        return {"success": True, "behaviors": behaviors}
    except Exception as e:
        return {"success": False, "behaviors": [], "error": str(e)}


@app.post("/api/behavior/create")
async def create_behavior(req_data: BehaviorFileRequest):
    """新しい動作スクリプトのテンプレートファイルを作成"""
    raw_name = req_data.name.strip()
    if not raw_name:
        return {"success": False, "message": "ファイル名を入力してください。"}
    if not raw_name.endswith(".py"):
        raw_name += ".py"
    safe_name = os.path.basename(raw_name)
    dest_dir = get_user_behaviors_dir()
    dest_file = os.path.join(dest_dir, safe_name)
    if os.path.exists(dest_file):
        return {"success": False, "message": f"すでに '{safe_name}' が存在します。"}

    template = f'''#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair ユーザー動作プログラム: {safe_name}
"""

import sys
import os
import rclpy

sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "altair_core"))
from altair_core.base_behavior import AltairBehavior


class CustomBehavior(AltairBehavior):
    def on_init(self):
        self.set_state("MAIN")
        self.get_logger().info("{safe_name} を初期化しました。")

    def loop(self):
        # ここに周期制御ロジックを記述します
        pass


def main(args=None):
    rclpy.init(args=args)
    behavior = CustomBehavior("custom_behavior_node")
    behavior.run(rate_hz=100.0)


if __name__ == "__main__":
    main()
'''
    try:
        with open(dest_file, "w", encoding="utf-8") as f:
            f.write(template)
        return {"success": True, "name": safe_name, "message": f"新規スクリプト '{safe_name}' を作成しました。"}
    except Exception as e:
        return {"success": False, "message": f"スクリプト作成失敗: {e}"}


@app.post("/api/behavior/delete")
async def delete_behavior(req_data: BehaviorFileRequest):
    """指定された動作スクリプトを削除"""
    safe_name = os.path.basename(req_data.name.strip())
    if not safe_name:
        return {"success": False, "message": "削除対象が指定されていません。"}
    dest_dir = get_user_behaviors_dir()
    target = os.path.join(dest_dir, safe_name)
    if not os.path.exists(target):
        return {"success": False, "message": f"'{safe_name}' が見つかりません。"}
    try:
        os.remove(target)
        return {"success": True, "message": f"スクリプト '{safe_name}' を削除しました。"}
    except Exception as e:
        return {"success": False, "message": f"削除失敗: {e}"}


@app.post("/api/behavior/open_folder")
async def open_behavior_folder():
    """動作スクリプト保存ディレクトリをOSのファイルマネージャーで開く"""
    dest_dir = get_user_behaviors_dir()
    try:
        system = platform.system()
        if system == "Windows":
            os.startfile(dest_dir)
        elif system == "Darwin":
            subprocess.Popen(["open", dest_dir])
        else:
            subprocess.Popen(["xdg-open", dest_dir])
        return {"success": True, "message": f"フォルダーを開きました: {dest_dir}"}
    except Exception as e:
        return {"success": False, "message": f"フォルダーを開けませんでした ({dest_dir}): {e}"}


@app.get("/api/behavior/get_blockly_workspace")
async def get_blockly_workspace():
    """保存されているBlocklyのブロックレイアウト(XML文字列)を取得"""
    dest_dir = get_user_behaviors_dir()
    xml_file = os.path.join(dest_dir, "blockly_workspace.xml")
    if os.path.exists(xml_file):
        try:
            with open(xml_file, "r", encoding="utf-8") as f:
                return {"success": True, "xml": f.read()}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"読み込みに失敗しました: {str(e)}")

    default_xml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="event_macro" id="initial_entry" x="30" y="30"></block></xml>'
    return {"success": True, "xml": default_xml}


# --- プロファイル管理 (REST API) ---

def get_profiles_dir():
    return str(resolve_profiles_dir())


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

        with open(dest, 'r', encoding='utf-8') as f:
            config_data = json.load(f)
        sync_msg = String()
        sync_msg.data = json.dumps(config_data, ensure_ascii=False)
        ros_node.config_sync_pub.publish(sync_msg)
        std_srv = ros_node.create_client(Trigger, '/altair/reload_config')
        if std_srv.wait_for_service(timeout_sec=1.0):
            req = Trigger.Request()
            std_srv.call_async(req)

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


@app.post("/api/profiles/delete")
async def delete_profile(name: str):
    """指定されたプロファイルを削除"""
    pdir = get_profiles_dir()
    target = os.path.join(pdir, f"{name}.json")

    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail="プロファイルが見つかりません。")

    try:
        os.remove(target)
        return {"success": True, "message": f"プロファイル '{name}' を削除しました。"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"削除に失敗しました: {str(e)}")


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

        sync_msg = String()
        sync_msg.data = json.dumps(config_data, ensure_ascii=False)
        ros_node.config_sync_pub.publish(sync_msg)

        std_srv = ros_node.create_client(Trigger, '/altair/reload_config')
        if std_srv.wait_for_service(timeout_sec=1.0):
            req = Trigger.Request()
            std_srv.call_async(req)

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
                axes_raw = msg.get("axes", [])
                buttons_raw = msg.get("buttons", [])

                # ROS 2 標準 sensor_msgs/msg/Joy トピックへ配信
                joy_msg = Joy()
                joy_msg.header.stamp = ros_node.get_clock().now().to_msg()
                joy_msg.axes = [float(a) for a in axes_raw]
                joy_msg.buttons = [1 if bool(b) else 0 for b in buttons_raw]
                ros_node.joy_pub.publish(joy_msg)

                # 後方互換用の JSON 文字列トピックへも配信
                ros_msg = String()
                ros_msg.data = json.dumps({
                    "axes": axes_raw,
                    "buttons": buttons_raw
                })
                ros_node.gamepad_pub.publish(ros_msg)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


# --- 静的フロントエンドファイルの配備 ---

def get_frontend_dir():
    return str(resolve_frontend_dir())


frontend_dir = get_frontend_dir()
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True, follow_symlink=True), name="frontend")


# --- ROS2 ノードスピン実行スレッドの管理 ---
def run_ros2_spin(node):
    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    executor.spin()


def main(args=None):
    rclpy.init(args=args)

    loop = asyncio.new_event_loop()

    global ros_node
    ros_node = WebServerROSNode(loop)

    ros_thread = threading.Thread(target=run_ros2_spin, args=(ros_node,))
    ros_thread.daemon = True
    ros_thread.start()

    import socket
    local_ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary_ip = s.getsockname()[0]
        s.close()
        local_ips.append(primary_ip)
    except Exception:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in local_ips:
                local_ips.append(ip)
    except Exception:
        pass

    print("\n=======================================================")
    print(" Altair Web Controller が起動しました！")
    print(" ブラウザから以下のURLでアクセスできます:")
    print("   ローカル:   http://localhost:8000/")
    for ip in local_ips:
        print(f"   WiFi / LAN: http://{ip}:8000/")
    print("=======================================================\n")

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=8000,
        loop="asyncio",
        log_level="info"
    )
    server = uvicorn.Server(config)

    try:
        loop.run_until_complete(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
