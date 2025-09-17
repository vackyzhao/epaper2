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
#include <avr/wdt.h>
#include <avr/eeprom.h>
#include <avr/io.h> // 提供 E2END 宏

// 选择“尾部 256B”的起始地址
#define EE_TAIL_BASE ((uint16_t)(E2END - 255)) // 1023-255=768

// 存储布局： [len(1B)] [data(32B)] [hash(4B)] 共 37B，用掉尾区很小一部分
#define MAX_STORE 32

#define EE_LEN_ADDR (EE_TAIL_BASE + 0)
#define EE_DATA_ADDR (EE_TAIL_BASE + 1)             // 32B
#define EE_HASH_ADDR (EE_TAIL_BASE + 1 + MAX_STORE) // 4B

#define PMOS_CTRL_PIN 5
#define SERIAL_BUFFER_SIZE 128

#define COUNTDOWN_EXAM 0
#define COUNTDOWN_MEET 1
char serialBuffer[SERIAL_BUFFER_SIZE];

RTC_DS3231 rtc;
Epd epd;
unsigned char image[512];
Paint paint(image, 0, 0); // width should be the multiple of 8
char buf[256];
DateTime examDate(2025, 12, 20);

bool firstFlag = true; // 用于第一次显示时间时的特殊处理
volatile bool wakeUp = false;
volatile bool alarmTriggered = false;
volatile bool button1Pressed = false; // D2
volatile bool button2Pressed = false; // D3
volatile bool button3Pressed = false; // A7

DateTime lastDisplayTime; // 全局变量，记录上一次显示的时间（建议只比较年月日）
uint8_t lastDay = 255;
uint16_t todayMin = 0;
uint32_t totalMin = 0;
char timeBuf_old[6];

// ——— 任务调度参数 ———
const uint8_t TASK_BASE_H = 2;   // 起点小时 2 (= 02:05)
const uint8_t TASK_INTERVAL = 6; // 每 6 小时
const uint8_t TASK_MINUTE = 5;   // 固定在 xx:05

// 上一次真正执行任务的“日 + 时”
static uint8_t lastTaskDay = 0xFF;
static int8_t lastTaskHour = -1;

SystemState currentState = STATE_EXAM_COUNTDOWN;
SystemState lastState = STATE_EXAM_COUNTDOWN;
void switchState(EventType event);
void setupNextAlarm();

extern "C"
{
  extern char *__brkval;    // malloc 使用过时，指向堆顶；否则为 0
  extern char __heap_start; // 堆起始（BSS/数据段之后）
}

// 建议不要 inline，避免 LTO 下奇怪折叠
static int16_t free_ram_now(void)
{
  volatile char top; // 放在栈上，取其地址就是当前栈顶
  char *heap_end = __brkval ? __brkval : &__heap_start;
  return (int16_t)(&top - heap_end); // 328 系列 2KB，int16 足够
}

void reset()
{
  // 启动看门狗定时器，设定一个短的超时时间（15ms）
  wdt_enable(WDTO_15MS);
  while (1)
    ; // 等待看门狗超时并复位设备
}
// FNV-1a 32-bit：快 & 小 & 无表
static inline uint32_t fnv1a32(const uint8_t *p, size_t n)
{
  uint32_t h = 2166136261UL; // offset basis
  while (n--)
  {
    h ^= *p++;
    h *= 16777619UL; // FNV prime
  }
  return h;
}

// 用法：对 buf 的“有效长度 n”做摘要
// 例如 n = min((size_t)decl_len, strlen(buf), 32)

