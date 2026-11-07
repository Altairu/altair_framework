from typing import Dict, List, Type
from can_msgs.msg import Frame


# 登録済みモジュールプラグインのグローバルレジストリ
MODULE_REGISTRY: Dict[str, Type["BaseModulePlugin"]] = {}


def register_module(module_type: str):
    """
    新しいCANモジュールプラグインをシステムに登録するデコレータ。
    フォーク先で独自モジュールを追加する際は、このデコレータを付与するだけで
    module_manager と base_behavior の双方から自動認識されます。
    """
    def decorator(cls: Type["BaseModulePlugin"]):
        cls.MODULE_TYPE = module_type
        MODULE_REGISTRY[module_type] = cls
        return cls
    return decorator


class BaseModulePlugin:
    """
    すべてのCANモジュールプラグインの基底クラス。
    1つのモジュール種別につき1つのサブクラスを定義し、
    ROS 2 トピック <-> CAN フレームの相互変換と Behavior 用クライアント生成を担います。
    """
    MODULE_TYPE: str = "base"

    def __init__(self, manager_node, module_config: dict):
        self.node = manager_node
        self.config = module_config
        self.name: str = module_config["name"]
        base_id_raw = module_config.get("base_id", "0x000")
        self.base_id: int = int(base_id_raw, 16) if isinstance(base_id_raw, str) else int(base_id_raw)
        self._subscriptions = []
        self._publishers = []

    def create_module_subscription(self, msg_type, topic: str, callback, qos: int = 10):
        sub = self.node.create_subscription(
            msg_type,
            topic,
            callback,
            qos,
            callback_group=self.node.callback_group,
        )
        self._subscriptions.append(sub)
        self.node.subscriptions_dict[topic] = sub
        return sub

    def create_module_publisher(self, msg_type, topic: str, qos: int = 10):
        pub = self.node.create_publisher(msg_type, topic, qos)
        self._publishers.append(pub)
        self.node.publishers_dict[topic] = pub
        return pub

    def setup_ros_interfaces(self):
        """ROS 2 の Pub/Sub トピックを初期化する（サブクラスで実装）"""
        pass

    def destroy_ros_interfaces(self):
        """リロード時に動的生成した Pub/Sub を破棄する"""
        for sub in self._subscriptions:
            self.node.destroy_subscription(sub)
        for pub in self._publishers:
            self.node.destroy_publisher(pub)
        self._subscriptions.clear()
        self._publishers.clear()

    def build_init_frames(self) -> List[Frame]:
        """
        /altair/start_control サービス呼び出し時に送信する初期設定用 CAN フレーム一覧を返す。
        不要なモジュールは空リストを返す。
        """
        return []

    def build_periodic_tx_frames(self, is_running: bool) -> List[Frame]:
        """
        100Hz (10ms周期) で CAN バス (/altair/can/tx) へ送出する制御フレーム一覧を返す。
        """
        return []

    def handle_can_rx(self, frame: Frame) -> bool:
        """
        受信した CAN フレーム (/altair/can/rx) を処理する。
        自モジュール宛のフレームであればデコード・Publishして True を返す。
        """
        return False

    @classmethod
    def create_behavior_client(cls, behavior_node, name: str, module_config: dict):
        """
        AltairBehavior.get_module(name) で返却するクライアントインスタンスを生成する。
        """
        raise NotImplementedError(f"{cls.__name__} does not implement create_behavior_client()")
