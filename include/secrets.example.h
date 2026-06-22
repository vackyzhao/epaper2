#ifndef SECRETS_EXAMPLE_H
#define SECRETS_EXAMPLE_H

// Copy this file to include/secrets.h and fill real values for device builds.
#define MQTT_CLIENT_ID "epaper2"
#define MQTT_USER "your_user"
#define MQTT_PASS "your_password"
#define MQTT_BROKER "mqtt.example.com"
#define MQTT_PORT 1883
#define MQTT_CLEAN_SESSION 1
#define MQTT_KEEPALIVE_SEC 60

#define MQTT_STATUS_TOPIC "epaper2/status"
#define MQTT_CMD_TOPIC "epaper2/cmd"
#define MQTT_TX_TOPIC "epaper2/tx"
#define MQTT_RX_TOPIC "epaper2/rx"

// Li-SOCl2 cells hold near 3.6V for most of their life; keep margin for Air780E.
#define LOW_BATTERY_MV 3300

#endif
