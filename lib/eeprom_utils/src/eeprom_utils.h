#ifndef EEPROM_UTILS_H
#define EEPROM_UTILS_H

#include <Arduino.h>
#include <RTClib.h>

enum EepromDateSlot : uint8_t {
  EEPROM_DATE_MEET = 0,
  EEPROM_DATE_EXAM = 1
};

// 读取目标日期，成功则写入 DateTime 结构
bool eepromLoadTargetDate(EepromDateSlot slot, DateTime &out);
bool eepromLoadTargetDate(DateTime &out);

// 保存目标日期（仅保存 YY/MM/DD）
void eepromSaveTargetDate(EepromDateSlot slot, const DateTime &dt);
void eepromSaveTargetDate(const DateTime &dt);

// 可选：清除全部 EEPROM 数据（调试用）
void eepromClearAll();

#endif // EEPROM_UTILS_H
