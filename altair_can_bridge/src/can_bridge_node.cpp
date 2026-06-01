// C++ 標準ヘッダー
#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <filesystem>
#include <iostream>
#include <cstdlib>
#include <cerrno>

// Linux SocketCAN ヘッダー
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <unistd.h>
#include <string.h>
#include <fcntl.h>
#include <linux/can.h>
#include <linux/can/raw.h>

// ROS2 ヘッダー
#include "rclcpp/rclcpp.hpp"
#include "can_msgs/msg/frame.hpp"
#include "altair_interfaces/msg/can_status.hpp"
#include "altair_interfaces/srv/get_available_ports.hpp"
#include "altair_interfaces/srv/connect_can.hpp"
#include <ament_index_cpp/get_package_share_directory.hpp>

using namespace std::chrono_literals;
namespace fs = std::filesystem;

class CanBridgeNode : public rclcpp::Node
{
public:
  CanBridgeNode()
  : Node("can_bridge_node"), is_connected_(false), can_socket_(-1)
  {
    // ROS2パブリッシャ・サブスクライバの初期化
    can_rx_pub_ = this->create_publisher<can_msgs::msg::Frame>("/altair/can/rx", 100);
    can_status_pub_ = this->create_publisher<altair_interfaces::msg::CanStatus>("/altair/can/status", 10);
    
    can_tx_sub_ = this->create_subscription<can_msgs::msg::Frame>(
      "/altair/can/tx", 100,
      std::bind(&CanBridgeNode::handle_can_tx_callback, this, std::placeholders::_1));

    // ROS2サービスの初期化
    get_ports_srv_ = this->create_service<altair_interfaces::srv::GetAvailablePorts>(
      "/altair/can/get_ports",
      std::bind(&CanBridgeNode::handle_get_ports_service, this, std::placeholders::_1, std::placeholders::_2));

    connect_can_srv_ = this->create_service<altair_interfaces::srv::ConnectCan>(
      "/altair/can/connect",
      std::bind(&CanBridgeNode::handle_connect_can_service, this, std::placeholders::_1, std::placeholders::_2));

    // 接続ステータス配信用のタイマー (1Hz)
    status_timer_ = this->create_wall_timer(
      1000ms, std::bind(&CanBridgeNode::publish_status, this));

    // CAN受信スレッドの起動
    rx_thread_running_ = true;
    rx_thread_ = std::thread(&CanBridgeNode::rx_thread_loop, this);

    RCLCPP_INFO(this->get_logger(), "Altair CAN Bridge Node が起動しました。接続待ち状態です。");

    // デフォルトで自動接続を試みる (自動接続モードが標準ONを想定)
    std::thread([this]() {
      RCLCPP_INFO(this->get_logger(), "起動時自動接続プロセスを開始します...");
      trigger_connect("", true);
    }).detach();
  }

  ~CanBridgeNode()
  {
    rx_thread_running_ = false;
    if (rx_thread_.joinable()) {
      rx_thread_.join();
    }
    close_can_socket();
  }

private:
  // --- 1. ROS2トピック ➔ 物理CAN (TX) ---
  void handle_can_tx_callback(const can_msgs::msg::Frame::SharedPtr msg)
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    if (!is_connected_ || can_socket_ < 0) {
      // 接続されていない場合は黙って無視
      return;
    }

    struct can_frame frame;
    memset(&frame, 0, sizeof(frame));

    frame.can_id = msg->id;
    if (msg->is_rtr) {
      frame.can_id |= CAN_RTR_FLAG;
    }
    if (msg->is_extended) {
      frame.can_id |= CAN_EFF_FLAG;
    }
    frame.can_dlc = msg->dlc;
    memcpy(frame.data, msg->data.data(), msg->dlc);

