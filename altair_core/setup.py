import os
from glob import glob
from setuptools import setup

package_name = 'altair_core'

setup(
    name=package_name,
    version='1.0.0',
    packages=[package_name, 'user_behaviors'],
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # configファイルのインストール
        (os.path.join('share', package_name, 'config'), glob('config/*.json')),
        # プロファイル保存フォルダのインストール
        (os.path.join('share', package_name, 'profiles'), glob('profiles/*.json')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='USER',
    maintainer_email='106no@users.noreply.github.com',
    description='操縦者PC側：高レベルモジュール管理、状態遷移、およびユーザー動作プログラムランナー',
    license='MIT',
    extras_require={
        'test': ['pytest'],
    },
    entry_points={
        'console_scripts': [
            'module_manager = altair_core.module_manager:main',
            'behavior_runner = altair_core.behavior_runner:main',
        ],
    },
)
