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
  int pos[] = {196, 163, 130};
  int dig[] = {units, tens, hundreds};

  for (int i = 0; i < 3; i++) {
    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, dig[i], &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, pos[i], paint.GetWidth(), paint.GetHeight());
  }

  paint.SetWidth(16);
  paint.SetHeight(80);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, days_left == 1 ? "DAY" : "DAYS", &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 45, 230, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, status == COUNTDOWN_EXAM ? "TO" : "MEET", &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 30, 230, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, status == COUNTDOWN_EXAM ? "EXAM" : "ZCQ", &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 10, 230, paint.GetWidth(), paint.GetHeight());

}



void renderClockPanel(const DateTime* now, bool* firstFlag, char* timeBuf_old) {
  epd.Init();
  char timeBuf[6];
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", now->hour(), now->minute());

  paint.SetWidth(32);
  paint.SetHeight(96);
  paint.SetRotate(ROTATE_90);

  if (*firstFlag) {
    *firstFlag = false;
  } else {
    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 4, timeBuf_old, &Font20, COLORED);
    epd.SetFrameMemory_Old(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  }
  delay(100);
  paint.Clear(UNCOLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();

  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 4, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();

  epd.Sleep();
  strcpy(timeBuf_old, timeBuf);
}




void renderLowBatteryScreen() {
  epd.SetFrameMemory_Base(IMAGE_DATA);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
  epd.DisplayFrame();
  epd.Sleep();
}
