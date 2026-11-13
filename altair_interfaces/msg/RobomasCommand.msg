# RoboMaster モーター制御コマンドメッセージ定義

float64 target          # 目標値 (current/voltage: 生指令値, speed_pid: rpm, position_pid: deg)
string mode             # 空文字なら設定モードを使用 ("current", "voltage", "speed_pid", "position_pid")
bool reset_zero         # true の場合、累積角度原点を 0 deg にリセット
