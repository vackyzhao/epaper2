#include <epd2in9_V2.h>
#include <epdpaint.h>
#include <imagedata.h>

#include <Wire.h>
#include <EEPROM.h>
#include <limits.h>

#include <avr/sleep.h>
#include <avr/power.h>
#include <avr/interrupt.h>
#include <battery_monitor.h>

#include <EEPROM.h>
#include <RTClib.h>




#define PMOS_CTRL_PIN 5
#define SERIAL_BUFFER_SIZE 128
#define COLORED 0
#define UNCOLORED 1

char serialBuffer[SERIAL_BUFFER_SIZE];
unsigned char image[512];
Paint paint(image, 0, 0);  // width should be the multiple of 8

RTC_DS3231 rtc;
Epd epd;
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

void displayTime(DateTime now) ;

enum SystemState {
  STATE_EXAM_COUNTDOWN,
  STATE_MEET_COUNTDOWN,
  STATE_FOCUS_PAUSED,
  STATE_FOCUS_RUNNING,
  STATE_MQTT_MESSAGE,
  STATE_LOW_BATTERY
};
enum EventType {
  EVENT_BUTTON1,
  EVENT_BUTTON2,
  EVENT_BUTTON3
};

SystemState currentState = STATE_EXAM_COUNTDOWN;
SystemState lastState = STATE_EXAM_COUNTDOWN;


void drawicon(int status);
void drawFocus(int status);
void drawLowBatteryUI();
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


void saveTotalMin(uint32_t totalMin) {
  const uint16_t addr_magic = 0x30;
  const uint8_t magic_val = 0xA6;
  const uint16_t addr_data = 0x31;

  EEPROM.update(addr_magic, magic_val);

  for (uint8_t i = 0; i < 4; ++i) {
    EEPROM.update(addr_data + i, (totalMin >> (8 * i)) & 0xFF);
  }
  //debugSerial.print("save: ");
  //debugSerial.println(totalMin);
}
bool loadTotalMin(uint32_t &totalMin) {
  const uint16_t addr_magic = 0x30;
  const uint8_t magic_val = 0xA6;
  const uint16_t addr_data = 0x31;

  if (EEPROM.read(addr_magic) != magic_val) {
    totalMin = 0;
    return false;
  }

  totalMin = 0;
  for (uint8_t i = 0; i < 4; ++i) {
    totalMin |= ((uint32_t)EEPROM.read(addr_data + i)) << (8 * i);
  }
  //debugSerial.print("load: ");
  //debugSerial.println(totalMin);
  return true;
}



// 读取：从固定地址取 MAGIC/YY/MM/DD，成功则写入 out（year = 2000 + YY）
bool eepromLoadTarget(DateTime &out) {
  const uint16_t addr = 0x0020;    // 存放地址（可改）
  const uint8_t magicWant = 0xA5;  // MAGIC（可改）
  const uint16_t baseYear = 2000;

  if (addr + 3 >= EEPROM.length())
    return false;  // 越界保护

  if (EEPROM.read(addr + 0) != magicWant)
    return false;
  const uint8_t yy = EEPROM.read(addr + 1);
  const uint8_t mm = EEPROM.read(addr + 2);
  const uint8_t dd = EEPROM.read(addr + 3);

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31)
    return false;

  out = DateTime((uint16_t)(baseYear + yy), mm, dd);
  return true;
}

