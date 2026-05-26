import os
from glob import glob
from setuptools import setup

package_name = 'altair_web_server'

setup(
    name=package_name,
    version='1.0.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # フロントエンド静的ファイルのインストール
        ('share/' + package_name + '/frontend', glob('frontend/*.html')),
        ('share/' + package_name + '/frontend/css', glob('frontend/css/*.css')),
        ('share/' + package_name + '/frontend/js', glob('frontend/js/*.js')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='USER',
    maintainer_email='106no@users.noreply.github.com',
    description='操縦者PC/NUC側：FastAPI Webサーバーおよびモダンなブラウザ制御ダッシュボードUI',
    license='MIT',
    extras_require={
        'test': ['pytest'],
    },
    entry_points={
        'console_scripts': [
            'web_server_node = altair_web_server.web_server_node:main',
        ],
    },
)
