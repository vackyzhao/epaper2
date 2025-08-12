#include "display_utils.h"
#include "epd2in9_V2.h"
#include "epdpaint.h"
#include "imagedata.h"
#include "eeprom_utils.h"

extern RTC_DS3231 rtc;
extern Epd epd;
extern Paint paint;

void initCountdownPanel(int status) {
  epd.Init();
  DateTime now = rtc.now();
  DateTime now00(now.year(), now.month(), now.day());
  DateTime target(2025, 12, 20);

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



void initFocusPanel(int* status, const SystemState* currentState, const SystemState* lastState,
               uint32_t* todayMin, uint32_t* totalMin) {
  if (*lastState != STATE_FOCUS_RUNNING && *lastState != STATE_FOCUS_PAUSED) {
    extern bool firstFlag;
    firstFlag = true;

    epd.Init();
    epd.SetFrameMemory_WhiteBase(0, 0, 128, 296);
    paint.SetWidth(14);
    paint.SetHeight(148);
    paint.SetRotate(ROTATE_90);

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "Focus Mode", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 110, 20, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "Today:", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 50, 60, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "Total:", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 10, 60, paint.GetWidth(), paint.GetHeight());

    epd.DisplayFrame();
  }
}




void renderFocusPanel(const DateTime* now, const SystemState* currentState, const SystemState* lastState,
                  uint32_t* todayMin, uint32_t* totalMin) {
  epd.Init();
  char timeBuf[6];
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", now->hour(), now->minute());

  paint.SetWidth(14);
  paint.SetHeight(148);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  epd.SetPartialRefresh();

  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 110, 180, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 50, 180, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 10, 180, paint.GetWidth(), paint.GetHeight());

  paint.SetWidth(32);
  paint.SetHeight(32);
  if (*currentState != *lastState) {
    paint.Clear(UNCOLORED);
    if (*currentState == STATE_FOCUS_PAUSED) {
      paint.DrawFilledRectangle(6, 4, 12, 28, COLORED);
      paint.DrawFilledRectangle(20, 4, 26, 28, COLORED);
    } else {
      paint.DrawStringAt(0, 0, " ", &Font00, COLORED);
    }
    epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 30, 10, paint.GetWidth(), paint.GetHeight());
  }

  epd.DisplayFrame_Partial();

  if (*currentState == STATE_FOCUS_RUNNING) {
    (*todayMin)++;
    (*totalMin)++;
  }

  char todayStr[16], totalStr[16];
  snprintf(todayStr, sizeof(todayStr), "%uh %02um", (*todayMin) / 60, (*todayMin) % 60);
  snprintf(totalStr, sizeof(totalStr), "%luh %02lum", (*totalMin) / 60, (*totalMin) % 60);

  paint.SetWidth(14);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 110, 180, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, todayStr, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 50, 160, paint.GetWidth(), paint.GetHeight());

  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, totalStr, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 10, 160, paint.GetWidth(), paint.GetHeight());

  epd.DisplayFrame_Partial();
  epd.Sleep();
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
    epd.SetFrameMemory_Base(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  }

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