int checkMessages_debug(int mode)
{
  uint8_t idx2 = 0;
  uint32_t t2;
  bool tcp_ok = false;
  bool registered = false;
  bool attached = false;
  bool mqtt_ok = false;
  uint16_t voltage = readBatteryVoltage_mv(5);
  delay(10);
  digitalWrite(PMOS_CTRL_PIN, LOW); // 打开电源

  t2 = millis();
  idx2 = 0;
  memset(buf, 0, sizeof(buf));

  while (millis() - t2 < 10000)
  {
    if (Serial.available())
    {
      char c = (char)Serial.read();
      if (idx2 < sizeof(buf) - 1)
      {
        buf[idx2++] = c;
        buf[idx2] = '\0';
      }

      if (c == '\n') // 一行接收完毕
      {
        // 去掉行尾 \r\n
        while (idx2 > 0 && (buf[idx2 - 1] == '\r' || buf[idx2 - 1] == '\n'))
        {
          buf[--idx2] = '\0';
        }

        if (strstr_P(buf, PSTR("+CGEV: ME PDN ACT 1")))
        {
          // PDP 激活成功
          break;
        }

        // 处理完这一行 → 清空准备接收下一行
        idx2 = 0;
        buf[0] = '\0';
      }
    }
  }
  delay(500);
  while (Serial.available() > 0)
  {
    (void)Serial.read(); // 读走并丢弃
    delay(5);
  }

  for (uint8_t i = 0; i < 10; i++)
  {
    Serial.println(F("AT+CEREG?"));
    Serial.flush();

    t2 = millis();
    idx2 = 0;
    memset(buf, 0, sizeof(buf));

    while (millis() - t2 < 10000)
    {
      if (Serial.available())
      {
        char c = (char)Serial.read();
        if (idx2 < sizeof(buf) - 1)
        {
          buf[idx2++] = c;
          buf[idx2] = '\0';
        }

        if (strstr_P(buf, PSTR("+CEREG: 0,1")))
        {
          registered = true;
          break; // 注册成功
        }
        if (strstr_P(buf, PSTR("+CEREG: 0,2")))
        {
          break;
        }
        if (c == '\n') // 到行尾，清空缓冲
        {
          idx2 = 0;
          buf[0] = '\0';
        }
      }
    }

    if (registered)
      break;     // 成功就直接跳出整个 for
    delay(3000); // 否则等3000毫秒再试
  }

  if (!registered)
  {
    // 10 次都失败，直接返回
    digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
    return -1;
  }

  delay(500);

  for (uint8_t i = 0; i < 5; i++)
  {
    // 清空串口缓冲和 buf
    while (Serial.available())
    {
      (void)Serial.read();
    }
    idx2 = 0;
    memset(buf, 0, sizeof(buf));

    Serial.println(F("AT+CGATT?"));
    Serial.flush();

    delay(100);
    t2 = millis();
    while (millis() - t2 < 10000)
    {
      if (Serial.available())
      {
        char c = (char)Serial.read();
        if (idx2 < sizeof(buf) - 1)
        {
          buf[idx2++] = c;
          buf[idx2] = '\0';
        }

        if (strstr_P(buf, PSTR("+CGATT: 1")))
        {
          attached = true;
          break; // 注册成功
        }

        if (c == '\n') // 到行尾，清空缓冲
        {
          idx2 = 0;
          buf[0] = '\0';
        }
      }
    }

    if (attached)
      break;     // 成功就直接跳出整个 for
    delay(1000); // 否则等一秒再试
  }

  if (!attached)
  {
    // 5 次都失败，直接返回
    digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
    return -1;
  }

  delay(500);

  /*
    for (uint8_t i = 0; i < 5; i++)
    {
      // 清空串口和接收缓冲
      while (Serial.available())
      {
        (void)Serial.read();
      }
      idx2 = 0;
      memset(buf, 0, sizeof(buf));

      Serial.println(F("AT+CIPGSMLOC=1,1")); // 基站定位（超时官方建议 30s，这里先给 10s，看你现场情况）
      Serial.flush();
      delay(100);

      t2 = millis();
      while (millis() - t2 < 10000)
      {
        if (Serial.available())
        {
          char c = (char)Serial.read();

          if (c == '\n')
          {
            buf[idx2] = '\0'; // 成行

            if (strncmp(buf, "+CIPGSMLOC: 0,", 14) == 0)
            {
              char *p = buf + 14;          // 从第14个字符开始
              char *end = strchr(p, '\n'); // 查找换行符
              if (end)
              {
                size_t len = end - p;       // 计算长度（不包含换行符）
                if (len >= sizeof(payload)) // 防止溢出
                  len = sizeof(payload) - 1;
                memcpy(payload, p, len);
                payload[len] = '\0'; // 补上字符串结尾
              }
              else
              {
                // 没有找到换行符，直接拷贝剩余部分
                strncpy(payload, p, sizeof(payload) - 1);
                payload[sizeof(payload) - 1] = '\0';
              }
            }

            // 准备收下一行
            idx2 = 0;
            memset(buf, 0, sizeof(buf));
          }
          else if (c != '\r')
          {
            if (idx2 < sizeof(buf) - 1)
            {
              buf[idx2++] = c;
            }
            else
            { // 溢出保护：丢弃当前行
              idx2 = 0;
              buf[0] = '\0';
            }
          }
        }
      }

      if (got_loc)
        break;
      delay(1000); // 重试间隔
    }

    delay(2000);

    while (Serial.available() > 0)
    {
      (void)Serial.read(); // 读走并丢弃
      delay(5);
    }
  */

  Serial.println(F("AT+MCONFIG=\"wjy_air780e\",\"wjy\",\"1234asdf\",1,1,\"wjy_air780e/status\",\"connection lost\""));
  Serial.flush();
  delay(500);

  for (uint8_t i = 0; i < 10; i++)
  {
    // 清空串口缓冲和 buf
    while (Serial.available())
    {
      (void)Serial.read();
    }
    idx2 = 0;
    memset(buf, 0, sizeof(buf));

    Serial.println(F("AT+MIPSTART=\"cow.milkcat.cc\",1883"));
    Serial.flush();
    delay(100);
    t2 = millis();
    while (millis() - t2 < 10000)
    {
      if (Serial.available())
      {
        char c = (char)Serial.read();
        if (idx2 < sizeof(buf) - 1)
        {
          buf[idx2++] = c;
          buf[idx2] = '\0';
        }

        if (strstr_P(buf, PSTR("CONNECT OK")) || strstr_P(buf, PSTR("ALREADY CONNECT")))
        {
          tcp_ok = true;
          break; // TCP 连接成功，跳出 while 和 for
        }

        if (strstr_P(buf, PSTR("CONNECT FAIL")) || strstr_P(buf, PSTR("ERROR")))
        {
          break; // 本次失败，跳出 while 重新尝试
        }

        if (c == '\n') // 行结束，重置缓冲
        {
          idx2 = 0;
          buf[0] = '\0';
        }
      }
    }
    if (tcp_ok)
      break;     // 成功就直接跳出整个 for
    delay(1500); // 每次重试之间等一秒
  }
  if (!tcp_ok)
  {
    // 5 次都失败，直接返回
    digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
    return -1;
  }
  delay(500);

  for (uint8_t i = 0; i < 5; i++)
  {
    // 清空串口缓冲和 buf
    while (Serial.available())
    {
      (void)Serial.read();
    }
    idx2 = 0;
    memset(buf, 0, sizeof(buf));

    Serial.println(F("AT+MCONNECT=0,60"));
    Serial.flush();
    delay(100);
    t2 = millis();
    while (millis() - t2 < 10000)
    {
      if (Serial.available())
      {
        char c = (char)Serial.read();
        if (idx2 < sizeof(buf) - 1)
        {
          buf[idx2++] = c;
          buf[idx2] = '\0';
        }

        if (strstr_P(buf, PSTR("CONNACK OK")))
        {
          mqtt_ok = true;
          break; // MQTT 连接成功，跳出 while 和 for
        }

        if (strstr_P(buf, PSTR("ERROR")))
        {
          break; // 本次失败，跳出 while 重新尝试
        }

        if (c == '\n') // 行结束，重置缓冲
        {
          idx2 = 0;
          buf[0] = '\0';
        }
      }
    }
    if (mqtt_ok)
      break;     // 成功就直接跳出整个 for
    delay(1000); // 每次重试之间等一秒
  }

  if (!mqtt_ok)
  {
    // 5 次都失败，直接返回
    digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
    return -1;
  }

  delay(500);
  Serial.println(F("AT+MQTTMSGSET=0"));
  Serial.flush();
  delay(500);
  // 计算电压（整数毫伏）
  uint32_t v = (uint32_t)voltage * 336 / 100; // voltage * 3.36

  // 拼接到 payload 后面
  memset(buf, 0, sizeof(buf));
  snprintf(buf, sizeof(buf), "%u,%u", (unsigned int)v, (unsigned int)free_ram_now());
  Serial.print(F("AT+MPUB=\"wjy_air780e/status\",1,1,\""));
  Serial.print(buf);
  Serial.print(F("\"\r\n"));
  Serial.flush();

  delay(2000);

  // 发送 AT 命令
  if (mode != 4)
  {
    Serial.println(F("AT+MSUB=\"wjy_air780e/cmd\",1"));
    Serial.flush();

    memset(buf, 0, sizeof(buf));
    idx2 = 0;
    t2 = millis();

    while (millis() - t2 < 15000)
    { // 建议延长一点超时
      if (!Serial.available())
        continue;

      char c = (char)Serial.read();

      // 追加到一行缓冲
      if (idx2 < sizeof(buf) - 1)
      {
        buf[idx2++] = c;
        buf[idx2] = '\0';
      }

      if (c == '\n')
      {
        // 去掉行尾 \r\n
        while (idx2 > 0 && (buf[idx2 - 1] == '\r' || buf[idx2 - 1] == '\n'))
        {
          buf[--idx2] = '\0';
        }

        // 只在“读到完整一行”后再判断
        // 只在“读到完整一行”后再判断
        if (strncmp_P(buf, PSTR("+MSUB:"), 6) == 0)
        {
          const char *p = strstr_P(buf, PSTR("byte,"));
          if (p)
          {
            // --- 取出 payload 串（到行尾为止） ---
            p += 5; // 跳过 "byte,"
            while (*p == ' ')
              ++p; // 去掉空格

            char tmp[16]; // "ddmmyy,ddmmyy" 最多 13 字节
            size_t n = 0;
            while (p[n] && p[n] != '\r' && p[n] != '\n' && n < sizeof(tmp) - 1)
            {
              tmp[n] = p[n];
              ++n;
            }
            tmp[n] = '\0';

            // --- 切成两个字段 ---
            char *comma = strchr(tmp, ',');
            if (comma)
            {
              *comma = '\0';
              char *s1 = tmp;       // 第一个 ddmmyy
              char *s2 = comma + 1; // 第二个 ddmmyy

              // 校验长度与字符
              auto ok6 = [](const char *s) -> bool
              {
                if (!s)
                  return false;
                if (strlen(s) != 6)
                  return false;
                for (uint8_t i = 0; i < 6; ++i)
                {
                  if (s[i] < '0' || s[i] > '9')
                    return false;
                }
                return true;
              };

              if (ok6(s1) && ok6(s2))
              {
                // 解析 "ddmmyy"
                auto parse_ddmmyy = [](const char *s, uint16_t &Y, uint8_t &M, uint8_t &D)
                {
                  D = (s[4] - '0') * 10 + (s[5] - '0');
                  M = (s[2] - '0') * 10 + (s[3] - '0');
                  uint8_t yy = (s[0] - '0') * 10 + (s[1] - '0');
                  Y = 2000 + yy;
                };

                uint16_t Y1, Y2;
                uint8_t M1, D1, M2, D2;
                parse_ddmmyy(s1, Y1, M1, D1);
                parse_ddmmyy(s2, Y2, M2, D2);

                // 简单合法性检查
                auto valid = [](uint16_t Y, uint8_t M, uint8_t D) -> bool
                {
                  if (Y < 2000 || Y > 2255)
                    return false;
                  if (M < 1 || M > 12)
                    return false;
                  if (D < 1 || D > 31)
                    return false; // 简化月天数校验
                  return true;
                };

                if (valid(Y1, M1, D1) && valid(Y2, M2, D2))
                {
                  DateTime dt1(Y1, M1, D1, 0, 0, 0);
                  DateTime dt2(Y2, M2, D2, 0, 0, 0);

                  // 保存到 EEPROM（采用你前面改过的带 ID 版本）
                  if (examDate.year() != Y1 || examDate.month() != M1 || examDate.day() != D1)
                  {
                    examDate = dt1;
                  }
                  DateTime dt3;
                  eepromLoadTargetDate(dt3);
                  if (dt3.year() != Y2 || dt3.month() != M2 || dt3.day() != D2)
                  {
                    eepromSaveTargetDate(dt2);
                  }

                  /*
                   Serial.print(F("Date1 saved (ID=1): "));
                   Serial.print(dt1.year());
                   Serial.print('-');
                   Serial.print(dt1.month());
                   Serial.print('-');
                   Serial.println(dt1.day());

                   Serial.print(F("Date2 saved (ID=2): "));
                   Serial.print(dt2.year());
                   Serial.print('-');
                   Serial.print(dt2.month());
                   Serial.print('-');
                   Serial.println(dt2.day());
                   */
                }
                else
                {
                }
              }
              else
              {
              }
            }
            else
            {
            }
          }
          else
          {
          }
          Serial.flush();
          break; // 处理完这行就退出
        }

        // 不是 +MSUB: 的行，清空缓冲，继续等下一行
        idx2 = 0;
        buf[0] = '\0';

        // 不是 +MSUB: 的行，清空缓冲，继续等下一行
        idx2 = 0;
        buf[0] = '\0';
      }
    }
  }
  if (mode == 1 || mode == 2 || mode == 3)
  {
    Serial.print(F("AT+MPUB=\"wjy_air780e/tx\",1,0,\""));
    if (mode == 1)
    {
      Serial.print(F("Happy"));
    }
    else if (mode == 2)
    {
      Serial.print(F("Miss u"));
    }
    else if (mode == 3)
    {
      Serial.print(F("Tired"));
    }

    Serial.print(F("\"\r\n"));
    Serial.flush();
  }
  else if (mode == 4)
  {
    bool rx_ok = false;
    bool overflow = false; // 本行是否已溢出
    bool is_msub = false;  // 本行是否 +MSUB:（即便溢出也要记住）
    Serial.println(F("AT+MSUB=\"wjy_air780e/rx\",1"));
    Serial.flush();

    memset(buf, 0, sizeof(buf));
    idx2 = 0;
    t2 = millis();

    while (millis() - t2 < 15000)
    {
      if (!Serial.available())
        continue;

      char c = (char)Serial.read();

      // 先把前缀判断出来（溢出后也要维持 is_msub=true）
      if (!overflow)
      {
        if (idx2 < sizeof(buf) - 1)
        {
          buf[idx2++] = c;
          buf[idx2] = '\0';

          // 当缓冲里已有足够长度时再判断
          if (idx2 >= 6 && !is_msub)
          {
            is_msub = (strncmp_P(buf, PSTR("+MSUB:"), 6) == 0);
          }
        }
        else
        {
          overflow = true; // 标记溢出
        }
      }
      else
      {
        // 溢出状态：不再写 buf，只是“吞掉”到行尾
      }

      if (c == '\n')
      {
        // 完整读到一行（或其截断版）
        if (!overflow)
        {
          // 去掉行尾 \r\n
          while (idx2 > 0 && (buf[idx2 - 1] == '\r' || buf[idx2 - 1] == '\n'))
          {
            buf[--idx2] = '\0';
          }
        }

        if (is_msub)
        {
          // 这是我们要的第一条 +MSUB 行
          if (overflow)
          {
            // 此行过长，buf 已是安全截断版（以 '\0' 结尾），串口剩余已被吞掉到 \n
            // 这里可以提示被截断，或直接按截断后的内容处理
            // Serial.println(F("MSUB line truncated"));
          }
          rx_ok = true;
          break;
        }

        // 不是 +MSUB: 的行，或者我们不关心的行 → 准备读下一行
        idx2 = 0;
        overflow = false;
        is_msub = false;
        buf[0] = '\0';
      }
    }

    if (rx_ok)
    {
      // 收到 +MSUB: 行

      // 假定此时 buf 里是一整行，且已去掉行尾 \r\n
      // 例：+MSUB: "wjy_air780e/rx",14 byte,hello world!

      char *p1 = strchr(buf, ','); // 第一个逗号（topic 后）
      if (p1)
      {
        char *p2 = strchr(p1 + 1, ','); // 第二个逗号（"14 byte" 后）
        if (p2)
        {
          // 解析长度：位于 p1 之后直到 " byte" 之前（格式固定）
          int len = 0;
          char *q = p1 + 1;
          while (*q == ' ')
            q++; // 跳过空格
          while (*q >= '0' && *q <= '9')
          { // 十进制长度
            len = len * 10 + (*q - '0');
            q++;
          }
          // 可选：校验 " byte"
          while (*q == ' ')
            q++;
          // if (strncmp(q, "byte", 4) != 0) { /* 格式异常处理 */ }

          // 消息起始在第二个逗号后
          char *msg = p2 + 1;
          while (*msg == ' ')
            msg++; // 跳过空格

          // —— 原地移位：把正文搬到 buf[0] —— //
          size_t visible = strlen(msg); // 可见长度
          size_t cap = sizeof(buf) - 1; // buf 的显示容量
          size_t n = visible;           // 默认拷贝可见长度

          // 如果声明长度更短，就按 len 截断显示
          if (len >= 0 && (size_t)len < n)
            n = (size_t)len;
          // 再按缓冲容量截断，防止越界（通常 visible 已≤cap，这里双保险）
          if (n > cap)
            n = cap;

          memmove(buf, msg, n);
          buf[n] = '\0';
        }
      }

      // 处理接收到的消息
    }
  }
  delay(500);

  Serial.println(F("AT+MDISCONNECT"));
  Serial.flush();
  delay(500);

  Serial.println(F("AT+MIPCLOSE"));
  Serial.flush();
  delay(500);

  digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
  return 0;
}