// 写入：把 DateTime 压缩成 YY/MM/DD + MAGIC 存到固定地址
void eepromSaveTarget(const DateTime &dt) {
  const uint16_t addr = 0x0020;    // 存放地址（可改）
  const uint8_t magicWant = 0xA5;  // MAGIC（可改）
  const uint16_t baseYear = 2000;

  if (addr + 3 >= EEPROM.length())
    return;  // 越界保护

  uint16_t y = dt.year();
  uint8_t m = dt.month();
  uint8_t d = dt.day();

  // 合法性与夹取
  if (y < baseYear)
    y = baseYear;
  uint8_t yy = (uint8_t)((y - baseYear) > 255 ? 255 : (y - baseYear));
  if (m < 1 || m > 12)
    m = 1;
  if (d < 1 || d > 31)
    d = 1;

  EEPROM.update(addr + 0, magicWant);
  EEPROM.update(addr + 1, yy);
  EEPROM.update(addr + 2, m);
  EEPROM.update(addr + 3, d);
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
      saveTotalMin(totalMin);
      if (event == EVENT_BUTTON1)
        currentState = STATE_EXAM_COUNTDOWN;
      else if (event == EVENT_BUTTON2)
        currentState = STATE_FOCUS_PAUSED;
      else if (event == EVENT_BUTTON3)
        currentState = STATE_MQTT_MESSAGE;
      break;

    case STATE_FOCUS_PAUSED:
      saveTotalMin(totalMin);
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
      drawicon(0);
      epd.DisplayFrame(); 
      displayTime(rtc.now());
      break;
    case STATE_MEET_COUNTDOWN:
      drawicon(1);
      epd.DisplayFrame(); 
      displayTime(rtc.now());
      break;
    case STATE_FOCUS_PAUSED:
      saveTotalMin(totalMin);
      drawFocus(0);
      break;
    case STATE_FOCUS_RUNNING:
      loadTotalMin(totalMin);
      drawFocus(1);
      break;
    case STATE_MQTT_MESSAGE:
      checkMessages();
      break;
    case STATE_LOW_BATTERY:
      drawLowBatteryUI();
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

void displayFocus(DateTime now) {
  epd.Init();

  char timeBuf[6];  // "HH:MM"
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", now.hour(), now.minute());

  // 设置画布方向和大小（适合竖直文字）
  paint.SetWidth(14);          // 字体宽度为 32px
  paint.SetHeight(148);        // 高度为 96px，容纳整个文字
  paint.SetRotate(ROTATE_90);  // 顺时针旋转 90°，竖排

  // 第一步：清空旧内容
  epd.SetPartialRefresh();
  paint.Clear(UNCOLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 110, 180, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 50, 180, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 10, 180, paint.GetWidth(), paint.GetHeight());

  paint.SetWidth(32);          // 字体宽度为 32px
  paint.SetHeight(32);         // 高度为 96px，容纳整个文字
  paint.SetRotate(ROTATE_90);  // 顺时针旋转 90°，竖排

  if (currentState == STATE_FOCUS_RUNNING) {
    if (lastState != STATE_FOCUS_RUNNING) {
      paint.Clear(UNCOLORED);
      epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 30, 10, paint.GetWidth(), paint.GetHeight());
    }
  } else if (currentState == STATE_FOCUS_PAUSED) {
    if (lastState != STATE_FOCUS_PAUSED) {
      paint.Clear(UNCOLORED);
      epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 30, 10, paint.GetWidth(), paint.GetHeight());
    }
  }

  epd.DisplayFrame_Partial();
  delay(100);  // 延迟用于防止残影和刷新干扰

  char todayStr[16];  // e.g., "1h 23m"
  char totalStr[16];  // e.g., "54h 01m"

  paint.SetWidth(32);          // 字体宽度为 32px
  paint.SetHeight(32);         // 高度为 96px，容纳整个文字
  paint.SetRotate(ROTATE_90);  // 顺时针旋转 90°，竖排

  if (currentState == STATE_FOCUS_RUNNING) {
    todayMin += 1;  // 每分钟增加1
    totalMin += 1;

    paint.Clear(UNCOLORED);
    epd.SetPartialRefresh();
    paint.DrawStringAt(0, 0, " ", &Font00, COLORED);
    epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 30, 10, paint.GetWidth(), paint.GetHeight());

  } else if (currentState == STATE_FOCUS_PAUSED) {
    paint.Clear(UNCOLORED);
    epd.SetPartialRefresh();
    paint.DrawFilledRectangle(6, 4, 12, 28, COLORED);   // 左条
    paint.DrawFilledRectangle(20, 4, 26, 28, COLORED);  // 右条
    epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 30, 10, paint.GetWidth(), paint.GetHeight());
    // 暂停状态不增加计时
  }


  // 第二步：绘制新时间
  // 设置画布方向和大小（适合竖直文字）
  paint.SetWidth(14);          // 字体宽度为 32px
  paint.SetHeight(148);        // 高度为 96px，容纳整个文字
  paint.SetRotate(ROTATE_90);  // 顺时针旋转 90°，竖排
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 110, 180, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  snprintf(todayStr, sizeof(todayStr), "%uh %02um", todayMin / 60, todayMin % 60);
  paint.DrawStringAt(0, 0, todayStr, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 50, 160, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  snprintf(totalStr, sizeof(totalStr), "%luh %02lum", totalMin / 60, totalMin % 60);
  paint.DrawStringAt(0, 0, totalStr, &Font20, COLORED);
  epd.SetFrameMemory_Partial_NoRefresh(paint.GetImage(), 10, 160, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  epd.DisplayFrame_Partial();
  delay(100);
  epd.Sleep();
  delay(100);
}

void displayTime(DateTime now) {
  epd.Init();
  char timeBuf[6];  // "HH:MM"
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", now.hour(), now.minute());

  // 设置画布方向和大小（适合竖直文字）
  paint.SetWidth(32);          // 字体宽度为 32px
  paint.SetHeight(96);         // 高度为 96px，容纳整个文字
  paint.SetRotate(ROTATE_90);  // 顺时针旋转 90°，竖排

  if(firstFlag==true) {
    firstFlag=false;
  } else {
    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 4, timeBuf_old, &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());//设置上一次的base
  }


  // 第一步：清空旧内容
  paint.Clear(UNCOLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();
  delay(1000);  // 延迟用于防止残影和刷新干扰


  // 第二步：绘制新时间
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 4, timeBuf, &Font20, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 64, 168, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();
  delay(300);
  epd.Sleep();
  delay(100);
  strcpy(timeBuf_old, timeBuf);  // 复制内容

}

void handleRtcAlarmEvent() {

  rtc.clearAlarm(1);  // 清除 DS3231 的闹钟中断标志
  DateTime now = rtc.now() + TimeSpan(0, 0, 1, 0);

  // 检查是否跨天
  if (now.day() != lastDay) {
    lastDay = now.day();                  // 更新记录
    currentState = STATE_EXAM_COUNTDOWN;  // 重置状态为考试倒计时
    todayMin = 0;                         // 重置今天的分钟数
    drawicon(0);
    epd.DisplayFrame(); 
    displayTime(now);                     // 显示当前时间
    setupNextAlarm();  // 设置下一分钟的闹钟
    return;            // 直接返回，不再继续执行
  }


  if (now.minute() == TASK_MINUTE &&                                      // 分钟 = 5
      (uint8_t)((now.hour() + 24 - TASK_BASE_H) % TASK_INTERVAL) == 0 &&  // (时-2) % 6 == 0
      !(now.day() == lastTaskDay && now.hour() == lastTaskHour)           // 避免同一小时重复
  ) {
    lastTaskDay = now.day();
    lastTaskHour = now.hour();
    checkMessages();
  }


  switch (currentState) {
    case STATE_EXAM_COUNTDOWN:
    drawicon(0);
    displayTime(now);
    break;

    case STATE_MEET_COUNTDOWN:
    drawicon(1);
    displayTime(now);
    break;
    
    case STATE_FOCUS_PAUSED:
      displayFocus(now);
      break;
    case STATE_FOCUS_RUNNING:
      displayFocus(now);
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

void drawLowBatteryUI() {
  epd.SetFrameMemory_Base(IMAGE_DATA);
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
  epd.DisplayFrame();

  delay(5000);
  //debugSerial.println("sleep...");
  epd.Sleep();
  delay(100);
}
void drawFocus(int status) {
  
  if ((lastState != STATE_FOCUS_RUNNING) && (lastState != STATE_FOCUS_PAUSED)) {
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
    epd.DisplayFrame();  // 刷新
  }

  DateTime now = rtc.now();
  displayFocus(now);
}

void drawicon(int status) {
  firstFlag = true;
  epd.Init();
  // epd.ClearFrameMemory(0xFF);
  DateTime now = rtc.now();
  DateTime target(2025, 12, 20);                       // 目标时间
  DateTime now00(now.year(), now.month(), now.day());  // 时分秒默认 0
  TimeSpan remaining = target - now00;
  int days_left = remaining.days();  // 剩余天数
  if (days_left < 0)
    days_left = 0;  // 已经过了，设为0天
  int hundreds = days_left / 100;
  int tens = (days_left / 10) % 10;
  int units = days_left % 10;

  epd.SetFrameMemory_Base(IMAGE_DATA_ICON);  // 居中绘图标
  epd.SetFrameMemory_WhiteBase(0, 128, 128, 168);
  paint.SetWidth(14);
  paint.SetHeight(148);
  paint.SetRotate(ROTATE_90);
  /* For simplicity, the arguments are explicit numerical coordinates */
  char dateBuf[11];  // "2025-07-23"
  snprintf(dateBuf, sizeof(dateBuf), "%04d-%02d-%02d", now.year(), now.month(), now.day());
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 1, dateBuf, &Font20, COLORED);
  epd.SetFrameMemory_Base(paint.GetImage(), 110, 140, paint.GetWidth(), paint.GetHeight());

  paint.SetWidth(64);
  paint.SetHeight(33);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);

  if (status == 0) {
    paint.DrawCharFromZeroAt(0, 0, units, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 196, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, tens, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 163, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, hundreds, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 130, paint.GetWidth(), paint.GetHeight());

    paint.SetWidth(16);
    paint.SetHeight(80);
    paint.SetRotate(ROTATE_90);
    paint.Clear(UNCOLORED);

    // 判断显示 DAY 或 DAYS
    if (days_left == 1) {
      paint.DrawStringAt(0, 0, "DAY", &Font20, COLORED);
    } else {
      paint.DrawStringAt(0, 0, "DAYS", &Font20, COLORED);
    }
    epd.SetFrameMemory_Base(paint.GetImage(), 45, 230, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);

    paint.DrawStringAt(0, 0, "TO", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 30, 230, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "EXAM", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 10, 230, paint.GetWidth(), paint.GetHeight());
  } else {

    eepromLoadTarget(target);
    remaining = target - now00;
    days_left = remaining.days();  // 剩余天数
    if (days_left < 0)
      days_left = 0;  // 已经过了，设为0天
    hundreds = days_left / 100;
    tens = (days_left / 10) % 10;
    units = days_left % 10;

    paint.DrawCharFromZeroAt(0, 0, units, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 196, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, tens, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 163, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawCharFromZeroAt(0, 0, hundreds, &Font36, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 1, 130, paint.GetWidth(), paint.GetHeight());

    paint.SetWidth(16);
    paint.SetHeight(80);
    paint.SetRotate(ROTATE_90);
    paint.Clear(UNCOLORED);

    paint.DrawStringAt(0, 0, "DAYS", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 45, 230, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "MEET", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 30, 230, paint.GetWidth(), paint.GetHeight());

    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "ZCQ", &Font20, COLORED);
    epd.SetFrameMemory_Base(paint.GetImage(), 10, 230, paint.GetWidth(), paint.GetHeight());
  }
  /*
  if(lastState != STATE_EXAM_COUNTDOWN && lastState != STATE_MEET_COUNTDOWN) {
    epd.DisplayFrame();  // 刷新全部
  }
  
  delay(200);

  now = rtc.now();
  displayTime(now);*/
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
  // put your setup code here, to run once:
  Serial.begin(115200);
  //debugSerial.begin(115200);

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
  //debugSerial.println("Serial Begin");
  delay(10);
  epd.Init();
  epd.ClearFrameMemory(0xFF);  // bit set = white, bit reset = black
  epd.DisplayFrame();
  delay(100);

  batteryMonitorBegin();  // 初始化
  uint16_t batteryVoltage = readBatteryVoltage_mv();
  if (batteryVoltage < 820) {
    //debugSerial.println("Low Battery, Entering Low Battery Mode");
    currentState = STATE_LOW_BATTERY;
    drawLowBatteryUI();
    enterDeepSleep();  // 进入深度睡眠
  } else {
    //debugSerial.print("Battery Voltage: ");
    //debugSerial.print(batteryVoltage);
    //debugSerial.println(" mV");
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

  drawicon(0);
  epd.DisplayFrame(); 
  displayTime(rtc.now());  // 显示当前时间
  setupNextAlarm();

  lastDisplayTime = rtc.now();
  eepromSaveTarget(DateTime(2025, 07, 30));
  loadTotalMin(totalMin);
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
