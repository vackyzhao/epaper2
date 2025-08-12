#ifndef EEPROM_UTILS_H
#define EEPROM_UTILS_H

#include <Arduino.h>
#include <RTClib.h>

// 读取总累计分钟数（成功返回 true，失败返回 false）
bool eepromLoadTotalMinutes(uint32_t &totalMin);

// 存储总累计分钟数
void eepromSaveTotalMinutes(uint32_t totalMin);

// 读取目标日期（如考试日期等），成功则写入 DateTime 结构
bool eepromLoadTargetDate(DateTime &out);

// 保存目标日期（仅保存 YY/MM/DD）
void eepromSaveTargetDate(const DateTime &dt);

// 可选：清除全部 EEPROM 数据（调试用）
void eepromClearAll();

#endif // EEPROM_UTILS_H
