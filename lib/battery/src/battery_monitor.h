#ifndef BATTERY_MONITOR_H
#define BATTERY_MONITOR_H

#include <Arduino.h>

void batteryMonitorBegin();              // 初始化（引脚内部定义）
uint16_t readBatteryVoltage_mv(uint8_t samples = 8);  // 返回电压值（单位V）

#endif
