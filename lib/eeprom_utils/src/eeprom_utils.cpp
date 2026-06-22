#include "eeprom_utils.h"
#include <EEPROM.h>

#define EEPROM_ADDR_MEET_DATE 0x20
#define EEPROM_ADDR_EXAM_DATE 0x24
#define EEPROM_MAGIC_DATE 0xA5

static uint16_t slotBase(EepromDateSlot slot)
{
  return slot == EEPROM_DATE_EXAM ? EEPROM_ADDR_EXAM_DATE : EEPROM_ADDR_MEET_DATE;
}

static uint8_t daysInMonth(uint8_t yy, uint8_t mm)
{
  switch (mm)
  {
  case 4:
  case 6:
  case 9:
  case 11:
    return 30;
  case 2:
    return (yy % 4) == 0 ? 29 : 28;
  default:
    return 31;
  }
}

static bool dateFieldsValid(uint8_t yy, uint8_t mm, uint8_t dd)
{
  if (yy > 99 || mm < 1 || mm > 12 || dd < 1)
    return false;
  return dd <= daysInMonth(yy, mm);
}

// --------------------- 目标日期 ---------------------
bool eepromLoadTargetDate(EepromDateSlot slot, DateTime &out)
{
  const uint16_t baseYear = 2000;
  const uint16_t base = slotBase(slot);

  if (base + 3 >= EEPROM.length())
    return false;

  if (EEPROM.read(base) != EEPROM_MAGIC_DATE)
    return false;

  const uint8_t yy = EEPROM.read(base + 1);
  const uint8_t mm = EEPROM.read(base + 2);
  const uint8_t dd = EEPROM.read(base + 3);

  if (!dateFieldsValid(yy, mm, dd))
    return false;

  out = DateTime((uint16_t)(baseYear + yy), mm, dd);
  return true;
}

bool eepromLoadTargetDate(DateTime &out)
{
  return eepromLoadTargetDate(EEPROM_DATE_MEET, out);
}

void eepromSaveTargetDate(EepromDateSlot slot, const DateTime &dt)
{
  const uint16_t baseYear = 2000;
  const uint16_t base = slotBase(slot);

  if (base + 3 >= EEPROM.length())
    return;

  uint16_t y = dt.year();
  uint8_t m = dt.month();
  uint8_t d = dt.day();

  if (y < baseYear)
    y = baseYear;
  if (y > 2099)
    y = 2099;
  uint8_t yy = (uint8_t)(y - baseYear);
  if (m < 1 || m > 12)
    m = 1;

  const uint8_t maxDay = daysInMonth(yy, m);
  if (d < 1)
    d = 1;
  if (d > maxDay)
    d = maxDay;

  EEPROM.update(base + 0, EEPROM_MAGIC_DATE);
  EEPROM.update(base + 1, yy);
  EEPROM.update(base + 2, m);
  EEPROM.update(base + 3, d);
}

void eepromSaveTargetDate(const DateTime &dt)
{
  eepromSaveTargetDate(EEPROM_DATE_MEET, dt);
}

// --------------------- EEPROM 清空 ---------------------
void eepromClearAll()
{
  for (uint16_t i = 0; i < EEPROM.length(); ++i)
  {
    EEPROM.update(i, 0xFF);  // 或写入 0x00
  }
}
