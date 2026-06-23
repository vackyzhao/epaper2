#include "display_utils.h"
#include "epd2in9_V2.h"
#include "epdpaint.h"
#include "imagedata.h"
#include "eeprom_utils.h"

extern RTC_DS3231 rtc;
extern Epd epd;
extern Paint paint;
extern DateTime examDate;

static void write2(char *out, uint8_t value)
{
  out[0] = (char)('0' + value / 10);
  out[1] = (char)('0' + value % 10);
}

static void formatDate(char *out, const DateTime &dt)
{
  const uint16_t year = dt.year();
  out[0] = (char)('0' + (year / 1000) % 10);
  out[1] = (char)('0' + (year / 100) % 10);
  out[2] = (char)('0' + (year / 10) % 10);
  out[3] = (char)('0' + year % 10);
  out[4] = '-';
  write2(out + 5, dt.month());
  out[7] = '-';
  write2(out + 8, dt.day());
  out[10] = '\0';
}

static void formatTime(char *out, const DateTime &dt)
{
  write2(out, dt.hour());
  out[2] = ':';
  write2(out + 3, dt.minute());
  out[5] = '\0';
}

//渲染并且写入新旧显存，不显示
void initCountdownPanel(int status) {
  epd.Init();
  DateTime now = rtc.now();
  DateTime now00(now.year(), now.month(), now.day());
  DateTime target;
  target = examDate;
  

  if (status == COUNTDOWN_MEET)
  {
    eepromLoadTargetDate(EEPROM_DATE_MEET, target);
  }

  TimeSpan remaining = target - now00;
  int days_left = max(remaining.days(), 0);
  int hundreds = days_left / 100;
  int tens = (days_left / 10) % 10;
  int units = days_left % 10;

#if EPD_COUNTDOWN_BITMAP_ICON
  epd.SetFrameMemory_Base(IMAGE_DATA_ICON);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
#else
  epd.ClearFrameMemory(0xFF);
#endif

  char dateBuf[11];
  formatDate(dateBuf, now);

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
  formatTime(timeBuf, now);
  paint.SetWidth(32);
  paint.SetHeight(96);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 4, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
}

#if EPD_FAST_PARTIAL_REFRESH
void updateCountdownTimePartial()
{
  DateTime now = rtc.now();
  char timeBuf[6];
  formatTime(timeBuf, now);

  paint.SetWidth(32);
  paint.SetHeight(96);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 4, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();
}
#endif




void renderLowBatteryScreen() {
  epd.SetFrameMemory_Base(IMAGE_DATA);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
  epd.DisplayFrame();
  epd.Sleep();
}
