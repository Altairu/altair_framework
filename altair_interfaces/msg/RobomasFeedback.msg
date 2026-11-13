# RoboMaster モーター フィードバック情報メッセージ定義

uint16 raw_angle        # 生エンコーダ値 (0〜8191)
float64 single_angle_deg # 単回転角度 [deg] (0〜360)
float64 angle_deg       # 多回転累積角度 [deg]
int16 speed_rpm         # 回転速度 [rpm]
int16 torque_current    # トルク電流生値
float64 current_a       # 換算電流値 [A]
uint8 temperature       # モーター温度 [°C] (GM6020等)
int16 output_cmd        # 現在の出力指令値
float64 target          # 現在の目標値
string control_mode     # 現在の制御モード