bool mqtt_receive(void)
{
  int mqtt_len = 0;
  alarmTriggered = false;
  button1Pressed = false;
  button2Pressed = false;
  button3Pressed = false;
  // 清空屏幕
  rtc.clearAlarm(1);
  epd.Init();
  epd.ClearFrameMemory(0xFF); // 全白刷新屏幕
  epd.DisplayFrame();
  delay(100);

  paint.SetWidth(12);
  paint.SetHeight(256);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, "Receiving Message......", &Font12, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 110, 20, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();

  int r = checkMessages_debug(4);
  if (r == -1)
  {
    paint.Clear(UNCOLORED);
    paint.DrawStringAt(0, 0, "Message receive failed.", &Font12, COLORED);
    epd.SetFrameMemory_Partial(paint.GetImage(), 110, 20, paint.GetWidth(), paint.GetHeight());
    epd.DisplayFrame_Partial();
    return false;
  }
  mqtt_len = strlen(buf);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, " ", &Font12, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 110, 20, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();
  delay(100);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, "Message Updated", &Font12, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 110, 20, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  // 分行绘制
  for (uint16_t i = 0; i < mqtt_len; i += 36)
  {
    // 临时把多余部分截断成一行（直接操作 buf）
    char c = buf[i + 36]; // 保存第37个字符
    if (i + 36 < mqtt_len)
    {
      buf[i + 36] = '\0'; // 截断成当前行
    }
    // y = 30, 70, 110 ...（你可以改成基于 i 的偏移量）
    uint16_t y = 80 - (i / 36) * 16; // 每行16像素高
    paint.DrawStringAt(0, 0, buf + i, &Font12, COLORED);
    epd.SetFrameMemory_Partial(paint.GetImage(), y, 20, paint.GetWidth(), paint.GetHeight());
    // 恢复 buf 内容，继续下一轮
    if (i + 36 < mqtt_len)
    {
      buf[i + 36] = c;
    }
    paint.Clear(UNCOLORED);
  }
  epd.DisplayFrame_Partial();
  delay(2000);

  return 0;
}

