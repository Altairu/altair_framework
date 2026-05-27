# NUC側 CANable 2 自動セットアップ ＆ 設定ガイド (setup_guide_nuc.md)

本ドキュメントは、ロボット搭載PC（NUC）に **CANable 2 (USB-to-CAN アダプタ)** を接続した際、シリアルポート番号のズレを防いで常に一発で安定して SocketCAN (`can0`) インターフェースを自動起動するための環境構築ガイドです。

---

## 1. udev ルールによるデバイス名の固定化

USBデバイスを接続した際、Linuxカーネルは通常 `/dev/ttyACM0` や `/dev/ttyACM1` などのポート名を割り当てますが、これは接続順や他のシリアルデバイス（Lidar、IMU等）の接続状況によってズレる場合があります。

これを防ぐため、デバイス固有の **ベンダーID(ID_VENDOR_ID)** と **プロダクトID(ID_MODEL_ID)** を用いて、常に固定のシンボリックリンク名（例：`/dev/altair_can`）を自動生成するように udev ルールを設定します。

### 設定手順

1. **デバイスIDの確認**:
   CANable 2 をNUCに接続し、ターミナルで以下を実行します。
   ```bash
   lsusb
   ```
   以下のような出力が見つかります（IDの `1d50:606f` がベンダーIDとモデルIDです）。
   ```text
   Bus 001 Device 054: ID 16d0:117e MCS CANable2 b158aa7 github.com/normaldotcom/canable2.git
   ```
   - ベンダーID (`vendorId`): `16d0`
   - プロダクトID (`modelId`): `117e`

2. **udev ルールファイルの作成**:
   管理者権限で新規ルールファイル `/etc/udev/rules.d/99-altair-can.rules` を作成します。
   ```bash
   sudo nano /etc/udev/rules.d/99-altair-can.rules
   ```
   以下の1行を記述し、保存して閉じます。
   ```text
   SUBSYSTEM=="tty", ATTRS{idVendor}=="16d0", ATTRS{idProduct}=="117e", SYMLINK+="altair_can", MODE="0666"
   ```

3. **udev サービスの再読み込み**:
   作成したルールをシステムに適用します。
   ```bash
   sudo udevadm control --reload-rules
   sudo udevadm trigger
   ```

4. **確認**:
   一旦 USB-to-CAN を引き抜いてから再度接続し、固定リンクが生成されたか確認します。
   ```bash
   ls -l /dev/altair_can
   ```
   以下のように、自動的に `/dev/ttyACM*` へのシンボリックリンクが張られていれば成功です！
   ```text
   lrwxrwxrwx 1 root root 7  5月 26 19:50 /dev/altair_can -> ttyACM0
   ```

> **💡 メリット**: `altair_can_bridge` ノードはこの `/dev/altair_can` を最優先でスキャンして接続するため、ポート番号の衝突やズレが100%発生しなくなります。

---

## 2. パスワード不要での SocketCAN 起動設定 (sudoersの設定)

NUC側のブリッジ自動起動において、`slcand` の実行や `ip link set can0 up` の実行には `sudo` (管理者権限) が必要です。通常はパスワードの入力を求められますが、ロボット起動時に自動で立ち上げるため、これらのコマンドのみ **パスワードなし (NOPASSWD)** で実行できるように設定します。

### 設定手順

1. **sudoers エディタの起動**:
   システムを安全に維持するため、必ず `visudo` を使って設定ファイルを編集します。
   ```bash
   sudo visudo
   ```

2. **例外権限ルールの追加**:
   ファイルの最下部に、以下の行を追加します（`nuc` の部分は、ロボットPC上で動作させるログインユーザー名に書き換えてください）。
   ```text
   # Altair CAN setup script privilege elevation without password
   nuc ALL=(ALL) NOPASSWD: /usr/sbin/modprobe, /usr/bin/slcand, /usr/bin/killall, /usr/sbin/ip
   ```
   > **注意**: `visudo` の保存方法は、Nanoエディタ形式の場合は `Ctrl+O` ➔ `Enter` ➔ `Ctrl+X` で終了します。

3. **動作テスト**:
   パスワードを入力せずにコマンドが通るかテストします。
   ```bash
   # パスワードを求められずに実行できれば成功です
   sudo ip link show can0
   ```

---

## 3. ロボット起動時の「完全自動起動」 (systemd サービス化)

ロボットの電源をONにした際、自動的に SocketCAN が立ち上がり、ROS2ブリッジまでが起動するように Linux の `systemd` サービスに登録する手順です。

1. **サービス定義ファイルの作成**:
   `/etc/systemd/system/altair_can.service` を新規作成します。
   ```bash
   sudo nano /etc/systemd/system/altair_can.service
   ```
   以下を記述し、保存します（`/home/nuc/ros2_ws` のパスはご自身の環境に合わせて変更してください）。
   ```ini
   [Unit]
   Description=Altair CANable2 Auto Setup and ROS2 Bridge Service
   After=network.target

   [Service]
   Type=simple
   User=nuc
   WorkingDirectory=/home/nuc/ros2_ws
   ExecStart=/bin/bash /home/nuc/ros2_ws/run_nuc.sh
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

2. **サービスの有効化 ＆ 開始**:
   ```bash
   # systemdデーモンのリロード
   sudo systemctl daemon-reload
   
   # 自動起動を有効化
   sudo systemctl enable altair_can.service
   
   # サービスを今すぐ手動起動
   sudo systemctl start altair_can.service
   ```

3. **ステータス確認**:
   正常に起動しているか確認します。
   ```bash
   sudo systemctl status altair_can.service
   ```
   「● Active: active (running)」と表示されれば、ロボットの主電源を入れるだけで自動認識からブリッジ起動までが自動で行われます！
