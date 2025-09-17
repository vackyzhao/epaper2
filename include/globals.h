#ifndef GLOBALS_H
#define GLOBALS_H

#pragma once
#include <RTClib.h>
#include "epd2in9_V2.h"
#include "epdpaint.h"

enum SystemState : uint8_t {
  STATE_EXAM_COUNTDOWN,
  STATE_MEET_COUNTDOWN,
  STATE_MQTT_SEND,
  STATE_MQTT_MESSAGE,
  STATE_LOW_BATTERY
};

enum EventType : uint8_t {
  EVENT_BUTTON1,
  EVENT_BUTTON2,
  EVENT_BUTTON3
};

extern RTC_DS3231 rtc;
extern Epd epd;
extern Paint paint;

#endif  // GLOBALS_H
