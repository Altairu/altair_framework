import importlib
import pkgutil
from pathlib import Path
from typing import Optional, Type

from altair_core.modules.base_module import BaseModulePlugin, MODULE_REGISTRY, register_module
from altair_core.modules.mdd_module import MddClient, MddModulePlugin
from altair_core.modules.servo_module import ServoClient, ServoModulePlugin
from altair_core.modules.solenoid_module import SolenoidClient, SolenoidModulePlugin
from altair_core.modules.robomas_module import RobomasClient, RobomasModulePlugin


def discover_module_plugins():
    """
    altair_core/modules/ 内のすべての *_module.py ファイルを自動インポートして
    @register_module デコレータを実行する。
    """
    pkg_dir = Path(__file__).resolve().parent
    for module_info in pkgutil.iter_modules([str(pkg_dir)]):
        if module_info.name not in ("__init__", "base_module"):
            importlib.import_module(f"altair_core.modules.{module_info.name}")


def get_module_plugin_class(module_type: str) -> Optional[Type[BaseModulePlugin]]:
    if not MODULE_REGISTRY:
        discover_module_plugins()
    if module_type not in MODULE_REGISTRY:
        discover_module_plugins()
    return MODULE_REGISTRY.get(module_type)


__all__ = [
    "BaseModulePlugin",
    "MODULE_REGISTRY",
    "register_module",
    "discover_module_plugins",
    "get_module_plugin_class",
    "MddClient",
    "MddModulePlugin",
    "ServoClient",
    "ServoModulePlugin",
    "SolenoidClient",
    "SolenoidModulePlugin",
    "RobomasClient",
    "RobomasModulePlugin",
]
