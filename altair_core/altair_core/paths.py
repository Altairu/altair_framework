import os
from pathlib import Path

try:
    from ament_index_python.packages import PackageNotFoundError, get_package_share_directory
except ImportError:
    PackageNotFoundError = Exception

    def get_package_share_directory(package_name: str) -> str:
        raise PackageNotFoundError(package_name)


def get_workspace_root() -> Path:
    """
    altair_framework リポジトリ（ワークスペース）のルートディレクトリを特定して返す。
    フォーク先で任意のディレクトリ名・階層に配置されても自動検出する。
    """
    env_root = os.getenv("ALTAIR_WS_ROOT")
    if env_root:
        p = Path(env_root).expanduser().resolve()
        if p.exists():
            return p

    # 1. このファイルの実体パスから親ディレクトリを辿る (--symlink-install 対応)
    this_file = Path(__file__).resolve()
    for parent in this_file.parents:
        if (parent / "altair_core").is_dir() and (parent / "altair_web_server").is_dir():
            return parent

    # 2. カレントワーキングディレクトリから親ディレクトリを辿る
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / "altair_core").is_dir() and (parent / "altair_web_server").is_dir():
            return parent

    return cwd


def get_config_path() -> str:
    """
    モジュール構成ファイル (modules_config.json) の絶対パスを返す。
    単一の正本として altair_core/config/modules_config.json を優先参照する。
    """
    env_path = os.getenv("ALTAIR_MODULES_CONFIG")
    if env_path:
        p = Path(env_path).expanduser().resolve()
        if p.exists():
            return str(p)

    ws_root = get_workspace_root()
    source_config = ws_root / "altair_core" / "config" / "modules_config.json"
    if source_config.exists():
        return str(source_config)

    try:
        share_dir = Path(get_package_share_directory("altair_core"))
        share_config = share_dir / "config" / "modules_config.json"
        if share_config.exists():
            return str(share_config)
    except PackageNotFoundError:
        pass

    return str(source_config)


def get_user_behaviors_dir() -> Path:
    """
    ユーザー動作プログラム (user_behaviors/) ディレクトリの絶対パスを返す。
    """
    env_dir = os.getenv("ALTAIR_BEHAVIORS_DIR")
    if env_dir:
        p = Path(env_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    behaviors_dir = get_workspace_root() / "user_behaviors"
    behaviors_dir.mkdir(parents=True, exist_ok=True)
    return behaviors_dir


def get_profiles_dir() -> Path:
    """
    プロファイル保存用 (profiles/) ディレクトリの絶対パスを返す。
    """
    env_dir = os.getenv("ALTAIR_PROFILES_DIR")
    if env_dir:
        p = Path(env_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    profiles_dir = get_workspace_root() / "profiles"
    profiles_dir.mkdir(parents=True, exist_ok=True)
    return profiles_dir


def get_frontend_dir() -> Path:
    """
    Webサーバーの静的フロントエンド (frontend/) ディレクトリの絶対パスを返す。
    """
    ws_frontend = get_workspace_root() / "altair_web_server" / "frontend"
    if ws_frontend.exists():
        return ws_frontend

    try:
        share_dir = Path(get_package_share_directory("altair_web_server"))
        share_frontend = share_dir / "frontend"
        if share_frontend.exists():
            return share_frontend
    except PackageNotFoundError:
        pass

    return ws_frontend


def get_network_config_path() -> Path:
    """
    Ethernet-CAN 接続設定ファイル (network_config.json) の絶対パスを返す。
    """
    return get_workspace_root() / "network_config.json"