    // SocketCANに書き込み
    int bytes_sent = write(can_socket_, &frame, sizeof(struct can_frame));
    if (bytes_sent < 0) {
      if (errno == ENOBUFS || errno == EAGAIN || errno == EWOULDBLOCK) {
        // 送信バッファ一時満杯などの軽微なエラー時は切断せずパケットをスキップ
        RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000, 
          "CAN送信バッファ満杯 (ENOBUFS/EAGAIN) を検知しました。パケットをスキップします。");
        return;
      }
      RCLCPP_ERROR(this->get_logger(), "CANフレームの送信に失敗しました: %s", strerror(errno));
      // 致命的な通信エラーのみ切断状態に移行
      handle_disconnect("CANフレーム送信失敗による通信切断");
    }
  }

  // --- 2. 物理CAN ➔ ROS2トピック (RXスレッド) ---
  void rx_thread_loop()
  {
    struct can_frame frame;

    while (rx_thread_running_ && rclcpp::ok()) {
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        if (!is_connected_ || can_socket_ < 0) {
          // 未接続時はスリープして待機
          socket_mutex_.unlock();
          std::this_thread::sleep_for(100ms);
          socket_mutex_.lock();
          continue;
        }
      }

      // ソケットのポーリング設定（ブロッキングを避けるためタイムアウトを設定）
      struct timeval tv;
      tv.tv_sec = 0;
      tv.tv_usec = 100000; // 100ms
      
      fd_set rdfs;
      FD_ZERO(&rdfs);
      FD_SET(can_socket_, &rdfs);

      int ret = select(can_socket_ + 1, &rdfs, NULL, NULL, &tv);
      if (ret < 0) {
        if (errno == EINTR) continue;
        RCLCPP_ERROR(this->get_logger(), "SocketCANの選択中にエラーが発生しました: %s", strerror(errno));
        handle_disconnect("SocketCAN選択エラー");
        continue;
      }
      else if (ret == 0) {
        // タイムアウト、ループ継続
        continue;
      }

      // CANデータ読み取り
      int nbytes = read(can_socket_, &frame, sizeof(struct can_frame));
      if (nbytes < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
        RCLCPP_ERROR(this->get_logger(), "CANフレームの読み取りに失敗しました: %s", strerror(errno));
        handle_disconnect("CANフレーム読み取りエラー");
        continue;
      }

      if (nbytes < (int)sizeof(struct can_frame)) {
        RCLCPP_ERROR(this->get_logger(), "不正なサイズのCANフレームを受信しました。");
        continue;
      }

      // ROS2メッセージへ詰め替え
      auto rx_msg = std::make_shared<can_msgs::msg::Frame>();
      rx_msg->header.stamp = this->now();
      rx_msg->header.frame_id = "can0";
      
      rx_msg->id = frame.can_id & CAN_EFF_MASK;
      rx_msg->is_rtr = (frame.can_id & CAN_RTR_FLAG) != 0;
      rx_msg->is_extended = (frame.can_id & CAN_EFF_FLAG) != 0;
      rx_msg->is_error = (frame.can_id & CAN_ERR_FLAG) != 0;
      rx_msg->dlc = frame.can_dlc;
      
      std::copy(frame.data, frame.data + frame.can_dlc, rx_msg->data.begin());

      // パブリッシュ
      can_rx_pub_->publish(*rx_msg);
    }
  }

  // --- 3. 接続処理コア ---
  bool trigger_connect(const std::string& port, bool auto_connect)
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    
    // 一度既存のソケットを閉じる
    close_can_socket_nolock();
    is_connected_ = false;

    // パッケージシェアディレクトリ内のsetup_slcan.shのパスをROS2標準APIで取得
    std::string pkg_share_dir = "";
    try {
      pkg_share_dir = ament_index_cpp::get_package_share_directory("altair_can_bridge");
    } catch (const std::exception& e) {
      RCLCPP_ERROR(this->get_logger(), "パッケージシェアディレクトリの検出に失敗しました: %s", e.what());
      last_error_ = "パッケージ検出失敗";
      return false;
    }

    std::string script_path = pkg_share_dir + "/scripts/setup_slcan.sh";
    // もしインストールディレクトリに無ければ、カレントワークスペースのローカルパスも探す (デバッグ用)
    if (!fs::exists(script_path)) {
      script_path = "./src/altair_can_bridge/scripts/setup_slcan.sh";
    }
    if (!fs::exists(script_path)) {
      script_path = "./src/altair_framework/altair_can_bridge/scripts/setup_slcan.sh";
    }
    
    // WSL環境か否かに応じてコマンド構築
    std::string cmd;
    if (auto_connect) {
      cmd = "bash " + script_path + " auto 1000000";
    } else {
      cmd = "bash " + script_path + " " + port + " 1000000";
    }

    RCLCPP_INFO(this->get_logger(), "接続スクリプトを実行中: %s", cmd.c_str());
    
    // スクリプトの実行
    int exit_code = std::system(cmd.c_str());
    if (exit_code != 0) {
      RCLCPP_WARN(this->get_logger(), "接続スクリプトが非ゼロで終了しました (コード: %d)。すでに can0 が起動しているか、sudo パスワードが必要です。ソケットバインドを試行します...", exit_code);
    }

    // SocketCAN ソケットのオープン
    can_socket_ = socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (can_socket_ < 0) {
      RCLCPP_ERROR(this->get_logger(), "SocketCAN ソケットの作成に失敗しました: %s", strerror(errno));
      last_error_ = "Socket作成失敗: " + std::string(strerror(errno));
      return false;
    }

    struct ifreq ifr;
    strcpy(ifr.ifr_name, "can0");
    if (ioctl(can_socket_, SIOCGIFINDEX, &ifr) < 0) {
      RCLCPP_ERROR(this->get_logger(), "インターフェース can0 の検出に失敗しました: %s", strerror(errno));
      last_error_ = "can0 検出失敗: " + std::string(strerror(errno));
      close(can_socket_);
      can_socket_ = -1;
      return false;
    }

    struct sockaddr_can addr;
    memset(&addr, 0, sizeof(addr));
    addr.can_family = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;

    // ソケットをバインド
    if (bind(can_socket_, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
      RCLCPP_ERROR(this->get_logger(), "SocketCAN can0 へのバインドに失敗しました: %s", strerror(errno));
      last_error_ = "can0 バインド失敗: " + std::string(strerror(errno));
      close(can_socket_);
      can_socket_ = -1;
      return false;
    }

    // ノンブロッキングモードに設定
    int opts = fcntl(can_socket_, F_GETFL);
    if (opts >= 0) {
      fcntl(can_socket_, F_SETFL, opts | O_NONBLOCK);
    }

    // 接続成功
    is_connected_ = true;
    active_port_ = auto_connect ? "Auto-Detected Port" : port;
    last_error_ = "";
    RCLCPP_INFO(this->get_logger(), "SocketCAN can0 への接続が完了しました！");
    return true;
  }

  void handle_disconnect(const std::string& error_msg)
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    close_can_socket_nolock();
    is_connected_ = false;
    last_error_ = error_msg;
    RCLCPP_WARN(this->get_logger(), "CAN接続が切断されました: %s", error_msg.c_str());
  }

  void close_can_socket()
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    close_can_socket_nolock();
  }

  void close_can_socket_nolock()
  {
    if (can_socket_ >= 0) {
      close(can_socket_);
      can_socket_ = -1;
    }
  }

  // --- 4. サービスハンドラー ---
  void handle_get_ports_service(
    const std::shared_ptr<altair_interfaces::srv::GetAvailablePorts::Request> request,
    std::shared_ptr<altair_interfaces::srv::GetAvailablePorts::Response> response)
  {
    (void)request;
    std::vector<std::string> detected_ports;

    // /dev ディレクトリから ttyACM* と ttyUSB* を探索 (C++17 filesystem)
    try {
      if (fs::exists("/dev")) {
        for (const auto& entry : fs::directory_iterator("/dev")) {
          std::string name = entry.path().filename().string();
          if (name.find("ttyACM") == 0 || name.find("ttyUSB") == 0) {
            detected_ports.push_back(entry.path().string());
          }
        }
      }
    } catch (const std::exception& e) {
      RCLCPP_WARN(this->get_logger(), "ポート一覧スキャン中に例外が発生しました: %s", e.what());
    }

    // WSL上でデバッグしやすいようにモックポートも追加 (WSLで物理COMポートが見えない場合のテスト用)
    if (detected_ports.empty()) {
      detected_ports.push_back("/dev/ttyACM0 (Mock CANable2)");
      detected_ports.push_back("/dev/ttyACM1 (Mock USB-CAN)");
    }

    response->ports = detected_ports;
  }

  void handle_connect_can_service(
    const std::shared_ptr<altair_interfaces::srv::ConnectCan::Request> request,
    std::shared_ptr<altair_interfaces::srv::ConnectCan::Response> response)
  {
    RCLCPP_INFO(this->get_logger(), "CAN接続サービス要求を受信しました。");
    
    // 非同期で接続プロセスを実行 (ブロッキングを避けるため)
    bool success = trigger_connect(request->port, request->auto_connect);
    
    response->success = success;
    if (success) {
      response->message = "接続成功: can0 が正常に起動しました。";
    } else {
      response->message = "接続失敗: " + last_error_;
    }
  }

  // --- 5. 接続ステータス配信 ---
  void publish_status()
  {
    auto status_msg = altair_interfaces::msg::CanStatus();
    status_msg.is_connected = is_connected_;
    status_msg.active_port = is_connected_ ? active_port_ : "None";
    status_msg.bitrate = is_connected_ ? 1000000 : 0;
    status_msg.error_message = last_error_;

    can_status_pub_->publish(status_msg);
  }

  // メンバー変数
  std::atomic<bool> is_connected_;
  std::string active_port_;
  std::string last_error_;
  int can_socket_;
  std::mutex socket_mutex_;

  std::thread rx_thread_;
  std::atomic<bool> rx_thread_running_;

  // ROS2 インターフェース
  rclcpp::Publisher<can_msgs::msg::Frame>::SharedPtr can_rx_pub_;
  rclcpp::Publisher<altair_interfaces::msg::CanStatus>::SharedPtr can_status_pub_;
  rclcpp::Subscription<can_msgs::msg::Frame>::SharedPtr can_tx_sub_;
  
  rclcpp::Service<altair_interfaces::srv::GetAvailablePorts>::SharedPtr get_ports_srv_;
  rclcpp::Service<altair_interfaces::srv::ConnectCan>::SharedPtr connect_can_srv_;
  
  rclcpp::TimerBase::SharedPtr status_timer_;
};

int main(int argc, char * argv[])
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<CanBridgeNode>());
  rclcpp::shutdown();
  return 0;
}
