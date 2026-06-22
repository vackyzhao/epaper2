#include "battery_monitor.h"
#include "app_config.h"

#define BAT_ADC_PIN A7
#define BAT_SWITCH_PIN 4

// The PCB drives a low-side N-MOS that connects the lower divider leg to GND.
// Keep this overrideable for board spins with a different sampling switch.
#ifndef BAT_SWITCH_ACTIVE_LEVEL
#define BAT_SWITCH_ACTIVE_LEVEL HIGH
#endif

#ifndef BAT_SETTLE_MS
#define BAT_SETTLE_MS 50
#endif

#ifndef BAT_SAMPLE_INTERVAL_MS
#define BAT_SAMPLE_INTERVAL_MS 5
#endif

#ifndef BAT_DIVIDER_TOP_OHMS
#define BAT_DIVIDER_TOP_OHMS 1000000UL
#endif

#ifndef BAT_DIVIDER_BOTTOM_OHMS
#define BAT_DIVIDER_BOTTOM_OHMS 330000UL
#endif

#define VREF_MV 1100UL
#define DIVIDER_NUM (BAT_DIVIDER_TOP_OHMS + BAT_DIVIDER_BOTTOM_OHMS)
#define DIVIDER_DEN BAT_DIVIDER_BOTTOM_OHMS
#define ADC_MAX 1023UL

static bool batteryMonitorReady = false;

static void setBatterySwitch(bool enabled)
{
  const uint8_t level = enabled ? BAT_SWITCH_ACTIVE_LEVEL : !BAT_SWITCH_ACTIVE_LEVEL;
  digitalWrite(BAT_SWITCH_PIN, level);
  pinMode(BAT_SWITCH_PIN, OUTPUT);
}

void batteryMonitorBegin() {
  analogReference(INTERNAL);  // 使用 1.1V 内部参考
  setBatterySwitch(false);
  pinMode(BAT_ADC_PIN, INPUT);
  digitalWrite(BAT_ADC_PIN, LOW);
  batteryMonitorReady = true;
}

uint16_t readBatteryVoltage_mv(uint8_t samples) {
  if (!batteryMonitorReady) {
    batteryMonitorBegin();
  }
  if (samples == 0) {
    samples = 1;
  }

  ADCSRA |= _BV(ADEN);
  analogReference(INTERNAL);
  setBatterySwitch(true);
  delay(BAT_SETTLE_MS);
  analogRead(BAT_ADC_PIN);  // 丢弃第一次

  uint32_t sum = 0;
  for (uint8_t i = 0; i < samples; i++) {
    sum += analogRead(BAT_ADC_PIN);
    delay(BAT_SAMPLE_INTERVAL_MS);
  }

  setBatterySwitch(false);

  uint16_t avg = sum / samples;
  const uint32_t full_scale_mv = (VREF_MV * DIVIDER_NUM + DIVIDER_DEN / 2) / DIVIDER_DEN;
  uint32_t voltage_mv = ((uint32_t)avg * full_scale_mv + ADC_MAX / 2) / ADC_MAX;
  ADCSRA &= ~_BV(ADEN);
  return (uint16_t)voltage_mv;
}
