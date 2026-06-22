#include "display_utils.h"
#include "epd2in9_V2.h"
#include "epdpaint.h"
#include "imagedata.h"
#include "eeprom_utils.h"

extern RTC_DS3231 rtc;
extern Epd epd;
extern Paint paint;
extern DateTime examDate;

//渲染并且写入新旧显存，不显示
void initCountdownPanel(int status) {
  epd.Init();
  DateTime now = rtc.now();
  DateTime now00(now.year(), now.month(), now.day());
  DateTime target;
  target = examDate;
  

  if (status == COUNTDOWN_MEET)
  {
    eepromLoadTargetDate(target);    
  }

  TimeSpan remaining = target - now00;
  int days_left = max(remaining.days(), 0);
  int hundreds = days_left / 100;
  int tens = (days_left / 10) % 10;
  int units = days_left % 10;

  epd.SetFrameMemory_Base(IMAGE_DATA_ICON);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);

  char dateBuf[11];
  snprintf(dateBuf, sizeof(dateBuf), "%04d-%02d-%02d", now.year(), now.month(), now.day());

  paint.SetWidth(14);
  paint.SetHeight(148);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 1, dateBuf, &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 110, 140, paint.GetWidth(), paint.GetHeight());

  paint.SetWidth(64);
  paint.SetHeight(33);
  paint.SetRotate(ROTATE_90);
  const uint8_t pos[] = {196, 163, 130};
  const uint8_t dig[] = {(uint8_t)units, (uint8_t)tens, (uint8_t)hundreds};

  for (int i = 0; i < 3; i++) {
    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, dig[i], &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, pos[i], paint.GetWidth(), paint.GetHeight());
  }

  paint.SetWidth(16);
  paint.SetHeight(80);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt_P(0, 0, days_left == 1 ? PSTR("DAY") : PSTR("DAYS"), &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 45, 230, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt_P(0, 0, status == COUNTDOWN_EXAM ? PSTR("TO") : PSTR("MEET"), &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 30, 230, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt_P(0, 0, status == COUNTDOWN_EXAM ? PSTR("EXAM") : PSTR("ZCQ"), &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 10, 230, paint.GetWidth(), paint.GetHeight());

  char timeBuf[6];
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", now.hour(), now.minute());
  paint.SetWidth(32);
  paint.SetHeight(96);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 4, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
}




void renderLowBatteryScreen() {
  epd.SetFrameMemory_Base(IMAGE_DATA);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
  epd.DisplayFrame();
  epd.Sleep();
}
