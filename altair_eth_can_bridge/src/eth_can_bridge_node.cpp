// C++ 標準ヘッダー
#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include <deque>
#include <thread>
#include <atomic>
#include <mutex>
#include <iostream>
#include <cstring>
#include <cerrno>
#include <algorithm>
#include <cctype>

// POSIX ネットワークヘッダー
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>

// ROS2 ヘッダー
#include "rclcpp/rclcpp.hpp"
#include "can_msgs/msg/frame.hpp"
#include "altair_interfaces/msg/can_status.hpp"
#include "altair_interfaces/srv/connect_can.hpp"
#include "altair_interfaces/srv/connect_eth_can.hpp"

using namespace std::chrono_literals;

class EthCanBridgeNode : public rclcpp::Node
{
public:
  EthCanBridgeNode()
  : Node("eth_can_bridge_node"), is_connected_(false), sock_(-1), manual_disconnected_(false)
  {
    // ROS2パラメータの宣言と取得
    this->declare_parameter<std::string>("target_ip", "192.168.2.123");
    this->declare_parameter<int>("target_port", 5000);
    this->declare_parameter<std::string>("can_channel", "can1");
    this->declare_parameter<double>("poll_interval_ms", 5.0);
    this->declare_parameter<double>("poll_suppress_after_tx_ms", 15.0);
    this->declare_parameter<int>("config_frame_repeat", 3);

    target_ip_ = this->get_parameter("target_ip").as_string();
    target_port_ = this->get_parameter("target_port").as_int();
    can_channel_ = normalize_can_channel(this->get_parameter("can_channel").as_string());
    poll_interval_ms_ = this->get_parameter("poll_interval_ms").as_double();
    poll_suppress_after_tx_ms_ = this->get_parameter("poll_suppress_after_tx_ms").as_double();
    config_frame_repeat_ = this->get_parameter("config_frame_repeat").as_int();
    if (config_frame_repeat_ < 1) {
      config_frame_repeat_ = 1;
    }

    RCLCPP_INFO(this->get_logger(), "Altair Ethernet-CAN Bridge ノードを初期化しています...");
    RCLCPP_INFO(this->get_logger(), "接続先: %s:%d, 対象チャンネル: %s",
      target_ip_.c_str(), target_port_, can_channel_.c_str());

    // ROS2パブリッシャとサブスクライバの初期化
    can_rx_pub_ = this->create_publisher<can_msgs::msg::Frame>("/altair/can/rx", 100);
    can_status_pub_ = this->create_publisher<altair_interfaces::msg::CanStatus>("/altair/can/status", 10);

    can_tx_sub_ = this->create_subscription<can_msgs::msg::Frame>(
      "/altair/can/tx", 100,
      std::bind(&EthCanBridgeNode::handle_can_tx_callback, this, std::placeholders::_1));

    // ROS2サービスサーバーの初期化
    connect_can_srv_ = this->create_service<altair_interfaces::srv::ConnectCan>(
      "/altair/can/connect",
      std::bind(&EthCanBridgeNode::handle_connect_can_service, this, std::placeholders::_1, std::placeholders::_2));

    connect_eth_can_srv_ = this->create_service<altair_interfaces::srv::ConnectEthCan>(
      "/altair/eth_can/connect",
      std::bind(&EthCanBridgeNode::handle_connect_eth_can_service, this, std::placeholders::_1, std::placeholders::_2));

    // 接続ステータス配信用のタイマー (1Hz)
    status_timer_ = this->create_wall_timer(
      1000ms, std::bind(&EthCanBridgeNode::publish_status, this));

    // 送受信統合スレッドの開始
    io_thread_running_ = true;
    io_thread_ = std::thread(&EthCanBridgeNode::io_thread_loop, this);

    // 自動接続・再接続スレッドの開始
    auto_connect_running_ = true;
    auto_connect_thread_ = std::thread(&EthCanBridgeNode::auto_connect_loop, this);

    RCLCPP_INFO(this->get_logger(), "Ethernet-CAN Bridge ノードが起動しました。");
  }

  ~EthCanBridgeNode()
  {
    auto_connect_running_ = false;
    if (auto_connect_thread_.joinable()) {
      auto_connect_thread_.join();
    }

    io_thread_running_ = false;
    if (io_thread_.joinable()) {
      io_thread_.join();
    }

    close_socket();
  }

private:
  // 送信キュー要素
  struct PendingTxItem
  {
    uint16_t can_id;
    bool send_can1;
    bool send_can2;
    bool is_config_frame;
    uint8_t payload[20];
  };

