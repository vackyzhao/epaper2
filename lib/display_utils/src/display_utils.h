#ifndef DISPLAY_UTILS_H
#define DISPLAY_UTILS_H

#include <Arduino.h>
#include <RTClib.h>
#include <epd2in9_V2.h>
#include <epdpaint.h>
#include <imagedata.h>
#include <globals.h>

#define COLORED 0
#define UNCOLORED 1

#define COUNTDOWN_EXAM 0
#define COUNTDOWN_MEET 1

void initCountdownPanel(int status);


void renderClockPanel(const DateTime* now, bool* firstFlag, char* timeBuf_old);

void renderLowBatteryScreen();

#endif