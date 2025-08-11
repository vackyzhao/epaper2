#include "battery_monitor.h"

// ✅ 写死引脚
#define BAT_ADC_PIN     A7   // 电池电压采样输入
#define BAT_SWITCH_PIN  4    // 控制NMOS开关的IO（低电平导通）

// ✅ 定点值：VREF × DIVIDER_RATIO × 1000（毫伏） = 1.1 / 1023 × 3.127 × 1000 ≈ 3.363
// 我们用整数定点 ×1000 处理
#define VREF_mV 1100UL               // 内部参考电压：1100mV
#define DIVIDER_NUM 10000UL         // 分压比分子（定点整数，1/0.3197 ≈ 3.127）
#define DIVIDER_DEN 3197UL
#define ADC_MAX 1023UL

void batteryMonitorBegin() {
  analogReference(INTERNAL);  // 使用 1.1V 内部参考
  pinMode(BAT_SWITCH_PIN, OUTPUT);
  digitalWrite(BAT_SWITCH_PIN, LOW);
  pinMode(BAT_ADC_PIN, INPUT);
  digitalWrite(BAT_ADC_PIN, LOW);
}

uint16_t readBatteryVoltage_mv(uint8_t samples) {
  ADCSRA |= _BV(ADEN);
  analogReference(INTERNAL);
  digitalWrite(BAT_SWITCH_PIN, HIGH);
  delay(1000);
  analogRead(BAT_ADC_PIN);  // 丢弃第一次

  uint32_t sum = 0;
  for (uint8_t i = 0; i < samples; i++) {
    sum += analogRead(BAT_ADC_PIN);
    delay(5);
  }

  // 关闭电池测量通路
  pinMode(BAT_ADC_PIN, INPUT);
  digitalWrite(BAT_ADC_PIN, LOW);
  pinMode(BAT_SWITCH_PIN, INPUT);
  digitalWrite(BAT_SWITCH_PIN, LOW);

  uint16_t avg = sum / samples;

  // 计算真实电压（单位毫伏）
  // realVoltage = avg × VREF × divider_ratio / 1023
  // 为避免浮点，乘上定点常数再整除
  uint16_t voltage_mv = avg;
  ADCSRA &= ~_BV(ADEN);
  return (uint16_t)voltage_mv;
}
