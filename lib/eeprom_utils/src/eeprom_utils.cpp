#include "eeprom_utils.h"
#include <EEPROM.h>

#define EEPROM_ADDR_MAGIC_TOTALMIN  0x30
#define EEPROM_ADDR_TOTALMIN        0x31
#define EEPROM_ADDR_DATE_MAGIC      0x20

#define EEPROM_MAGIC_TOTALMIN       0xA6
#define EEPROM_MAGIC_DATE           0xA5

// --------------------- 累计分钟数 ---------------------
bool eepromLoadTotalMinutes(uint32_t &totalMin) {
  if (EEPROM.read(EEPROM_ADDR_MAGIC_TOTALMIN) != EEPROM_MAGIC_TOTALMIN) {
    totalMin = 0;
    return false;
  }
  totalMin = 0;
  for (uint8_t i = 0; i < 4; ++i) {
    totalMin |= ((uint32_t)EEPROM.read(EEPROM_ADDR_TOTALMIN + i)) << (8 * i);
  }
  return true;
}

void eepromSaveTotalMinutes(uint32_t totalMin) {
  EEPROM.update(EEPROM_ADDR_MAGIC_TOTALMIN, EEPROM_MAGIC_TOTALMIN);
  for (uint8_t i = 0; i < 4; ++i) {
    EEPROM.update(EEPROM_ADDR_TOTALMIN + i, (totalMin >> (8 * i)) & 0xFF);
  }
}

// --------------------- 目标日期 ---------------------
bool eepromLoadTargetDate(DateTime &out) {
  const uint16_t baseYear = 2000;

  if (EEPROM_ADDR_DATE_MAGIC + 3 >= EEPROM.length())
    return false;

  if (EEPROM.read(EEPROM_ADDR_DATE_MAGIC) != EEPROM_MAGIC_DATE)
    return false;

  const uint8_t yy = EEPROM.read(EEPROM_ADDR_DATE_MAGIC + 1);
  const uint8_t mm = EEPROM.read(EEPROM_ADDR_DATE_MAGIC + 2);
  const uint8_t dd = EEPROM.read(EEPROM_ADDR_DATE_MAGIC + 3);

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31)
    return false;

  out = DateTime((uint16_t)(baseYear + yy), mm, dd);
  return true;
}

void eepromSaveTargetDate(const DateTime &dt) {
  const uint16_t baseYear = 2000;

  if (EEPROM_ADDR_DATE_MAGIC + 3 >= EEPROM.length())
    return;

  uint16_t y = dt.year();
  uint8_t m = dt.month();
  uint8_t d = dt.day();

  if (y < baseYear) y = baseYear;
  uint8_t yy = (uint8_t)((y - baseYear) > 255 ? 255 : (y - baseYear));
  if (m < 1 || m > 12) m = 1;
  if (d < 1 || d > 31) d = 1;

  EEPROM.update(EEPROM_ADDR_DATE_MAGIC + 0, EEPROM_MAGIC_DATE);
  EEPROM.update(EEPROM_ADDR_DATE_MAGIC + 1, yy);
  EEPROM.update(EEPROM_ADDR_DATE_MAGIC + 2, m);
  EEPROM.update(EEPROM_ADDR_DATE_MAGIC + 3, d);
}

// --------------------- EEPROM 清空 ---------------------
void eepromClearAll() {
  for (int i = 0; i < EEPROM.length(); ++i) {
    EEPROM.update(i, 0xFF);  // 或写入 0x00
  }
}