bool mqtt_send(void)
{
  alarmTriggered = false;
  button1Pressed = false;
  button2Pressed = false;
  button3Pressed = false;
  // 清空屏幕
  rtc.clearAlarm(1);
  epd.Init();
  epd.ClearFrameMemory(0xFF); // 全白刷新屏幕
  epd.DisplayFrame();
  delay(100);

  paint.SetWidth(12);
  paint.SetHeight(256);
  paint.SetRotate(ROTATE_90);
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, "v", &Font20, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 0, 55, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial(paint.GetImage(), 0, 115, paint.GetWidth(), paint.GetHeight());
  epd.SetFrameMemory_Partial(paint.GetImage(), 0, 170, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, "Happy    Miss u    Tired", &Font12, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 24, 30, paint.GetWidth(), paint.GetHeight());
  paint.Clear(UNCOLORED);
  paint.DrawStringAt(0, 0, "Press to Send Message:", &Font12, COLORED);
  epd.SetFrameMemory_Partial(paint.GetImage(), 80, 30, paint.GetWidth(), paint.GetHeight());
  epd.DisplayFrame_Partial();

  unsigned long t3 = millis();
  int display_type = 0;

  while (millis() - t3 < 15000)
  {
    // 等待 15 秒
    if (button1Pressed)
    {
      button1Pressed = false;
      button2Pressed = false;
      button3Pressed = false;
      display_type = 1;
      break;
    }
    else if (button2Pressed)
    {
      button1Pressed = false;
      button2Pressed = false;
      button3Pressed = false;
      display_type = 2;
      break;
    }
    else if (button3Pressed)
    {
      button1Pressed = false;
      button2Pressed = false;
      button3Pressed = false;
      display_type = 3;
      break;
    }
    delay(50);
  }
  if (display_type == 1 || display_type == 2 || display_type == 3)
  {
    paint.Clear(UNCOLORED);
    epd.SetFrameMemory_Partial(paint.GetImage(), 80, 30, paint.GetWidth(), paint.GetHeight());
    epd.DisplayFrame_Partial();
    delay(100);
    paint.DrawStringAt(0, 0, "Sending Message......", &Font12, COLORED);
    epd.SetFrameMemory_Partial(paint.GetImage(), 80, 30, paint.GetWidth(), paint.GetHeight());
    epd.DisplayFrame_Partial();

    int r = checkMessages_debug(display_type);
    paint.Clear(UNCOLORED);

    epd.SetFrameMemory_Partial(paint.GetImage(), 80, 30, paint.GetWidth(), paint.GetHeight());
    epd.DisplayFrame_Partial();
    delay(100);
    if (r == 0)
    {
      paint.DrawStringAt(0, 0, "Sending Success!", &Font12, COLORED);
    }
    else
    {
      paint.DrawStringAt(0, 0, "Sending Failed!", &Font12, COLORED);
    }
    epd.SetFrameMemory_Partial(paint.GetImage(), 80, 30, paint.GetWidth(), paint.GetHeight());
    epd.DisplayFrame_Partial();
    delay(10000);
  }
  else
  {
    epd.ClearFrameMemory(0xFF); // 全白刷新屏幕
    epd.DisplayFrame();
    delay(100);
    switchState(EVENT_BUTTON1);
    return false;
  }

  epd.ClearFrameMemory(0xFF); // 全白刷新屏幕
  epd.DisplayFrame();
  delay(1000);
  switchState(EVENT_BUTTON1);
  return true;
}
void switchState(EventType event)
{
  // 状态迁移逻辑：输入事件 + 当前状态 => 下一个状态
  lastState = currentState;
  switch (currentState)
  {
  case STATE_EXAM_COUNTDOWN:
    if (event == EVENT_BUTTON1)
      currentState = STATE_MEET_COUNTDOWN;
    else if (event == EVENT_BUTTON2)
      currentState = STATE_MQTT_SEND;
    else if (event == EVENT_BUTTON3)
      currentState = STATE_MQTT_MESSAGE;
    break;

  case STATE_MEET_COUNTDOWN:
    if (event == EVENT_BUTTON1)
      currentState = STATE_EXAM_COUNTDOWN;
    else if (event == EVENT_BUTTON2)
      currentState = STATE_MQTT_SEND;
    else if (event == EVENT_BUTTON3)
      currentState = STATE_MQTT_MESSAGE;
    break;

  case STATE_MQTT_SEND:
    if (event == EVENT_BUTTON1)
      currentState = STATE_EXAM_COUNTDOWN;
    else if (event == EVENT_BUTTON2)
      currentState = STATE_MQTT_SEND;
    else if (event == EVENT_BUTTON3)
      currentState = STATE_MQTT_MESSAGE;
    break;

  case STATE_MQTT_MESSAGE:
    if (event == EVENT_BUTTON1)
      currentState = STATE_EXAM_COUNTDOWN;
    else if (event == EVENT_BUTTON2)
      currentState = STATE_MQTT_SEND;
    else if (event == EVENT_BUTTON3)
      currentState = STATE_MQTT_MESSAGE;
    break;

  case STATE_LOW_BATTERY:
    // 不允许退出低电状态，直到重启或唤醒
    return;
  }
  DateTime now;
  switch (currentState)
  {
  case STATE_EXAM_COUNTDOWN:
    initCountdownPanel(0);
    epd.DisplayFrame();
    now = rtc.now();
    renderClockPanel(&now, &firstFlag, timeBuf_old);
    // displayTime(rtc.now());
    break;
  case STATE_MEET_COUNTDOWN:
    initCountdownPanel(1);
    epd.DisplayFrame();
    now = rtc.now();
    renderClockPanel(&now, &firstFlag, timeBuf_old);
    // displayTime(rtc.now());
    break;

  case STATE_MQTT_SEND:
    mqtt_send();

    break;
  case STATE_MQTT_MESSAGE:
    mqtt_receive();
    break;
  case STATE_LOW_BATTERY:
    // renderLowBatteryScreen();
    break;
  }
}

