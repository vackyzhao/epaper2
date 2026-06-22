#ifndef APP_CONFIG_H
#define APP_CONFIG_H

#if defined(__has_include)
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#endif

#ifndef MQTT_CLIENT_ID
#define MQTT_CLIENT_ID "epaper2"
#endif

#ifndef MQTT_USER
#define MQTT_USER "CHANGE_ME"
#endif

#ifndef MQTT_PASS
#define MQTT_PASS "CHANGE_ME"
#endif

#ifndef MQTT_BROKER
#define MQTT_BROKER "example.com"
#endif

#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif

#ifndef MQTT_CLEAN_SESSION
#define MQTT_CLEAN_SESSION 1
#endif

#ifndef MQTT_KEEPALIVE_SEC
#define MQTT_KEEPALIVE_SEC 60
#endif

#ifndef MQTT_STATUS_TOPIC
#define MQTT_STATUS_TOPIC "epaper2/status"
#endif

#ifndef MQTT_CMD_TOPIC
#define MQTT_CMD_TOPIC "epaper2/cmd"
#endif

#ifndef MQTT_TX_TOPIC
#define MQTT_TX_TOPIC "epaper2/tx"
#endif

#ifndef MQTT_RX_TOPIC
#define MQTT_RX_TOPIC "epaper2/rx"
#endif

#ifndef LOW_BATTERY_MV
#define LOW_BATTERY_MV 3300
#endif

// 0 = power-first: put the EPD into deep sleep after a visible refresh. This
// clears controller RAM, so the next wake must rebuild a full baseline frame.
// 1 = speed-first: keep controller RAM valid between countdown wakeups so
// minute updates can use differential partial refresh.
#ifndef EPD_FAST_PARTIAL_REFRESH
#define EPD_FAST_PARTIAL_REFRESH 0
#endif

// Partial refresh should not run forever. Force a full refresh periodically to
// resync OLD/NEW RAM and reduce ghosting.
#ifndef EPD_PARTIALS_BEFORE_FULL
#define EPD_PARTIALS_BEFORE_FULL 20
#endif

// Current PCB: D4 drives a low-side N-MOS sampling switch; HIGH enables ADC divider.
#ifndef BAT_SWITCH_ACTIVE_LEVEL
#define BAT_SWITCH_ACTIVE_LEVEL 1
#endif

// Current PCB battery divider: VCC -> 1M -> A7 -> 330k -> sampling N-MOS -> GND.
#ifndef BAT_DIVIDER_TOP_OHMS
#define BAT_DIVIDER_TOP_OHMS 1000000UL
#endif

#ifndef BAT_DIVIDER_BOTTOM_OHMS
#define BAT_DIVIDER_BOTTOM_OHMS 330000UL
#endif

#endif