  // STM32 LANtoCAN 60Bパケット内のハードウェアCAN診断情報 (CanDebug構造体: 17バイト)
  struct CanHwDiag
  {
    uint8_t boff = 0;
    uint8_t epvf = 0;
    uint8_t ewgf = 0;
    uint8_t lec = 0;
    uint8_t tec = 0;
    uint8_t rec = 0;
    uint8_t tx_free = 3;
  };

  static std::string normalize_can_channel(const std::string& ch)
  {
    std::string lower = ch;
    std::transform(lower.begin(), lower.end(), lower.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (lower == "can2" || lower == "2") {
      return "can2";
    }
    if (lower == "both" || lower == "can1+2" || lower == "all") {
      return "both";
    }
    return "can1";
  }

  static std::string format_channel_label(const std::string& ch)
  {
    if (ch == "can2") {
      return "CAN2";
    }
    if (ch == "both") {
      return "CAN1+2";
    }
    return "CAN1";
  }

  // パラメータ設定 (0x200..0x203) やモード設定 (0x210) など、取りこぼし厳禁の設定用フレームかどうかを判定
  static bool is_config_can_id(uint16_t can_id)
  {
    uint16_t sub_id = can_id & 0x0FF;
    // MDD Base ID (例: 0x200, 0x400) に対する +0x00..+0x1F を設定フレームとして扱う
    return (can_id >= 0x200) && (sub_id < 0x20);
  }

  // STM32 CanDebug (17B) のデコード:
  // offset+0..3: err (uint32 LE), offset+4..7: esr (uint32 LE),
  // offset+8: lec, offset+9: tec, offset+10: rec,
  // offset+11: ewgf, offset+12: epvf, offset+13: boff, offset+14: tx_free
  static CanHwDiag parse_can_debug(const uint8_t* buf, size_t offset)
  {
    CanHwDiag d{};
    d.lec = buf[offset + 8];
    d.tec = buf[offset + 9];
    d.rec = buf[offset + 10];
    d.ewgf = buf[offset + 11];
    d.epvf = buf[offset + 12];
    d.boff = buf[offset + 13];
    d.tx_free = buf[offset + 14];
    return d;
  }

  // --- 1. ROS2トピック ➔ 送信キュー登録 (TX) ---
  void handle_can_tx_callback(const can_msgs::msg::Frame::SharedPtr msg)
  {
    if (!is_connected_) {
      return;
    }

    // Analyzer Mode 送信パケット構造 (20バイト)
    // 0..1:   CAN1 ID (11bit標準IDをBig-Endian格納)
    // 2..9:   CAN1 Data (8バイト)
    // 10..11: CAN2 ID (11bit標準IDをBig-Endian格納)
    // 12..19: CAN2 Data (8バイト)
    PendingTxItem item{};
    std::memset(item.payload, 0, sizeof(item.payload));

    uint16_t standard_id = static_cast<uint16_t>(msg->id & 0x7FF);
    if (standard_id == 0) {
      return;
    }
    uint8_t dlc = msg->dlc > 8 ? 8 : msg->dlc;

    std::string active_ch;
    {
      std::lock_guard<std::mutex> lock(socket_mutex_);
      active_ch = can_channel_;
    }

    bool send_can1 = false;
    bool send_can2 = false;
    if (msg->header.frame_id == "can1") {
      send_can1 = true;
    } else if (msg->header.frame_id == "can2") {
      send_can2 = true;
    } else if (msg->header.frame_id == "both") {
      send_can1 = true;
      send_can2 = true;
    } else if (active_ch == "can2") {
      send_can2 = true;
    } else if (active_ch == "both") {
      send_can1 = true;
      send_can2 = true;
    } else {
      send_can1 = true;
    }

    if (send_can1) {
      item.payload[0] = static_cast<uint8_t>((standard_id >> 8) & 0xFF);
      item.payload[1] = static_cast<uint8_t>(standard_id & 0xFF);
      for (size_t i = 0; i < dlc; ++i) {
        item.payload[2 + i] = msg->data[i];
      }
    }
    if (send_can2) {
      item.payload[10] = static_cast<uint8_t>((standard_id >> 8) & 0xFF);
      item.payload[11] = static_cast<uint8_t>(standard_id & 0xFF);
      for (size_t i = 0; i < dlc; ++i) {
        item.payload[12 + i] = msg->data[i];
      }
    }

    item.can_id = standard_id;
    item.send_can1 = send_can1;
    item.send_can2 = send_can2;
    item.is_config_frame = is_config_can_id(standard_id);

    std::lock_guard<std::mutex> lock(tx_queue_mutex_);
    if (item.is_config_frame) {
      // 同一CAN ID・同一チャンネルの古い設定フレームがキューに残っていれば削除して滞留・洪水化を防ぐ
      tx_queue_.erase(
        std::remove_if(tx_queue_.begin(), tx_queue_.end(),
          [&](const PendingTxItem& existing) {
            return existing.is_config_frame &&
                   existing.can_id == item.can_id &&
                   existing.send_can1 == item.send_can1 &&
                   existing.send_can2 == item.send_can2;
          }),
        tx_queue_.end());

      // 設定フレーム (0x200..0x203, 0x210) はSTM32側の1msタイマーで確実に拾わせるため複数回キューに積む
      for (int r = 0; r < config_frame_repeat_; ++r) {
        tx_queue_.push_back(item);
      }
    } else {
      // 周期制御フレーム (0x220, 0x100, 0x300等) は同一CAN ID・同一チャンネルの未送信フレームがあれば最新値で上書きして遅延蓄積を防ぐ
      for (auto & existing : tx_queue_) {
        if (!existing.is_config_frame &&
            existing.can_id == item.can_id &&
            existing.send_can1 == item.send_can1 &&
            existing.send_can2 == item.send_can2) {
          std::memcpy(existing.payload, item.payload, sizeof(item.payload));
          return;
        }
      }
      // キュー上限を超えている場合は古い非設定フレームを破棄
      if (tx_queue_.size() >= 64) {
        for (auto it = tx_queue_.begin(); it != tx_queue_.end(); ++it) {
          if (!it->is_config_frame) {
            tx_queue_.erase(it);
            break;
          }
        }
      }
      tx_queue_.push_back(item);
    }
  }

  // --- 2. Ethernet-CAN 送受信統合スレッド ---
  // LANtoCAN (STM32 + W5500) ファームウェアの以下の特性に合わせて送受信を同期制御する:
  // 1) STM32の tcp_process() は send(60B) -> ブロッキング recv(140B) の順で動作するため、
  //    PC側から定期的に20Bパケット(送信データまたはゼロ埋めpoll)を送らないと次の受信パケットが返らない。
  // 2) STM32の main() ループは約0.1msで回る一方、CAN送信処理 interrupt() は1ms周期タイマーで動作し、
  //    単一バッファ eth_recv_data の先頭20Bのみを参照する。
  //    そのため、異なる設定IDへ切り替える際は最低8.0msホールドし、設定フレーム送信直後は15.0ms間ゼロpollを抑制する。
  void io_thread_loop()
  {
    constexpr size_t ANALYZER_RX_SIZE = 60;
    constexpr size_t ANALYZER_TX_SIZE = 20;
    uint8_t rx_buffer[ANALYZER_RX_SIZE];
    size_t buffer_filled = 0;

    uint16_t last_rx_id[2] = {0, 0};
    uint8_t last_rx_data[2][8] = {{0}, {0}};
    auto last_rx_publish_time0 = std::chrono::steady_clock::now() - 100ms;
    auto last_rx_publish_time1 = std::chrono::steady_clock::now() - 100ms;

    auto last_wire_send_time = std::chrono::steady_clock::now() - 100ms;
    auto last_config_tx_time = std::chrono::steady_clock::now() - 100ms;
    bool has_last_sent_config_id = false;
    uint16_t last_sent_config_id = 0;

    while (io_thread_running_ && rclcpp::ok()) {
      int current_sock = -1;
      std::string active_ch;
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        if (is_connected_ && sock_ >= 0) {
          current_sock = sock_;
        }
        active_ch = can_channel_;
      }

      if (current_sock < 0) {
        buffer_filled = 0;
        last_rx_id[0] = 0;
        last_rx_id[1] = 0;
        has_last_sent_config_id = false;
        std::this_thread::sleep_for(50ms);
        continue;
      }

      // 1ms刻みでソケット受信を監視しつつ、送信タイミングを制御する
      fd_set read_fds;
      FD_ZERO(&read_fds);
      FD_SET(current_sock, &read_fds);

      struct timeval tv;
      tv.tv_sec = 0;
      tv.tv_usec = 1000; // 1ms

      int ret = select(current_sock + 1, &read_fds, nullptr, nullptr, &tv);
      if (ret < 0) {
        if (errno == EINTR) {
          continue;
        }
        RCLCPP_ERROR(this->get_logger(), "select エラー: %s", strerror(errno));
        handle_disconnect("selectエラー");
        buffer_filled = 0;
        continue;
      }

      if (ret > 0 && FD_ISSET(current_sock, &read_fds)) {
        ssize_t bytes_read = recv(
          current_sock,
          rx_buffer + buffer_filled,
          ANALYZER_RX_SIZE - buffer_filled,
          0);

        if (bytes_read <= 0) {
          if (bytes_read < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            // 読み取り待機継続
          } else {
            RCLCPP_WARN(this->get_logger(), "TCP接続がリモートによって切断されました。");
            handle_disconnect("相手先による切断検知");
            buffer_filled = 0;
            continue;
          }
        } else {
          buffer_filled += static_cast<size_t>(bytes_read);

          // 60バイト揃ったらパースしてROS2トピックへパブリッシュ
          if (buffer_filled >= ANALYZER_RX_SIZE) {
            buffer_filled = 0;
            auto now_steady = std::chrono::steady_clock::now();

            // 0. STM32 CAN1/CAN2 ハードウェア診断ブロック (offset 23..39, 43..59) の解析
            CanHwDiag diag1 = parse_can_debug(rx_buffer, 23);
            CanHwDiag diag2 = parse_can_debug(rx_buffer, 43);
            {
              std::lock_guard<std::mutex> lock(socket_mutex_);
              hw_diag_can1_ = diag1;
              hw_diag_can2_ = diag2;
            }
            if ((active_ch == "can1" || active_ch == "both") && diag1.boff) {
              RCLCPP_WARN_THROTTLE(
                this->get_logger(), *this->get_clock(), 3000,
                "[HW DIAG] CAN1 が Bus-Off 状態です (BOFF=1, TEC=%u, REC=%u, LEC=%u)。CAN2への切り替えを推奨します。",
                diag1.tec, diag1.rec, diag1.lec);
            }
            if ((active_ch == "can2" || active_ch == "both") && diag2.boff) {
              RCLCPP_WARN_THROTTLE(
                this->get_logger(), *this->get_clock(), 3000,
                "[HW DIAG] CAN2 が Bus-Off 状態です (BOFF=1, TEC=%u, REC=%u, LEC=%u)。",
                diag2.tec, diag2.rec, diag2.lec);
            }

            // モジュール単位で CAN1 / CAN2 を個別に割り当てた場合でもフィードバックを受信できるよう、
            // 60B パケットに含まれる CAN1 (0..9) と CAN2 (10..19) の両方を常に確認する
            // 1. CAN1 受信フレームの復元 (オフセット 0..9)
            {
              uint16_t can1_id = static_cast<uint16_t>(
                ((static_cast<uint16_t>(rx_buffer[0]) << 8) | rx_buffer[1]) & 0x7FF);
              if (can1_id != 0) {
                bool changed = (can1_id != last_rx_id[0]) ||
                  (std::memcmp(rx_buffer + 2, last_rx_data[0], 8) != 0);
                double elapsed_ms = std::chrono::duration<double, std::milli>(
                  now_steady - last_rx_publish_time0).count();
                // LANtoCANは新規CANフレーム未着時も前回の can1_r_data を返し続けるため、
                // 内容変化時または最大10ms周期でパブリッシュする
                if (changed || elapsed_ms >= 9.0) {
                  last_rx_id[0] = can1_id;
                  std::memcpy(last_rx_data[0], rx_buffer + 2, 8);
                  last_rx_publish_time0 = now_steady;

                  auto frame_msg = std::make_shared<can_msgs::msg::Frame>();
                  frame_msg->header.stamp = this->now();
                  frame_msg->header.frame_id = "can1";
                  frame_msg->id = can1_id;
                  frame_msg->is_extended = false;
                  frame_msg->is_rtr = false;
                  frame_msg->is_error = false;
                  frame_msg->dlc = 8;
                  std::copy(rx_buffer + 2, rx_buffer + 10, frame_msg->data.begin());

                  can_rx_pub_->publish(*frame_msg);
                }
              }
            }

            // 2. CAN2 受信フレームの復元 (オフセット 10..19)
            {
              uint16_t can2_id = static_cast<uint16_t>(
                ((static_cast<uint16_t>(rx_buffer[10]) << 8) | rx_buffer[11]) & 0x7FF);
              if (can2_id != 0) {
                bool changed = (can2_id != last_rx_id[1]) ||
                  (std::memcmp(rx_buffer + 12, last_rx_data[1], 8) != 0);
                double elapsed_ms = std::chrono::duration<double, std::milli>(
                  now_steady - last_rx_publish_time1).count();
                if (changed || elapsed_ms >= 9.0) {
                  last_rx_id[1] = can2_id;
                  std::memcpy(last_rx_data[1], rx_buffer + 12, 8);
                  last_rx_publish_time1 = now_steady;

                  auto frame_msg = std::make_shared<can_msgs::msg::Frame>();
                  frame_msg->header.stamp = this->now();
                  frame_msg->header.frame_id = "can2";
                  frame_msg->id = can2_id;
                  frame_msg->is_extended = false;
                  frame_msg->is_rtr = false;
                  frame_msg->is_error = false;
                  frame_msg->dlc = 8;
                  std::copy(rx_buffer + 12, rx_buffer + 20, frame_msg->data.begin());

                  can_rx_pub_->publish(*frame_msg);
                }
              }
            }
          }
        }
      }

      // --- 送信 (またはRXトリガー用poll) 判定 ---
      auto now = std::chrono::steady_clock::now();
      double since_last_send_ms = std::chrono::duration<double, std::milli>(
        now - last_wire_send_time).count();
      double since_config_tx_ms = std::chrono::duration<double, std::milli>(
        now - last_config_tx_time).count();

      // STM32の1msタイマー割り込みが確実に前回の eth_recv_data を処理できるよう、最低2.0msの間隔を空ける
      if (since_last_send_ms < 2.0) {
        continue;
      }

      uint8_t tx_payload[ANALYZER_TX_SIZE];
      bool is_config_tx = false;
      bool should_send_wire = false;

      {
        std::lock_guard<std::mutex> lock(tx_queue_mutex_);
        if (!tx_queue_.empty()) {
          const PendingTxItem& front = tx_queue_.front();
          // 異なる設定CAN IDへ切り替える際は、前回の設定IDがSTM32で確実に送信完了するよう最低8.0ms保持する
          bool id_switch_hold = front.is_config_frame &&
            has_last_sent_config_id &&
            (last_sent_config_id != front.can_id) &&
            (since_config_tx_ms < 8.0);

          if (!id_switch_hold) {
            PendingTxItem item = tx_queue_.front();
            tx_queue_.pop_front();
            std::memcpy(tx_payload, item.payload, ANALYZER_TX_SIZE);
            is_config_tx = item.is_config_frame;
            if (item.is_config_frame) {
              has_last_sent_config_id = true;
              last_sent_config_id = item.can_id;
            }
            should_send_wire = true;
          }
        }
      }

      if (!should_send_wire) {
        // 設定フレーム送信直後はSTM32の eth_recv_data をゼロで上書きしないよう poll を抑制し、
        // 通常時 (周期制御フレーム送信中を含む) は poll_interval_ms_ 周期で 20B ゼロパケットを送信して 5ms CAN RX を継続させる
        if (since_last_send_ms >= poll_interval_ms_ &&
            since_config_tx_ms >= poll_suppress_after_tx_ms_)
        {
          std::memset(tx_payload, 0, ANALYZER_TX_SIZE);
          has_last_sent_config_id = false;
          should_send_wire = true;
        }
      }

      if (should_send_wire) {
        ssize_t bytes_sent = -1;
        {
          std::lock_guard<std::mutex> lock(socket_mutex_);
          if (is_connected_ && sock_ == current_sock) {
            bytes_sent = send(current_sock, tx_payload, ANALYZER_TX_SIZE, MSG_NOSIGNAL);
          }
        }

        if (bytes_sent < 0) {
          if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
            continue;
          }
          RCLCPP_ERROR(this->get_logger(), "TCPパケットの送信に失敗しました: %s", strerror(errno));
          handle_disconnect("TCP送信エラー");
          buffer_filled = 0;
          continue;
        }

        last_wire_send_time = now;
        if (is_config_tx) {
          last_config_tx_time = now;
        }
      }
    }
  }

  // --- 3. ソケット接続処理 ---
  bool trigger_connect(const std::string& ip, int port)
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    close_socket_nolock();

    {
      std::lock_guard<std::mutex> qlock(tx_queue_mutex_);
      tx_queue_.clear();
    }

    RCLCPP_INFO(this->get_logger(), "Ethernet-CAN 基板へ接続を試みています... (%s:%d [%s])",
      ip.c_str(), port, format_channel_label(can_channel_).c_str());

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) {
      last_error_ = "ソケット生成に失敗しました: " + std::string(strerror(errno));
      RCLCPP_ERROR(this->get_logger(), "%s", last_error_.c_str());
      return false;
    }

    // TCP_NODELAY (Nagleアルゴリズム無効化) の設定
    int flag = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<char*>(&flag), sizeof(int));

    // 送受信タイムアウトの設定 (1秒)
    struct timeval timeout;
    timeout.tv_sec = 1;
    timeout.tv_usec = 0;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));

    struct sockaddr_in serv_addr;
    std::memset(&serv_addr, 0, sizeof(serv_addr));
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(port);

    if (inet_pton(AF_INET, ip.c_str(), &serv_addr.sin_addr) <= 0) {
      last_error_ = "不正なIPアドレス形式です: " + ip;
      RCLCPP_ERROR(this->get_logger(), "%s", last_error_.c_str());
      close(s);
      return false;
    }

    if (connect(s, reinterpret_cast<struct sockaddr*>(&serv_addr), sizeof(serv_addr)) < 0) {
      last_error_ = "接続に失敗しました: " + std::string(strerror(errno));
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000, "%s", last_error_.c_str());
      close(s);
      return false;
    }

    sock_ = s;
    is_connected_ = true;
    manual_disconnected_ = false;
    target_ip_ = ip;
    target_port_ = port;
    last_error_ = "";

    RCLCPP_INFO(this->get_logger(), "Ethernet-CAN 基板 (%s:%d [%s]) へのTCP接続が完了しました！",
      ip.c_str(), port, format_channel_label(can_channel_).c_str());
    return true;
  }

  void handle_disconnect(const std::string& error_msg)
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    close_socket_nolock();
    last_error_ = error_msg;
    RCLCPP_WARN(this->get_logger(), "CAN接続が切断されました: %s", error_msg.c_str());
  }

  void close_socket()
  {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    close_socket_nolock();
  }

  void close_socket_nolock()
  {
    if (sock_ >= 0) {
      close(sock_);
      sock_ = -1;
    }
    is_connected_ = false;
  }

  // --- 4. 自動接続ループ ---
  void auto_connect_loop()
  {
    while (auto_connect_running_ && rclcpp::ok()) {
      bool need_connect = false;
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        need_connect = (!manual_disconnected_) && (!is_connected_ || sock_ < 0);
      }

      if (need_connect) {
        trigger_connect(target_ip_, target_port_);
      }

      std::this_thread::sleep_for(1500ms);
    }
  }

  // --- 5. ステータス配信 ---
  void publish_status()
  {
    auto status_msg = altair_interfaces::msg::CanStatus();
    {
      std::lock_guard<std::mutex> lock(socket_mutex_);
      status_msg.is_connected = is_connected_;
      status_msg.active_port = target_ip_ + ":" + std::to_string(target_port_) +
        " [" + format_channel_label(can_channel_) + "]";
      status_msg.bitrate = 1000000;

      std::string diag_err = last_error_;
      if (is_connected_) {
        if ((can_channel_ == "can1" || can_channel_ == "both") && hw_diag_can1_.boff) {
          diag_err = "CAN1 ハードウェア Bus-Off 検知 (BOFF=1, TEC=" +
            std::to_string(hw_diag_can1_.tec) + ", LEC=" + std::to_string(hw_diag_can1_.lec) +
            ") - CAN2への切り替えを推奨";
        } else if ((can_channel_ == "can2" || can_channel_ == "both") && hw_diag_can2_.boff) {
          diag_err = "CAN2 ハードウェア Bus-Off 検知 (BOFF=1, TEC=" +
            std::to_string(hw_diag_can2_.tec) + ", LEC=" + std::to_string(hw_diag_can2_.lec) + ")";
        }
      }
      status_msg.error_message = diag_err;
    }
    can_status_pub_->publish(status_msg);
  }

  // --- 6. サービスハンドラ ---
  void handle_connect_can_service(
    const std::shared_ptr<altair_interfaces::srv::ConnectCan::Request> request,
    std::shared_ptr<altair_interfaces::srv::ConnectCan::Response> response)
  {
    if (request->port.empty() && !request->auto_connect) {
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        manual_disconnected_ = true;
        close_socket_nolock();
        last_error_ = "";
      }
      publish_status();
      response->success = true;
      response->message = "Ethernet-CAN 接続を切断しました。";
      return;
    }

    RCLCPP_INFO(this->get_logger(), "手動再接続リクエストを受信しました。");
    bool ok = trigger_connect(target_ip_, target_port_);
    publish_status();
    response->success = ok;
    response->message = ok ? "接続成功" : last_error_;
  }

  void handle_connect_eth_can_service(
    const std::shared_ptr<altair_interfaces::srv::ConnectEthCan::Request> request,
    std::shared_ptr<altair_interfaces::srv::ConnectEthCan::Response> response)
  {
    // 空IPの場合は手動切断リクエストとして処理
    if (request->target_ip.empty()) {
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        manual_disconnected_ = true;
        close_socket_nolock();
        last_error_ = "";
      }
      publish_status();
      response->success = true;
      response->message = "Ethernet-CAN 接続を切断しました。";
      return;
    }

    // チャンネルのみ即時変更リクエスト
    if (request->target_ip == "__CHANNEL_ONLY__") {
      std::string ch = normalize_can_channel(request->can_channel);
      {
        std::lock_guard<std::mutex> lock(socket_mutex_);
        can_channel_ = ch;
      }
      {
        std::lock_guard<std::mutex> qlock(tx_queue_mutex_);
        tx_queue_.clear();
      }
      publish_status();
      RCLCPP_INFO(this->get_logger(), "Ethernet-CAN 使用チャンネルを %s に切り替えました。",
        format_channel_label(ch).c_str());
      response->success = true;
      response->message = "使用CANチャンネルを " + format_channel_label(ch) + " に切り替えました。";
      return;
    }

    if (!request->can_channel.empty()) {
      std::lock_guard<std::mutex> lock(socket_mutex_);
      can_channel_ = normalize_can_channel(request->can_channel);
    }

    RCLCPP_INFO(this->get_logger(), "設定変更リクエストを受信しました: %s:%d [%s]",
      request->target_ip.c_str(), request->target_port, format_channel_label(can_channel_).c_str());
    bool ok = trigger_connect(request->target_ip, request->target_port);
    publish_status();
    response->success = ok;
    response->message = ok
      ? ("Ethernet-CAN (" + request->target_ip + ":" + std::to_string(request->target_port) +
         " [" + format_channel_label(can_channel_) + "]) に接続しました。")
      : last_error_;
  }

  // 内部変数
  std::atomic<bool> is_connected_;
  int sock_;
  bool manual_disconnected_;
  std::mutex socket_mutex_;
  std::string target_ip_;
  int target_port_;
  std::string can_channel_;
  double poll_interval_ms_;
  double poll_suppress_after_tx_ms_;
  int config_frame_repeat_;
  std::string last_error_;
  CanHwDiag hw_diag_can1_{};
  CanHwDiag hw_diag_can2_{};

  // 送信キュー
  std::mutex tx_queue_mutex_;
  std::deque<PendingTxItem> tx_queue_;

  // スレッド制御
  std::atomic<bool> io_thread_running_;
  std::thread io_thread_;
  std::atomic<bool> auto_connect_running_;
  std::thread auto_connect_thread_;

  // ROS2 インターフェース
  rclcpp::Publisher<can_msgs::msg::Frame>::SharedPtr can_rx_pub_;
  rclcpp::Publisher<altair_interfaces::msg::CanStatus>::SharedPtr can_status_pub_;
  rclcpp::Subscription<can_msgs::msg::Frame>::SharedPtr can_tx_sub_;
  rclcpp::Service<altair_interfaces::srv::ConnectCan>::SharedPtr connect_can_srv_;
  rclcpp::Service<altair_interfaces::srv::ConnectEthCan>::SharedPtr connect_eth_can_srv_;
  rclcpp::TimerBase::SharedPtr status_timer_;
};

int main(int argc, char** argv)
{
  rclcpp::init(argc, argv);
  auto node = std::make_shared<EthCanBridgeNode>();
  rclcpp::spin(node);
  rclcpp::shutdown();
  return 0;
}