ISR(INT0_vect)
{
  button1Pressed = true;
}
ISR(INT1_vect)
{
  button2Pressed = true;
}
// D8-D13 对应 PCINT0 向量（PORTB）
ISR(PCINT0_vect)
{
  if (!(PINB & (1 << PINB5)))
  {
    // D13 为低电平（可能是 RTC 触发的中断）
    alarmTriggered = true;
  }
  else
  {
    // D13 为高电平
  }
}
ISR(PCINT1_vect)
{
  if (!(PINC & (1 << PINC1)))
  {
    // A1 为低电平（比如按钮按下）
    button3Pressed = true;
  }
  else
  {
    // A1 为高电平
  }
}

void handleRtcAlarmEvent()
{
  digitalWrite(PMOS_CTRL_PIN, HIGH); // 关闭电源
  rtc.clearAlarm(1);                 // 清除 DS3231 的闹钟中断标志
  DateTime now = rtc.now() + TimeSpan(0, 0, 1, 0);

  // 检查是否跨天
  if (now.day() != lastDay)
  {
    lastDay = now.day();                 // 更新记录
    currentState = STATE_EXAM_COUNTDOWN; // 重置状态为考试倒计时
    todayMin = 0;                        // 重置今天的分钟数
    initCountdownPanel(0);
    epd.DisplayFrame();
    // displayTime(now);                     // 显示当前时间
    setupNextAlarm(); // 设置下一分钟的闹钟
    reset();
    return; // 直接返回，不再继续执行
  }

  if (now.minute() == TASK_MINUTE &&                                     // 分钟 = 5
      (uint8_t)((now.hour() + 24 - TASK_BASE_H) % TASK_INTERVAL) == 0 && // (时-2) % 6 == 0
      !(now.day() == lastTaskDay && now.hour() == lastTaskHour)          // 避免同一小时重复
  )
  {
    lastTaskDay = now.day();
    lastTaskHour = now.hour();
    // checkMessages();
  }

  switch (currentState)
  {
  case STATE_EXAM_COUNTDOWN:
    initCountdownPanel(0);
    renderClockPanel(&now, &firstFlag, timeBuf_old);
    // displayTime(now);
    break;

  case STATE_MEET_COUNTDOWN:
    initCountdownPanel(1);
    renderClockPanel(&now, &firstFlag, timeBuf_old);
    // displayTime(now);
    break;

  case STATE_MQTT_SEND:

    break;
  case STATE_MQTT_MESSAGE:

    break;
  case STATE_LOW_BATTERY:

    break;
  }

  setupNextAlarm(); // 设置下一分钟的闹钟
}

