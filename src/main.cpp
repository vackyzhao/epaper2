#include <epd2in9_V2.h>
#include <epdpaint.h>
#include <imagedata.h>

#include <Wire.h>
#include <limits.h>

#include <avr/sleep.h>
#include <avr/power.h>
#include <avr/interrupt.h>

#include <battery_monitor.h>
#include <eeprom_utils.h>
#include <display_utils.h>

#include <RTClib.h>
#include <globals.h>

#define PMOS_CTRL_PIN 5
#define SERIAL_BUFFER_SIZE 128

#define COUNTDOWN_EXAM 0
#define COUNTDOWN_MEET 1

char serialBuffer[SERIAL_BUFFER_SIZE];

RTC_DS3231 rtc;
Epd epd;
unsigned char image[512];
Paint paint(image, 0, 0);  // width should be the multiple of 8


bool firstFlag = true;  // 用于第一次显示时间时的特殊处理
volatile bool wakeUp = false;
volatile bool alarmTriggered = false;
volatile bool button1Pressed = false;  // D2
volatile bool button2Pressed = false;  // D3
volatile bool button3Pressed = false;  // A7

DateTime lastDisplayTime;  // 全局变量，记录上一次显示的时间（建议只比较年月日）
uint8_t lastDay = 255;
uint16_t todayMin = 0;
uint32_t totalMin = 0;
 char timeBuf_old[6];

// ——— 任务调度参数 ———
const uint8_t TASK_BASE_H = 2;    // 起点小时 2 (= 02:05)
const uint8_t TASK_INTERVAL = 6;  // 每 6 小时
const uint8_t TASK_MINUTE = 5;    // 固定在 xx:05

// 上一次真正执行任务的“日 + 时”
static uint8_t lastTaskDay = 0xFF;
static int8_t lastTaskHour = -1;




SystemState currentState = STATE_EXAM_COUNTDOWN;
SystemState lastState = STATE_EXAM_COUNTDOWN;

void setupNextAlarm();


void checkMessages(void) {
  uint16_t voltage = readBatteryVoltage_mv(5);
  digitalWrite(PMOS_CTRL_PIN, LOW);  // 打开电源
  delay(5000);
  Serial.println("AT+CEREG?"); 
  Serial.flush();
  delay(1000);
  Serial.println("AT+CIPGSMLOC=1,1");
  Serial.flush();
  delay(1000);

  Serial.println("AT+MCONFIG=\"wjy_air780e\",\"wjy\",\"1234asdf\",1,1,\"wjy_air780e/status\",\"offline\"");
  Serial.flush();
  delay(1000);

  Serial.println("AT+MIPSTART=\"cow.milkcat.cc\",1883");
  Serial.flush();
  delay(1000);


  Serial.println("AT+MCONNECT=0,60");
  Serial.flush();
  delay(1000);

  
  Serial.println("AT+MDISCONNECT");
  Serial.flush();
  delay(1000);


  Serial.println("AT+MIPCLOSE");
  Serial.flush();
  delay(1000);

  delay(3000);
  digitalWrite(PMOS_CTRL_PIN, HIGH);  // 打开电源
}

