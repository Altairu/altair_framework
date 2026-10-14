cmake_minimum_required(VERSION 3.8)
project(altair_eth_can_bridge)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -std=c++17)
endif()

# 依存パッケージの探索
find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(can_msgs REQUIRED)
find_package(altair_interfaces REQUIRED)

# 実行可能ターゲット
add_executable(eth_can_bridge_node src/eth_can_bridge_node.cpp)
target_include_directories(eth_can_bridge_node PRIVATE
  ${rclcpp_INCLUDE_DIRS}
  ${can_msgs_INCLUDE_DIRS}
  ${altair_interfaces_INCLUDE_DIRS}
)
ament_target_dependencies(eth_can_bridge_node
  rclcpp
  can_msgs
  altair_interfaces
)

# インストール設定
install(TARGETS
  eth_can_bridge_node
  DESTINATION lib/${PROJECT_NAME}
)

ament_package()