void enterDeepSleep()
{
  // 设置为掉电模式
  ADCSRA &= ~_BV(ADEN);
  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  sleep_enable();
  // 关闭 BOD（Brown-Out Detector），降低睡眠功耗
  cli(); // 进入原子操作区
  sleep_bod_disable();
  sei(); // 开启中断（必须在 sleep_cpu() 前）

  sleep_cpu();     // 💥 实际进入掉电睡眠
  sleep_disable(); // 🛌 醒来后清除睡眠允许标志
}

void setupNextAlarm()
{
  DateTime now = rtc.now();

  // 默认设定秒 = 58
  uint8_t next_sec = 58;
  uint8_t next_min = now.minute();
  uint8_t next_hour = now.hour();
  uint8_t next_day = now.day();
  uint8_t next_month = now.month();
  uint16_t next_year = now.year();

  // 如果当前已经超过58秒，则设置为下一分钟
  if (now.second() >= 58)
  {
    next_min += 1;
    if (next_min >= 60)
    {
      next_min = 0;
      next_hour += 1;
      if (next_hour >= 24)
      {
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

void setup()
{
  Serial.begin(9600);
  pinMode(PMOS_CTRL_PIN, OUTPUT);
  delay(30000);//等待电容充电
  checkMessages_debug(0);//获取初始化日期参数

  // 配置 D2、D3 为上拉输入
  pinMode(2, INPUT_PULLUP);             // INT0
  pinMode(3, INPUT_PULLUP);             // INT1
  EIMSK |= (1 << INT0) | (1 << INT1);   // 启用外部中断 INT0 / INT1
  EICRA |= (1 << ISC01) | (1 << ISC11); // 下降沿触发 INT0 / INT1
  pinMode(A1, INPUT_PULLUP);            // PCINT23
  PCICR |= (1 << PCIE1);                // 启用 Port C（PCINT[14:8]）的中断功能
  PCMSK1 |= (1 << PCINT9);              // 允许 A1（PC1）电平变化触发中断

  Wire.begin();
  delay(10);
  epd.Init();
  epd.ClearFrameMemory(0xFF); // 全白刷新屏幕
  epd.DisplayFrame();
  delay(100);

  batteryMonitorBegin(); // 初始化电量检测
  uint16_t batteryVoltage = readBatteryVoltage_mv();
  if (batteryVoltage < 800) // 800*3.69=3038mV
  {
    currentState = STATE_LOW_BATTERY;
    // renderLowBatteryScreen();
    enterDeepSleep(); // 进入深度睡眠
  }
  if (!rtc.begin())
  {
    while (1)
      delay(10);
  }
  delay(100);
  pinMode(13, INPUT_PULLUP); // D13连接DS3231 INT，开漏，必须上拉
  // 禁用DS3231方波，启用中断模式
  rtc.writeSqwPinMode(DS3231_OFF);
  // 启用 PCINT0 中断，PCINT5 = D13
  PCICR |= (1 << PCIE0);   // 使能 Port B（PB0–PB7）的 PCINT 中断
  PCMSK0 |= (1 << PCINT5); // 启用 D13 的 PCINT
  DateTime now = rtc.now();
  lastDay = now.day();
  initCountdownPanel(COUNTDOWN_EXAM);
  epd.DisplayFrame();
  now = rtc.now();
  renderClockPanel(&now, &firstFlag, timeBuf_old);
  // displayTime(rtc.now());  // 显示当前时间
  setupNextAlarm();
  lastDisplayTime = rtc.now();
}

void loop()
{
  wakeUp = false;
  alarmTriggered = false;
  enterDeepSleep();

  if (button1Pressed)
  {
    button1Pressed = false;
    switchState(EVENT_BUTTON1);
    button1Pressed = false;
  }

  if (button2Pressed)
  {
    button2Pressed = false;
    switchState(EVENT_BUTTON2);
    button2Pressed = false;
  }

  if (button3Pressed)
  {
    button3Pressed = false;
    switchState(EVENT_BUTTON3);
    button3Pressed = false;
  }

  if (alarmTriggered)
  {
    alarmTriggered = false;
    handleRtcAlarmEvent();
  }
}