void switchState(EventType event) {
  // 状态迁移逻辑：输入事件 + 当前状态 => 下一个状态
  lastState = currentState;
  switch (currentState) {
    case STATE_EXAM_COUNTDOWN:
      if (event == EVENT_BUTTON1)
        currentState = STATE_MEET_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_RUNNING;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_MEET_COUNTDOWN:
      if (event == EVENT_BUTTON1)
        currentState = STATE_EXAM_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_RUNNING;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_FOCUS_RUNNING:
      eepromSaveTotalMinutes(totalMin);
      if (event == EVENT_BUTTON1)
        currentState = STATE_EXAM_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_PAUSED;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_FOCUS_PAUSED:
      eepromSaveTotalMinutes(totalMin);
      if (event == EVENT_BUTTON1)
        currentState = STATE_EXAM_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_RUNNING;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_MQTT_MESSAGE:
      if (event == EVENT_BUTTON1)
        currentState = STATE_EXAM_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_RUNNING;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_LOW_BATTERY:
      // 不允许退出低电状态，直到重启或唤醒
      return;
  }
  //debugSerial.println(currentState);
  // 界面更新（集中统一）
  switch (currentState) {
    case STATE_EXAM_COUNTDOWN:
      initCountdownPanel(0);
      epd.DisplayFrame(); 
      //displayTime(rtc.now());
      break;
    case STATE_MEET_COUNTDOWN:
      initCountdownPanel(1);
      epd.DisplayFrame(); 
      //displayTime(rtc.now());
      break;
    case STATE_FOCUS_PAUSED:
      eepromSaveTotalMinutes(totalMin);
      //drawFocus(0);
      break;
    case STATE_FOCUS_RUNNING:
      eepromLoadTotalMinutes(totalMin);
      //drawFocus(1);
      break;
    case STATE_MQTT_MESSAGE:
      //checkMessages();
      break;
    case STATE_LOW_BATTERY:
      renderLowBatteryScreen();
      break;
  }
}

ISR(INT0_vect) {
  button1Pressed = true;
}
ISR(INT1_vect) {
  button2Pressed = true;
}
// D8-D13 对应 PCINT0 向量（PORTB）
ISR(PCINT0_vect) {
  if (!(PINB & (1 << PINB5))) {
    // D13 为低电平（可能是 RTC 触发的中断）
    alarmTriggered = true;
  } else {
    // D13 为高电平
  }
}
ISR(PCINT1_vect) {
  if (!(PINC & (1 << PINC1))) {
    // A1 为低电平（比如按钮按下）
    button3Pressed = true;
  } else {
    // A1 为高电平
  }
}

void handleRtcAlarmEvent() {

  rtc.clearAlarm(1);  // 清除 DS3231 的闹钟中断标志
  DateTime now = rtc.now() + TimeSpan(0, 0, 1, 0);

  // 检查是否跨天
  if (now.day() != lastDay) {
    lastDay = now.day();                  // 更新记录
    currentState = STATE_EXAM_COUNTDOWN;  // 重置状态为考试倒计时
    todayMin = 0;                         // 重置今天的分钟数
    initCountdownPanel(0);
    epd.DisplayFrame(); 
    //displayTime(now);                     // 显示当前时间
    setupNextAlarm();  // 设置下一分钟的闹钟
    return;            // 直接返回，不再继续执行
  }


  if (now.minute() == TASK_MINUTE &&                                      // 分钟 = 5
      (uint8_t)((now.hour() + 24 - TASK_BASE_H) % TASK_INTERVAL) == 0 &&  // (时-2) % 6 == 0
      !(now.day() == lastTaskDay && now.hour() == lastTaskHour)           // 避免同一小时重复
  ) {
    lastTaskDay = now.day();
    lastTaskHour = now.hour();
    //checkMessages();
  }


  switch (currentState) {
    case STATE_EXAM_COUNTDOWN:
    initCountdownPanel(0);
    //displayTime(now);
    break;

    case STATE_MEET_COUNTDOWN:
    initCountdownPanel(1);
    //displayTime(now);
    break;
    
    case STATE_FOCUS_PAUSED:
      //displayFocus(now);
      break;
    case STATE_FOCUS_RUNNING:
      //displayFocus(now);
      break;
    case STATE_MQTT_MESSAGE:

      break;
    case STATE_LOW_BATTERY:

      break;
  }

  setupNextAlarm();  // 设置下一分钟的闹钟
}

void enterDeepSleep() {
  // 设置为掉电模式
  ADCSRA &= ~_BV(ADEN);
  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  sleep_enable();
  // 关闭 BOD（Brown-Out Detector），降低睡眠功耗
  cli();  // 进入原子操作区
  sleep_bod_disable();
  sei();  // 开启中断（必须在 sleep_cpu() 前）

  sleep_cpu();      // 💥 实际进入掉电睡眠
  sleep_disable();  // 🛌 醒来后清除睡眠允许标志
}

