"use strict";

const LOW_BATTERY_MV = 3300;
const EPD_FRAME_BYTES = 4736;
const FEATURE_DEFAULTS = {
  ui: { items: 4, payloadKb: 0, storage: "flash" },
  vocab: { items: 80, payloadKb: 6, storage: "hybrid" },
  image: { items: 3, payloadKb: 4.6, storage: "flash" },
  ota: { items: 1, payloadKb: 22, storage: "mqtt" },
  combo: { items: 60, payloadKb: 14, storage: "hybrid" },
};
const FEATURE_LABELS = {
  ui: "多页面 UI",
  vocab: "背单词卡片",
  image: "图片槽切换",
  ota: "Air780 OTA",
  combo: "UI + 背单词 + 图片",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function hm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function localDatetimeValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

class EventLog {
  constructor(node) {
    this.node = node;
    this.lines = [];
  }

  add(text) {
    const now = new Date();
    const line = `${hm(now)}:${pad2(now.getSeconds())}  ${text}`;
    this.lines.push(line);
    if (this.lines.length > 260) {
      this.lines.shift();
    }
    this.node.textContent = this.lines.join("\n");
    this.node.scrollTop = this.node.scrollHeight;
  }

  clear() {
    this.lines = [];
    this.node.textContent = "";
  }
}

class BrowserUi {
  constructor() {
    this.log = new EventLog(document.getElementById("eventLog"));
    this.ctx = document.getElementById("epdCanvas").getContext("2d", { willReadFrequently: true });
    this.ramContexts = {
      visible: document.getElementById("visibleCanvas").getContext("2d", { willReadFrequently: true }),
      old: document.getElementById("oldCanvas").getContext("2d", { willReadFrequently: true }),
      new: document.getElementById("newCanvas").getContext("2d", { willReadFrequently: true }),
    };
    this.diffCtx = document.getElementById("diffCanvas").getContext("2d", { willReadFrequently: true });
    this.waveCtx = document.getElementById("waveCanvas").getContext("2d");
    this.memoryMapCtx = document.getElementById("memoryMapCanvas").getContext("2d");
    this.flashMapCtx = document.getElementById("flashMapCanvas").getContext("2d");
    this.eepromMapCtx = document.getElementById("eepromMapCanvas").getContext("2d");
    this.featurePreviewCtx = document.getElementById("featurePreviewCanvas").getContext("2d");
    this.powerScopeCtx = document.getElementById("powerScope").getContext("2d");
    this.powerSamples = [];
    this.lastPowerSampleS = -Infinity;
    this.lastSnapshot = null;
    this.memoryMapLayouts = {};
    this.firmwareSymbols = { ok: false, sram: [], flash: [] };
    this.sim = new Epaper2Avr.Epaper2Avr({
      log: (line) => this.log.add(line),
      onChange: (snapshot) => this.update(snapshot),
    });
    this.lastFrameSignature = "";
    this.renderLoopActive = false;
    this.renderLoopHandle = 0;
    this.bindUi();
    this.boot();
  }

  bindUi() {
    document.getElementById("bootBtn").addEventListener("click", () => this.boot());
    document.getElementById("alarmBtn").addEventListener("click", () => this.sim.triggerRtcAlarm());
    document.getElementById("minuteBtn").addEventListener("click", () => this.advanceMinuteAndAlarm());
    document.getElementById("faultPartialBtn").addEventListener("click", () => this.sim.injectPartialFaultProbe());
    document.getElementById("btn1").addEventListener("click", () => this.sim.pressButton(1));
    document.getElementById("btn2").addEventListener("click", () => this.sim.pressButton(2));
    document.getElementById("btn3").addEventListener("click", () => this.sim.pressButton(3));
    document.getElementById("sendHappyBtn").addEventListener("click", () => this.pressSendHappySequence());
    document.getElementById("receiveBtn").addEventListener("click", () => this.sim.pressButton(3));
    document.getElementById("clearLogBtn").addEventListener("click", () => this.log.clear());
    document.getElementById("ltspiceBtn").addEventListener("click", () => this.runLtspicePowerCheck());
    document.getElementById("simulinkBtn").addEventListener("click", () => this.checkSimulinkBackend());
    document.getElementById("rtcInput").addEventListener("change", (event) => {
      this.sim.setRtcDate(new Date(event.target.value));
    });
    document.getElementById("rtcBackupMv").addEventListener("input", () => this.updateRtcControls());
    document.getElementById("rtcVccDrop").addEventListener("change", () => this.updateRtcControls());
    document.getElementById("speedSelect").addEventListener("change", (event) => {
      this.sim.setSpeed(event.target.value);
    });
    document.getElementById("panelSelect").addEventListener("change", () => this.updatePanelWarning());
    document.getElementById("featureSelect").addEventListener("change", () => {
      this.applyFeatureDefaults();
      this.updateFeatureLab(this.lastSnapshot);
    });
    for (const id of ["featureItems", "featurePayloadKb", "featureStorage"]) {
      document.getElementById(id).addEventListener("input", () => this.updateFeatureLab(this.lastSnapshot));
    }
    document.getElementById("featureApplyBtn").addEventListener("click", () => {
      this.updateFeatureLab(this.sim.snapshot());
    });
    for (const id of [
      "batteryMv",
      "batteryCount",
      "internalResistance",
      "batteryTemperature",
      "batteryContinuousLimit",
      "batteryPulseLimit",
      "airPulse",
      "airSustain",
      "airPulseWidth",
      "supercapF",
      "supercapCount",
      "supercapChargeR",
      "chargeResistorCount",
      "supercapEsr",
      "supercapLeakage",
      "supercapDiode",
      "supplySwitchR",
      "burstGlitch",
      "measurementNoise",
      "avrActiveMa",
      "avrSleepUa",
    ]) {
      document.getElementById(id).addEventListener("input", () => this.updatePowerControls());
    }
    for (const id of ["rxMessage", "datePayload", "failAttach", "failMqtt"]) {
      document.getElementById(id).addEventListener("input", () => this.syncAirOptions());
    }
    for (const [canvasId, mapKey, outId] of [
      ["memoryMapCanvas", "sram", "memoryMapHover"],
      ["flashMapCanvas", "flash", "flashMapHover"],
      ["eepromMapCanvas", "eeprom", "eepromMapHover"],
    ]) {
      const canvas = document.getElementById(canvasId);
      canvas.addEventListener("mousemove", (event) => this.updateMemoryHover(mapKey, outId, event));
      canvas.addEventListener("mouseleave", () => {
        document.getElementById(outId).textContent = "--";
      });
    }
    document.getElementById("examDateInput").addEventListener("change", () => this.updateDatePayloadFromInputs());
    document.getElementById("meetDateInput").addEventListener("change", () => this.updateDatePayloadFromInputs());
    window.setInterval(() => {
      if (this.lastSnapshot) {
        this.updateRtcControls(this.sim.snapshot());
      }
    }, 1000);
  }

  async boot() {
    try {
      this.log.add("Loading firmware.hex from PlatformIO build output");
      document.getElementById("simulinkState").textContent = "JS plant active";
      document.getElementById("simulinkDetail").textContent = "--";
      await this.loadFirmwareSymbols();
      const response = await fetch("/firmware.hex", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const hex = await response.text();
      this.sim.loadHex(hex);
      this.sim.reset();
      this.powerSamples = [];
      this.lastPowerSampleS = -Infinity;
      this.syncAirOptions();
      const rtcValue = document.getElementById("rtcInput").value;
      if (rtcValue) {
        this.sim.setRtcDate(new Date(rtcValue));
      } else {
        this.sim.setRtcDate(new Date());
      }
      this.sim.setSpeed(document.getElementById("speedSelect").value);
      this.sim.start();
    } catch (error) {
      this.log.add(`boot failed: ${error.message}`);
      document.getElementById("firmwareState").textContent = "HEX LOAD FAILED";
      document.getElementById("invariantState").textContent = "firmware.hex missing";
      document.getElementById("invariantState").classList.add("bad");
    }
  }

  async loadFirmwareSymbols() {
    try {
      const response = await fetch("/api/firmware/symbols", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.firmwareSymbols = await response.json();
      if (this.firmwareSymbols.ok) {
        const topSram = this.topSymbols(this.firmwareSymbols.sram, 4)
          .map((item) => `${item.name} ${item.size} B`)
          .join(", ");
        this.log.add(`firmware symbols loaded: SRAM ${this.firmwareSymbols.sram.length}, Flash ${this.firmwareSymbols.flash.length}`);
        document.getElementById("memoryMapSymbols").textContent = topSram || "no SRAM globals";
      } else {
        document.getElementById("memoryMapSymbols").textContent = this.firmwareSymbols.error || "symbols unavailable";
        document.getElementById("flashMapSymbols").textContent = this.firmwareSymbols.error || "symbols unavailable";
      }
    } catch (error) {
      this.firmwareSymbols = { ok: false, sram: [], flash: [], error: error.message };
      document.getElementById("memoryMapSymbols").textContent = `symbols unavailable: ${error.message}`;
      document.getElementById("flashMapSymbols").textContent = `symbols unavailable: ${error.message}`;
    }
  }

  topSymbols(symbols, limit) {
    return [...(symbols ?? [])].sort((a, b) => b.size - a.size).slice(0, limit);
  }

  update(snapshot) {
    this.lastSnapshot = snapshot;
    document.getElementById("firmwareState").textContent =
      snapshot.sleeping ? "AVR SLEEP" : `PC 0x${snapshot.pc.toString(16).padStart(4, "0")}`;
    const capWaitLeft = Math.max(0, snapshot.timing.capWaitMs - snapshot.timing.bootWallMs);
    document.getElementById("mcuStateText").textContent =
      `${snapshot.sleeping ? "MCU sleep" : "MCU running"} ${(snapshot.millis / 1000).toFixed(1)}s @ ${(snapshot.timing.clockHz / 1000000).toFixed(0)}MHz x${snapshot.timing.speedMultiplier}${capWaitLeft > 0 ? `, cap wait ${(capWaitLeft / 1000).toFixed(0)}s` : ""}`;
    document.getElementById("mcuStateLed").classList.toggle("on", !snapshot.sleeping);

    document.getElementById("epdStateText").textContent =
      `${snapshot.epd.awake ? "EPD awake" : "EPD sleep"}, LUT ${snapshot.epd.lutMode}, ${snapshot.epd.oldComplete ? "old OK" : "old invalid"}, ${snapshot.epd.newComplete ? "new OK" : "new invalid"}`;
    document.getElementById("spiState").textContent =
      `CS ${level(snapshot.epdPins.cs)}, DC ${level(snapshot.epdPins.dc)}, RST ${level(snapshot.epdPins.rst)}, bytes ${snapshot.epd.spiBytes}`;
    document.getElementById("busyState").textContent =
      `${snapshot.epdPins.busy ? "HIGH busy" : "LOW idle"}${snapshot.epd.refreshActive ? `, ${snapshot.epd.refreshPartial ? "partial" : "full"} pigment moving` : snapshot.epd.partialPrepared ? ", Mode2 ready" : ""}`;
    document.getElementById("ramState").textContent =
      `${snapshot.epd.oldComplete ? "old OK" : "old partial"} / ${snapshot.epd.newComplete ? "new OK" : "new partial"}, black ${snapshot.epd.visibleBlackPixels}px`;
    document.getElementById("busyOverlay").classList.toggle("hidden", !snapshot.epdPins.busy);

    this.setButtonUi("S1", "s1State", "s1Probe", snapshot.buttons.s1, "D2 / INT0");
    this.setButtonUi("S2", "s2State", "s2Probe", snapshot.buttons.s2, "D3 / INT1");
    this.setButtonUi("S3", "s3State", "s3Probe", snapshot.buttons.s3, "A1 / PCINT9");
    document.getElementById("rtcIntState").textContent =
      `${snapshot.rtcIntHigh ? "HIGH" : "LOW"}, DS3231 ${snapshot.rtc.toLocaleString()}`;
    document.getElementById("rtcInput").value = localDatetimeValue(snapshot.rtc);
    this.updateRtcControls(snapshot);

    document.getElementById("eepromState").textContent =
      `firmware EEPROM backend active, cycles ${snapshot.cycles}`;
    document.getElementById("firmwareGeometry").textContent = "firmware.hex -> EPD 128x296, 4736 bytes";
    this.updateSocPanel(snapshot);
    this.updateFeatureLab(snapshot);
    document.getElementById("sampleSwitchState").textContent =
      snapshot.power.batSwitchOn ? "N-MOS on, D4 HIGH -> ADC sample" : "N-MOS off, D4 LOW";
    document.getElementById("airState").textContent =
      `${snapshot.air.powered ? "VBAT ON" : "OFF"} / ${snapshot.air.state} / ${snapshot.air.protocolStep}`;
    document.getElementById("airRegState").textContent =
      `${snapshot.air.registered ? "CEREG 5" : "CEREG wait"} / ${snapshot.air.attached ? "CGATT 1" : "CGATT 0"}`;
    document.getElementById("airTcpState").textContent =
      `${snapshot.air.tcpConnected ? "TCP connected" : "TCP closed"} / ${snapshot.air.mqttConnected ? "MQTT connected" : snapshot.air.mqttConfigured ? "MQTT configured" : "MQTT off"}`;
    document.getElementById("airTopicState").textContent =
      snapshot.air.topics.length ? snapshot.air.topics.join(", ") : "none";
    document.getElementById("airQueueState").textContent =
      `rx ${snapshot.air.queued} / pending ${snapshot.air.pendingResponses}`;

    const invariant = document.getElementById("invariantState");
    invariant.textContent = snapshot.epd.partialFault ? "EPD partial invariant failed" : "EPD invariant OK";
    invariant.classList.toggle("bad", snapshot.epd.partialFault);

    this.updatePowerControls(snapshot);
    this.updatePanelWarning();
    this.renderFrames(snapshot);
    this.drawMemoryMap(snapshot);
  }

  updateSocPanel(snapshot) {
    const soc = snapshot.soc;
    if (!soc) {
      return;
    }
    const core = soc.core;
    const mem = soc.memory;
    const flash = soc.flash;
    const eeprom = soc.eeprom;
    const wdt = soc.watchdog;
    const timers = soc.timers;
    document.getElementById("socState").textContent =
      `${(core.clockHz / 1000000).toFixed(0)}MHz ${core.sleeping ? "sleep" : "run"}`;
    document.getElementById("socCoreState").textContent =
      `${core.pcHex}, SREG ${core.sregHex} ${core.sregFlags.length ? core.sregFlags.join("") : "-"}, cycles ${core.cycles}`;
    document.getElementById("socInterruptState").textContent =
      `${core.interruptsEnabled ? "I-bit on" : "I-bit off"}, pending ${soc.interrupts.pendingCount}, next ${soc.interrupts.next}`;
    document.getElementById("socSramState").textContent =
      `${mem.sramBytes} B SRAM @ ${hex4(mem.sramStart)}-${hex4(mem.sramEnd)}, touched ${mem.touchedSramBytes} B, nonzero ${mem.nonZeroSramBytes} B`;
    document.getElementById("socFlashState").textContent =
      `${flash.totalBytes} B flash, covered ${flash.coveredBytes} B, app free ${flash.appFreeBytes} B`;
    document.getElementById("socEepromState").textContent =
      `${eeprom.totalBytes} B EEPROM, written ${eeprom.writtenBytes} B, EEAR ${hex4(eeprom.eear)}`;
    document.getElementById("socStackState").textContent = mem.stackPointerOk
      ? `SP ${mem.spHex}, used ${mem.stackUsedBytes} B, free ${mem.stackFreeBytes} B`
      : `SP ${mem.spHex} outside SRAM`;
    document.getElementById("socStackPeakState").textContent =
      mem.stackPeakBytes === null ? "--" : `peak ${mem.stackPeakBytes} B since reset`;
    document.getElementById("socCacheState").textContent =
      "none, classic AVR Harvard core has no I/D cache";
    document.getElementById("socWdtState").textContent = wdt.enabled
      ? `${wdt.interruptEnable ? "WDIE" : ""}${wdt.resetEnable ? " WDE" : ""}, ${wdt.timeoutMs.toFixed(0)} ms, left ${wdt.remainingMs.toFixed(1)} ms, WDTCSR ${hex2(wdt.wdtcsr)}`
      : `off, WDTCSR ${hex2(wdt.wdtcsr)}, MCUSR ${hex2(wdt.mcusr)}`;
    document.getElementById("socTimerState").textContent =
      `T0 ${timerLine(timers.t0)} / T1 ${timerLine(timers.t1)} / T2 ${timerLine(timers.t2)}`;
  }

  applyFeatureDefaults() {
    const kind = document.getElementById("featureSelect").value;
    const defaults = FEATURE_DEFAULTS[kind] ?? FEATURE_DEFAULTS.ui;
    document.getElementById("featureItems").value = defaults.items;
    document.getElementById("featurePayloadKb").value = defaults.payloadKb;
    document.getElementById("featureStorage").value = defaults.storage;
  }

  featureLabValues() {
    const kind = document.getElementById("featureSelect").value;
    const defaults = FEATURE_DEFAULTS[kind] ?? FEATURE_DEFAULTS.ui;
    const payloadKb = clampNumber(Number(document.getElementById("featurePayloadKb").value), 0, 64, defaults.payloadKb);
    return {
      kind,
      label: FEATURE_LABELS[kind] ?? FEATURE_LABELS.ui,
      items: Math.round(clampNumber(Number(document.getElementById("featureItems").value), 1, 600, defaults.items)),
      payloadKb,
      payloadBytes: Math.round(payloadKb * 1024),
      storage: document.getElementById("featureStorage").value,
    };
  }

  updateFeatureLab(snapshot = null) {
    const values = this.featureLabValues();
    const estimate = this.estimateFeature(values, snapshot);
    const verdict = document.getElementById("featureVerdict");
    verdict.textContent = estimate.verdict;
    verdict.classList.toggle("bad", estimate.severity === "bad");
    verdict.classList.toggle("warn", estimate.severity === "warn");
    document.getElementById("featureFlashCost").textContent = estimate.flashLine;
    document.getElementById("featureRamCost").textContent = estimate.ramLine;
    document.getElementById("featureEepromCost").textContent = estimate.eepromLine;
    document.getElementById("featureNetworkCost").textContent = estimate.networkLine;
    document.getElementById("featureRefreshCost").textContent = estimate.refreshLine;
    document.getElementById("featureEnergyCost").textContent = estimate.energyLine;
    document.getElementById("featureNotes").textContent = estimate.notes.join(" / ");
    this.renderFeaturePreview(values, estimate);
  }

  estimateFeature(values, snapshot) {
    const flash = snapshot?.soc?.flash;
    const mem = snapshot?.soc?.memory;
    const eeprom = snapshot?.soc?.eeprom;
    const flashFree = flash?.appFreeBytes ?? 0;
    const ramFree = mem?.stackFreeBytes ?? 0;
    const eepromFree = eeprom?.erasedBytes ?? eeprom?.totalBytes ?? 0;
    const powerValues = this.powerControlValues();
    const power = snapshot?.power ?? {
      v3v3Mv: Math.min(3300, powerValues.mv),
      airBrownout: false,
      airWarn: false,
    };
    const model = this.featureCostModel(values);
    const totalFlashBytes = model.codeBytes + model.dataFlashBytes;
    const networkSeconds = model.networkBytes > 0
      ? model.attachSeconds + (model.networkBytes * 10) / model.uartBps + model.chunks * 0.12
      : 0;
    const txPulses = model.networkBytes > 0 ? Math.max(4, model.chunks * 2) : 0;
    const radioChargeMc = model.networkBytes > 0
      ? powerValues.sustain * networkSeconds + powerValues.pulse * (powerValues.pulseWidth / 1000) * txPulses
      : 0;
    const epdCurrentMa = model.refreshKind === "full" ? 16 : model.refreshMs > 0 ? 8 : 0;
    const epdChargeMc = epdCurrentMa * (model.refreshMs / 1000);
    const activeSeconds = Math.min(3, networkSeconds) + model.refreshMs / 1000 + model.cpuMs / 1000;
    const avrChargeMc = powerValues.avrActiveMa * activeSeconds;
    const totalChargeMc = radioChargeMc + epdChargeMc + avrChargeMc;
    const energyMj = totalChargeMc * ((power.v3v3Mv ?? 3300) / 1000);
    const notes = [...model.notes];
    let severity = "ok";
    let verdict = "AVR 可落地";

    if (!snapshot?.soc) {
      severity = "warn";
      verdict = "waiting for firmware";
      notes.unshift("等待固件快照后才能按真实余量判断");
    } else {
      const flashMargin = flashFree - totalFlashBytes;
      const ramMargin = ramFree - model.ramBytes;
      const eepromMargin = eepromFree - model.eepromBytes;
      if (flashMargin < 0) {
        severity = "bad";
        verdict = `Flash 超 ${formatBytes(-flashMargin)}`;
        notes.unshift("需要继续压缩代码/字体/字符串，或把数据移到 LTE 侧按需拉取");
      } else if (flashMargin < 1024) {
        severity = "warn";
        verdict = `Flash 余 ${formatBytes(flashMargin)}`;
        notes.unshift("固件仍能放下，但没有足够回滚余量");
      }
      if (eepromMargin < 0) {
        severity = "bad";
        verdict = `EEPROM 超 ${formatBytes(-eepromMargin)}`;
        notes.unshift("EEPROM 只能放状态/索引，不适合放图片或大词库");
      } else if (severity === "ok" && eepromMargin < 96) {
        severity = "warn";
        verdict = `EEPROM 余 ${formatBytes(eepromMargin)}`;
      }
      if (ramFree > 0 && ramMargin < 384) {
        severity = severity === "bad" ? "bad" : "warn";
        verdict = ramMargin < 0 ? `SRAM 超 ${formatBytes(-ramMargin)}` : `SRAM 栈余 ${formatBytes(ramMargin)}`;
        notes.unshift("运行期要避免大缓冲，优先逐字节渲染和窗口刷新");
      }
      if (values.kind === "ota") {
        severity = severity === "bad" ? "bad" : "warn";
        verdict = "固件 OTA 需暂存";
        notes.unshift("当前模型只建议 OTA-lite：远程配置/词库/图片；全量固件需要 SPM bootloader 和外部暂存");
      }
      if (model.networkBytes > 0 && (power.airBrownout || power.airWarn)) {
        severity = "bad";
        verdict = "LTE 电源风险";
        notes.unshift("当前电源模型下网络更新会碰到 VLTE 风险，先增大电容或降低脉冲");
      }
    }

    return {
      ...model,
      severity,
      verdict,
      notes,
      totalFlashBytes,
      networkSeconds,
      txPulses,
      totalChargeMc,
      flashLine: snapshot?.soc
        ? `${formatBytes(totalFlashBytes)} / free ${formatBytes(flashFree)} (${formatBytes(model.codeBytes)} code + ${formatBytes(model.dataFlashBytes)} data)`
        : `${formatBytes(totalFlashBytes)} estimated`,
      ramLine: snapshot?.soc
        ? `${formatBytes(model.ramBytes)} transient / stack free ${formatBytes(ramFree)}`
        : `${formatBytes(model.ramBytes)} transient`,
      eepromLine: snapshot?.soc
        ? `${formatBytes(model.eepromBytes)} / free ${formatBytes(eepromFree)}`
        : `${formatBytes(model.eepromBytes)} estimated`,
      networkLine: model.networkBytes > 0
        ? `${formatBytes(model.networkBytes)}, ${networkSeconds.toFixed(1)} s, ${txPulses} LTE burst pulses`
        : "none",
      refreshLine: model.refreshMs > 0
        ? `${model.refreshName}, ${formatBytes(model.refreshBytes)} window, ${model.refreshMs.toFixed(0)} ms`
        : "none",
      energyLine: `${totalChargeMc.toFixed(1)} mC, ${(totalChargeMc / 3600).toFixed(5)} mAh, ${energyMj.toFixed(1)} mJ`,
    };
  }

  featureCostModel(values) {
    const storage = values.storage;
    const items = values.items;
    const payloadBytes = values.payloadBytes;
    const chunks = Math.ceil(Math.max(payloadBytes, 0) / 384);
    const attachSeconds = this.lastSnapshot?.air?.mqttConnected ? 1.2 : 10.5;
    const common = {
      codeBytes: 0,
      dataFlashBytes: 0,
      ramBytes: 0,
      eepromBytes: 0,
      networkBytes: 0,
      refreshBytes: 0,
      refreshMs: 0,
      refreshKind: "none",
      refreshName: "no EPD refresh",
      cpuMs: 0,
      chunks,
      attachSeconds,
      uartBps: 9600,
      notes: [],
    };

    if (values.kind === "ui") {
      common.codeBytes = 820 + items * 150;
      common.dataFlashBytes = storage === "flash" ? items * 48 : storage === "hybrid" ? items * 18 : 0;
      common.ramBytes = 80 + Math.min(160, items * 10);
      common.eepromBytes = storage === "eeprom" || storage === "hybrid" ? 24 + items * 2 : 16;
      common.networkBytes = storage === "mqtt" ? payloadBytes : 0;
      common.refreshBytes = Math.min(EPD_FRAME_BYTES, 320 + items * 64);
      common.refreshMs = 450 + Math.min(400, items * 20);
      common.refreshKind = "partial";
      common.refreshName = "局刷 0x0f";
      common.cpuMs = 80 + items * 12;
      common.notes.push("适合做菜单/状态页，刷新应保持完整 old/new 基线");
      return common;
    }

    if (values.kind === "vocab") {
      common.codeBytes = 1180;
      common.dataFlashBytes =
        storage === "flash" ? items * 56 : storage === "hybrid" ? Math.ceil(items * 18) : 0;
      common.ramBytes = 128 + Math.min(180, Math.ceil(items / 4));
      common.eepromBytes = 24 + items * 4;
      common.networkBytes = storage === "mqtt" || storage === "hybrid" ? payloadBytes : 0;
      common.refreshBytes = 780;
      common.refreshMs = 620;
      common.refreshKind = "partial";
      common.refreshName = "词卡局刷";
      common.cpuMs = 140;
      common.notes.push("词条建议 UTF-8 压缩包远程下发，EEPROM 只存复习状态");
      return common;
    }

    if (values.kind === "image") {
      const perImageBytes = payloadBytes > 0 ? payloadBytes : EPD_FRAME_BYTES;
      common.codeBytes = 760;
      common.dataFlashBytes =
        storage === "flash" ? items * perImageBytes : storage === "hybrid" ? items * 384 + Math.min(2048, perImageBytes) : 0;
      common.ramBytes = 96 + (storage === "flash" ? 64 : 256);
      common.eepromBytes = 16 + items * (storage === "eeprom" ? 32 : 4);
      common.networkBytes = storage === "mqtt" || storage === "hybrid" ? perImageBytes : 0;
      common.refreshBytes = EPD_FRAME_BYTES;
      common.refreshMs = 2600;
      common.refreshKind = "full";
      common.refreshName = "整屏换图";
      common.cpuMs = 220;
      common.notes.push("2.9 黑白整帧 4736B，Flash 里多图很快吃满空间");
      if (storage === "eeprom") {
        common.notes.push("EEPROM 不适合存整图，只能放图片索引/校验");
      }
      return common;
    }

    if (values.kind === "ota") {
      common.codeBytes = 3600;
      common.dataFlashBytes = 0;
      common.ramBytes = 420;
      common.eepromBytes = 48;
      common.networkBytes = payloadBytes || 22 * 1024;
      common.cpuMs = 1800;
      common.notes.push("ATmega328P 全量固件 OTA 需要 bootloader SPM 和外部暂存/分块校验");
      common.notes.push("更现实的是远程配置、词库、图片素材更新");
      return common;
    }

    common.codeBytes = 2800;
    common.dataFlashBytes =
      storage === "flash" ? items * 56 + EPD_FRAME_BYTES : storage === "hybrid" ? Math.ceil(items * 18) + 1600 : 0;
    common.ramBytes = 320;
    common.eepromBytes = 64 + items * 4;
    common.networkBytes = storage === "mqtt" || storage === "hybrid" ? payloadBytes : 0;
    common.refreshBytes = EPD_FRAME_BYTES;
    common.refreshMs = 2800;
    common.refreshKind = "full";
    common.refreshName = "组合界面整刷";
    common.cpuMs = 460;
    common.notes.push("组合功能要先做资源预算，优先远程数据 + 本地状态索引");
    return common;
  }

  renderFeaturePreview(values, estimate) {
    const ctx = this.featurePreviewCtx;
    const { width, height } = prepareCanvasForDisplay(ctx);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#d9dacd";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(27, 36, 32, 0.06)";
    for (let y = 0; y < height; y += 6) {
      for (let x = (y / 6) % 2 === 0 ? 0 : 3; x < width; x += 6) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = "#141817";
    ctx.fillRect(0, 0, width, 24);
    ctx.fillStyle = "#f1f4ef";
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(values.label, 10, 16);
    ctx.fillStyle = estimate.severity === "bad" ? "#a72626" : estimate.severity === "warn" ? "#a34d18" : "#19706a";
    ctx.fillRect(width - 74, 7, 62, 10);
    ctx.fillStyle = "#141817";
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(estimate.severity.toUpperCase(), width - 68, 15);
    ctx.fillStyle = "#1b2420";

    if (values.kind === "vocab") {
      ctx.font = "bold 24px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("abandon", 18, 58);
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(`${values.items} cards  due today  12`, 18, 82);
      ctx.strokeRect(18, 94, width - 36, 14);
      ctx.fillRect(18, 94, Math.max(18, (width - 36) * 0.36), 14);
    } else if (values.kind === "image") {
      const left = 18;
      const top = 36;
      const cell = Math.max(7, Math.floor((height - 50) / 7));
      for (let row = 0; row < 7; row += 1) {
        for (let col = 0; col < 15; col += 1) {
          if ((row + col) % 3 === 0) {
            ctx.fillRect(left + col * cell, top + row * cell, cell, cell);
          }
        }
      }
      ctx.font = "bold 16px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(`slot 1/${values.items}`, width - 92, 70);
    } else if (values.kind === "ota") {
      ctx.font = "bold 18px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("OTA-lite", 18, 56);
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("config / assets / vocab", 18, 76);
      ctx.strokeRect(18, 92, width - 36, 16);
      ctx.fillRect(18, 92, Math.max(12, (width - 36) * 0.22), 16);
    } else if (values.kind === "combo") {
      ctx.font = "bold 14px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("HOME", 18, 48);
      ctx.fillText("WORD", 18, 72);
      ctx.fillText("PIC", 18, 96);
      ctx.strokeRect(86, 38, width - 112, 58);
      ctx.fillRect(98, 48, width - 136, 5);
      ctx.fillRect(98, 62, width - 160, 5);
      ctx.fillRect(98, 76, width - 128, 5);
    } else {
      ctx.font = "bold 16px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("12:25", 18, 54);
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("Review  Send  Settings", 18, 78);
      ctx.strokeRect(18, 92, width - 36, 18);
      ctx.fillText(`${values.items} pages`, 28, 105);
    }

    ctx.fillStyle = "#1b2420";
    ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.fillText(`${formatBytes(estimate.totalFlashBytes)} flash  ${formatBytes(estimate.ramBytes)} ram`, 10, height - 8);
  }

  renderFrames(snapshot) {
    const signature = [
      snapshot.epd.spiBytes,
      snapshot.epd.oldComplete ? 1 : 0,
      snapshot.epd.newComplete ? 1 : 0,
      snapshot.epd.visibleComplete ? 1 : 0,
      snapshot.epd.busy ? 1 : 0,
      snapshot.epd.refreshActive ? 1 : 0,
      snapshot.epd.updateControl,
      snapshot.epd.partialFault ? 1 : 0,
    ].join(":");
    if (signature === this.lastFrameSignature && !snapshot.epd.refreshActive) {
      return;
    }
    this.lastFrameSignature = signature;
    this.drawRotatedFrame(this.ctx, this.sim.imageData("visible"));
    this.drawRotatedFrame(this.ramContexts.visible, this.sim.imageData("visible", { visualEffect: false }));
    this.drawRotatedFrame(this.ramContexts.old, this.sim.imageData("old"));
    this.drawRotatedFrame(this.ramContexts.new, this.sim.imageData("new"));
    this.drawEpdDifferential(snapshot);
    if (snapshot.epd.refreshActive && !this.renderLoopActive) {
      this.renderLoopActive = true;
      this.renderLoopHandle = window.setInterval(() => this.renderRefreshEffect(), 80);
    } else if (!snapshot.epd.refreshActive && this.renderLoopActive) {
      window.clearInterval(this.renderLoopHandle);
      this.renderLoopActive = false;
    }
  }

  drawMemoryMap(snapshot) {
    this.drawSramMap(snapshot);
    this.drawFlashMap(snapshot);
    this.drawEepromMap(snapshot);
  }

  drawSramMap(snapshot) {
    const mem = snapshot.soc?.memory;
    if (!mem?.bytes) {
      return;
    }
    const bytes = Array.from(mem.bytes);
    const touched = Array.from(mem.touched ?? []);
    const spOffset = mem.stackPointerOk ? mem.sp - mem.sramStart : -1;
    const peakOffset =
      mem.stackLowWaterSp === null || mem.stackLowWaterSp === undefined
        ? -1
        : mem.stackLowWaterSp - mem.sramStart;
    this.drawByteMap(this.memoryMapCtx, "sram", {
      bytes,
      startAddr: mem.sramStart,
      totalBytes: mem.sramBytes,
      cols: 64,
      rows: 32,
      title: "SRAM data space",
      subtitle: "1 byte/cell, 64 B/row",
      rowLabelEvery: 4,
      majorLineEvery: 256,
      colorFor: (value, index) => {
        const wasTouched = touched[index] === 1;
        const isCurrentStack = spOffset >= 0 && index > spOffset;
        const isPeakStack = peakOffset >= 0 && index > peakOffset;
        let fill = value === 0 ? (wasTouched ? "#263f3a" : "#141918") : memoryValueColor(value);
        if (isPeakStack) {
          fill = blendHex(fill, "#a34d18", 0.42);
        }
        if (isCurrentStack) {
          fill = blendHex(fill, "#19706a", 0.62);
        }
        return fill;
      },
      markers: [
        {
          offset: spOffset,
          color: "#f0d35a",
          label: "SP",
        },
      ],
      regions: this.symbolRegions(this.firmwareSymbols.sram, 12, "sram"),
      meta: {
        kind: "sram",
        touched,
        symbols: this.firmwareSymbols.sram ?? [],
      },
    });

    document.getElementById("memoryMapState").textContent =
      `${mem.nonZeroSramBytes}/${mem.sramBytes} B nonzero`;
    document.getElementById("memoryMapRange").textContent =
      `${hex4(mem.sramStart)}-${hex4(mem.sramEnd)}, byte accurate`;
    document.getElementById("memoryMapUsage").textContent =
      `nonzero ${mem.nonZeroSramBytes} B, touched ${mem.touchedSramBytes} B, touched zero ${mem.touchedZeroBytes} B, initial/unchanged ${mem.untouchedSramBytes} B`;
    document.getElementById("memoryMapStack").textContent = mem.stackPointerOk
      ? `SP ${mem.spHex}, stack ${mem.stackUsedBytes} B, free ${mem.stackFreeBytes} B, peak ${mem.stackPeakBytes} B`
      : `SP ${mem.spHex} outside SRAM`;
    document.getElementById("memoryMapSymbols").textContent =
      this.formatSymbolSummary(this.firmwareSymbols.sram, "largest SRAM objects");
  }

  drawFlashMap(snapshot) {
    const flash = snapshot.soc?.flash;
    if (!flash?.bytes) {
      return;
    }
    const bytes = Array.from(flash.bytes);
    const covered = Array.from(flash.covered ?? []);
    this.drawByteMap(this.flashMapCtx, "flash", {
      bytes,
      startAddr: flash.start,
      totalBytes: flash.totalBytes,
      cols: 256,
      rows: 128,
      title: "Flash program memory",
      subtitle: "1 byte/cell, 256 B/row",
      rowLabelEvery: 16,
      majorLineEvery: 4096,
      colorFor: (value, index) => {
        const isCovered = covered[index] === 1;
        if (index >= flash.bootStart) {
          if (!isCovered) {
            return "#2d2417";
          }
          return value === 0xff
            ? "#6d7068"
            : blendHex(memoryValueColor(value), "#b35b1e", 0.48);
        }
        if (!isCovered) {
          return "#151a19";
        }
        return value === 0xff ? "#6d7973" : flashByteColor(value, index);
      },
      markers: [
        {
          offset: flash.pcByte,
          color: "#f0d35a",
          label: "PC",
        },
      ],
      bands: [
        {
          offset: flash.bootStart,
          color: "#b35b1e",
          label: "BOOT",
        },
      ],
      regions: this.symbolRegions(this.topSymbols(this.firmwareSymbols.flash, 28), 96, "flash"),
      meta: {
        kind: "flash",
        symbols: this.firmwareSymbols.flash ?? [],
      },
    });

    document.getElementById("flashMapState").textContent =
      `${flash.coveredBytes}/${flash.totalBytes} B covered`;
    document.getElementById("flashMapRange").textContent =
      `${hex4(flash.start)}-${hex4(flash.end)}, app ${hex4(flash.appStart)}-${hex4(flash.appEnd)}, boot ${hex4(flash.bootStart)}-${hex4(flash.bootEnd)}`;
    document.getElementById("flashMapUsage").textContent =
      `covered ${flash.coveredBytes} B, non-0xff ${flash.nonFfBytes} B, covered 0xff ${flash.coveredFfBytes} B, app free ${flash.appFreeBytes} B`;
    document.getElementById("flashMapPc").textContent =
      `PC word ${snapshot.soc.core.pcHex}, byte ${flash.pcByteHex}`;
    document.getElementById("flashMapSymbols").textContent =
      this.formatSymbolSummary(this.firmwareSymbols.flash, "largest flash functions");
  }

  drawEepromMap(snapshot) {
    const eeprom = snapshot.soc?.eeprom;
    if (!eeprom?.bytes) {
      return;
    }
    const bytes = Array.from(eeprom.bytes);
    this.drawByteMap(this.eepromMapCtx, "eeprom", {
      bytes,
      startAddr: eeprom.start,
      totalBytes: eeprom.totalBytes,
      cols: 64,
      rows: 16,
      title: "EEPROM nonvolatile array",
      subtitle: "1 byte/cell, 64 B/row",
      rowLabelEvery: 2,
      majorLineEvery: 128,
      colorFor: (value) => (value === 0xff ? "#191d1c" : eepromByteColor(value)),
      markers: [
        {
          offset: eeprom.eear,
          color: "#f0d35a",
          label: "EEAR",
        },
      ],
    });

    document.getElementById("eepromMapState").textContent =
      `${eeprom.writtenBytes}/${eeprom.totalBytes} B written`;
    document.getElementById("eepromMapRange").textContent =
      `${hex4(eeprom.start)}-${hex4(eeprom.end)}, erased byte = 0xff`;
    document.getElementById("eepromMapUsage").textContent =
      `written ${eeprom.writtenBytes} B, erased ${eeprom.erasedBytes} B`;
    document.getElementById("eepromMapRegs").textContent =
      `EEAR ${hex4(eeprom.eear)}, EEDR ${hex2(eeprom.eedr)}, EECR ${hex2(eeprom.eecr)}${eeprom.writeBusy ? ", write busy" : ""}`;
  }

  drawByteMap(ctx, key, options) {
    const {
      bytes,
      startAddr,
      totalBytes,
      cols,
      rows,
      title,
      subtitle,
      rowLabelEvery,
      majorLineEvery,
      colorFor,
      markers = [],
      bands = [],
      regions = [],
    } = options;
    const { width, height } = prepareCanvasForDisplay(ctx);
    const margin = { left: 68, top: 34, right: 10, bottom: 24 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const cellW = plotW / cols;
    const cellH = plotH / rows;
    const count = Math.min(totalBytes, cols * rows, bytes.length);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#101513";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "11px Consolas, ui-monospace, monospace";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#d9e3de";
    ctx.fillText(title, margin.left, 15);
    ctx.fillStyle = "#91a19a";
    ctx.fillText(subtitle, margin.left, 29);
    ctx.fillText(hex4(startAddr), margin.left, height - 7);
    ctx.fillText(hex4(startAddr + totalBytes - 1), width - margin.right - 48, height - 7);
    ctx.fillText("+00", margin.left, margin.top - 4);
    ctx.fillText(`+${(cols - 1).toString(16).padStart(2, "0")}`, width - margin.right - 26, margin.top - 4);

    ctx.strokeStyle = "#26322f";
    ctx.lineWidth = 1;
    for (let offset = majorLineEvery; offset < totalBytes; offset += majorLineEvery) {
      const row = Math.floor(offset / cols);
      const y = margin.top + row * cellH;
      if (y >= margin.top && y <= margin.top + plotH) {
        ctx.beginPath();
        ctx.moveTo(margin.left, Math.round(y) + 0.5);
        ctx.lineTo(margin.left + plotW, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }

    for (let row = 0; row < rows; row += 1) {
      if (row % rowLabelEvery === 0) {
        ctx.fillStyle = "#91a19a";
        ctx.fillText(hex4(startAddr + row * cols), 6, margin.top + row * cellH + Math.max(8, cellH));
      }
    }

    for (let i = 0; i < count; i += 1) {
      const x = margin.left + (i % cols) * cellW;
      const y = margin.top + Math.floor(i / cols) * cellH;
      ctx.fillStyle = colorFor(bytes[i], i);
      ctx.fillRect(x, y, Math.max(1, cellW - 0.35), Math.max(1, cellH - 0.35));
    }

    for (const band of bands) {
      if (band.offset < 0 || band.offset >= totalBytes) {
        continue;
      }
      const row = Math.floor(band.offset / cols);
      const y = margin.top + row * cellH;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = band.color;
      ctx.fillText(band.label, margin.left + 4, Math.max(margin.top + 10, y - 4));
    }

    for (const region of regions) {
      this.drawMemoryRegion(ctx, region, {
        cols,
        count,
        cellW,
        cellH,
        margin,
        plotW,
        plotH,
        width,
      });
    }

    for (const marker of markers) {
      if (marker.offset < 0 || marker.offset >= totalBytes) {
        continue;
      }
      const x = margin.left + (marker.offset % cols) * cellW;
      const y = margin.top + Math.floor(marker.offset / cols) * cellH;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cellW - 1), Math.max(1, cellH - 1));
      ctx.fillStyle = marker.color;
      ctx.fillText(marker.label, Math.min(width - margin.right - 26, x + 3), Math.max(10, y - 3));
    }

    ctx.strokeStyle = "#66746d";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left - 0.5, margin.top - 0.5, plotW + 1, plotH + 1);
    this.memoryMapLayouts[key] = {
      margin,
      plotW,
      plotH,
      cols,
      rows,
      cellW,
      cellH,
      startAddr,
      totalBytes,
      bytes,
      meta: options.meta ?? null,
    };
  }

  drawMemoryRegion(ctx, region, layout) {
    const { cols, count, cellW, cellH, margin, plotW, plotH, width } = layout;
    const start = Math.max(0, Number(region.offset) || 0);
    const end = Math.min(count, start + Math.max(1, Number(region.size) || 1));
    if (end <= start) {
      return;
    }

    const startRow = Math.floor(start / cols);
    const endRow = Math.floor((end - 1) / cols);
    ctx.save();
    ctx.strokeStyle = region.color;
    ctx.fillStyle = region.color;
    ctx.lineWidth = 1.5;
    ctx.font = "10px Consolas, ui-monospace, monospace";
    ctx.textBaseline = "alphabetic";

    for (let row = startRow; row <= endRow; row += 1) {
      const rowStart = Math.max(start, row * cols);
      const rowEnd = Math.min(end, (row + 1) * cols);
      const x = margin.left + (rowStart % cols) * cellW;
      const y = margin.top + row * cellH;
      const w = Math.max(2, (rowEnd - rowStart) * cellW);
      if (y < margin.top || y > margin.top + plotH) {
        continue;
      }
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, cellH - 1));
    }

    if (region.label) {
      const x = margin.left + (start % cols) * cellW + 3;
      const y = margin.top + startRow * cellH;
      ctx.fillText(region.label, Math.min(width - 96, x), Math.max(margin.top + 11, y - 3));
    }
    ctx.restore();
  }

  symbolRegions(symbols, minSize, paletteName) {
    const palette =
      paletteName === "flash"
        ? ["#5fb3c4", "#cf8e3f", "#8f9d3f", "#b28fe8", "#66a16b"]
        : ["#62b9cc", "#d69a45", "#c7b342", "#9f8dde", "#77b174"];
    const labelMinSize = paletteName === "flash" ? 256 : 96;
    return (symbols ?? [])
      .filter((symbol) => symbol.size >= minSize)
      .map((symbol, index) => ({
        offset: symbol.offset,
        size: symbol.size,
        color: palette[index % palette.length],
        label: symbol.size >= labelMinSize ? this.shortSymbolName(symbol.name) : "",
      }));
  }

  formatSymbolSummary(symbols, fallback) {
    if (!this.firmwareSymbols.ok) {
      return this.firmwareSymbols.error || "symbols unavailable";
    }
    const top = this.topSymbols(symbols, 5);
    if (!top.length) {
      return fallback;
    }
    return top.map((item) => `${this.shortSymbolName(item.name)} ${item.size} B @${item.addressHex}`).join(", ");
  }

  shortSymbolName(name) {
    return String(name)
      .replace(/\s*\[clone.*\]$/, "")
      .replace(/\(.*\)/, "()")
      .replace(/^.*::/, "")
      .slice(0, 22);
  }

  updateMemoryHover(key, outId, event) {
    const layout = this.memoryMapLayouts[key];
    if (!layout) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const col = Math.floor((x - layout.margin.left) / layout.cellW);
    const row = Math.floor((y - layout.margin.top) / layout.cellH);
    const index = row * layout.cols + col;
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows || index >= layout.totalBytes) {
      document.getElementById(outId).textContent = "--";
      return;
    }
    const value = layout.bytes[index] ?? 0xff;
    const symbol = this.symbolAt(layout.meta?.symbols, index);
    const extra =
      layout.meta?.kind === "sram"
        ? `, ${layout.meta.touched?.[index] === 1 ? "touched" : "initial/unchanged"}`
        : "";
    document.getElementById(outId).textContent =
      `${hex4(layout.startAddr + index)} = ${hex2(value)}${extra}${symbol ? `, ${this.shortSymbolName(symbol.name)}+${hex4(index - symbol.offset)}` : ""} (${key.toUpperCase()} offset ${hex4(index)})`;
  }

  symbolAt(symbols, index) {
    return (symbols ?? []).find((symbol) => index >= symbol.offset && index < symbol.offset + symbol.size);
  }

  renderRefreshEffect() {
    const snapshot = this.sim.snapshot();
    this.drawRotatedFrame(this.ctx, this.sim.imageData("visible"));
    this.drawEpdDifferential(snapshot);
    if (!snapshot.epd.refreshActive) {
      window.clearInterval(this.renderLoopHandle);
      this.renderLoopActive = false;
      this.update(snapshot);
    }
  }

  drawRotatedFrame(ctx, imageData) {
    const scratch = this.scratchCanvas || document.createElement("canvas");
    this.scratchCanvas = scratch;
    scratch.width = imageData.width;
    scratch.height = imageData.height;
    scratch.getContext("2d").putImageData(imageData, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.translate(0, ctx.canvas.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  drawEpdDifferential(snapshot) {
    const oldImage = this.sim.imageData("old");
    const newImage = this.sim.imageData("new");
    const image = new ImageData(oldImage.width, oldImage.height);
    const data = image.data;
    const oldData = oldImage.data;
    const newData = newImage.data;
    let whiteToBlack = 0;
    let blackToWhite = 0;
    let invalid = 0;
    for (let i = 0; i < data.length; i += 4) {
      const oldInvalid = oldData[i + 1] !== oldData[i] || oldData[i + 2] !== oldData[i];
      const newInvalid = newData[i + 1] !== newData[i] || newData[i + 2] !== newData[i];
      const oldBlack = oldData[i] < 128;
      const newBlack = newData[i] < 128;
      let r = 135;
      let g = 146;
      let b = 140;
      if (oldInvalid || newInvalid) {
        r = 179;
        g = 91;
        b = 30;
        invalid += 1;
      } else if (!oldBlack && newBlack) {
        r = 18;
        g = 24;
        b = 22;
        whiteToBlack += 1;
      } else if (oldBlack && !newBlack) {
        r = 241;
        g = 244;
        b = 239;
        blackToWhite += 1;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    this.drawRotatedFrame(this.diffCtx, image);
    this.drawDiffAreaOverlay(this.diffCtx, snapshot.epd.refreshEffect?.area ?? snapshot.epd.memoryArea);
    this.drawEpdWaveform(snapshot);

    const diff = snapshot.epd.diff ?? {};
    const prereq = snapshot.epd.partialPrereq ?? {};
    const area = snapshot.epd.refreshEffect?.area ?? snapshot.epd.memoryArea;
    const command = snapshot.epd.command === null ? "--" : hex2(snapshot.epd.command);
    document.getElementById("epdUpdateState").textContent =
      `R22 ${hex2(snapshot.epd.updateControl)}, cmd ${command}, LUT ${snapshot.epd.lutMode}, ${snapshot.epd.awake ? "standby/RAM-access" : "deep sleep/reset; HWRESET before data"}`;
    document.getElementById("epdPartialPrereq").textContent =
      `${prereq.ok ? "OK" : "blocked"}: LUT ${prereq.partialLut ? "partial" : "no"}, Mode2 ${prereq.mode2Ready ? "ready" : "no"}, 0x26/base ${prereq.oldComplete ? "complete" : "invalid"}, BW ${prereq.newComplete ? "complete" : "invalid"}, base=visible ${prereq.oldMatchesVisible ? "yes" : "no"}`;
    document.getElementById("epdWindowState").textContent =
      `X bytes ${area.xStart}-${area.xEnd} (${area.xStart * 8}-${area.xEnd * 8 + 7}px), Y ${area.yStart}-${area.yEnd}`;
    document.getElementById("epdDiffState").textContent =
      `changed ${diff.changedPixels ?? whiteToBlack + blackToWhite}px, W->B ${diff.whiteToBlack ?? whiteToBlack}, B->W ${diff.blackToWhite ?? blackToWhite}, invalid bytes ${diff.invalidBytes ?? Math.ceil(invalid / 8)}`;
  }

  drawDiffAreaOverlay(ctx, area) {
    if (!area) {
      return;
    }
    const canvas = ctx.canvas;
    const sx = canvas.width / 296;
    const sy = canvas.height / 128;
    const rawX = area.yStart;
    const rawY = 127 - (area.xEnd * 8 + 7);
    const rawW = area.yEnd - area.yStart + 1;
    const rawH = (area.xEnd - area.xStart + 1) * 8;
    ctx.save();
    ctx.strokeStyle = "#19706a";
    ctx.lineWidth = Math.max(1, Math.round(canvas.width / 296));
    ctx.strokeRect(rawX * sx, rawY * sy, rawW * sx, rawH * sy);
    ctx.restore();
  }

  drawEpdWaveform(snapshot) {
    const ctx = this.waveCtx;
    const { width, height } = prepareCanvasForDisplay(ctx);
    const effect = snapshot.epd.refreshEffect;
    const phase = effect ? effect.phase : 0;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#101513";
    ctx.fillRect(0, 0, width, height);
    const margin = { left: 58, top: 18, right: 16, bottom: 32 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const lanes = [
      { name: "VCOM", color: "#d5b93f", amp: 0.85, phase: 0 },
      { name: "BLACK", color: "#e7ece8", amp: 0.72, phase: 0.23 },
      { name: "WHITE", color: "#6a7470", amp: 0.58, phase: 0.52 },
      { name: "SCAN", color: "#19706a", amp: 0.42, phase: 0.12 },
    ];
    ctx.strokeStyle = "#26322f";
    ctx.lineWidth = 1;
    ctx.font = "11px Consolas, ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i < lanes.length; i += 1) {
      const y = margin.top + (plotH * (i + 0.5)) / lanes.length;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
      ctx.fillStyle = "#91a19a";
      ctx.fillText(lanes[i].name, 10, y);
      this.drawWaveLane(ctx, lanes[i], margin.left, y, plotW, plotH / lanes.length, phase, effect);
    }
    const cursorX = margin.left + plotW * phase;
    ctx.strokeStyle = effect?.fault ? "#b35b1e" : "#d5b93f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, margin.top);
    ctx.lineTo(cursorX, height - margin.bottom);
    ctx.stroke();
    ctx.fillStyle = "#d9e3de";
    const mode = effect ? `${effect.mode}${effect.partial ? " differential" : " full waveform"}` : "idle";
    ctx.fillText(`SSD1680 ${mode}  phase ${(phase * 100).toFixed(0)}%`, margin.left, height - 14);
    ctx.fillStyle = effect?.fault ? "#ffcf9a" : "#91a19a";
    ctx.fillText(
      effect?.fault
        ? "fault: LUT/base SRAM/visible state invalid"
        : effect?.partial
          ? "partial: R22=0x0f uses old/new differential area"
          : "full: R22=0xc7 drives BW RAM over full glass",
      margin.left + 220,
      height - 14,
    );
  }

  drawWaveLane(ctx, lane, x, y, width, laneHeight, phase, effect) {
    const amp = laneHeight * lane.amp * 0.32;
    ctx.strokeStyle = lane.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i <= width; i += 1) {
      const t = i / width;
      const activeWindow = effect?.partial ? smoothPulse(t, 0.12, 0.84) : smoothPulse(t, 0.04, 0.96);
      const settle = Math.max(0, 1 - t);
      const wave =
        Math.sin((t * (effect?.partial ? 4.5 : 8.5) + lane.phase) * Math.PI * 2) *
        amp *
        activeWindow *
        (0.35 + 0.65 * settle);
      const rowKick = lane.name === "SCAN" ? Math.sin((t - phase) * Math.PI * 18) * amp * 0.36 : 0;
      const py = y + wave + rowKick;
      if (i === 0) {
        ctx.moveTo(x + i, py);
      } else {
        ctx.lineTo(x + i, py);
      }
    }
    ctx.stroke();
  }

  setButtonUi(name, stateId, probeId, high, pinName) {
    const text = `${high ? "HIGH" : "LOW"}, ${pinName}`;
    document.getElementById(stateId).textContent = text;
    const probe = document.getElementById(probeId);
    probe.textContent = `${name} ${high ? "HIGH" : "LOW"}`;
    probe.classList.toggle("low", !high);
  }

  syncAirOptions() {
    this.sim.setAirOptions({
      failAttach: document.getElementById("failAttach").checked,
      failMqtt: document.getElementById("failMqtt").checked,
      rxMessage: document.getElementById("rxMessage").value,
      datePayload: document.getElementById("datePayload").value,
    });
  }

  updateDatePayloadFromInputs() {
    const exam = new Date(`${document.getElementById("examDateInput").value}T00:00:00`);
    const meet = new Date(`${document.getElementById("meetDateInput").value}T00:00:00`);
    if (Number.isNaN(exam.getTime()) || Number.isNaN(meet.getTime())) {
      return;
    }
    const payload =
      `${String(exam.getFullYear()).slice(2)}${pad2(exam.getMonth() + 1)}${pad2(exam.getDate())},` +
      `${String(meet.getFullYear()).slice(2)}${pad2(meet.getMonth() + 1)}${pad2(meet.getDate())}`;
    document.getElementById("datePayload").value = payload;
    this.syncAirOptions();
  }

  updatePowerControls(snapshot = null) {
    const controls = this.powerControlValues();
    const {
      mv,
      batteryCount,
      r,
      temperatureC,
      continuousLimitMa,
      pulseLimitMa,
      pulse,
      sustain,
      pulseWidth,
      supercapF,
      supercapCount,
      chargeR,
      chargeResistorCount,
      supercapEsr,
      supercapLeakage,
      diode,
      supplySwitchR,
      burstGlitch,
      measurementNoise,
      avrActiveMa,
      avrSleepUa,
    } = controls;
    const loaded = snapshot?.power.vlteMv ?? Math.round(mv - (r * pulse) / 1000);
    document.getElementById("batteryMvOut").textContent = `${mv} mV`;
    document.getElementById("batteryCountOut").textContent =
      `${batteryCount} cells, eq R ${(r / batteryCount).toFixed(0)} mΩ`;
    document.getElementById("internalResistanceOut").textContent = `${r} mΩ / cell`;
    document.getElementById("batteryTemperatureOut").textContent = `${temperatureC} C`;
    document.getElementById("batteryContinuousLimitOut").textContent = `${continuousLimitMa} mA`;
    document.getElementById("batteryPulseLimitOut").textContent = `${pulseLimitMa} mA`;
    document.getElementById("airPulseOut").textContent = `${pulse} mA`;
    document.getElementById("airSustainOut").textContent = `${sustain} mA`;
    document.getElementById("airPulseWidthOut").textContent = `${pulseWidth.toFixed(2)} ms`;
    document.getElementById("supercapFOut").textContent = `${supercapF.toFixed(2)} F`;
    document.getElementById("supercapCountOut").textContent = `${supercapCount} pcs, eq ${(supercapF * supercapCount).toFixed(2)} F`;
    document.getElementById("supercapChargeROut").textContent = `${chargeR} Ω`;
    document.getElementById("chargeResistorCountOut").textContent =
      `${chargeResistorCount} pcs, eq ${(chargeR / chargeResistorCount).toFixed(2)} Ω`;
    document.getElementById("supercapEsrOut").textContent = `${supercapEsr} mΩ`;
    document.getElementById("supercapLeakageOut").textContent = `${supercapLeakage} uA`;
    document.getElementById("supercapDiodeOut").textContent = `${diode} mV`;
    document.getElementById("supplySwitchROut").textContent = `${supplySwitchR} mΩ`;
    document.getElementById("burstGlitchOut").textContent = `${burstGlitch} mV`;
    document.getElementById("measurementNoiseOut").textContent = `${measurementNoise} mV`;
    document.getElementById("avrActiveMaOut").textContent = `${avrActiveMa.toFixed(1)} mA`;
    document.getElementById("avrSleepUaOut").textContent = `${avrSleepUa} uA`;
    document.getElementById("droopState").textContent =
      snapshot
        ? `${snapshot.power.vlteMv} mV, load ${Math.round(snapshot.power.loadCurrentMa)} mA, uv ${snapshot.power.airUndervoltageMs} ms`
        : `${loaded} mV under pulse`;
    document.getElementById("v3v3State").textContent = snapshot
      ? `${snapshot.power.v3v3Mv} mV, dropout ${snapshot.power.ldoDropoutMv} mV`
      : "model pending";
    document.getElementById("supercapState").textContent = snapshot
      ? `${snapshot.power.supercapMv} mV, ${snapshot.power.capSupplying ? "supplying LTE" : `charge ${snapshot.power.chargeCurrentMa} mA`}`
      : "model pending";
    document.getElementById("batteryCurrentState").textContent = snapshot
      ? `${snapshot.power.batteryCurrentMa} mA, limit ${Math.round((snapshot.power.txPulseWindow ? snapshot.power.effectivePulseLimitMa : snapshot.power.effectiveContinuousLimitMa) * snapshot.power.temperatureDerating)} mA`
      : "model pending";
    document.getElementById("supercapCurrentState").textContent = snapshot
      ? `${snapshot.power.supercapCurrentMa} mA, ESR ${snapshot.power.supercapEsrMohm} mΩ`
      : "model pending";
    document.getElementById("airPowerEventState").textContent = snapshot
      ? `${snapshot.power.eventCurrentMa} mA, ${snapshot.power.activeEvents.length ? snapshot.power.activeEvents.join("+") : "idle"}, EPD ${snapshot.power.epdAwake ? `${snapshot.power.epdRetainUa}uA standby/RAM` : `${snapshot.power.epdSleepUa}uA deep sleep`}`
      : "model pending";
    document.getElementById("pulseValleyState").textContent = snapshot
      ? `${snapshot.power.predictedPulseVlteMv} mV, ${snapshot.power.plantSource} plant`
      : "model pending";
    const power = document.getElementById("powerState");
    if (snapshot?.power.airBrownout) {
      power.textContent = "AIR780 BROWNOUT";
    } else if (snapshot?.power.airWarn || loaded < LOW_BATTERY_MV) {
      power.textContent = "VLTE WARN";
    } else {
      power.textContent = "VLTE OK";
    }
    power.classList.toggle("bad", !!snapshot?.power.airBrownout);
    power.classList.toggle("warn", !snapshot?.power.airBrownout && (snapshot?.power.airWarn || loaded < 3400));
    const shouldSync =
      !snapshot ||
      snapshot.power.batteryMv !== mv ||
      snapshot.power.batteryCount !== batteryCount ||
      snapshot.power.internalResistanceMohm !== r ||
      snapshot.power.temperatureC !== temperatureC ||
      snapshot.power.continuousLimitMa !== continuousLimitMa ||
      snapshot.power.pulseLimitMa !== pulseLimitMa ||
      snapshot.power.airPulseMa !== pulse ||
      snapshot.power.airSustainMa !== sustain ||
      snapshot.power.txPulseMs !== pulseWidth ||
      snapshot.power.unitSupercapF !== supercapF ||
      snapshot.power.supercapCount !== supercapCount ||
      snapshot.power.unitChargeOhms !== chargeR ||
      snapshot.power.chargeResistorCount !== chargeResistorCount ||
      snapshot.power.supercapEsrMohm !== supercapEsr ||
      snapshot.power.supercapLeakageUa !== supercapLeakage ||
      snapshot.power.diodeDropMv !== diode ||
      snapshot.power.switchResistanceMohm !== supplySwitchR ||
      snapshot.power.burstGlitchMv !== burstGlitch ||
      snapshot.power.measurementNoiseMv !== measurementNoise ||
      snapshot.power.avrActiveMa !== avrActiveMa ||
      snapshot.power.avrSleepUa !== avrSleepUa;
    if (shouldSync) {
      this.sim.configurePowerModel({
        batteryMv: mv,
        batteryCount,
        internalResistanceMohm: r,
        temperatureC,
        continuousLimitMa,
        pulseLimitMa,
        airPulseMa: pulse,
        airSustainMa: sustain,
        txPulseMs: pulseWidth,
        unitCapacitanceF: supercapF,
        supercapCount,
        unitChargeOhms: chargeR,
        chargeResistorCount,
        supercapEsrMohm: supercapEsr,
        supercapLeakageUa: supercapLeakage,
        diodeDropMv: diode,
        switchResistanceMohm: supplySwitchR,
        burstGlitchMv: burstGlitch,
        measurementNoiseMv: measurementNoise,
        avrActiveMa,
        avrSleepUa,
      });
    } else if (snapshot && (snapshot.power.loadCurrentMa > 0 || snapshot.power.chargeCurrentMa > 0)) {
      window.setTimeout(() => this.updatePowerControls(this.sim.snapshot()), 250);
    }
    if (snapshot) {
      this.recordPowerSample(snapshot);
      this.drawPowerScope(snapshot);
    }
  }

  powerControlValues() {
    return {
      mv: Number(document.getElementById("batteryMv").value),
      batteryCount: Number(document.getElementById("batteryCount").value),
      r: Number(document.getElementById("internalResistance").value),
      temperatureC: Number(document.getElementById("batteryTemperature").value),
      continuousLimitMa: Number(document.getElementById("batteryContinuousLimit").value),
      pulseLimitMa: Number(document.getElementById("batteryPulseLimit").value),
      pulse: Number(document.getElementById("airPulse").value),
      sustain: Number(document.getElementById("airSustain").value),
      pulseWidth: Number(document.getElementById("airPulseWidth").value),
      supercapF: Number(document.getElementById("supercapF").value),
      supercapCount: Number(document.getElementById("supercapCount").value),
      chargeR: Number(document.getElementById("supercapChargeR").value),
      chargeResistorCount: Number(document.getElementById("chargeResistorCount").value),
      supercapEsr: Number(document.getElementById("supercapEsr").value),
      supercapLeakage: Number(document.getElementById("supercapLeakage").value),
      diode: Number(document.getElementById("supercapDiode").value),
      supplySwitchR: Number(document.getElementById("supplySwitchR").value),
      burstGlitch: Number(document.getElementById("burstGlitch").value),
      measurementNoise: Number(document.getElementById("measurementNoise").value),
      avrActiveMa: Number(document.getElementById("avrActiveMa").value),
      avrSleepUa: Number(document.getElementById("avrSleepUa").value),
    };
  }

  ltspiceQuery() {
    const values = this.powerControlValues();
    return new URLSearchParams({
      batteryMv: values.mv,
      batteryCount: values.batteryCount,
      internalResistanceMohm: values.r,
      continuousLimitMa: values.continuousLimitMa,
      pulseLimitMa: values.pulseLimitMa,
      unitCapacitanceF: values.supercapF,
      supercapCount: values.supercapCount,
      unitChargeOhms: values.chargeR,
      chargeResistorCount: values.chargeResistorCount,
      supercapEsrMohm: values.supercapEsr,
      airPulseMa: values.pulse,
      airSustainMa: values.sustain,
      txPulseMs: values.pulseWidth,
      switchResistanceMohm: values.supplySwitchR,
      diodeDropMv: values.diode,
    });
  }

  async runLtspicePowerCheck() {
    const state = document.getElementById("ltspiceState");
    const detail = document.getElementById("ltspiceDetail");
    document.getElementById("backendState").textContent = "LTspice running";
    state.textContent = "running batch transient...";
    detail.textContent = "--";
    try {
      const response = await fetch(`/api/ltspice/power?${this.ltspiceQuery().toString()}`, { cache: "no-store" });
      const result = await response.json();
      if (!result.ok) {
        state.textContent = result.error || `failed rc ${result.returncode}`;
        detail.textContent = result.backends?.ltspice?.available ? "LTspice found, transient failed" : "LTspice executable not found";
        document.getElementById("backendState").textContent = "LTspice failed";
        return;
      }
      const eff = result.effective;
      state.textContent = `ok, ${result.elapsedMs} ms, raw ${result.rawProduced ? "yes" : "no"}`;
      detail.textContent =
        `C ${eff.capacitanceF.toFixed(2)}F / Rbat ${eff.batteryInternalOhms.toFixed(3)}Ω / Rchg ${eff.chargeOhms.toFixed(2)}Ω / Icont ${(eff.continuousLimitA * 1000).toFixed(0)}mA`;
      document.getElementById("backendState").textContent = "LTspice verified";
      this.log.add(`LTspice transient ok: ${state.textContent}`);
    } catch (error) {
      state.textContent = `request failed: ${error.message}`;
      detail.textContent = "--";
      document.getElementById("backendState").textContent = "LTspice request failed";
    }
  }

  async checkSimulinkBackend() {
    const state = document.getElementById("simulinkState");
    const detail = document.getElementById("simulinkDetail");
    document.getElementById("backendState").textContent = "Simulink running";
    state.textContent = "building load trace...";
    try {
      const request = this.sim.buildSimulinkPowerRequest({ horizonMs: 8000, stepMs: 1 });
      if (!request) {
        throw new Error("power model not ready");
      }
      detail.textContent = `${request.tMs.length} samples @ ${request.stepMs} ms`;
      const response = await fetch("/api/simulink/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const result = await response.json();
      if (!result.ok) {
        state.textContent = result.error || "Simulink failed";
        detail.textContent = result.stdout ? result.stdout.slice(-240) : "--";
        document.getElementById("backendState").textContent = "Simulink failed";
        return;
      }
      this.sim.applySimulinkPowerTrace(result.trace, {
        engine: result.engine,
        elapsedMs: result.elapsedMs,
        samples: result.samples,
        stepMs: result.stepMs,
      });
      state.textContent = `${result.engine}, ${result.elapsedMs} ms`;
      detail.textContent = `${result.samples} samples, ${result.stepMs} ms step, trace applied`;
      document.getElementById("backendState").textContent = "Simulink plant active";
      this.log.add(`Simulink power plant applied: ${result.samples} samples @ ${result.stepMs} ms`);
    } catch (error) {
      state.textContent = `probe failed: ${error.message}`;
      detail.textContent = "--";
      document.getElementById("backendState").textContent = "Simulink request failed";
    }
  }

  updateRtcControls(snapshot = null) {
    const backupMv = Number(document.getElementById("rtcBackupMv").value);
    const vccDropped = document.getElementById("rtcVccDrop").checked;
    document.getElementById("rtcBackupMvOut").textContent = `${backupMv} mV`;
    if (!snapshot || snapshot.rtcSummary.vbatMv !== backupMv) {
      this.sim.setRtcBackupMv(backupMv);
      if (!snapshot) {
        return;
      }
    }
    const expectedVcc = vccDropped ? 0 : snapshot.power.v3v3Mv;
    if (snapshot.rtcSummary.vccMv !== expectedVcc) {
      this.sim.setRtcVccOverrideMv(vccDropped ? 0 : null);
      return;
    }
    const rtc = snapshot.rtcSummary;
    const power = document.getElementById("rtcPowerState");
    power.textContent = rtc.domain === "OFF" ? "RTC OFF" : rtc.domain;
    power.classList.toggle("bad", rtc.domain === "OFF");
    power.classList.toggle("warn", rtc.domain === "VBAT");
    document.getElementById("rtcDomainState").textContent =
      `VCC ${rtc.vccMv} mV / VBAT ${rtc.vbatMv} mV, ${rtc.domain}`;
    document.getElementById("rtcOscState").textContent =
      `${rtc.oscillatorRunning ? "32k running" : "stopped"}, OSF ${rtc.osf ? 1 : 0}, ${rtc.temperatureC} C`;
    document.getElementById("rtcIntDetailState").textContent =
      `${rtc.intLow ? "LOW asserted" : "HIGH released"}, ${rtc.intcn ? "INTCN" : "SQW"}, 32k ${rtc.en32k ? "EN" : "off"}`;
    document.getElementById("rtcCtrlState").textContent =
      `CTRL ${hex2(rtc.control)} / A1 ${rtc.a1Enabled ? "EN" : "off"} / A2 ${rtc.a2Enabled ? "EN" : "off"}`;
    document.getElementById("rtcStatusState").textContent =
      `STAT ${hex2(rtc.status)} / A1F ${rtc.a1F ? 1 : 0} / A2F ${rtc.a2F ? 1 : 0}`;
    document.getElementById("rtcAlarm1State").textContent =
      `${rtc.a1Enabled ? "enabled" : "disabled"}, ${rtc.alarm1}`;
    document.getElementById("rtcAlarm1Countdown").textContent =
      rtc.alarm1CountdownMs === null ? "--" : `${formatDuration(rtc.alarm1CountdownMs)} -> ${formatDateTime(rtc.alarm1NextMs)}`;
    document.getElementById("rtcAlarm2State").textContent =
      `${rtc.a2Enabled ? "enabled" : "disabled"}, ${rtc.alarm2}`;
    document.getElementById("rtcAlarm2Countdown").textContent =
      rtc.alarm2CountdownMs === null ? "--" : `${formatDuration(rtc.alarm2CountdownMs)} -> ${formatDateTime(rtc.alarm2NextMs)}`;
    document.getElementById("rtcI2cState").textContent =
      `0x68 ${rtc.i2cOnline ? "ACK" : "NACK on VBAT"}, pointer ${hex2(rtc.pointer)}`;
  }

  recordPowerSample(snapshot) {
    const t = snapshot.timing.bootWallMs / 1000;
    if (t - this.lastPowerSampleS < 0.05) {
      return;
    }
    this.lastPowerSampleS = t;
    this.powerSamples.push({
      t,
      vbat: snapshot.power.batteryMv,
      loaded: snapshot.power.batteryLoadedMv,
      v3v3: snapshot.power.v3v3Mv,
      vlte: snapshot.power.vlteMv,
      idealVlte: snapshot.power.idealVlteMv,
      cap: snapshot.power.supercapMv,
    });
    const cutoff = t - 90;
    while (this.powerSamples.length > 0 && this.powerSamples[0].t < cutoff) {
      this.powerSamples.shift();
    }
    if (this.powerSamples.length > 1800) {
      this.powerSamples.splice(0, this.powerSamples.length - 1800);
    }
  }

  drawPowerScope(snapshot) {
    const ctx = this.powerScopeCtx;
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const left = 48;
    const right = 12;
    const top = 12;
    const bottom = 26;
    const plotW = w - left - right;
    const plotH = h - top - bottom;
    const t = snapshot.timing.bootWallMs / 1000;
    const xMax = Math.max(8, t);
    const xMin = Math.max(0, xMax - 60);
    const samples = this.powerSamples.filter((sample) => sample.t >= xMin);
    const values = samples.flatMap((sample) => [sample.vbat, sample.loaded, sample.v3v3, sample.vlte, sample.idealVlte, sample.cap]);
    const minValue = values.length ? Math.min(...values) : 2500;
    const maxValue = values.length ? Math.max(...values) : 3800;
    const yMin = Math.max(0, Math.floor((Math.min(2500, minValue) - 100) / 100) * 100);
    const yMax = Math.ceil((Math.max(3800, maxValue) + 100) / 100) * 100;
    const xFor = (sampleT) => left + ((sampleT - xMin) / Math.max(1, xMax - xMin)) * plotW;
    const yFor = (mv) => top + (1 - (mv - yMin) / Math.max(1, yMax - yMin)) * plotH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#101513";
    ctx.fillRect(0, 0, w, h);
    ctx.font = "11px Consolas, ui-monospace, monospace";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2c3834";
    ctx.fillStyle = "#aebbb4";
    for (let i = 0; i <= 5; i += 1) {
      const mv = yMin + ((yMax - yMin) * i) / 5;
      const y = yFor(mv);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - right, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(mv)}mV`, 4, y + 4);
    }
    for (let i = 0; i <= 4; i += 1) {
      const seconds = xMin + ((xMax - xMin) * i) / 4;
      const x = xFor(seconds);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h - bottom);
      ctx.stroke();
      ctx.fillText(`${Math.round(seconds - xMax)}s`, x - 12, h - 8);
    }

    const drawTrace = (key, color, width = 2) => {
      if (samples.length === 0) {
        return;
      }
      ctx.beginPath();
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      samples.forEach((sample, index) => {
        const x = xFor(sample.t);
        const y = yFor(sample[key]);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    };
    drawTrace("vbat", "#e2c044", 1.5);
    drawTrace("loaded", "#a34d18", 1.5);
    drawTrace("v3v3", "#19706a", 2);
    drawTrace("vlte", "#1b5ea8", 2);
    drawTrace("idealVlte", "#7da7d8", 1);
    drawTrace("cap", "#6f7d1c", 2);
    ctx.strokeStyle = "#66746d";
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, plotW, plotH);
    document.getElementById("scopeReadout").textContent =
      `VBAT ${snapshot.power.batteryMv} / 3V3 ${snapshot.power.v3v3Mv} / VLTE ${snapshot.power.vlteMv} / ideal ${snapshot.power.idealVlteMv} / CAP ${snapshot.power.supercapMv} mV`;
  }

  updatePanelWarning() {
    const selected = document.getElementById("panelSelect").value;
    const warning = document.getElementById("panelWarning");
    if (selected === "ws29bw") {
      warning.textContent = "Waveshare 2.9 V2 matched";
      warning.classList.remove("bad", "warn");
    } else {
      warning.textContent = "firmware remains 2.9 V2";
      warning.classList.add("bad", "warn");
    }
  }

  advanceMinuteAndAlarm() {
    const value = document.getElementById("rtcInput").value;
    const date = value ? new Date(value) : new Date();
    date.setMinutes(date.getMinutes() + 1);
    this.sim.setRtcDate(date);
    this.sim.triggerRtcAlarm();
  }

  pressSendHappySequence() {
    this.sim.pressButton(2);
    window.setTimeout(() => this.sim.pressButton(1), 1400);
  }
}

function level(value) {
  return value ? "HIGH" : "LOW";
}

function hex2(value) {
  return `0x${Number(value).toString(16).padStart(2, "0")}`;
}

function hex4(value) {
  return `0x${Number(value).toString(16).padStart(4, "0")}`;
}

function formatBytes(bytes) {
  const value = Math.max(0, Math.round(Number(bytes) || 0));
  if (value >= 1024) {
    const kib = value / 1024;
    return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KiB`;
  }
  return `${value} B`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function timerLine(timer) {
  const tcnt = Number(timer.tcnt).toString(16).padStart(timer.bits === 16 ? 4 : 2, "0");
  return `0x${tcnt} CS${timer.cs} WGM${timer.wgm ?? "-"} TIMSK ${hex2(timer.timsk)}`;
}

function smoothPulse(value, start, end) {
  const rise = smoothstep(start, start + 0.08, value);
  const fall = 1 - smoothstep(end - 0.08, end, value);
  return Math.max(0, Math.min(1, rise * fall));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function prepareCanvasForDisplay(ctx) {
  const canvas = ctx.canvas;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.width));
  const height = Math.max(1, Math.round(rect.height || canvas.height));
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}

function memoryValueColor(value) {
  const v = Number(value) & 0xff;
  const bitCount = countBits(v);
  const lane = (v ^ (v >> 3) ^ (v >> 5)) & 3;
  const light = 42 + bitCount * 4;
  const palette = [
    [31, 82, 107],
    [92, 74, 124],
    [112, 82, 39],
    [57, 99, 73],
  ][lane];
  return rgbToHex(
    Math.min(255, palette[0] + light),
    Math.min(255, palette[1] + Math.floor(light * 0.65)),
    Math.min(255, palette[2] + Math.floor(light * 0.55)),
  );
}

function flashByteColor(value, index) {
  const base = memoryValueColor(value);
  const lane = Math.floor(index / 256) % 4;
  const tint = ["#1f5e6f", "#4d5178", "#5c6c39", "#7a5630"][lane];
  return blendHex(base, tint, 0.28);
}

function eepromByteColor(value) {
  if (value === 0x00) {
    return "#28645f";
  }
  const base = memoryValueColor(value);
  return blendHex(base, "#6f7d1c", 0.34);
}

function countBits(value) {
  let v = value & 0xff;
  let count = 0;
  while (v) {
    count += v & 1;
    v >>= 1;
  }
  return count;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function blendHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  );
}

function hexToRgb(hex) {
  const raw = hex.replace("#", "");
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

function formatDateTime(ms) {
  if (!Number.isFinite(Number(ms))) {
    return "--";
  }
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

window.addEventListener("DOMContentLoaded", () => {
  window.epaper2SimUi = new BrowserUi();
});
