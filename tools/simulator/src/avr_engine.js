import {
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRTWI,
  AVRTimer,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  adcConfig,
  avrInstruction,
  clockConfig,
  eepromConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from "avr8js";

const CPU_FREQ_HZ = 8_000_000;
const SRAM_BYTES = 2048;
const AVR_DATA_SPACE_BYTES = 0x100 + SRAM_BYTES;
const SRAM_START_ADDR = 0x100;
const SRAM_END_ADDR = SRAM_START_ADDR + SRAM_BYTES - 1;
const FLASH_WORDS = 0x4000;
const FLASH_BYTES = FLASH_WORDS * 2;
const FLASH_APP_LIMIT_BYTES = 32256;
const EEPROM_BYTES = 1024;
const SMCR = 0x53;
const SPL_ADDR = 0x5d;
const SREG_ADDR = 0x5f;
const SE_BIT = 0x01;
const SLEEP_OPCODE = 0x9588;
const USART_RXC = 0x80;
const BAT_DIVIDER_TOP_OHMS = 1_000_000;
const BAT_DIVIDER_BOTTOM_OHMS = 330_000;
const BAT_ADC_REF_V = 1.1;
const AIR780_WARN_MV = 3300;
const AIR780_BROWNOUT_MV = 3000;
const AIR780_CRITICAL_MV = 2800;
const AIR780_BROWNOUT_HOLD_MS = 80;
const AIR780_CRITICAL_HOLD_MS = 3;
const AIR780_DEFAULT_TX_PEAK_MA = 430;
const AIR780_DEFAULT_SUSTAIN_MA = 4;
const AIR780_DEFAULT_TX_PULSE_MS = 0.5;
const AIR780_TX_PERIOD_MS = 1200;
const AIR780_UART_BAUD = 9600;
const AIR780_IDLE_MA = 4;
const AIR780_BOOT_MA = 24;
const AIR780_ATTACH_SCAN_MA = 36;
const AIR780_RX_MA = 24;
const AIR780_UART_BIT_MA = 2;
const ER14505_DEFAULT_COUNT = 2;
const ER14505_DEFAULT_CONTINUOUS_LIMIT_MA = 100;
const ER14505_DEFAULT_PULSE_LIMIT_MA = 200;
const SUPERCAP_DEFAULT_F = 0.5;
const SUPERCAP_DEFAULT_COUNT = 2;
const SUPERCAP_DEFAULT_CHARGE_OHMS = 10;
const SUPERCAP_DEFAULT_CHARGE_RESISTORS = 2;
const SUPERCAP_DEFAULT_ESR_MOHM = 800;
const SUPERCAP_DEFAULT_LEAKAGE_UA = 25;
const SUPERCAP_DEFAULT_DIODE_MV = 250;
const SUPPLY_SWITCH_DEFAULT_MOHM = 80;
const LTE_BURST_DEFAULT_GLITCH_MV = 90;
const SUPPLY_MEASUREMENT_DEFAULT_NOISE_MV = 12;
const LDO_DROPOUT_MV = 150;
const AVR_ACTIVE_DEFAULT_MA = 5.5;
const AVR_SLEEP_DEFAULT_UA = 6;
const BOARD_QUIESCENT_DEFAULT_UA = 120;
const DS3231_DEFAULT_VBAT_MV = 3000;
const DS3231_VCC_MIN_MV = 2300;
const DS3231_VBAT_MIN_MV = 2000;
const FIRST_BOOT_CAP_CHARGE_WAIT_MS = 30_000;
const EPD_FULL_REFRESH_CYCLES = Math.round(CPU_FREQ_HZ * 2.0);
const EPD_PARTIAL_REFRESH_CYCLES = Math.round(CPU_FREQ_HZ * 0.3);
const EPD_PARTIAL_SETUP_CYCLES = Math.round(CPU_FREQ_HZ * 0.08);
const EPD_REGISTER_BUSY_CYCLES = Math.round(CPU_FREQ_HZ * 0.02);

const PIN = {
  EPD_RST: 0,
  EPD_DC: 1,
  EPD_CS: 2,
  EPD_MOSI: 3,
  EPD_SCK: 4,
  RTC_INT: 5,
  BAT_SWITCH: 4,
  AIR780_PMOS: 5,
  BUTTON1: 2,
  BUTTON2: 3,
  BUTTON3: 1,
  EPD_BUSY: 7,
};

function bcd(value) {
  return (((Math.floor(value / 10) % 10) << 4) | (value % 10)) & 0xff;
}

function fromBcd(value) {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hexByte(value) {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

function hexWord(value) {
  return `0x${Number(value).toString(16).padStart(4, "0")}`;
}

function sregFlags(value) {
  const names = ["C", "Z", "N", "V", "S", "H", "T", "I"];
  return names.filter((name, bit) => value & (1 << bit));
}

function padAlarm(value) {
  return String(value).padStart(2, "0");
}

function monotonicNow() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function pixelNoise(x, y, salt = 0) {
  let v = (x * 1103515245 + y * 12345 + salt * 2654435761) >>> 0;
  v ^= v >>> 16;
  v = Math.imul(v, 2246822519) >>> 0;
  v ^= v >>> 13;
  return (v & 0xff) / 255;
}

export function loadIntelHex(hex) {
  const program = new Uint16Array(FLASH_WORDS);
  program.fill(0xffff);
  const bytes = new Uint8Array(program.buffer);
  let upper = 0;

  for (const rawLine of hex.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith(":")) {
      throw new Error(`Invalid Intel HEX line: ${line}`);
    }

    const length = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    const data = [];
    let sum = length + (addr >> 8) + (addr & 0xff) + type;
    for (let i = 0; i < length; i += 1) {
      const value = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
      data.push(value);
      sum += value;
    }
    const checksum = parseInt(line.slice(9 + length * 2, 11 + length * 2), 16);
    if (((sum + checksum) & 0xff) !== 0) {
      throw new Error(`Bad Intel HEX checksum at ${line}`);
    }

    if (type === 0x00) {
      const base = upper + addr;
      for (let i = 0; i < data.length; i += 1) {
        if (base + i < bytes.length) {
          bytes[base + i] = data[i];
        }
      }
    } else if (type === 0x01) {
      break;
    } else if (type === 0x04) {
      upper = (((data[0] << 8) | data[1]) << 16) >>> 0;
    }
  }

  return program;
}

class DS3231Model {
  constructor({ log, getTimeMs = monotonicNow, getVccMv = () => 3300, setRtcInt }) {
    this.log = log;
    this.getTimeMs = getTimeMs;
    this.getVccMv = getVccMv;
    this.setRtcInt = setRtcInt;
    this.baseDate = new Date();
    this.baseTimeMs = this.getTimeMs();
    this.vbatMv = DS3231_DEFAULT_VBAT_MV;
    this.regs = new Uint8Array(0x20);
    this.regs[0x0e] = 0x1c;
    this.regs[0x0f] = 0x00;
    this.pointer = 0;
    this.oscillatorRunning = this.hasOscillatorPower();
    this.lastAlarmSecondKey = null;
    this.intLow = false;
    this.updateIntPin();
  }

  hasVcc() {
    return this.getVccMv() >= DS3231_VCC_MIN_MV;
  }

  hasVbat() {
    return this.vbatMv >= DS3231_VBAT_MIN_MV;
  }

  hasOscillatorPower() {
    const eosc = !!(this.regs[0x0e] & 0x80);
    return this.hasVcc() || (this.hasVbat() && !eosc);
  }

  busAvailable() {
    return this.hasVcc();
  }

  setBackupMv(mv) {
    if (Number.isFinite(Number(mv))) {
      this.step();
      this.vbatMv = Math.max(0, Number(mv));
      this.step();
    }
  }

  currentDate(nowMs = this.getTimeMs()) {
    if (!this.oscillatorRunning) {
      return new Date(this.baseDate);
    }
    return new Date(this.baseDate.getTime() + Math.max(0, nowMs - this.baseTimeMs));
  }

  setDate(date) {
    this.baseDate = new Date(date);
    this.baseTimeMs = this.getTimeMs();
    this.oscillatorRunning = this.hasOscillatorPower();
    this.regs[0x0f] &= ~0x80;
    this.lastAlarmSecondKey = Math.floor(this.baseDate.getTime() / 1000);
    this.updateIntPin();
  }

  now() {
    this.step();
    return this.currentDate();
  }

  step() {
    const nowMs = this.getTimeMs();
    const shouldRun = this.hasOscillatorPower();
    if (this.oscillatorRunning && !shouldRun) {
      this.baseDate = this.currentDate(nowMs);
      this.baseTimeMs = nowMs;
      this.regs[0x0f] |= 0x80;
    } else if (!this.oscillatorRunning && shouldRun) {
      this.baseTimeMs = nowMs;
    }
    this.oscillatorRunning = shouldRun;
    if (this.oscillatorRunning) {
      this.checkAlarms(this.currentDate(nowMs));
    }
    this.updateIntPin();
  }

  triggerAlarm() {
    this.regs[0x0f] |= 0x01;
    this.updateIntPin();
    this.log("DS3231 INT low: alarm flag A1F set");
  }

  updateIntPin() {
    const control = this.regs[0x0e];
    const status = this.regs[0x0f];
    const alarmLow =
      !!(control & 0x04) &&
      (((control & 0x01) && (status & 0x01)) || ((control & 0x02) && (status & 0x02)));
    this.intLow = this.hasOscillatorPower() && alarmLow;
    this.setRtcInt(!this.intLow);
  }

  checkAlarms(date) {
    const secondKey = Math.floor(date.getTime() / 1000);
    if (secondKey === this.lastAlarmSecondKey) {
      return;
    }
    this.lastAlarmSecondKey = secondKey;
    let fired = false;
    if ((this.regs[0x0e] & 0x01) && this.matchesAlarm1(date)) {
      if ((this.regs[0x0f] & 0x01) === 0) {
        this.log("DS3231 Alarm1 match: A1F set");
      }
      this.regs[0x0f] |= 0x01;
      fired = true;
    }
    if ((this.regs[0x0e] & 0x02) && this.matchesAlarm2(date)) {
      if ((this.regs[0x0f] & 0x02) === 0) {
        this.log("DS3231 Alarm2 match: A2F set");
      }
      this.regs[0x0f] |= 0x02;
      fired = true;
    }
    if (fired) {
      this.updateIntPin();
    }
  }

  dsDay(date) {
    const day = date.getDay();
    return day === 0 ? 7 : day;
  }

  alarmDateMatches(regValue, date) {
    const dyDt = !!(regValue & 0x40);
    const value = fromBcd(regValue & 0x3f);
    return dyDt ? value === this.dsDay(date) : value === date.getDate();
  }

  alarmHourMatches(regValue, date) {
    if (regValue & 0x40) {
      const hour12 = fromBcd(regValue & 0x1f);
      const pm = !!(regValue & 0x20);
      const normalized = (hour12 % 12) + (pm ? 12 : 0);
      return normalized === date.getHours();
    }
    return fromBcd(regValue & 0x3f) === date.getHours();
  }

  matchesAlarm1(date) {
    const sec = this.regs[0x07];
    const min = this.regs[0x08];
    const hour = this.regs[0x09];
    const day = this.regs[0x0a];
    if (!(sec & 0x80) && fromBcd(sec & 0x7f) !== date.getSeconds()) {
      return false;
    }
    if (!(min & 0x80) && fromBcd(min & 0x7f) !== date.getMinutes()) {
      return false;
    }
    if (!(hour & 0x80) && !this.alarmHourMatches(hour, date)) {
      return false;
    }
    if (!(day & 0x80) && !this.alarmDateMatches(day, date)) {
      return false;
    }
    return true;
  }

  matchesAlarm2(date) {
    if (date.getSeconds() !== 0) {
      return false;
    }
    const min = this.regs[0x0b];
    const hour = this.regs[0x0c];
    const day = this.regs[0x0d];
    if (!(min & 0x80) && fromBcd(min & 0x7f) !== date.getMinutes()) {
      return false;
    }
    if (!(hour & 0x80) && !this.alarmHourMatches(hour, date)) {
      return false;
    }
    if (!(day & 0x80) && !this.alarmDateMatches(day, date)) {
      return false;
    }
    return true;
  }

  readRegister(reg) {
    this.step();
    const date = this.currentDate();
    switch (reg & 0xff) {
      case 0x00:
        return bcd(date.getSeconds());
      case 0x01:
        return bcd(date.getMinutes());
      case 0x02:
        return bcd(date.getHours());
      case 0x03:
        return this.dsDay(date);
      case 0x04:
        return bcd(date.getDate());
      case 0x05:
        return bcd(date.getMonth() + 1);
      case 0x06:
        return bcd(date.getFullYear() - 2000);
      case 0x11:
        return 25;
      case 0x12:
        return 0;
      default:
        return this.regs[reg & 0x1f];
    }
  }

  writeSequential(bytes) {
    if (bytes.length === 0 || !this.busAvailable()) {
      return;
    }
    this.pointer = bytes[0] & 0xff;
    for (let i = 1; i < bytes.length; i += 1) {
      this.writeRegister((this.pointer + i - 1) & 0xff, bytes[i]);
    }
  }

  writeRegister(reg, value) {
    const r = reg & 0x1f;
    const v = value & 0xff;
    this.regs[r] = v;
    if (r >= 0x00 && r <= 0x06) {
      const current = this.currentDate();
      const year = r === 0x06 ? 2000 + fromBcd(v) : current.getFullYear();
      const month = r === 0x05 ? fromBcd(v) - 1 : current.getMonth();
      const day = r === 0x04 ? fromBcd(v) : current.getDate();
      const hour = r === 0x02 ? fromBcd(v & 0x3f) : current.getHours();
      const minute = r === 0x01 ? fromBcd(v) : current.getMinutes();
      const second = r === 0x00 ? fromBcd(v & 0x7f) : current.getSeconds();
      this.baseDate = new Date(year, month, day, hour, minute, second);
      this.baseTimeMs = this.getTimeMs();
      this.lastAlarmSecondKey = Math.floor(this.baseDate.getTime() / 1000);
    }
    if (r === 0x0e || r === 0x0f || (r >= 0x07 && r <= 0x0d)) {
      this.step();
      this.updateIntPin();
    }
  }

  alarmMode1() {
    return (
      ((this.regs[0x07] & 0x80) >> 7) |
      ((this.regs[0x08] & 0x80) >> 6) |
      ((this.regs[0x09] & 0x80) >> 5) |
      ((this.regs[0x0a] & 0x80) >> 4) |
      ((this.regs[0x0a] & 0x40) >> 2)
    );
  }

  alarmMode2() {
    return (
      ((this.regs[0x0b] & 0x80) >> 7) |
      ((this.regs[0x0c] & 0x80) >> 6) |
      ((this.regs[0x0d] & 0x80) >> 5) |
      ((this.regs[0x0d] & 0x40) >> 3)
    );
  }

  describeAlarm1() {
    const sec = fromBcd(this.regs[0x07] & 0x7f);
    const min = fromBcd(this.regs[0x08] & 0x7f);
    const hour = fromBcd(this.regs[0x09] & 0x3f);
    const day = fromBcd(this.regs[0x0a] & 0x3f);
    const mode = this.alarmMode1();
    if (mode === 0x0f) {
      return "once per second";
    }
    if (mode === 0x0e) {
      return `sec=${sec}`;
    }
    if (mode === 0x0c) {
      return `${padAlarm(min)}:${padAlarm(sec)}`;
    }
    if (mode === 0x08) {
      return `${padAlarm(hour)}:${padAlarm(min)}:${padAlarm(sec)}`;
    }
    const dayKind = this.regs[0x0a] & 0x40 ? "dow" : "date";
    return `${dayKind}=${day} ${padAlarm(hour)}:${padAlarm(min)}:${padAlarm(sec)}`;
  }

  describeAlarm2() {
    const min = fromBcd(this.regs[0x0b] & 0x7f);
    const hour = fromBcd(this.regs[0x0c] & 0x3f);
    const day = fromBcd(this.regs[0x0d] & 0x3f);
    const mode = this.alarmMode2();
    if (mode === 0x07) {
      return "once per minute";
    }
    if (mode === 0x06) {
      return `min=${min}`;
    }
    if (mode === 0x04) {
      return `${padAlarm(hour)}:${padAlarm(min)}`;
    }
    const dayKind = this.regs[0x0d] & 0x40 ? "dow" : "date";
    return `${dayKind}=${day} ${padAlarm(hour)}:${padAlarm(min)}`;
  }

  nextSecondMatch(date, second) {
    const next = new Date(date);
    next.setMilliseconds(0);
    next.setSeconds(second);
    if (next.getTime() <= date.getTime()) {
      next.setMinutes(next.getMinutes() + 1);
    }
    return next;
  }

  nextMinuteMatch(date, minute, second = 0) {
    const next = new Date(date);
    next.setMilliseconds(0);
    next.setSeconds(second);
    next.setMinutes(minute);
    if (next.getTime() <= date.getTime()) {
      next.setHours(next.getHours() + 1);
    }
    return next;
  }

  nextHourMatch(date, hour, minute, second = 0) {
    const next = new Date(date);
    next.setMilliseconds(0);
    next.setSeconds(second);
    next.setMinutes(minute);
    next.setHours(hour);
    if (next.getTime() <= date.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  nextDateMatch(date, day, hour, minute, second = 0) {
    for (let offset = 0; offset < 14; offset += 1) {
      const month = date.getMonth() + offset;
      const candidate = new Date(date.getFullYear(), month, day, hour, minute, second, 0);
      if (candidate.getMonth() === ((month % 12) + 12) % 12 && candidate.getTime() > date.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  nextDayMatch(date, dsDay, hour, minute, second = 0) {
    const next = new Date(date);
    next.setMilliseconds(0);
    next.setSeconds(second);
    next.setMinutes(minute);
    next.setHours(hour);
    const delta = (dsDay - this.dsDay(next) + 7) % 7;
    next.setDate(next.getDate() + delta);
    if (next.getTime() <= date.getTime()) {
      next.setDate(next.getDate() + 7);
    }
    return next;
  }

  nextAlarm1Date(date) {
    if ((this.regs[0x0e] & 0x01) === 0) {
      return null;
    }
    const sec = fromBcd(this.regs[0x07] & 0x7f);
    const min = fromBcd(this.regs[0x08] & 0x7f);
    const hour = fromBcd(this.regs[0x09] & 0x3f);
    const day = fromBcd(this.regs[0x0a] & 0x3f);
    switch (this.alarmMode1()) {
      case 0x0f:
        return new Date(Math.floor(date.getTime() / 1000) * 1000 + 1000);
      case 0x0e:
        return this.nextSecondMatch(date, sec);
      case 0x0c:
        return this.nextMinuteMatch(date, min, sec);
      case 0x08:
        return this.nextHourMatch(date, hour, min, sec);
      case 0x10:
        return this.nextDayMatch(date, day, hour, min, sec);
      default:
        return this.nextDateMatch(date, day, hour, min, sec);
    }
  }

  nextAlarm2Date(date) {
    if ((this.regs[0x0e] & 0x02) === 0) {
      return null;
    }
    const min = fromBcd(this.regs[0x0b] & 0x7f);
    const hour = fromBcd(this.regs[0x0c] & 0x3f);
    const day = fromBcd(this.regs[0x0d] & 0x3f);
    switch (this.alarmMode2()) {
      case 0x07:
        return this.nextMinuteMatch(date, date.getMinutes() + 1, 0);
      case 0x06:
        return this.nextMinuteMatch(date, min, 0);
      case 0x04:
        return this.nextHourMatch(date, hour, min, 0);
      case 0x08:
        return this.nextDayMatch(date, day, hour, min, 0);
      default:
        return this.nextDateMatch(date, day, hour, min, 0);
    }
  }

  summary() {
    this.step();
    const date = this.currentDate();
    const alarm1Next = this.nextAlarm1Date(date);
    const alarm2Next = this.nextAlarm2Date(date);
    const control = this.regs[0x0e];
    const status = this.regs[0x0f];
    return {
      vccMv: Math.round(this.getVccMv()),
      vbatMv: Math.round(this.vbatMv),
      domain: this.hasVcc() ? "VCC" : this.hasVbat() ? "VBAT" : "OFF",
      i2cOnline: this.busAvailable(),
      oscillatorRunning: this.oscillatorRunning,
      intLow: this.intLow,
      control,
      status,
      intcn: !!(control & 0x04),
      a1Enabled: !!(control & 0x01),
      a2Enabled: !!(control & 0x02),
      a1F: !!(status & 0x01),
      a2F: !!(status & 0x02),
      en32k: !!(status & 0x08),
      osf: !!(status & 0x80),
      alarm1: this.describeAlarm1(),
      alarm2: this.describeAlarm2(),
      alarm1NextMs: alarm1Next ? alarm1Next.getTime() : null,
      alarm2NextMs: alarm2Next ? alarm2Next.getTime() : null,
      alarm1CountdownMs: alarm1Next ? Math.max(0, alarm1Next.getTime() - date.getTime()) : null,
      alarm2CountdownMs: alarm2Next ? Math.max(0, alarm2Next.getTime() - date.getTime()) : null,
      temperatureC: 25,
      pointer: this.pointer & 0xff,
    };
  }
}

class DS3231TWIHandler {
  constructor(twi, ds3231, log) {
    this.twi = twi;
    this.ds3231 = ds3231;
    this.log = log;
    this.addr = 0;
    this.writeMode = true;
    this.writeBuffer = [];
  }

  start(repeated) {
    this.writeBuffer = repeated ? this.writeBuffer : [];
    this.twi.completeStart();
  }

  stop() {
    if (this.addr === 0x68 && this.writeMode && this.writeBuffer.length > 0) {
      this.ds3231.writeSequential(this.writeBuffer);
      this.log(`TWI DS3231 write ${this.writeBuffer.map(hexByte).join(" ")}`);
    }
    this.writeBuffer = [];
    this.twi.completeStop();
  }

  connectToSlave(addr, write) {
    this.addr = addr;
    this.writeMode = write;
    this.twi.completeConnect(addr === 0x68 && this.ds3231.busAvailable());
  }

  writeByte(value) {
    if (this.addr === 0x68 && this.ds3231.busAvailable()) {
      this.writeBuffer.push(value & 0xff);
      this.twi.completeWrite(true);
    } else {
      this.twi.completeWrite(false);
    }
  }

  readByte() {
    if (this.addr !== 0x68 || !this.ds3231.busAvailable()) {
      this.twi.completeRead(0xff);
      return;
    }
    if (this.writeBuffer.length > 0) {
      this.ds3231.pointer = this.writeBuffer[0] & 0xff;
      this.writeBuffer = [];
    }
    const reg = this.ds3231.pointer & 0xff;
    const value = this.ds3231.readRegister(reg);
    this.ds3231.pointer = (this.ds3231.pointer + 1) & 0xff;
    this.twi.completeRead(value);
  }
}

class Air780Model {
  constructor({ usart, cpu, log, supplyOk = () => true, addPowerEvent = () => {} }) {
    this.usart = usart;
    this.cpu = cpu;
    this.log = log;
    this.supplyOk = supplyOk;
    this.addPowerEvent = addPowerEvent;
    this.powered = false;
    this.state = "OFF";
    this.rxQueue = [];
    this.failAttach = false;
    this.failMqtt = false;
    this.rxMessage = "hello from mqtt";
    this.datePayload = "261225,261225";
    this.pendingResponses = [];
    this.protocolStep = "OFF";
    this.registered = false;
    this.attached = false;
    this.pdpActive = false;
    this.tcpConnected = false;
    this.mqttConfigured = false;
    this.mqttConnected = false;
    this.subscribedTopics = new Set();
  }

  setOptions(options) {
    if (!options) {
      return;
    }
    if (typeof options.failAttach === "boolean") {
      this.failAttach = options.failAttach;
    }
    if (typeof options.failMqtt === "boolean") {
      this.failMqtt = options.failMqtt;
    }
    if (typeof options.rxMessage === "string") {
      this.rxMessage = options.rxMessage;
    }
    if (typeof options.datePayload === "string") {
      this.datePayload = options.datePayload;
    }
  }

  setPower(on) {
    if (this.powered === on) {
      return;
    }
    this.powered = on;
    if (on) {
      this.resetProtocol();
      this.state = "BOOTING";
      this.protocolStep = "BOOTING";
      this.log("Air780 power on via PMOS D5 low");
      this.addPowerEvent({ type: "boot", durationMs: 1200, currentMa: AIR780_BOOT_MA });
      this.scheduleResponse(650, "\r\n+CGEV: ME PDN ACT 1\r\n", {
        state: "READY",
        protocolStep: "SIM READY",
      });
    } else {
      this.resetProtocol();
      this.state = "OFF";
      this.protocolStep = "OFF";
      this.rxQueue = [];
      this.log("Air780 power off via PMOS D5 high");
    }
  }

  resetProtocol() {
    this.pendingResponses = [];
    this.rxQueue = [];
    this.protocolStep = this.powered ? "IDLE" : "OFF";
    this.registered = false;
    this.attached = false;
    this.pdpActive = false;
    this.tcpConnected = false;
    this.mqttConfigured = false;
    this.mqttConnected = false;
    this.subscribedTopics = new Set();
  }

  scheduleResponse(delayMs, text, { state, protocolStep, apply } = {}) {
    this.pendingResponses.push({
      dueMs: monotonicNow() + Math.max(0, Number(delayMs) || 0),
      text,
      state,
      protocolStep,
      apply,
    });
    this.pendingResponses.sort((left, right) => left.dueMs - right.dueMs);
  }

  flushScheduledResponses() {
    if (!this.powered || this.pendingResponses.length === 0) {
      return;
    }
    const now = monotonicNow();
    const ready = [];
    while (this.pendingResponses.length > 0 && this.pendingResponses[0].dueMs <= now) {
      ready.push(this.pendingResponses.shift());
    }
    ready.forEach((response) => {
      if (typeof response.apply === "function") {
        response.apply();
      }
      if (response.state) {
        this.state = response.state;
      }
      if (response.protocolStep) {
        this.protocolStep = response.protocolStep;
      }
      this.enqueue(response.text);
    });
  }

  enqueue(text) {
    this.addPowerEvent({
      type: "uart-rx",
      durationMs: this.uartFrameMs(text.length),
      currentMa: AIR780_UART_BIT_MA,
      bytes: text.length,
    });
    for (let i = 0; i < text.length; i += 1) {
      this.rxQueue.push(text.charCodeAt(i) & 0xff);
    }
  }

  uartFrameMs(byteLength) {
    return (Math.max(0, byteLength) * 10 * 1000) / AIR780_UART_BAUD;
  }

  commandPower(cmd) {
    const bytes = cmd.length + 2;
    this.addPowerEvent({
      type: "uart-tx",
      durationMs: this.uartFrameMs(bytes),
      currentMa: AIR780_UART_BIT_MA,
      bytes,
    });
    if (cmd === "AT+CEREG?" || cmd === "AT+CGATT?") {
      this.addPowerEvent({ type: "network-scan", durationMs: this.failAttach ? 2400 : 900, currentMa: AIR780_ATTACH_SCAN_MA });
    } else if (cmd.startsWith("AT+MIPSTART=")) {
      this.addPowerEvent({ type: "tcp-handshake", durationMs: 900, currentMa: AIR780_ATTACH_SCAN_MA + 40 });
      this.addBurstTrain("tcp-tx", 3, 1.2);
    } else if (cmd.startsWith("AT+MCONNECT=")) {
      this.addPowerEvent({ type: "mqtt-connect", durationMs: 700, currentMa: AIR780_ATTACH_SCAN_MA + 50 });
      this.addBurstTrain("mqtt-tx", 4, 1.1);
    } else if (cmd.startsWith("AT+MSUB=")) {
      this.addPowerEvent({ type: "mqtt-sub", durationMs: 380, currentMa: AIR780_RX_MA });
      this.addBurstTrain("sub-ack", 2, 0.9);
    } else if (cmd.startsWith("AT+MPUB=")) {
      this.addPowerEvent({ type: "mqtt-pub", durationMs: 460, currentMa: AIR780_RX_MA + 30 });
      this.addBurstTrain("pub-tx", Math.max(2, Math.ceil(cmd.length / 22)), 1.4);
    } else if (cmd === "AT+MDISCONNECT" || cmd === "AT+MIPCLOSE") {
      this.addPowerEvent({ type: "close", durationMs: 220, currentMa: 80 });
    } else {
      this.addPowerEvent({ type: "at", durationMs: 80, currentMa: AIR780_RX_MA });
    }
  }

  addBurstTrain(type, count, spacingMs) {
    for (let i = 0; i < count; i += 1) {
      this.addPowerEvent({
        type,
        delayMs: i * spacingMs,
        durationMs: 0.58,
        currentMa: AIR780_DEFAULT_TX_PEAK_MA + Math.min(120, i * 18),
        glitchMv: 70 + Math.min(80, i * 8),
      });
    }
  }

  onLine(line) {
    const cmd = line.replace(/\r/g, "").trim();
    if (!cmd) {
      return;
    }
    this.log(`USART0 TX -> ${cmd}`);
    this.commandPower(cmd);
    if (!this.powered) {
      return;
    }
    if (!this.supplyOk()) {
      this.state = "BROWNOUT";
      this.rxQueue = [];
      this.pendingResponses = [];
      this.log("Air780 brownout: VLTE below model threshold");
      return;
    }

    if (cmd === "AT") {
      this.scheduleResponse(30, "\r\nOK\r\n", { state: "READY", protocolStep: "AT READY" });
    } else if (cmd === "AT+CEREG?") {
      this.protocolStep = "CEREG QUERY";
      if (this.failAttach) {
        this.registered = false;
        this.scheduleResponse(850, "\r\n+CEREG: 0,2\r\n\r\nOK\r\n", {
          state: "CEREG SEARCH",
          protocolStep: "NETWORK SEARCH",
        });
      } else {
        this.scheduleResponse(850, "\r\n+CEREG: 0,5\r\n\r\nOK\r\n", {
          state: "CEREG OK",
          protocolStep: "REGISTERED",
          apply: () => {
            this.registered = true;
          },
        });
      }
    } else if (cmd === "AT+CGATT?") {
      this.protocolStep = "CGATT QUERY";
      if (this.failAttach || !this.registered) {
        this.scheduleResponse(500, "\r\n+CGATT: 0\r\n\r\nOK\r\n", {
          state: "PDP DETACHED",
          protocolStep: "ATTACH WAIT",
        });
      } else {
        this.scheduleResponse(500, "\r\n+CGATT: 1\r\n\r\nOK\r\n", {
          state: "PDP ATTACHED",
          protocolStep: "PDP ACTIVE",
          apply: () => {
            this.attached = true;
            this.pdpActive = true;
          },
        });
      }
    } else if (cmd.startsWith("AT+MCONFIG=")) {
      this.scheduleResponse(120, "\r\nOK\r\n", {
        state: "MQTT CONFIG",
        protocolStep: "MQTT CONFIGURED",
        apply: () => {
          this.mqttConfigured = true;
        },
      });
    } else if (cmd.startsWith("AT+MIPSTART=")) {
      this.protocolStep = "TCP SYN";
      if (this.failAttach || !this.pdpActive) {
        this.scheduleResponse(900, "\r\nCONNECT FAIL\r\n", {
          state: "TCP FAIL",
          protocolStep: "TCP CLOSED",
        });
      } else {
        this.scheduleResponse(900, "\r\nCONNECT OK\r\n", {
          state: "TCP OK",
          protocolStep: "TCP CONNECTED",
          apply: () => {
            this.tcpConnected = true;
          },
        });
      }
    } else if (cmd.startsWith("AT+MCONNECT=")) {
      this.protocolStep = "MQTT CONNECT";
      if (this.failMqtt || !this.tcpConnected || !this.mqttConfigured) {
        this.scheduleResponse(700, "\r\nERROR\r\n", {
          state: "MQTT FAIL",
          protocolStep: "MQTT CLOSED",
        });
      } else {
        this.scheduleResponse(700, "\r\nCONNACK OK\r\n", {
          state: "MQTT OK",
          protocolStep: "MQTT CONNECTED",
          apply: () => {
            this.mqttConnected = true;
          },
        });
      }
    } else if (cmd.startsWith("AT+MSUB=")) {
      const topic = cmd.includes("/cmd") ? "epaper2/cmd" : cmd.includes("/rx") ? "epaper2/rx" : "unknown";
      if (!this.mqttConnected) {
        this.scheduleResponse(180, "\r\nERROR\r\n", { state: "SUB FAIL", protocolStep: "MQTT NOT CONNECTED" });
        return;
      }
      this.protocolStep = "MQTT SUBSCRIBE";
      this.scheduleResponse(160, "\r\nOK\r\n", {
        state: "SUB OK",
        protocolStep: `SUB ${topic}`,
        apply: () => {
          this.subscribedTopics.add(topic);
        },
      });
      if (topic === "epaper2/cmd") {
        this.scheduleResponse(900, `+MSUB: "epaper2/cmd",${this.datePayload.length} byte,${this.datePayload}\r\n`, {
          protocolStep: "MQTT DOWNLINK",
        });
      } else if (topic === "epaper2/rx") {
        this.scheduleResponse(900, `+MSUB: "epaper2/rx",${this.rxMessage.length} byte,${this.rxMessage}\r\n`, {
          protocolStep: "MQTT DOWNLINK",
        });
      }
    } else if (cmd.startsWith("AT+MPUB=")) {
      this.protocolStep = "MQTT PUBLISH";
      this.scheduleResponse(this.mqttConnected ? 220 : 120, this.mqttConnected ? "\r\nOK\r\n" : "\r\nERROR\r\n", {
        state: this.mqttConnected ? "PUB OK" : "PUB FAIL",
        protocolStep: this.mqttConnected ? "MQTT UPLOAD" : "MQTT NOT CONNECTED",
      });
    } else if (cmd === "AT+MDISCONNECT" || cmd === "AT+MIPCLOSE") {
      this.scheduleResponse(180, "\r\nOK\r\n", {
        state: cmd === "AT+MIPCLOSE" ? "CLOSED" : "MQTT CLOSED",
        protocolStep: cmd === "AT+MIPCLOSE" ? "TCP CLOSED" : "MQTT DISCONNECT",
        apply: () => {
          this.mqttConnected = false;
          if (cmd === "AT+MIPCLOSE") {
            this.tcpConnected = false;
          }
        },
      });
    } else {
      this.scheduleResponse(80, "\r\nOK\r\n", { state: "READY", protocolStep: "AT OK" });
    }
  }

  pump(maxBytes = 2) {
    if (this.powered && !this.supplyOk()) {
      this.state = "BROWNOUT";
      this.rxQueue = [];
      this.pendingResponses = [];
      return;
    }
    this.flushScheduledResponses();
    let sent = 0;
    while (sent < maxBytes && this.rxQueue.length > 0) {
      if (!this.usart.rxEnable || this.usart.rxBusy) {
        break;
      }
      if (this.cpu.data[usart0Config.UCSRA] & USART_RXC) {
        break;
      }
      const value = this.rxQueue.shift();
      if (this.usart.writeByte(value) === false) {
        this.rxQueue.unshift(value);
        break;
      }
      sent += 1;
    }
  }

  summary() {
    return {
      state: this.state,
      protocolStep: this.protocolStep,
      powered: this.powered,
      queued: this.rxQueue.length,
      pendingResponses: this.pendingResponses.length,
      registered: this.registered,
      attached: this.attached,
      pdpActive: this.pdpActive,
      tcpConnected: this.tcpConnected,
      mqttConfigured: this.mqttConfigured,
      mqttConnected: this.mqttConnected,
      topics: Array.from(this.subscribedTopics),
    };
  }
}

class PowerReservoirModel {
  constructor({ getTimeMs = monotonicNow }) {
    this.getTimeMs = getTimeMs;
    this.batteryMv = 3600;
    this.batteryCount = ER14505_DEFAULT_COUNT;
    this.internalResistanceMohm = 240;
    this.temperatureC = 25;
    this.continuousLimitMa = ER14505_DEFAULT_CONTINUOUS_LIMIT_MA;
    this.pulseLimitMa = ER14505_DEFAULT_PULSE_LIMIT_MA;
    this.airPulseMa = AIR780_DEFAULT_TX_PEAK_MA;
    this.airSustainMa = AIR780_IDLE_MA;
    this.txPulseMs = AIR780_DEFAULT_TX_PULSE_MS;
    this.avrActiveMa = AVR_ACTIVE_DEFAULT_MA;
    this.avrSleepUa = AVR_SLEEP_DEFAULT_UA;
    this.boardQuiescentUa = BOARD_QUIESCENT_DEFAULT_UA;
    this.avrSleeping = false;
    this.unitCapacitanceF = SUPERCAP_DEFAULT_F;
    this.supercapCount = SUPERCAP_DEFAULT_COUNT;
    this.unitChargeOhms = SUPERCAP_DEFAULT_CHARGE_OHMS;
    this.chargeResistorCount = SUPERCAP_DEFAULT_CHARGE_RESISTORS;
    this.capacitanceF = this.effectiveCapacitanceF();
    this.chargeOhms = this.effectiveChargeOhms();
    this.supercapEsrMohm = SUPERCAP_DEFAULT_ESR_MOHM;
    this.supercapLeakageUa = SUPERCAP_DEFAULT_LEAKAGE_UA;
    this.diodeDropMv = SUPERCAP_DEFAULT_DIODE_MV;
    this.switchResistanceMohm = SUPPLY_SWITCH_DEFAULT_MOHM;
    this.burstGlitchMv = LTE_BURST_DEFAULT_GLITCH_MV;
    this.measurementNoiseMv = SUPPLY_MEASUREMENT_DEFAULT_NOISE_MV;
    this.capMv = 3600;
    this.lastTimeMs = this.getTimeMs();
    this.airOnSinceMs = null;
    this.airOn = false;
    this.loadEvents = [];
    this.lastActiveEvents = [];
    this.vlteMv = 3600;
    this.batteryLoadedMv = 3600;
    this.idealVlteMv = 3600;
    this.v3v3Mv = 3300;
    this.chargeCurrentMa = 0;
    this.batteryCurrentMa = 0;
    this.supercapCurrentMa = 0;
    this.loadCurrentMa = 0;
    this.glitchMv = 0;
    this.eventCurrentMa = 0;
    this.eventGlitchMv = 0;
    this.capSupplying = false;
    this.externalTrace = null;
    this.externalTraceStartMs = 0;
    this.externalTraceMeta = null;
    this.airWarn = false;
    this.airBrownout = false;
    this.airUndervoltageMs = 0;
    this.airCriticalMs = 0;
  }

  configure({
    batteryMv,
    batteryCount,
    internalResistanceMohm,
    temperatureC,
    continuousLimitMa,
    pulseLimitMa,
    airPulseMa,
    airSustainMa,
    txPulseMs,
    avrActiveMa,
    avrSleepUa,
    boardQuiescentUa,
    avrSleeping,
    capacitanceF,
    unitCapacitanceF,
    supercapCount,
    chargeOhms,
    unitChargeOhms,
    chargeResistorCount,
    supercapEsrMohm,
    supercapLeakageUa,
    diodeDropMv,
    switchResistanceMohm,
    burstGlitchMv,
    measurementNoiseMv,
  } = {}) {
    this.step();
    if (Number.isFinite(Number(batteryMv))) {
      const oldBattery = this.batteryMv;
      this.batteryMv = Number(batteryMv);
      if (this.capMv > this.batteryMv || Math.abs(this.capMv - oldBattery) < 1) {
        this.capMv = Math.min(this.capMv, this.batteryMv);
      }
    }
    if (Number.isFinite(Number(batteryCount))) {
      this.batteryCount = Math.max(1, Math.round(Number(batteryCount)));
    }
    if (Number.isFinite(Number(internalResistanceMohm))) {
      this.internalResistanceMohm = Math.max(0, Number(internalResistanceMohm));
    }
    if (Number.isFinite(Number(temperatureC))) {
      this.temperatureC = clamp(Number(temperatureC), -60, 85);
    }
    if (Number.isFinite(Number(continuousLimitMa))) {
      this.continuousLimitMa = Math.max(0, Number(continuousLimitMa));
    }
    if (Number.isFinite(Number(pulseLimitMa))) {
      this.pulseLimitMa = Math.max(0, Number(pulseLimitMa));
    }
    if (Number.isFinite(Number(airPulseMa))) {
      this.airPulseMa = Math.max(0, Number(airPulseMa));
    }
    if (Number.isFinite(Number(airSustainMa))) {
      this.airSustainMa = Math.max(0, Number(airSustainMa));
    }
    if (Number.isFinite(Number(txPulseMs))) {
      this.txPulseMs = clamp(Number(txPulseMs), 0.05, AIR780_TX_PERIOD_MS);
    }
    if (Number.isFinite(Number(avrActiveMa))) {
      this.avrActiveMa = Math.max(0, Number(avrActiveMa));
    }
    if (Number.isFinite(Number(avrSleepUa))) {
      this.avrSleepUa = Math.max(0, Number(avrSleepUa));
    }
    if (Number.isFinite(Number(boardQuiescentUa))) {
      this.boardQuiescentUa = Math.max(0, Number(boardQuiescentUa));
    }
    if (typeof avrSleeping === "boolean") {
      this.avrSleeping = avrSleeping;
    }
    if (Number.isFinite(Number(unitCapacitanceF ?? capacitanceF))) {
      this.unitCapacitanceF = Math.max(0.01, Number(unitCapacitanceF ?? capacitanceF));
    }
    if (Number.isFinite(Number(supercapCount))) {
      this.supercapCount = Math.max(1, Math.round(Number(supercapCount)));
    }
    if (Number.isFinite(Number(unitChargeOhms ?? chargeOhms))) {
      this.unitChargeOhms = Math.max(0.1, Number(unitChargeOhms ?? chargeOhms));
    }
    if (Number.isFinite(Number(chargeResistorCount))) {
      this.chargeResistorCount = Math.max(1, Math.round(Number(chargeResistorCount)));
    }
    if (Number.isFinite(Number(supercapEsrMohm))) {
      this.supercapEsrMohm = Math.max(0, Number(supercapEsrMohm));
    }
    if (Number.isFinite(Number(supercapLeakageUa))) {
      this.supercapLeakageUa = Math.max(0, Number(supercapLeakageUa));
    }
    if (Number.isFinite(Number(diodeDropMv))) {
      this.diodeDropMv = Math.max(0, Number(diodeDropMv));
    }
    if (Number.isFinite(Number(switchResistanceMohm))) {
      this.switchResistanceMohm = Math.max(0, Number(switchResistanceMohm));
    }
    if (Number.isFinite(Number(burstGlitchMv))) {
      this.burstGlitchMv = Math.max(0, Number(burstGlitchMv));
    }
    if (Number.isFinite(Number(measurementNoiseMv))) {
      this.measurementNoiseMv = Math.max(0, Number(measurementNoiseMv));
    }
    this.capacitanceF = this.effectiveCapacitanceF();
    this.chargeOhms = this.effectiveChargeOhms();
    this.step(0);
  }

  effectiveCapacitanceF() {
    return this.unitCapacitanceF * this.supercapCount;
  }

  effectiveChargeOhms() {
    return this.unitChargeOhms / this.chargeResistorCount;
  }

  effectiveBatteryResistanceMohm() {
    return this.internalResistanceMohm / Math.max(1, this.batteryCount);
  }

  effectiveContinuousLimitMa() {
    return this.continuousLimitMa * Math.max(1, this.batteryCount);
  }

  effectivePulseLimitMa() {
    return this.pulseLimitMa * Math.max(1, this.batteryCount);
  }

  setAirOn(on) {
    this.step();
    if (this.airOn === on) {
      return;
    }
    this.airOn = on;
    this.airOnSinceMs = on ? this.getTimeMs() : null;
    if (!on) {
      this.loadEvents = [];
      this.lastActiveEvents = [];
    }
    this.step(0);
  }

  setAvrSleeping(sleeping) {
    this.avrSleeping = !!sleeping;
  }

  clearExternalTrace() {
    this.externalTrace = null;
    this.externalTraceMeta = null;
  }

  setExternalTrace(trace, meta = {}) {
    if (!trace || !Array.isArray(trace.tMs) || trace.tMs.length < 2) {
      this.clearExternalTrace();
      return;
    }
    this.externalTrace = trace;
    this.externalTraceStartMs = this.getTimeMs();
    this.externalTraceMeta = meta;
  }

  traceValue(trace, key, index, ratio) {
    const values = trace[key];
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    const left = Number(values[Math.min(index, values.length - 1)]);
    const right = Number(values[Math.min(index + 1, values.length - 1)]);
    return left + (right - left) * ratio;
  }

  applyExternalTrace(now = this.getTimeMs()) {
    const trace = this.externalTrace;
    if (!trace?.tMs?.length) {
      return false;
    }
    const elapsed = now - this.externalTraceStartMs;
    const times = trace.tMs;
    if (elapsed < 0 || elapsed > Number(times[times.length - 1])) {
      this.clearExternalTrace();
      return false;
    }
    let index = 0;
    while (index < times.length - 2 && times[index + 1] < elapsed) {
      index += 1;
    }
    const leftT = Number(times[index]);
    const rightT = Number(times[index + 1]);
    const ratio = rightT > leftT ? (elapsed - leftT) / (rightT - leftT) : 0;
    const batteryLoadedMv = this.traceValue(trace, "batteryLoadedMv", index, ratio);
    const vlteMv = this.traceValue(trace, "vlteMv", index, ratio);
    const supercapMv = this.traceValue(trace, "supercapMv", index, ratio);
    const v3v3Mv = this.traceValue(trace, "v3v3Mv", index, ratio);
    const batteryCurrentMa = this.traceValue(trace, "batteryCurrentMa", index, ratio);
    const supercapCurrentMa = this.traceValue(trace, "supercapCurrentMa", index, ratio);
    const loadCurrentMa = this.traceValue(trace, "loadCurrentMa", index, ratio);

    if (batteryLoadedMv !== null) {
      this.batteryLoadedMv = Math.round(Math.max(0, batteryLoadedMv));
    }
    if (vlteMv !== null) {
      this.vlteMv = Math.round(Math.max(0, vlteMv));
      this.idealVlteMv = this.vlteMv;
    }
    if (supercapMv !== null) {
      this.capMv = clamp(supercapMv, 0, this.batteryMv);
    }
    if (v3v3Mv !== null) {
      this.v3v3Mv = Math.round(clamp(v3v3Mv, 0, 3300));
    }
    if (batteryCurrentMa !== null) {
      this.batteryCurrentMa = Math.round(Math.max(0, batteryCurrentMa));
    }
    if (supercapCurrentMa !== null) {
      this.supercapCurrentMa = Math.round(Math.max(0, supercapCurrentMa));
      this.capSupplying = this.supercapCurrentMa > 0;
    }
    if (loadCurrentMa !== null) {
      this.loadCurrentMa = Math.round(Math.max(0, loadCurrentMa));
    }
    return true;
  }

  simulinkRequest({ horizonMs = 8000, stepMs = 1 } = {}) {
    this.step();
    const now = this.getTimeMs();
    const step = clamp(Number(stepMs) || 1, 0.1, 20);
    const horizon = clamp(Number(horizonMs) || 8000, 100, 60000);
    const count = Math.floor(horizon / step) + 1;
    const tMs = [];
    const loadMa = [];
    for (let i = 0; i < count; i += 1) {
      const start = now + i * step;
      tMs.push(Math.round(i * step * 1000) / 1000);
      loadMa.push(this.averageLoadMa(start, start + step));
    }
    return {
      tMs,
      loadMa,
      stepMs: step,
      horizonMs: horizon,
      batteryMv: this.batteryMv,
      capInitialMv: this.capMv,
      batteryInternalMohm: this.effectiveBatteryResistanceMohm(),
      continuousLimitMa: this.effectiveContinuousLimitMa() * this.temperatureDerating(),
      pulseLimitMa: this.effectivePulseLimitMa() * this.temperatureDerating(),
      pulseThresholdMa: this.airSustainMa + this.avrActiveMa + 20,
      capacitanceF: this.capacitanceF,
      chargeOhms: this.chargeOhms,
      supercapEsrMohm: this.supercapEsrMohm,
      supercapLeakageUa: this.supercapLeakageUa,
      diodeDropMv: this.diodeDropMv,
      switchResistanceMohm: this.switchResistanceMohm,
      airOn: this.airOn,
      ldoDropoutMv: LDO_DROPOUT_MV,
    };
  }

  addLoadEvent({
    type = "event",
    delayMs = 0,
    durationMs = 1,
    currentMa = 0,
    glitchMv = 0,
    bitRate = null,
    bytes = 0,
  } = {}) {
    const startMs = this.getTimeMs() + Math.max(0, Number(delayMs) || 0);
    const duration = Math.max(0.001, Number(durationMs) || 0.001);
    this.loadEvents.push({
      type,
      startMs,
      endMs: startMs + duration,
      durationMs: duration,
      currentMa: Math.max(0, Number(currentMa) || 0),
      glitchMv: Math.max(0, Number(glitchMv) || 0),
      bitRate,
      bytes,
    });
    this.pruneLoadEvents(startMs);
  }

  pruneLoadEvents(now = this.getTimeMs()) {
    const keepAfter = now - 2000;
    this.loadEvents = this.loadEvents.filter((event) => event.endMs >= keepAfter);
  }

  activeLoadEvents(now = this.getTimeMs()) {
    this.pruneLoadEvents(now);
    return this.loadEvents.filter((event) => event.startMs <= now && event.endMs > now);
  }

  eventLoadMa(now = this.getTimeMs()) {
    if (!this.airOn) {
      this.lastActiveEvents = [];
      return 0;
    }
    const active = this.activeLoadEvents(now);
    this.lastActiveEvents = active;
    return active.reduce((sum, event) => sum + event.currentMa, 0);
  }

  currentLoadMa() {
    const avrMa = this.avrSleeping ? this.avrSleepUa / 1000 : this.avrActiveMa;
    const boardMa = this.boardQuiescentUa / 1000;
    if (!this.airOn) {
      return avrMa + boardMa;
    }
    return avrMa + boardMa + this.airSustainMa + this.eventLoadMa();
  }

  pulseOverlapMs(startMs, endMs) {
    if (!this.airOn || endMs <= startMs) {
      return 0;
    }
    const origin = this.airOnSinceMs ?? startMs;
    const pulseWidth = Math.min(this.txPulseMs, AIR780_TX_PERIOD_MS);
    const firstIndex = Math.floor((startMs - origin) / AIR780_TX_PERIOD_MS) - 1;
    const lastIndex = Math.floor((endMs - origin) / AIR780_TX_PERIOD_MS) + 1;
    let overlap = 0;
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const pulseStart = origin + index * AIR780_TX_PERIOD_MS;
      const pulseEnd = pulseStart + pulseWidth;
      overlap += Math.max(0, Math.min(endMs, pulseEnd) - Math.max(startMs, pulseStart));
    }
    return overlap;
  }

  averageLoadMa(startMs, endMs) {
    if (!this.airOn || endMs <= startMs) {
      const avrMa = this.avrSleeping ? this.avrSleepUa / 1000 : this.avrActiveMa;
      return avrMa + this.boardQuiescentUa / 1000;
    }
    const durationMs = Math.max(1, endMs - startMs);
    const eventMaMs = this.loadEvents.reduce((sum, event) => {
      const overlap = Math.max(0, Math.min(endMs, event.endMs) - Math.max(startMs, event.startMs));
      return sum + overlap * event.currentMa;
    }, 0);
    const avrMa = this.avrSleeping ? this.avrSleepUa / 1000 : this.avrActiveMa;
    return avrMa + this.boardQuiescentUa / 1000 + this.airSustainMa + eventMaMs / durationMs;
  }

  isTxPulseWindow(now = this.getTimeMs()) {
    if (!this.airOn) {
      return false;
    }
    const elapsedMs = now - (this.airOnSinceMs ?? now);
    return elapsedMs % AIR780_TX_PERIOD_MS < this.txPulseMs;
  }

  temperatureDerating() {
    if (this.temperatureC <= -40) {
      return 0.28;
    }
    if (this.temperatureC < 0) {
      return mix(0.35, 0.72, (this.temperatureC + 40) / 40);
    }
    if (this.temperatureC < 20) {
      return mix(0.72, 1.0, this.temperatureC / 20);
    }
    if (this.temperatureC > 70) {
      return mix(1.0, 0.82, (this.temperatureC - 70) / 15);
    }
    return 1.0;
  }

  batteryLimitMa(loadMa, pulseWindow) {
    if (loadMa <= 0) {
      return 0;
    }
    const nominal = pulseWindow ? this.effectivePulseLimitMa() : this.effectiveContinuousLimitMa();
    return nominal * this.temperatureDerating();
  }

  deterministicNoiseMv(now = this.getTimeMs()) {
    if (this.measurementNoiseMv <= 0) {
      return 0;
    }
    const salt = Math.floor(now * 0.73);
    return (pixelNoise(salt, 17, 91) * 2 - 1) * this.measurementNoiseMv;
  }

  burstGlitch(now = this.getTimeMs()) {
    const eventGlitch = this.activeLoadEvents(now).reduce((peak, event) => Math.max(peak, event.glitchMv), 0);
    return eventGlitch;
  }

  sourceCurrentMa(sourceMv, railMv, resistanceMohm, limitMa = Number.POSITIVE_INFINITY) {
    if (sourceMv <= railMv) {
      return 0;
    }
    if (resistanceMohm <= 0) {
      return Number.isFinite(limitMa) ? limitMa : 1_000_000;
    }
    return Math.min(limitMa, ((sourceMv - railMv) * 1000) / resistanceMohm);
  }

  solveLoadRail(loadMa, batteryLimitMa) {
    if (loadMa <= 0) {
      return {
        railMv: this.capMv,
        batteryLoadMa: 0,
        capLoadMa: 0,
      };
    }
    if (!this.airOn) {
      const batteryLoadMa = Math.min(loadMa, batteryLimitMa);
      return {
        railMv: Math.max(0, this.batteryMv - (batteryLoadMa * this.effectiveBatteryResistanceMohm()) / 1000),
        batteryLoadMa,
        capLoadMa: 0,
      };
    }
    const batteryResistanceMohm = this.effectiveBatteryResistanceMohm() + this.switchResistanceMohm;
    const capSourceMv = Math.max(0, this.capMv - this.diodeDropMv);
    const capResistanceMohm = Math.max(1, this.supercapEsrMohm + this.switchResistanceMohm);
    const batteryCurrentAt = (railMv) =>
      this.sourceCurrentMa(this.batteryMv, railMv, Math.max(1, batteryResistanceMohm), batteryLimitMa);
    const capCurrentAt = (railMv) => this.sourceCurrentMa(capSourceMv, railMv, capResistanceMohm);

    let low = 0;
    let high = Math.max(this.batteryMv, capSourceMv);
    for (let i = 0; i < 36; i += 1) {
      const mid = (low + high) / 2;
      const totalCurrentMa = batteryCurrentAt(mid) + capCurrentAt(mid);
      if (totalCurrentMa >= loadMa) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const railMv = low;
    const batteryLoadMa = Math.min(loadMa, batteryCurrentAt(railMv));
    const capLoadMa = Math.max(0, Math.min(loadMa - batteryLoadMa, capCurrentAt(railMv)));
    return {
      railMv,
      batteryLoadMa,
      capLoadMa,
    };
  }

  step(forcedDtSeconds = null) {
    const now = this.getTimeMs();
    const dtSeconds =
      forcedDtSeconds === null
        ? clamp((now - this.lastTimeMs) / 1000, 0, 0.25)
        : Math.max(0, forcedDtSeconds);
    this.lastTimeMs = now;

    const startMs = now - dtSeconds * 1000;
    const loadMa = this.currentLoadMa();
    const energyLoadMa = dtSeconds > 0 ? this.averageLoadMa(startMs, now) : loadMa;
    const pulseWindow = this.isTxPulseWindow(now);
    const batteryLimitMa = this.batteryLimitMa(loadMa, pulseWindow || this.lastActiveEvents.length > 0);
    let railSolution = this.solveLoadRail(loadMa, batteryLimitMa);
    const remainingBatteryBudgetMa = this.airOn
      ? Math.max(0, batteryLimitMa - railSolution.batteryLoadMa)
      : this.effectiveContinuousLimitMa() * this.temperatureDerating();
    const requestedChargeMa = Math.max(0, (this.batteryMv - this.capMv) / this.chargeOhms);
    const chargeMa = Math.min(requestedChargeMa, remainingBatteryBudgetMa);
    const leakageMa = this.supercapLeakageUa / 1000;
    if (dtSeconds > 0) {
      const energyPulseWindow = this.pulseOverlapMs(startMs, now) > 0 || this.loadEvents.some((event) => event.startMs < now && event.endMs > startMs);
      const energyBatteryLimitMa = this.batteryLimitMa(energyLoadMa, energyPulseWindow);
      const energyRailSolution = this.solveLoadRail(energyLoadMa, energyBatteryLimitMa);
      const netCapMa = chargeMa - energyRailSolution.capLoadMa - leakageMa;
      this.capMv += (netCapMa / 1000 / this.capacitanceF) * dtSeconds * 1000;
    }
    this.capMv = clamp(this.capMv, 0, this.batteryMv);
    railSolution = this.solveLoadRail(loadMa, batteryLimitMa);

    const batteryTerminalMv =
      this.batteryMv - ((railSolution.batteryLoadMa + chargeMa) * this.effectiveBatteryResistanceMohm()) / 1000;
    const idealVlteMv = this.airOn ? railSolution.railMv : this.capMv;
    const glitchMv = this.burstGlitch(now);
    const noiseMv = this.deterministicNoiseMv(now);
    this.idealVlteMv = Math.round(idealVlteMv);
    this.glitchMv = Math.round(glitchMv);
    this.eventCurrentMa = Math.round(this.lastActiveEvents.reduce((sum, event) => sum + event.currentMa, 0));
    this.eventGlitchMv = Math.round(this.lastActiveEvents.reduce((peak, event) => Math.max(peak, event.glitchMv), 0));
    this.vlteMv = Math.round(Math.max(0, idealVlteMv - glitchMv + noiseMv));
    this.batteryLoadedMv = Math.round(Math.max(0, batteryTerminalMv));
    this.v3v3Mv = Math.round(clamp(batteryTerminalMv - LDO_DROPOUT_MV + noiseMv * 0.35, 0, 3300));
    this.chargeCurrentMa = Math.round(chargeMa);
    this.batteryCurrentMa = Math.round(railSolution.batteryLoadMa + chargeMa);
    this.supercapCurrentMa = Math.round(railSolution.capLoadMa);
    this.loadCurrentMa = Math.round(loadMa);
    this.capSupplying = railSolution.capLoadMa > 0;
    this.applyExternalTrace(now);
    this.updateAirSupplyState(dtSeconds * 1000);
  }

  updateAirSupplyState(dtMs) {
    if (!this.airOn) {
      this.airWarn = false;
      this.airBrownout = false;
      this.airUndervoltageMs = 0;
      this.airCriticalMs = 0;
      return;
    }
    this.airWarn = this.vlteMv < AIR780_WARN_MV;
    if (this.vlteMv < AIR780_BROWNOUT_MV) {
      this.airUndervoltageMs += dtMs;
    } else {
      this.airUndervoltageMs = Math.max(0, this.airUndervoltageMs - dtMs * 4);
    }
    if (this.vlteMv < AIR780_CRITICAL_MV) {
      this.airCriticalMs += dtMs;
    } else {
      this.airCriticalMs = 0;
    }
    this.airBrownout =
      this.airCriticalMs >= AIR780_CRITICAL_HOLD_MS ||
      this.airUndervoltageMs >= AIR780_BROWNOUT_HOLD_MS;
  }

  snapshot() {
    this.step();
    const now = this.getTimeMs();
    const pulseWindow = this.activeLoadEvents(now).some((event) => event.currentMa >= this.airPulseMa * 0.5);
    const pulseRail = this.solveLoadRail(Math.max(this.airSustainMa, this.airPulseMa), this.batteryLimitMa(this.airPulseMa, true));
    const predictedPulseIdealMv = Math.round(this.airOn ? pulseRail.railMv : this.capMv);
    const predictedPulseVlteMv = Math.round(Math.max(0, predictedPulseIdealMv - this.burstGlitchMv));
    return {
      batteryMv: Math.round(this.batteryMv),
      batteryCount: this.batteryCount,
      batteryLoadedMv: this.batteryLoadedMv,
      v3v3Mv: this.v3v3Mv,
      vlteMv: this.vlteMv,
      supercapMv: Math.round(this.capMv),
      supercapF: this.capacitanceF,
      unitSupercapF: this.unitCapacitanceF,
      supercapCount: this.supercapCount,
      chargeOhms: this.chargeOhms,
      unitChargeOhms: this.unitChargeOhms,
      chargeResistorCount: this.chargeResistorCount,
      supercapEsrMohm: this.supercapEsrMohm,
      supercapLeakageUa: this.supercapLeakageUa,
      diodeDropMv: this.diodeDropMv,
      switchResistanceMohm: this.switchResistanceMohm,
      burstGlitchMv: this.burstGlitchMv,
      measurementNoiseMv: this.measurementNoiseMv,
      internalResistanceMohm: this.internalResistanceMohm,
      effectiveInternalResistanceMohm: this.effectiveBatteryResistanceMohm(),
      temperatureC: this.temperatureC,
      continuousLimitMa: this.continuousLimitMa,
      pulseLimitMa: this.pulseLimitMa,
      effectiveContinuousLimitMa: this.effectiveContinuousLimitMa(),
      effectivePulseLimitMa: this.effectivePulseLimitMa(),
      temperatureDerating: this.temperatureDerating(),
      airPulseMa: this.airPulseMa,
      airSustainMa: this.airSustainMa,
      txPulseMs: this.txPulseMs,
      avrActiveMa: this.avrActiveMa,
      avrSleepUa: this.avrSleepUa,
      boardQuiescentUa: this.boardQuiescentUa,
      avrSleeping: this.avrSleeping,
      txPeriodMs: AIR780_TX_PERIOD_MS,
      txPulseWindow: pulseWindow,
      airElapsedMs: this.airOn ? now - (this.airOnSinceMs ?? now) : null,
      ldoDropoutMv: LDO_DROPOUT_MV,
      chargeCurrentMa: this.chargeCurrentMa,
      batteryCurrentMa: this.batteryCurrentMa,
      supercapCurrentMa: this.supercapCurrentMa,
      loadCurrentMa: this.loadCurrentMa,
      eventCurrentMa: this.eventCurrentMa,
      eventGlitchMv: this.eventGlitchMv,
      activeEvents: this.lastActiveEvents.map((event) => event.type),
      idealVlteMv: this.idealVlteMv,
      plantSource: this.externalTrace ? "Simulink" : "JS",
      externalTraceRemainingMs: this.externalTrace
        ? Math.max(0, Number(this.externalTrace.tMs[this.externalTrace.tMs.length - 1]) - (now - this.externalTraceStartMs))
        : 0,
      externalTraceMeta: this.externalTraceMeta,
      predictedPulseIdealMv,
      predictedPulseVlteMv,
      glitchMv: this.glitchMv,
      capSupplying: this.capSupplying,
      airWarn: this.airWarn,
      airBrownout: this.airBrownout,
      airUndervoltageMs: Math.round(this.airUndervoltageMs),
      airCriticalMs: Math.round(this.airCriticalMs),
      airWarnMv: AIR780_WARN_MV,
      airBrownoutMv: AIR780_BROWNOUT_MV,
      airCriticalMv: AIR780_CRITICAL_MV,
      airSupplyOk: !this.airOn || !this.airBrownout,
    };
  }
}

class EpdControllerModel {
  constructor({ log, setBusyPin, getCycles, onFrame }) {
    this.log = log;
    this.setBusyPin = setBusyPin;
    this.getCycles = getCycles;
    this.onFrame = onFrame;
    this.width = 128;
    this.height = 296;
    this.bytesPerRow = this.width / 8;
    this.byteLength = this.bytesPerRow * this.height;
    this.oldRam = new Uint8Array(this.byteLength);
    this.newRam = new Uint8Array(this.byteLength);
    this.visibleRam = new Uint8Array(this.byteLength);
    this.previousVisibleRam = new Uint8Array(this.byteLength);
    this.oldValid = new Uint8Array(this.byteLength);
    this.newValid = new Uint8Array(this.byteLength);
    this.visibleValid = new Uint8Array(this.byteLength);
    this.oldRam.fill(0xff);
    this.newRam.fill(0xff);
    this.visibleRam.fill(0xff);
    this.previousVisibleRam.fill(0xff);
    this.awake = false;
    this.busy = false;
    this.busyUntil = 0;
    this.refreshEffect = null;
    this.refreshSeq = 0;
    this.partialFault = false;
    this.lastPortB = 0;
    this.lastSck = false;
    this.lastRst = true;
    this.bitBuffer = 0;
    this.bitCount = 0;
    this.currentCommand = null;
    this.commandData = [];
    this.updateControl = 0;
    this.dataEntryMode = 0x03;
    this.lutMode = "unknown";
    this.borderWaveform = 0;
    this.partialPrepared = false;
    this.analogOn = false;
    this.memoryArea = {
      xStart: 0,
      xEnd: this.bytesPerRow - 1,
      yStart: 0,
      yEnd: this.height - 1,
    };
    this.ptrX = 0;
    this.ptrY = 0;
    this.spiBytes = 0;
    this.reset("power-up", false);
  }

  attach(portB) {
    portB.addListener((value, oldValue) => this.onPortB(value, oldValue));
  }

  reset(reason, notify = true, clearRam = true) {
    this.awake = true;
    if (clearRam) {
      this.invalidateRam();
    }
    this.resetRegisters();
    this.log(`EPD reset (${reason}); old/new RAM ${clearRam ? "invalid" : "retained"}`);
    if (notify) {
      this.onFrame?.();
    }
  }

  softwareReset() {
    this.awake = true;
    this.resetRegisters();
    this.log("EPD SWRESET; registers reset, controller RAM retained");
    this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
    this.onFrame?.();
  }

  resetRegisters() {
    this.currentCommand = null;
    this.commandData = [];
    this.memoryArea = {
      xStart: 0,
      xEnd: this.bytesPerRow - 1,
      yStart: 0,
      yEnd: this.height - 1,
    };
    this.ptrX = 0;
    this.ptrY = 0;
    this.updateControl = 0;
    this.lutMode = "unknown";
    this.borderWaveform = 0;
    this.partialPrepared = false;
    this.analogOn = false;
  }

  invalidateRam() {
    this.oldValid.fill(0);
    this.newValid.fill(0);
  }

  onPortB(value) {
    const rst = !!(value & (1 << PIN.EPD_RST));
    const dc = !!(value & (1 << PIN.EPD_DC));
    const cs = !!(value & (1 << PIN.EPD_CS));
    const mosi = !!(value & (1 << PIN.EPD_MOSI));
    const sck = !!(value & (1 << PIN.EPD_SCK));

    if (!rst && this.lastRst) {
      this.awake = false;
      this.partialPrepared = false;
      this.analogOn = false;
      this.log("EPD RST low; controller held in reset, RAM retained while powered");
      this.onFrame?.();
    } else if (rst && !this.lastRst) {
      this.reset("RST rising edge", true, false);
    }
    this.lastRst = rst;

    if (cs) {
      this.bitBuffer = 0;
      this.bitCount = 0;
      this.lastSck = sck;
      this.lastPortB = value;
      return;
    }

    if (!this.lastSck && sck) {
      this.bitBuffer = ((this.bitBuffer << 1) | (mosi ? 1 : 0)) & 0xff;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.acceptByte(dc, this.bitBuffer);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }

    this.lastSck = sck;
    this.lastPortB = value;
  }

  acceptByte(isData, value) {
    this.spiBytes += 1;
    if (!isData) {
      this.startCommand(value);
      return;
    }
    this.acceptData(value);
  }

  startCommand(command) {
    this.currentCommand = command & 0xff;
    this.commandData = [];
    if (command === 0x12) {
      this.softwareReset();
      return;
    }
    if (command === 0x20) {
      this.masterActivation();
      return;
    }
    if (command === 0x24) {
      this.log("EPD RAM write start: new RAM (0x24)");
    } else if (command === 0x26) {
      this.log("EPD RAM write start: old/base RAM (0x26)");
    } else if (command === 0x10) {
      this.log("EPD deep-sleep command pending");
    }
  }

  acceptData(value) {
    if (this.currentCommand === null) {
      return;
    }
    if (this.currentCommand === 0x24 || this.currentCommand === 0x26) {
      this.writeRamByte(this.currentCommand, value);
      return;
    }
    this.commandData.push(value & 0xff);
    const expected = this.paramLength(this.currentCommand);
    if (expected >= 0 && this.commandData.length >= expected) {
      this.finishCommand(this.currentCommand, this.commandData);
    }
  }

  paramLength(command) {
    const lengths = {
      0x01: 3,
      0x03: 1,
      0x04: 3,
      0x10: 1,
      0x11: 1,
      0x21: 2,
      0x22: 1,
      0x2c: 1,
      0x3c: 1,
      0x3f: 1,
      0x44: 2,
      0x45: 4,
      0x4e: 1,
      0x4f: 2,
    };
    if (command === 0x32) {
      return 153;
    }
    if (command === 0x37) {
      return 10;
    }
    return Object.prototype.hasOwnProperty.call(lengths, command) ? lengths[command] : -1;
  }

  finishCommand(command, data) {
    switch (command) {
      case 0x10:
        this.sleep();
        break;
      case 0x22:
        this.updateControl = data[0] & 0xff;
        break;
      case 0x11:
        this.dataEntryMode = data[0] & 0xff;
        break;
      case 0x32:
        this.lutMode = this.detectLutMode(data);
        this.log(`EPD LUT loaded from host: ${this.lutMode}`);
        break;
      case 0x37:
        this.displayOption = Uint8Array.from(data);
        break;
      case 0x3c:
        this.borderWaveform = data[0] & 0xff;
        break;
      case 0x44:
        this.memoryArea.xStart = clamp(data[0], 0, this.bytesPerRow - 1);
        this.memoryArea.xEnd = clamp(data[1], 0, this.bytesPerRow - 1);
        break;
      case 0x45:
        this.memoryArea.yStart = clamp(data[0] | (data[1] << 8), 0, this.height - 1);
        this.memoryArea.yEnd = clamp(data[2] | (data[3] << 8), 0, this.height - 1);
        break;
      case 0x4e:
        this.ptrX = clamp(data[0], 0, this.bytesPerRow - 1);
        break;
      case 0x4f:
        this.ptrY = clamp(data[0] | (data[1] << 8), 0, this.height - 1);
        break;
      default:
        break;
    }
  }

  detectLutMode(data) {
    if (
      data.length >= 14 &&
      data[0] === 0x00 &&
      data[1] === 0x40 &&
      data[12] === 0x80 &&
      data[13] === 0x80
    ) {
      return "partial";
    }
    if (
      data.length >= 14 &&
      data[0] === 0x80 &&
      data[1] === 0x66 &&
      data[12] === 0x10 &&
      data[13] === 0x66
    ) {
      return "full";
    }
    return "custom";
  }

  writeRamByte(command, value) {
    const area = this.memoryArea;
    if (
      this.ptrX < area.xStart ||
      this.ptrX > area.xEnd ||
      this.ptrY < area.yStart ||
      this.ptrY > area.yEnd
    ) {
      this.ptrX = area.xStart;
      this.ptrY = area.yStart;
    }
    const index = this.ptrY * this.bytesPerRow + this.ptrX;
    if (index >= 0 && index < this.byteLength) {
      if (command === 0x24) {
        this.newRam[index] = value & 0xff;
        this.newValid[index] = 1;
      } else {
        this.oldRam[index] = value & 0xff;
        this.oldValid[index] = 1;
      }
    }
    this.advanceRamPointer();
  }

  advanceRamPointer() {
    const area = this.memoryArea;
    const xIncrement = (this.dataEntryMode & 0x01) !== 0;
    const yIncrement = (this.dataEntryMode & 0x02) !== 0;
    if (xIncrement) {
      this.ptrX += 1;
      if (this.ptrX > area.xEnd) {
        this.ptrX = area.xStart;
        this.ptrY += yIncrement ? 1 : -1;
      }
    } else {
      this.ptrX -= 1;
      if (this.ptrX < area.xStart) {
        this.ptrX = area.xEnd;
        this.ptrY += yIncrement ? 1 : -1;
      }
    }
    if (this.ptrY > area.yEnd) {
      this.ptrY = area.yStart;
    } else if (this.ptrY < area.yStart) {
      this.ptrY = area.yEnd;
    }
  }

  masterActivation() {
    const control = this.updateControl & 0xff;
    if (control === 0xc0) {
      this.analogOn = true;
      this.partialPrepared = this.lutMode === "partial";
      this.partialFault = false;
      this.log(
        this.partialPrepared
          ? "EPD Mode 2 partial setup: clock/analog enabled, glass unchanged"
          : "EPD 0xC0 activation without partial LUT; glass unchanged",
      );
      this.setBusy(true, EPD_PARTIAL_SETUP_CYCLES);
      this.onFrame?.();
      return;
    }
    if (control === 0x03) {
      this.analogOn = false;
      this.log("EPD clock/analog disabled; glass unchanged");
      this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
      this.onFrame?.();
      return;
    }
    if (control === 0x91 || control === 0xb1 || control === 0x99 || control === 0xb9) {
      this.log(`EPD update option 0x${control.toString(16)} loads LUT only; glass unchanged`);
      this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
      this.onFrame?.();
      return;
    }
    if (control === 0xc7 || control === 0xf7) {
      this.displayUpdate("full");
      return;
    }
    if (control === 0x0f || control === 0xcf || control === 0xff) {
      this.displayUpdate("partial");
      return;
    }
    this.log(`EPD master activation 0x${control.toString(16)} not modelled as image refresh`);
    this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
    this.onFrame?.();
  }

  displayUpdate(mode) {
    const partial = mode === "partial";
    const area = partial ? { ...this.memoryArea } : this.fullArea();
    const newComplete = this.areaComplete(this.newValid, area);
    const oldComplete = this.areaComplete(this.oldValid, area);
    const oldMatchesVisible = this.areaEquals(this.oldRam, this.visibleRam, area);
    if (partial) {
      this.partialFault =
        !this.partialPrepared || this.lutMode !== "partial" || !(oldComplete && newComplete && oldMatchesVisible);
      this.log(
        this.partialFault
          ? "EPD partial refresh fault: Mode 2 LUT/base SRAM/visible differential state invalid"
          : "EPD partial refresh accepted: differential area update",
      );
    } else {
      this.partialFault = false;
      this.partialPrepared = false;
      this.log(
        newComplete
          ? "EPD full refresh: BW RAM drives visible glass"
          : "EPD full refresh with incomplete BW RAM; invalid bytes shown as unknown",
      );
    }
    this.previousVisibleRam.set(this.visibleRam);
    if (this.partialFault) {
      this.applyPartialArtifact(area);
    } else {
      this.copyNewRamToVisible(area);
      this.oldRam.set(this.visibleRam);
      this.oldValid.set(this.visibleValid);
    }
    const duration = partial ? EPD_PARTIAL_REFRESH_CYCLES : EPD_FULL_REFRESH_CYCLES;
    this.refreshEffect = {
      start: this.getCycles(),
      duration,
      mode,
      partial,
      fault: this.partialFault,
      area,
      seq: (this.refreshSeq += 1),
    };
    this.setBusy(true, duration);
    this.onFrame?.();
  }

  fullArea() {
    return {
      xStart: 0,
      xEnd: this.bytesPerRow - 1,
      yStart: 0,
      yEnd: this.height - 1,
    };
  }

  copyNewRamToVisible(area) {
    for (let y = area.yStart; y <= area.yEnd; y += 1) {
      for (let xb = area.xStart; xb <= area.xEnd; xb += 1) {
        const index = y * this.bytesPerRow + xb;
        this.visibleRam[index] = this.newRam[index];
        this.visibleValid[index] = this.newValid[index];
      }
    }
  }

  applyPartialArtifact(area) {
    const salt = this.refreshSeq + this.getCycles();
    for (let y = area.yStart; y <= area.yEnd; y += 1) {
      for (let xb = area.xStart; xb <= area.xEnd; xb += 1) {
        const index = y * this.bytesPerRow + xb;
        const noise = ((pixelNoise(xb * 8, y, salt) * 255) | 0) & 0xff;
        this.visibleRam[index] = (this.visibleRam[index] ^ this.newRam[index] ^ noise) & 0xff;
        this.visibleValid[index] = 1;
      }
    }
  }

  sleep() {
    this.awake = false;
    this.invalidateRam();
    this.partialPrepared = false;
    this.analogOn = false;
    this.log("EPD sleep: controller RAM invalidated; glass keeps last image");
    this.onFrame?.();
  }

  setBusy(busy, cycles = 0) {
    this.busy = busy;
    this.busyUntil = busy ? this.getCycles() + cycles : 0;
    this.setBusyPin(!busy ? false : true);
  }

  updateBusy() {
    if (this.busy && this.getCycles() >= this.busyUntil) {
      this.busy = false;
      this.setBusyPin(false);
      this.log("EPD BUSY low");
      this.onFrame?.();
    }
  }

  isComplete(mask) {
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) {
        return false;
      }
    }
    return true;
  }

  ramEquals(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  areaComplete(mask, area) {
    for (let y = area.yStart; y <= area.yEnd; y += 1) {
      for (let xb = area.xStart; xb <= area.xEnd; xb += 1) {
        if (!mask[y * this.bytesPerRow + xb]) {
          return false;
        }
      }
    }
    return true;
  }

  areaEquals(a, b, area) {
    for (let y = area.yStart; y <= area.yEnd; y += 1) {
      for (let xb = area.xStart; xb <= area.xEnd; xb += 1) {
        const index = y * this.bytesPerRow + xb;
        if (a[index] !== b[index]) {
          return false;
        }
      }
    }
    return true;
  }

  blackPixels(ram = this.visibleRam) {
    let count = 0;
    for (let i = 0; i < ram.length; i += 1) {
      let value = ram[i] ^ 0xff;
      while (value) {
        count += value & 1;
        value >>= 1;
      }
    }
    return count;
  }

  imageData(kind, options = {}) {
    let ram = this.visibleRam;
    let mask = this.visibleValid;
    if (kind === "old") {
      ram = this.oldRam;
      mask = this.oldValid;
    } else if (kind === "new") {
      ram = this.newRam;
      mask = this.newValid;
    }
    const image = new ImageData(this.width, this.height);
    const data = image.data;
    const effect = kind === "visible" ? this.refreshVisualState(options.visualEffect !== false) : null;
    for (let y = 0; y < this.height; y += 1) {
      for (let xb = 0; xb < this.bytesPerRow; xb += 1) {
        const byteIndex = y * this.bytesPerRow + xb;
        const value = ram[byteIndex];
        const oldValue = this.previousVisibleRam[byteIndex];
        const valid = mask[byteIndex] || kind === "visible";
        for (let bit = 0; bit < 8; bit += 1) {
          const x = xb * 8 + bit;
          const offset = (y * this.width + x) * 4;
          const black = (value & (0x80 >> bit)) === 0;
          let shade = !valid ? 178 : black ? 24 : 218;
          if (effect) {
            const oldBlack = (oldValue & (0x80 >> bit)) === 0;
            shade = this.refreshShade({
              x,
              y,
              oldShade: oldBlack ? 30 : 218,
              newShade: black ? 24 : 218,
              effect,
            });
          }
          data[offset] = shade;
          data[offset + 1] = !valid ? 184 : shade;
          data[offset + 2] = !valid ? 176 : shade;
          data[offset + 3] = 255;
        }
      }
    }
    return image;
  }

  refreshVisualState(enabled = true) {
    if (!enabled || !this.refreshEffect) {
      return null;
    }
    const elapsed = this.getCycles() - this.refreshEffect.start;
    const duration = Math.max(1, this.refreshEffect.duration);
    if (elapsed >= duration && !this.busy) {
      return null;
    }
    return {
      phase: clamp(elapsed / duration, 0, 1),
      partial: this.refreshEffect.partial,
      fault: this.refreshEffect.fault,
      mode: this.refreshEffect.mode,
      area: this.refreshEffect.area,
      seq: this.refreshEffect.seq,
    };
  }

  refreshShade({ x, y, oldShade, newShade, effect }) {
    const phase = effect.phase;
    const scan = smoothstep(0.08, 0.92, phase) * this.height;
    const rowDelta = y - scan;
    const rowWave = Math.max(0, 1 - Math.abs(rowDelta) / 18);
    const salt = effect.seq + (effect.partial ? 101 : 7);
    const noise = (pixelNoise(x, y, salt) - 0.5) * 18;
    if (effect.fault) {
      const block = (((x >> 3) * 17 + (y >> 3) * 31 + effect.seq * 13) & 7) < 4 ? 38 : 226;
      const ghost = mix(oldShade, newShade, 0.45);
      const pulse = Math.sin(phase * Math.PI * 5) * 28 * (1 - phase);
      return clamp(mix(ghost, block, 0.55) + pulse + noise, 0, 255);
    }
    if (!effect.partial) {
      if (phase < 0.18) {
        const t = smoothstep(0, 0.18, phase);
        return clamp(mix(oldShade, 238, t) + rowWave * 10, 0, 255);
      }
      if (phase < 0.42) {
        const t = smoothstep(0.18, 0.42, phase);
        return clamp(mix(238, 18, t) + rowWave * 18 + noise * 0.5, 0, 255);
      }
      if (phase < 0.62) {
        const t = smoothstep(0.42, 0.62, phase);
        return clamp(mix(18, 232, t) - rowWave * 22 + noise * 0.4, 0, 255);
      }
      if (phase < 0.78) {
        const t = smoothstep(0.62, 0.78, phase);
        const predrive = newShade < 128 ? 28 : 226;
        return clamp(mix(232, predrive, t) + rowWave * (newShade < 128 ? 16 : -16), 0, 255);
      }
      const t = smoothstep(0.78, 1, phase);
      const settle = Math.sin(phase * Math.PI * 12) * (1 - t) * 9;
      return clamp(mix(newShade < 128 ? 28 : 226, newShade, t) + settle, 0, 255);
    }
    const t = smoothstep(0.08, 1, phase);
    const changed = Math.abs(oldShade - newShade) > 12;
    const active = changed ? 1 : 0.08;
    const direction = newShade < oldShade ? -1 : 1;
    const pulse = direction * Math.sin(phase * Math.PI * 2.4) * (1 - t) * 34 * active;
    return clamp(mix(oldShade, newShade, t) + pulse + rowWave * 18 * active + noise * 0.2, 0, 255);
  }

  summary() {
    return {
      awake: this.awake,
      busy: this.busy,
      oldComplete: this.isComplete(this.oldValid),
      newComplete: this.isComplete(this.newValid),
      visibleComplete: this.isComplete(this.visibleValid),
      partialFault: this.partialFault,
      refreshActive: !!this.refreshVisualState(true),
      refreshPartial: !!this.refreshEffect?.partial,
      lutMode: this.lutMode,
      partialPrepared: this.partialPrepared,
      analogOn: this.analogOn,
      visibleBlackPixels: this.blackPixels(this.visibleRam),
      oldBlackPixels: this.blackPixels(this.oldRam),
      newBlackPixels: this.blackPixels(this.newRam),
      spiBytes: this.spiBytes,
      command: this.currentCommand,
      updateControl: this.updateControl,
      width: this.width,
      height: this.height,
    };
  }
}

export class Epaper2Avr {
  constructor({ log = () => {}, onChange = () => {} } = {}) {
    this.log = log;
    this.onChange = onChange;
    this.program = null;
    this.cpu = null;
    this.running = false;
    this.sleeping = false;
    this.frameBudgetMs = 18;
    this.maxInstructionsPerSlice = 800_000;
    this.speedMultiplier = 1;
    this.wallAnchorMs = 0;
    this.cycleAnchor = 0;
    this.lastUiCycles = 0;
    this.lastUiWall = 0;
    this.bootWallMs = monotonicNow();
    this.batteryMv = 3600;
    this.rtcVccOverrideMv = null;
    this.powerModel = null;
    this.ports = {};
    this.peripherals = {};
    this.stackLowWaterSp = SRAM_END_ADDR;
    this._runBound = () => this.runFrame();
  }

  loadHex(hex) {
    this.program = loadIntelHex(hex);
    this.log(`firmware.hex loaded: ${this.program.length * 2} bytes flash image`);
  }

  reset() {
    if (!this.program) {
      throw new Error("No firmware loaded");
    }
    this.stop();
    this.cpu = new CPU(this.program.slice(), SRAM_BYTES);
    this.bootWallMs = monotonicNow();
    this.clock = new AVRClock(this.cpu, CPU_FREQ_HZ, clockConfig);
    this.ports.b = new AVRIOPort(this.cpu, portBConfig);
    this.ports.c = new AVRIOPort(this.cpu, portCConfig);
    this.ports.d = new AVRIOPort(this.cpu, portDConfig);
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.eepromBackend = new EEPROMMemoryBackend(EEPROM_BYTES);
    this.eeprom = new AVREEPROM(this.cpu, this.eepromBackend, eepromConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, CPU_FREQ_HZ);
    this.twi = new AVRTWI(this.cpu, twiConfig, CPU_FREQ_HZ);
    this.watchdog = new AVRWatchdog(this.cpu, watchdogConfig, this.clock);
    this.stackLowWaterSp = SRAM_END_ADDR;

    this.ports.b.setPin(PIN.RTC_INT, true);
    this.ports.c.setPin(PIN.BUTTON3, true);
    this.ports.d.setPin(PIN.BUTTON1, true);
    this.ports.d.setPin(PIN.BUTTON2, true);
    this.ports.d.setPin(PIN.EPD_BUSY, false);

    this.powerModel = new PowerReservoirModel({ getTimeMs: () => monotonicNow() });
    this.powerModel.configure({ batteryMv: this.batteryMv });
    this.ds3231 = new DS3231Model({
      log: this.log,
      getTimeMs: () => monotonicNow(),
      getVccMv: () => this.rtcVccOverrideMv ?? this.powerModel?.snapshot().v3v3Mv ?? 3300,
      setRtcInt: (high) => this.ports.b.setPin(PIN.RTC_INT, high),
    });
    this.twi.eventHandler = new DS3231TWIHandler(this.twi, this.ds3231, this.log);

    this.epd = new EpdControllerModel({
      log: this.log,
      getCycles: () => this.cpu.cycles,
      setBusyPin: (busyHigh) => this.ports.d.setPin(PIN.EPD_BUSY, busyHigh),
      onFrame: () => this.requestUiUpdate(),
    });
    this.epd.attach(this.ports.b);

    this.air780 = new Air780Model({
      usart: this.usart,
      cpu: this.cpu,
      log: this.log,
      supplyOk: () => this.powerModel?.snapshot().airSupplyOk ?? true,
      addPowerEvent: (event) => this.powerModel?.addLoadEvent(event),
    });
    this.usart.onLineTransmit = (line) => this.air780.onLine(line);

    this.ports.d.addListener((value) => {
      const ddr = this.cpu.data[portDConfig.DDR];
      const airDriven = !!(ddr & (1 << PIN.AIR780_PMOS));
      const airOn = airDriven && (value & (1 << PIN.AIR780_PMOS)) === 0;
      this.powerModel?.setAirOn(airOn);
      this.air780.setPower(airOn);
      this.updateBatteryAdc();
    });

    this.sleeping = false;
    this.resetTimeAnchor();
    this.updateBatteryAdc();
    this.log("AVR reset: ATmega328P core and bus peripherals re-created");
    this.requestUiUpdate(true);
  }

  start() {
    if (!this.cpu || this.running) {
      return;
    }
    this.running = true;
    this.resetTimeAnchor();
    this.scheduleRun();
  }

  stop() {
    this.running = false;
  }

  scheduleRun() {
    if (!this.running) {
      return;
    }
    if (globalThis.window?.requestAnimationFrame) {
      globalThis.window.requestAnimationFrame(this._runBound);
    } else {
      globalThis.setTimeout(this._runBound, 16);
    }
  }

  setSpeed(mode) {
    const value = Number(mode);
    if (value > 0) {
      this.speedMultiplier = value;
    } else {
      this.speedMultiplier = 1;
    }
    this.resetTimeAnchor();
    this.requestUiUpdate(true);
  }

  resetTimeAnchor(now = monotonicNow()) {
    this.wallAnchorMs = now;
    this.cycleAnchor = this.cpu?.cycles || 0;
  }

  targetCyclesFor(now = monotonicNow()) {
    if (!this.cpu) {
      return 0;
    }
    const elapsedMs = Math.max(0, now - this.wallAnchorMs);
    return this.cycleAnchor + Math.floor((elapsedMs * CPU_FREQ_HZ * this.speedMultiplier) / 1000);
  }

  setRtcDate(date) {
    this.ds3231?.setDate(date);
    this.log(`DS3231 time set: ${date.toLocaleString()}`);
    this.requestUiUpdate(true);
  }

  setRtcBackupMv(mv) {
    this.ds3231?.setBackupMv(mv);
    this.requestUiUpdate(true);
  }

  setRtcVccOverrideMv(mv) {
    this.rtcVccOverrideMv = Number.isFinite(Number(mv)) ? Math.max(0, Number(mv)) : null;
    this.ds3231?.step();
    this.requestUiUpdate(true);
  }

  setAirOptions(options) {
    this.air780?.setOptions(options);
  }

  setBatteryMv(mv) {
    this.batteryMv = Number(mv);
    this.powerModel?.configure({ batteryMv: this.batteryMv });
    this.updateBatteryAdc();
    this.requestUiUpdate(true);
  }

  configurePowerModel(options) {
    this.powerModel?.configure(options);
    if (Number.isFinite(Number(options?.batteryMv))) {
      this.batteryMv = Number(options.batteryMv);
    }
    this.updateBatteryAdc();
    this.requestUiUpdate(true);
  }

  buildSimulinkPowerRequest(options = {}) {
    return this.powerModel?.simulinkRequest(options) ?? null;
  }

  applySimulinkPowerTrace(trace, meta = {}) {
    this.powerModel?.setExternalTrace(trace, meta);
    this.updateBatteryAdc();
    this.requestUiUpdate(true);
  }

  clearSimulinkPowerTrace() {
    this.powerModel?.clearExternalTrace();
    this.requestUiUpdate(true);
  }

  isBatterySwitchOn() {
    if (!this.cpu) {
      return false;
    }
    const ddrD = this.cpu.data[portDConfig.DDR];
    const portDOut = this.cpu.data[portDConfig.PORT];
    return !!(ddrD & (1 << PIN.BAT_SWITCH)) && !!(portDOut & (1 << PIN.BAT_SWITCH));
  }

  updateBatteryAdc() {
    if (!this.adc) {
      return;
    }
    const vbat = Number(this.batteryMv) / 1000;
    const dividerRatio =
      BAT_DIVIDER_BOTTOM_OHMS / (BAT_DIVIDER_TOP_OHMS + BAT_DIVIDER_BOTTOM_OHMS);
    const adcVoltage = this.isBatterySwitchOn() ? vbat * dividerRatio : vbat;
    this.adc.channelValues[7] = clamp(adcVoltage, 0, BAT_ADC_REF_V);
  }

  pressButton(index, holdMs = 140) {
    if (!this.cpu) {
      return;
    }
    if (index === 1) {
      this.ports.d.setPin(PIN.BUTTON1, false);
    } else if (index === 2) {
      this.ports.d.setPin(PIN.BUTTON2, false);
    } else if (index === 3) {
      this.ports.c.setPin(PIN.BUTTON3, false);
    }
    this.sleeping = false;
    this.start();
    window.setTimeout(() => this.releaseButton(index), holdMs);
    this.log(`button S${index} low`);
    this.requestUiUpdate(true);
  }

  releaseButton(index) {
    if (!this.cpu) {
      return;
    }
    if (index === 1) {
      this.ports.d.setPin(PIN.BUTTON1, true);
    } else if (index === 2) {
      this.ports.d.setPin(PIN.BUTTON2, true);
    } else if (index === 3) {
      this.ports.c.setPin(PIN.BUTTON3, true);
    }
    this.log(`button S${index} high`);
    this.requestUiUpdate(true);
  }

  triggerRtcAlarm() {
    if (!this.cpu) {
      return;
    }
    this.ds3231.triggerAlarm();
    if (this.ds3231.summary().intLow) {
      this.sleeping = false;
      this.start();
    }
    this.requestUiUpdate(true);
  }

  runFrame() {
    if (!this.running || !this.cpu) {
      return;
    }
    const started = monotonicNow();
    if (this.sleeping) {
      this.resetTimeAnchor(started);
    }
    const targetCycles = this.sleeping ? this.cpu.cycles : this.targetCyclesFor(started);
    let executed = 0;
    const deadline = started + this.frameBudgetMs;
    let timeExpired = false;
    while (
      this.running &&
      !this.sleeping &&
      this.cpu.cycles < targetCycles &&
      executed < this.maxInstructionsPerSlice &&
      !timeExpired
    ) {
      const opcode = this.cpu.progMem[this.cpu.pc];
      avrInstruction(this.cpu);
      this.cpu.tick();
      executed += 1;

      if ((executed & 0x1ff) === 0) {
        this.epd.updateBusy();
        this.air780.pump(4);
      }
      if ((executed & 0xff) === 0) {
        timeExpired = monotonicNow() >= deadline;
      }

      if (opcode === SLEEP_OPCODE && (this.cpu.data[SMCR] & SE_BIT)) {
        this.sleeping = true;
        this.resetTimeAnchor();
        this.log("AVR sleep_cpu: simulated core halted until GPIO/RTC interrupt");
      }
    }

    this.epd.updateBusy();
    this.air780.pump(8);
    this.powerModel?.setAvrSleeping(this.sleeping);
    this.powerModel?.step();
    const wasSleeping = this.sleeping;
    this.ds3231?.step();
    if (wasSleeping && this.ds3231?.summary().intLow) {
      this.sleeping = false;
      this.resetTimeAnchor();
      this.log("AVR wake: DS3231 INT low");
    }

    const now = monotonicNow();
    if (
      this.sleeping ||
      this.epd.summary().refreshActive ||
      now - this.lastUiWall > 250 ||
      this.cpu.cycles - this.lastUiCycles > CPU_FREQ_HZ
    ) {
      this.requestUiUpdate();
      this.lastUiCycles = this.cpu.cycles;
      this.lastUiWall = now;
    }
    if (this.running) {
      this.scheduleRun();
    }
  }

  requestUiUpdate(force = false) {
    if (!this.cpu) {
      return;
    }
    if (force) {
      this.lastUiCycles = 0;
    }
    this.onChange(this.snapshot());
  }

  sramSummary() {
    const sp = this.cpu.dataView.getUint16(SPL_ADDR, true);
    const stackPointerOk = sp >= SRAM_START_ADDR && sp <= SRAM_END_ADDR;
    if (stackPointerOk) {
      this.stackLowWaterSp = Math.min(this.stackLowWaterSp, sp);
    }
    let nonZeroSramBytes = 0;
    for (let addr = SRAM_START_ADDR; addr <= SRAM_END_ADDR; addr += 1) {
      if (this.cpu.data[addr] !== 0) {
        nonZeroSramBytes += 1;
      }
    }
    const stackUsedBytes = stackPointerOk ? SRAM_END_ADDR - sp : null;
    const stackFreeBytes = stackPointerOk ? sp - SRAM_START_ADDR + 1 : null;
    const stackPeakBytes =
      stackPointerOk && this.stackLowWaterSp >= SRAM_START_ADDR
        ? SRAM_END_ADDR - this.stackLowWaterSp
        : null;
    const stackLowWaterSp = stackPointerOk ? this.stackLowWaterSp : null;
    return {
      dataSpaceBytes: AVR_DATA_SPACE_BYTES,
      sramBytes: SRAM_BYTES,
      sramStart: SRAM_START_ADDR,
      sramEnd: SRAM_END_ADDR,
      bytes: this.cpu.data.slice(SRAM_START_ADDR, SRAM_END_ADDR + 1),
      sp,
      spHex: hexWord(sp),
      stackLowWaterSp,
      stackLowWaterSpHex: stackLowWaterSp === null ? null : hexWord(stackLowWaterSp),
      stackPointerOk,
      stackUsedBytes,
      stackFreeBytes,
      stackPeakBytes,
      nonZeroSramBytes,
    };
  }

  flashSummary() {
    const bytes = this.cpu.progBytes.slice(0, FLASH_BYTES);
    let usedBytes = 0;
    let nonFfBytes = 0;
    let nonZeroBytes = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== 0xff) {
        nonFfBytes += 1;
        usedBytes = i + 1;
      }
      if (bytes[i] !== 0x00) {
        nonZeroBytes += 1;
      }
    }
    return {
      totalBytes: FLASH_BYTES,
      start: 0,
      end: FLASH_BYTES - 1,
      appStart: 0,
      appEnd: FLASH_APP_LIMIT_BYTES - 1,
      bootStart: FLASH_APP_LIMIT_BYTES,
      bootEnd: FLASH_BYTES - 1,
      bootBytes: FLASH_BYTES - FLASH_APP_LIMIT_BYTES,
      bytes,
      usedBytes,
      appFreeBytes: Math.max(0, FLASH_APP_LIMIT_BYTES - usedBytes),
      nonFfBytes,
      nonZeroBytes,
      pcByte: this.cpu.pc * 2,
      pcByteHex: hexWord(this.cpu.pc * 2),
    };
  }

  eepromSummary() {
    const source = this.eepromBackend?.memory ?? new Uint8Array(EEPROM_BYTES);
    const bytes = source.slice(0, EEPROM_BYTES);
    let nonFfBytes = 0;
    let nonZeroBytes = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== 0xff) {
        nonFfBytes += 1;
      }
      if (bytes[i] !== 0x00) {
        nonZeroBytes += 1;
      }
    }
    return {
      totalBytes: EEPROM_BYTES,
      start: 0,
      end: EEPROM_BYTES - 1,
      bytes,
      erasedBytes: EEPROM_BYTES - nonFfBytes,
      writtenBytes: nonFfBytes,
      nonFfBytes,
      nonZeroBytes,
      eecr: this.cpu.data[eepromConfig.EECR],
      eear: (this.cpu.data[eepromConfig.EEARH] << 8) | this.cpu.data[eepromConfig.EEARL],
      eedr: this.cpu.data[eepromConfig.EEDR],
      writeBusy: !!(this.cpu.data[eepromConfig.EECR] & 0x02),
    };
  }

  timerSummary(name, timer, config) {
    const readReg = (addr) => (addr ? this.cpu.data[addr] : 0);
    return {
      name,
      bits: config.bits,
      tcnt: timer?.debugTCNT ?? readReg(config.TCNT),
      tccra: readReg(config.TCCRA),
      tccrb: readReg(config.TCCRB),
      timsk: readReg(config.TIMSK),
      tifr: readReg(config.TIFR),
      ocra: readReg(config.OCRA),
      ocrb: readReg(config.OCRB),
      cs: timer?.CS ?? (readReg(config.TCCRB) & 0x07),
      wgm: timer?.WGM ?? null,
    };
  }

  watchdogSummary() {
    const wdtcsr = this.cpu.data[watchdogConfig.WDTCSR];
    const mcusr = this.cpu.data[watchdogConfig.MCUSR];
    const enabled = !!this.watchdog?.enabled;
    const remainingCycles = enabled
      ? Math.max(0, (this.watchdog.watchdogTimeout ?? this.cpu.cycles) - this.cpu.cycles)
      : null;
    return {
      enabled,
      interruptEnable: !!(wdtcsr & 0x40),
      resetEnable: !!(wdtcsr & 0x08),
      flag: !!(wdtcsr & 0x80),
      changeEnable: !!(wdtcsr & 0x10),
      wdtcsr,
      mcusr,
      prescaler: this.watchdog?.prescaler ?? null,
      timeoutMs:
        this.watchdog?.prescaler !== undefined
          ? (this.watchdog.prescaler / 128_000) * 1000
          : null,
      remainingMs:
        remainingCycles === null ? null : (remainingCycles / CPU_FREQ_HZ) * 1000,
    };
  }

  socSummary() {
    const sreg = this.cpu.data[SREG_ADDR];
    return {
      core: {
        clockHz: CPU_FREQ_HZ,
        pc: this.cpu.pc,
        pcHex: hexWord(this.cpu.pc),
        cycles: this.cpu.cycles,
        sreg,
        sregHex: hexByte(sreg),
        sregFlags: sregFlags(sreg),
        interruptsEnabled: this.cpu.interruptsEnabled,
        sleepControl: this.cpu.data[SMCR],
        sleeping: this.sleeping,
        flashBytes: FLASH_BYTES,
        eepromBytes: EEPROM_BYTES,
        cache: "none",
      },
      memory: this.sramSummary(),
      flash: this.flashSummary(),
      eeprom: this.eepromSummary(),
      watchdog: this.watchdogSummary(),
      timers: {
        t0: this.timerSummary("T0", this.timer0, timer0Config),
        t1: this.timerSummary("T1", this.timer1, timer1Config),
        t2: this.timerSummary("T2", this.timer2, timer2Config),
      },
      interrupts: {
        next: this.cpu.nextInterrupt,
        max: this.cpu.maxInterrupt,
        pendingCount: this.cpu.pendingInterrupts.filter(Boolean).length,
      },
    };
  }

  snapshot() {
    this.powerModel?.setAvrSleeping(this.sleeping);
    this.powerModel?.step();
    this.ds3231?.step();
    const rtcDate = this.ds3231.now();
    const rtcSummary = this.ds3231.summary();
    const portB = this.ports.b;
    const portC = this.ports.c;
    const portD = this.ports.d;
    const pinB = this.cpu.data[portBConfig.PIN];
    const pinC = this.cpu.data[portCConfig.PIN];
    const pinD = this.cpu.data[portDConfig.PIN];
    const portBOut = this.cpu.data[portBConfig.PORT];
    const portDOut = this.cpu.data[portDConfig.PORT];
    const ddrD = this.cpu.data[portDConfig.DDR];
    const powerSnapshot = this.powerModel?.snapshot() ?? {
      batteryMv: this.batteryMv,
      batteryLoadedMv: this.batteryMv,
      v3v3Mv: Math.min(3300, this.batteryMv),
      vlteMv: this.batteryMv,
      supercapMv: this.batteryMv,
      chargeCurrentMa: 0,
      loadCurrentMa: 0,
      airSupplyOk: true,
    };
    return {
      pc: this.cpu.pc,
      cycles: this.cpu.cycles,
      millis: this.clock.timeMillis,
      timing: {
        clockHz: CPU_FREQ_HZ,
        speedMultiplier: this.speedMultiplier,
        targetCycles: this.targetCyclesFor(),
        lagCycles: Math.max(0, this.targetCyclesFor() - this.cpu.cycles),
        bootWallMs: Math.max(0, monotonicNow() - this.bootWallMs),
        capWaitMs: FIRST_BOOT_CAP_CHARGE_WAIT_MS,
      },
      running: this.running,
      sleeping: this.sleeping,
      soc: this.socSummary(),
      rtc: rtcDate,
      rtcSummary,
      buttons: {
        s1: !!(pinD & (1 << PIN.BUTTON1)),
        s2: !!(pinD & (1 << PIN.BUTTON2)),
        s3: !!(pinC & (1 << PIN.BUTTON3)),
      },
      rtcIntHigh: !!(pinB & (1 << PIN.RTC_INT)),
      epdPins: {
        rst: !!(portBOut & (1 << PIN.EPD_RST)),
        dc: !!(portBOut & (1 << PIN.EPD_DC)),
        cs: !!(portBOut & (1 << PIN.EPD_CS)),
        mosi: !!(portBOut & (1 << PIN.EPD_MOSI)),
        sck: !!(portBOut & (1 << PIN.EPD_SCK)),
        busy: !!(pinD & (1 << PIN.EPD_BUSY)),
      },
      power: {
        ...powerSnapshot,
        batSwitchOn: this.isBatterySwitchOn(),
        airPmosOn:
          !!(ddrD & (1 << PIN.AIR780_PMOS)) && (portDOut & (1 << PIN.AIR780_PMOS)) === 0,
      },
      air: {
        ...this.air780.summary(),
      },
      epd: this.epd.summary(),
    };
  }

  imageData(kind) {
    return this.epd.imageData(kind);
  }

  injectPartialFaultProbe() {
    if (!this.epd) {
      return;
    }
    this.epd.sleep();
    this.epd.updateControl = 0x0f;
    this.epd.masterActivation();
    this.requestUiUpdate(true);
  }
}