void setupNextAlarm() {
  DateTime now = rtc.now();

  // 默认设定秒 = 58
  uint8_t next_sec = 58;
  uint8_t next_min = now.minute();
  uint8_t next_hour = now.hour();
  uint8_t next_day = now.day();
  uint8_t next_month = now.month();
  uint16_t next_year = now.year();

  // 如果当前已经超过58秒，则设置为下一分钟
  if (now.second() >= 58) {
    next_min += 1;
    if (next_min >= 60) {
      next_min = 0;
      next_hour += 1;
      if (next_hour >= 24) {
        next_hour = 0;
        // 处理跨天
        DateTime tomorrow = now + TimeSpan(1, 0, 0, 0);
        next_day = tomorrow.day();
        next_month = tomorrow.month();
        next_year = tomorrow.year();
      }
    }
  }

  // 清除之前的闹钟设置
  rtc.clearAlarm(1);

  // 设置 Alarm1 触发时间
  DateTime alarmTime(next_year, next_month, next_day, next_hour, next_min, next_sec);
  rtc.setAlarm1(alarmTime, DS3231_A1_Second);
}

void setup() {
  Serial.begin(115200);
  pinMode(PMOS_CTRL_PIN, OUTPUT);
  digitalWrite(PMOS_CTRL_PIN, HIGH);  // 初始状态关电源（截止）

  // 配置 D2、D3 为上拉输入
  pinMode(2, INPUT_PULLUP);              // INT0
  pinMode(3, INPUT_PULLUP);              // INT1
  EIMSK |= (1 << INT0) | (1 << INT1);    // 启用外部中断 INT0 / INT1
  EICRA |= (1 << ISC01) | (1 << ISC11);  // 下降沿触发 INT0 / INT1
  pinMode(A1, INPUT_PULLUP);             // PCINT23
  PCICR |= (1 << PCIE1);                 // 启用 Port C（PCINT[14:8]）的中断功能
  PCMSK1 |= (1 << PCINT9);               // 允许 A1（PC1）电平变化触发中断

  Wire.begin();
  delay(10);
  epd.Init();
  epd.ClearFrameMemory(0xFF);  // 全白刷新屏幕
  epd.DisplayFrame();
  delay(100);

  batteryMonitorBegin();  // 初始化电量检测
  uint16_t batteryVoltage = readBatteryVoltage_mv();
  if (batteryVoltage < 820) //820*3.69=3038mV
  {
    currentState = STATE_LOW_BATTERY;
    renderLowBatteryScreen();
    enterDeepSleep();  // 进入深度睡眠
  }
  if (!rtc.begin()) {
    while (1)
      delay(10);
  }
  pinMode(13, INPUT_PULLUP);  // D13连接DS3231 INT，开漏，必须上拉
  // 禁用DS3231方波，启用中断模式
  rtc.writeSqwPinMode(DS3231_OFF);
  // 启用 PCINT0 中断，PCINT5 = D13
  PCICR |= (1 << PCIE0);    // 使能 Port B（PB0–PB7）的 PCINT 中断
  PCMSK0 |= (1 << PCINT5);  // 启用 D13 的 PCINT

  eepromSaveTargetDate(DateTime(2025, 8, 12));
  //initCountdownPanel(COUNTDOWN_EXAM);
  initCountdownPanel(COUNTDOWN_MEET);
  epd.DisplayFrame(); 
  //displayTime(rtc.now());  // 显示当前时间
  //setupNextAlarm();

  //lastDisplayTime = rtc.now();
  //eepromSaveTargetDate(DateTime(2025, 08, 30));
  //eepromLoadTotalMinutes(totalMin);

  
}

void loop() {

  wakeUp = false;
  alarmTriggered = false;
  enterDeepSleep();

  if (button1Pressed) {
    button1Pressed = false;
    switchState(EVENT_BUTTON1);
  }

  if (button2Pressed) {
    button2Pressed = false;
    switchState(EVENT_BUTTON2);
  }

  if (button3Pressed) {
    button3Pressed = false;
    switchState(EVENT_BUTTON3);
  }

  if (alarmTriggered) {
    alarmTriggered = false;
    handleRtcAlarmEvent();
  }
}
