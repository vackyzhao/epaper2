var Epaper2Avr = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/avr_engine.js
  var avr_engine_exports = {};
  __export(avr_engine_exports, {
    Epaper2Avr: () => Epaper2Avr,
    loadIntelHex: () => loadIntelHex
  });

  // node_modules/avr8js/dist/esm/cpu/interrupt.js
  function avrInterrupt(cpu, addr) {
    const sp = cpu.dataView.getUint16(93, true);
    cpu.data[sp] = cpu.pc & 255;
    cpu.data[sp - 1] = cpu.pc >> 8 & 255;
    if (cpu.pc22Bits) {
      cpu.data[sp - 2] = cpu.pc >> 16 & 255;
    }
    cpu.dataView.setUint16(93, sp - (cpu.pc22Bits ? 3 : 2), true);
    cpu.data[95] &= 127;
    cpu.cycles += 2;
    cpu.pc = addr;
  }

  // node_modules/avr8js/dist/esm/cpu/cpu.js
  var registerSpace = 256;
  var MAX_INTERRUPTS = 128;
  var CPU = class {
    constructor(progMem, sramBytes = 8192) {
      this.progMem = progMem;
      this.sramBytes = sramBytes;
      this.data = new Uint8Array(this.sramBytes + registerSpace);
      this.data16 = new Uint16Array(this.data.buffer);
      this.dataView = new DataView(this.data.buffer);
      this.progBytes = new Uint8Array(this.progMem.buffer);
      this.readHooks = [];
      this.writeHooks = [];
      this.pendingInterrupts = new Array(MAX_INTERRUPTS);
      this.nextClockEvent = null;
      this.clockEventPool = [];
      this.pc22Bits = this.progBytes.length > 131072;
      this.gpioPorts = /* @__PURE__ */ new Set();
      this.gpioByPort = [];
      this.onWatchdogReset = () => {
      };
      this.pc = 0;
      this.cycles = 0;
      this.nextInterrupt = -1;
      this.maxInterrupt = 0;
      this.reset();
    }
    reset() {
      this.SP = this.data.length - 1;
      this.pc = 0;
      this.pendingInterrupts.fill(null);
      this.nextInterrupt = -1;
      this.nextClockEvent = null;
    }
    readData(addr) {
      if (addr >= 32 && this.readHooks[addr]) {
        return this.readHooks[addr](addr);
      }
      return this.data[addr];
    }
    writeData(addr, value, mask = 255) {
      const hook = this.writeHooks[addr];
      if (hook) {
        if (hook(value, this.data[addr], addr, mask)) {
          return;
        }
      }
      this.data[addr] = value;
    }
    get SP() {
      return this.dataView.getUint16(93, true);
    }
    set SP(value) {
      this.dataView.setUint16(93, value, true);
    }
    get SREG() {
      return this.data[95];
    }
    get interruptsEnabled() {
      return this.SREG & 128 ? true : false;
    }
    setInterruptFlag(interrupt) {
      const { flagRegister, flagMask, enableRegister, enableMask } = interrupt;
      if (interrupt.inverseFlag) {
        this.data[flagRegister] &= ~flagMask;
      } else {
        this.data[flagRegister] |= flagMask;
      }
      if (this.data[enableRegister] & enableMask) {
        this.queueInterrupt(interrupt);
      }
    }
    updateInterruptEnable(interrupt, registerValue) {
      const { enableMask, flagRegister, flagMask, inverseFlag } = interrupt;
      if (registerValue & enableMask) {
        const bitSet = this.data[flagRegister] & flagMask;
        if (inverseFlag ? !bitSet : bitSet) {
          this.queueInterrupt(interrupt);
        }
      } else {
        this.clearInterrupt(interrupt, false);
      }
    }
    queueInterrupt(interrupt) {
      const { address } = interrupt;
      this.pendingInterrupts[address] = interrupt;
      if (this.nextInterrupt === -1 || this.nextInterrupt > address) {
        this.nextInterrupt = address;
      }
      if (address > this.maxInterrupt) {
        this.maxInterrupt = address;
      }
    }
    clearInterrupt({ address, flagRegister, flagMask }, clearFlag = true) {
      if (clearFlag) {
        this.data[flagRegister] &= ~flagMask;
      }
      const { pendingInterrupts, maxInterrupt } = this;
      if (!pendingInterrupts[address]) {
        return;
      }
      pendingInterrupts[address] = null;
      if (this.nextInterrupt === address) {
        this.nextInterrupt = -1;
        for (let i = address + 1; i <= maxInterrupt; i++) {
          if (pendingInterrupts[i]) {
            this.nextInterrupt = i;
            break;
          }
        }
      }
    }
    clearInterruptByFlag(interrupt, registerValue) {
      const { flagRegister, flagMask } = interrupt;
      if (registerValue & flagMask) {
        this.data[flagRegister] &= ~flagMask;
        this.clearInterrupt(interrupt);
      }
    }
    addClockEvent(callback, cycles) {
      const { clockEventPool } = this;
      cycles = this.cycles + Math.max(1, cycles);
      const maybeEntry = clockEventPool.pop();
      const entry = maybeEntry !== null && maybeEntry !== void 0 ? maybeEntry : { cycles, callback, next: null };
      entry.cycles = cycles;
      entry.callback = callback;
      let { nextClockEvent: clockEvent } = this;
      let lastItem = null;
      while (clockEvent && clockEvent.cycles < cycles) {
        lastItem = clockEvent;
        clockEvent = clockEvent.next;
      }
      if (lastItem) {
        lastItem.next = entry;
        entry.next = clockEvent;
      } else {
        this.nextClockEvent = entry;
        entry.next = clockEvent;
      }
      return callback;
    }
    updateClockEvent(callback, cycles) {
      if (this.clearClockEvent(callback)) {
        this.addClockEvent(callback, cycles);
        return true;
      }
      return false;
    }
    clearClockEvent(callback) {
      let { nextClockEvent: clockEvent } = this;
      if (!clockEvent) {
        return false;
      }
      const { clockEventPool } = this;
      let lastItem = null;
      while (clockEvent) {
        if (clockEvent.callback === callback) {
          if (lastItem) {
            lastItem.next = clockEvent.next;
          } else {
            this.nextClockEvent = clockEvent.next;
          }
          if (clockEventPool.length < 10) {
            clockEventPool.push(clockEvent);
          }
          return true;
        }
        lastItem = clockEvent;
        clockEvent = clockEvent.next;
      }
      return false;
    }
    tick() {
      const { nextClockEvent } = this;
      if (nextClockEvent && nextClockEvent.cycles <= this.cycles) {
        nextClockEvent.callback();
        this.nextClockEvent = nextClockEvent.next;
        if (this.clockEventPool.length < 10) {
          this.clockEventPool.push(nextClockEvent);
        }
      }
      const { nextInterrupt } = this;
      if (this.interruptsEnabled && nextInterrupt >= 0) {
        const interrupt = this.pendingInterrupts[nextInterrupt];
        avrInterrupt(this, interrupt.address);
        if (!interrupt.constant) {
          this.clearInterrupt(interrupt);
        }
      }
    }
  };

  // node_modules/avr8js/dist/esm/cpu/instruction.js
  function isTwoWordInstruction(opcode) {
    return (
      /* LDS */
      (opcode & 65039) === 36864 || /* STS */
      (opcode & 65039) === 37376 || /* CALL */
      (opcode & 65038) === 37902 || /* JMP */
      (opcode & 65038) === 37900
    );
  }
  function avrInstruction(cpu) {
    const opcode = cpu.progMem[cpu.pc];
    if ((opcode & 64512) === 7168) {
      const d = cpu.data[(opcode & 496) >> 4];
      const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      const sum = d + r + (cpu.data[95] & 1);
      const R = sum & 255;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= (R ^ r) & (d ^ R) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= sum & 256 ? 1 : 0;
      sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 3072) {
      const d = cpu.data[(opcode & 496) >> 4];
      const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      const R = d + r & 255;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= (R ^ r) & (R ^ d) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= d + r & 256 ? 1 : 0;
      sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65280) === 38400) {
      const addr = 2 * ((opcode & 48) >> 4) + 24;
      const value = cpu.dataView.getUint16(addr, true);
      const R = value + (opcode & 15 | (opcode & 192) >> 2) & 65535;
      cpu.dataView.setUint16(addr, R, true);
      let sreg = cpu.data[95] & 224;
      sreg |= R ? 0 : 2;
      sreg |= 32768 & R ? 4 : 0;
      sreg |= ~value & R & 32768 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= ~R & value & 32768 ? 1 : 0;
      cpu.data[95] = sreg;
      cpu.cycles++;
    } else if ((opcode & 64512) === 8192) {
      const R = cpu.data[(opcode & 496) >> 4] & cpu.data[opcode & 15 | (opcode & 512) >> 5];
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 61440) === 28672) {
      const R = cpu.data[((opcode & 240) >> 4) + 16] & (opcode & 15 | (opcode & 3840) >> 4);
      cpu.data[((opcode & 240) >> 4) + 16] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65039) === 37893) {
      const value = cpu.data[(opcode & 496) >> 4];
      const R = value >>> 1 | 128 & value;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 224;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= value & 1;
      sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65423) === 38024) {
      cpu.data[95] &= ~(1 << ((opcode & 112) >> 4));
    } else if ((opcode & 65032) === 63488) {
      const b = opcode & 7;
      const d = (opcode & 496) >> 4;
      cpu.data[d] = ~(1 << b) & cpu.data[d] | (cpu.data[95] >> 6 & 1) << b;
    } else if ((opcode & 64512) === 62464) {
      if (!(cpu.data[95] & 1 << (opcode & 7))) {
        cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
        cpu.cycles++;
      }
    } else if ((opcode & 64512) === 61440) {
      if (cpu.data[95] & 1 << (opcode & 7)) {
        cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
        cpu.cycles++;
      }
    } else if ((opcode & 65423) === 37896) {
      cpu.data[95] |= 1 << ((opcode & 112) >> 4);
    } else if ((opcode & 65032) === 64e3) {
      const d = cpu.data[(opcode & 496) >> 4];
      const b = opcode & 7;
      cpu.data[95] = cpu.data[95] & 191 | (d >> b & 1 ? 64 : 0);
    } else if ((opcode & 65038) === 37902) {
      const k = cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13;
      const ret = cpu.pc + 2;
      const sp = cpu.dataView.getUint16(93, true);
      const { pc22Bits } = cpu;
      cpu.data[sp] = 255 & ret;
      cpu.data[sp - 1] = ret >> 8 & 255;
      if (pc22Bits) {
        cpu.data[sp - 2] = ret >> 16 & 255;
      }
      cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
      cpu.pc = k - 1;
      cpu.cycles += pc22Bits ? 4 : 3;
    } else if ((opcode & 65280) === 38912) {
      const A = opcode & 248;
      const b = opcode & 7;
      const R = cpu.readData((A >> 3) + 32);
      const mask = 1 << b;
      cpu.writeData((A >> 3) + 32, R & ~mask, mask);
    } else if ((opcode & 65039) === 37888) {
      const d = (opcode & 496) >> 4;
      const R = 255 - cpu.data[d];
      cpu.data[d] = R;
      let sreg = cpu.data[95] & 225 | 1;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 5120) {
      const val1 = cpu.data[(opcode & 496) >> 4];
      const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      const R = val1 - val2;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= 0 !== ((val1 ^ val2) & (val1 ^ R) & 128) ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= val2 > val1 ? 1 : 0;
      sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 1024) {
      const arg1 = cpu.data[(opcode & 496) >> 4];
      const arg2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      let sreg = cpu.data[95];
      const r = arg1 - arg2 - (sreg & 1);
      sreg = sreg & 192 | (!r && sreg >> 1 & 1 ? 2 : 0) | (arg2 + (sreg & 1) > arg1 ? 1 : 0);
      sreg |= 128 & r ? 4 : 0;
      sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 61440) === 12288) {
      const arg1 = cpu.data[((opcode & 240) >> 4) + 16];
      const arg2 = opcode & 15 | (opcode & 3840) >> 4;
      const r = arg1 - arg2;
      let sreg = cpu.data[95] & 192;
      sreg |= r ? 0 : 2;
      sreg |= 128 & r ? 4 : 0;
      sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= arg2 > arg1 ? 1 : 0;
      sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 4096) {
      if (cpu.data[(opcode & 496) >> 4] === cpu.data[opcode & 15 | (opcode & 512) >> 5]) {
        const nextOpcode = cpu.progMem[cpu.pc + 1];
        const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
        cpu.pc += skipSize;
        cpu.cycles += skipSize;
      }
    } else if ((opcode & 65039) === 37898) {
      const value = cpu.data[(opcode & 496) >> 4];
      const R = value - 1;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= 128 === value ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if (opcode === 38169) {
      const retAddr = cpu.pc + 1;
      const sp = cpu.dataView.getUint16(93, true);
      const eind = cpu.data[92];
      cpu.data[sp] = retAddr & 255;
      cpu.data[sp - 1] = retAddr >> 8 & 255;
      cpu.data[sp - 2] = retAddr >> 16 & 255;
      cpu.dataView.setUint16(93, sp - 3, true);
      cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
      cpu.cycles += 3;
    } else if (opcode === 37913) {
      const eind = cpu.data[92];
      cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
      cpu.cycles++;
    } else if (opcode === 38360) {
      const rampz = cpu.data[91];
      cpu.data[0] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 36870) {
      const rampz = cpu.data[91];
      cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 36871) {
      const rampz = cpu.data[91];
      const i = cpu.dataView.getUint16(30, true);
      cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | i];
      cpu.dataView.setUint16(30, i + 1, true);
      if (i === 65535) {
        cpu.data[91] = (rampz + 1) % (cpu.progBytes.length >> 16);
      }
      cpu.cycles += 2;
    } else if ((opcode & 64512) === 9216) {
      const R = cpu.data[(opcode & 496) >> 4] ^ cpu.data[opcode & 15 | (opcode & 512) >> 5];
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65416) === 776) {
      const v1 = cpu.data[((opcode & 112) >> 4) + 16];
      const v2 = cpu.data[(opcode & 7) + 16];
      const R = v1 * v2 << 1;
      cpu.dataView.setUint16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
      cpu.cycles++;
    } else if ((opcode & 65416) === 896) {
      const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
      const v2 = cpu.dataView.getInt8((opcode & 7) + 16);
      const R = v1 * v2 << 1;
      cpu.dataView.setInt16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
      cpu.cycles++;
    } else if ((opcode & 65416) === 904) {
      const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
      const v2 = cpu.data[(opcode & 7) + 16];
      const R = v1 * v2 << 1;
      cpu.dataView.setInt16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 2 : 0) | (v1 * v2 & 32768 ? 1 : 0);
      cpu.cycles++;
    } else if (opcode === 38153) {
      const retAddr = cpu.pc + 1;
      const sp = cpu.dataView.getUint16(93, true);
      const { pc22Bits } = cpu;
      cpu.data[sp] = retAddr & 255;
      cpu.data[sp - 1] = retAddr >> 8 & 255;
      if (pc22Bits) {
        cpu.data[sp - 2] = retAddr >> 16 & 255;
      }
      cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
      cpu.pc = cpu.dataView.getUint16(30, true) - 1;
      cpu.cycles += pc22Bits ? 3 : 2;
    } else if (opcode === 37897) {
      cpu.pc = cpu.dataView.getUint16(30, true) - 1;
      cpu.cycles++;
    } else if ((opcode & 63488) === 45056) {
      const i = cpu.readData((opcode & 15 | (opcode & 1536) >> 5) + 32);
      cpu.data[(opcode & 496) >> 4] = i;
    } else if ((opcode & 65039) === 37891) {
      const d = cpu.data[(opcode & 496) >> 4];
      const r = d + 1 & 255;
      cpu.data[(opcode & 496) >> 4] = r;
      let sreg = cpu.data[95] & 225;
      sreg |= r ? 0 : 2;
      sreg |= 128 & r ? 4 : 0;
      sreg |= 127 === d ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65038) === 37900) {
      cpu.pc = (cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13) - 1;
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 37382) {
      const r = (opcode & 496) >> 4;
      const clear = cpu.data[r];
      const value = cpu.readData(cpu.dataView.getUint16(30, true));
      cpu.writeData(cpu.dataView.getUint16(30, true), value & 255 - clear);
      cpu.data[r] = value;
    } else if ((opcode & 65039) === 37381) {
      const r = (opcode & 496) >> 4;
      const set = cpu.data[r];
      const value = cpu.readData(cpu.dataView.getUint16(30, true));
      cpu.writeData(cpu.dataView.getUint16(30, true), value | set);
      cpu.data[r] = value;
    } else if ((opcode & 65039) === 37383) {
      const r = cpu.data[(opcode & 496) >> 4];
      const R = cpu.readData(cpu.dataView.getUint16(30, true));
      cpu.writeData(cpu.dataView.getUint16(30, true), r ^ R);
      cpu.data[(opcode & 496) >> 4] = R;
    } else if ((opcode & 61440) === 57344) {
      cpu.data[((opcode & 240) >> 4) + 16] = opcode & 15 | (opcode & 3840) >> 4;
    } else if ((opcode & 65039) === 36864) {
      cpu.cycles++;
      const value = cpu.readData(cpu.progMem[cpu.pc + 1]);
      cpu.data[(opcode & 496) >> 4] = value;
      cpu.pc++;
    } else if ((opcode & 65039) === 36876) {
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(26, true));
    } else if ((opcode & 65039) === 36877) {
      const x = cpu.dataView.getUint16(26, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
      cpu.dataView.setUint16(26, x + 1, true);
    } else if ((opcode & 65039) === 36878) {
      const x = cpu.dataView.getUint16(26, true) - 1;
      cpu.dataView.setUint16(26, x, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
    } else if ((opcode & 65039) === 32776) {
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true));
    } else if ((opcode & 65039) === 36873) {
      const y = cpu.dataView.getUint16(28, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
      cpu.dataView.setUint16(28, y + 1, true);
    } else if ((opcode & 65039) === 36874) {
      const y = cpu.dataView.getUint16(28, true) - 1;
      cpu.dataView.setUint16(28, y, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
    } else if ((opcode & 53768) === 32776 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
    } else if ((opcode & 65039) === 32768) {
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true));
    } else if ((opcode & 65039) === 36865) {
      const z = cpu.dataView.getUint16(30, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
      cpu.dataView.setUint16(30, z + 1, true);
    } else if ((opcode & 65039) === 36866) {
      const z = cpu.dataView.getUint16(30, true) - 1;
      cpu.dataView.setUint16(30, z, true);
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
    } else if ((opcode & 53768) === 32768 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
      cpu.cycles++;
      cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
    } else if (opcode === 38344) {
      cpu.data[0] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 36868) {
      cpu.data[(opcode & 496) >> 4] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 36869) {
      const i = cpu.dataView.getUint16(30, true);
      cpu.data[(opcode & 496) >> 4] = cpu.progBytes[i];
      cpu.dataView.setUint16(30, i + 1, true);
      cpu.cycles += 2;
    } else if ((opcode & 65039) === 37894) {
      const value = cpu.data[(opcode & 496) >> 4];
      const R = value >>> 1;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 224;
      sreg |= R ? 0 : 2;
      sreg |= value & 1;
      sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 11264) {
      cpu.data[(opcode & 496) >> 4] = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    } else if ((opcode & 65280) === 256) {
      const r2 = 2 * (opcode & 15);
      const d2 = 2 * ((opcode & 240) >> 4);
      cpu.data[d2] = cpu.data[r2];
      cpu.data[d2 + 1] = cpu.data[r2 + 1];
    } else if ((opcode & 64512) === 39936) {
      const R = cpu.data[(opcode & 496) >> 4] * cpu.data[opcode & 15 | (opcode & 512) >> 5];
      cpu.dataView.setUint16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
      cpu.cycles++;
    } else if ((opcode & 65280) === 512) {
      const R = cpu.dataView.getInt8(((opcode & 240) >> 4) + 16) * cpu.dataView.getInt8((opcode & 15) + 16);
      cpu.dataView.setInt16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
      cpu.cycles++;
    } else if ((opcode & 65416) === 768) {
      const R = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16) * cpu.data[(opcode & 7) + 16];
      cpu.dataView.setInt16(0, R, true);
      cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37889) {
      const d = (opcode & 496) >> 4;
      const value = cpu.data[d];
      const R = 0 - value;
      cpu.data[d] = R;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= 128 === R ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= R ? 1 : 0;
      sreg |= 1 & (R | value) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if (opcode === 0) {
    } else if ((opcode & 64512) === 10240) {
      const R = cpu.data[(opcode & 496) >> 4] | cpu.data[opcode & 15 | (opcode & 512) >> 5];
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 61440) === 24576) {
      const R = cpu.data[((opcode & 240) >> 4) + 16] | (opcode & 15 | (opcode & 3840) >> 4);
      cpu.data[((opcode & 240) >> 4) + 16] = R;
      let sreg = cpu.data[95] & 225;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 63488) === 47104) {
      cpu.writeData((opcode & 15 | (opcode & 1536) >> 5) + 32, cpu.data[(opcode & 496) >> 4]);
    } else if ((opcode & 65039) === 36879) {
      const value = cpu.dataView.getUint16(93, true) + 1;
      cpu.dataView.setUint16(93, value, true);
      cpu.data[(opcode & 496) >> 4] = cpu.data[value];
      cpu.cycles++;
    } else if ((opcode & 65039) === 37391) {
      const value = cpu.dataView.getUint16(93, true);
      cpu.data[value] = cpu.data[(opcode & 496) >> 4];
      cpu.dataView.setUint16(93, value - 1, true);
      cpu.cycles++;
    } else if ((opcode & 61440) === 53248) {
      const k = (opcode & 2047) - (opcode & 2048 ? 2048 : 0);
      const retAddr = cpu.pc + 1;
      const sp = cpu.dataView.getUint16(93, true);
      const { pc22Bits } = cpu;
      cpu.data[sp] = 255 & retAddr;
      cpu.data[sp - 1] = retAddr >> 8 & 255;
      if (pc22Bits) {
        cpu.data[sp - 2] = retAddr >> 16 & 255;
      }
      cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
      cpu.pc += k;
      cpu.cycles += pc22Bits ? 3 : 2;
    } else if (opcode === 38152) {
      const { pc22Bits } = cpu;
      const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
      cpu.dataView.setUint16(93, i, true);
      cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
      if (pc22Bits) {
        cpu.pc |= cpu.data[i - 2] << 16;
      }
      cpu.cycles += pc22Bits ? 4 : 3;
    } else if (opcode === 38168) {
      const { pc22Bits } = cpu;
      const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
      cpu.dataView.setUint16(93, i, true);
      cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
      if (pc22Bits) {
        cpu.pc |= cpu.data[i - 2] << 16;
      }
      cpu.cycles += pc22Bits ? 4 : 3;
      cpu.data[95] |= 128;
    } else if ((opcode & 61440) === 49152) {
      cpu.pc = cpu.pc + ((opcode & 2047) - (opcode & 2048 ? 2048 : 0));
      cpu.cycles++;
    } else if ((opcode & 65039) === 37895) {
      const d = cpu.data[(opcode & 496) >> 4];
      const r = d >>> 1 | (cpu.data[95] & 1) << 7;
      cpu.data[(opcode & 496) >> 4] = r;
      let sreg = cpu.data[95] & 224;
      sreg |= r ? 0 : 2;
      sreg |= 128 & r ? 4 : 0;
      sreg |= 1 & d ? 1 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 64512) === 2048) {
      const val1 = cpu.data[(opcode & 496) >> 4];
      const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      let sreg = cpu.data[95];
      const R = val1 - val2 - (sreg & 1);
      cpu.data[(opcode & 496) >> 4] = R;
      sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
      sreg |= 128 & R ? 4 : 0;
      sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 61440) === 16384) {
      const val1 = cpu.data[((opcode & 240) >> 4) + 16];
      const val2 = opcode & 15 | (opcode & 3840) >> 4;
      let sreg = cpu.data[95];
      const R = val1 - val2 - (sreg & 1);
      cpu.data[((opcode & 240) >> 4) + 16] = R;
      sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
      sreg |= 128 & R ? 4 : 0;
      sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65280) === 39424) {
      const target = ((opcode & 248) >> 3) + 32;
      const mask = 1 << (opcode & 7);
      cpu.writeData(target, cpu.readData(target) | mask, mask);
      cpu.cycles++;
    } else if ((opcode & 65280) === 39168) {
      const value = cpu.readData(((opcode & 248) >> 3) + 32);
      if (!(value & 1 << (opcode & 7))) {
        const nextOpcode = cpu.progMem[cpu.pc + 1];
        const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
        cpu.cycles += skipSize;
        cpu.pc += skipSize;
      }
    } else if ((opcode & 65280) === 39680) {
      const value = cpu.readData(((opcode & 248) >> 3) + 32);
      if (value & 1 << (opcode & 7)) {
        const nextOpcode = cpu.progMem[cpu.pc + 1];
        const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
        cpu.cycles += skipSize;
        cpu.pc += skipSize;
      }
    } else if ((opcode & 65280) === 38656) {
      const i = 2 * ((opcode & 48) >> 4) + 24;
      const a = cpu.dataView.getUint16(i, true);
      const l = opcode & 15 | (opcode & 192) >> 2;
      const R = a - l;
      cpu.dataView.setUint16(i, R, true);
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 32768 & R ? 4 : 0;
      sreg |= a & ~R & 32768 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= l > a ? 1 : 0;
      sreg |= 1 & (~a & l | l & R | R & ~a) ? 32 : 0;
      cpu.data[95] = sreg;
      cpu.cycles++;
    } else if ((opcode & 65032) === 64512) {
      if (!(cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7))) {
        const nextOpcode = cpu.progMem[cpu.pc + 1];
        const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
        cpu.cycles += skipSize;
        cpu.pc += skipSize;
      }
    } else if ((opcode & 65032) === 65024) {
      if (cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7)) {
        const nextOpcode = cpu.progMem[cpu.pc + 1];
        const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
        cpu.cycles += skipSize;
        cpu.pc += skipSize;
      }
    } else if (opcode === 38280) {
    } else if (opcode === 38376) {
    } else if (opcode === 38392) {
    } else if ((opcode & 65039) === 37376) {
      const value = cpu.data[(opcode & 496) >> 4];
      const addr = cpu.progMem[cpu.pc + 1];
      cpu.writeData(addr, value);
      cpu.pc++;
      cpu.cycles++;
    } else if ((opcode & 65039) === 37388) {
      cpu.writeData(cpu.dataView.getUint16(26, true), cpu.data[(opcode & 496) >> 4]);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37389) {
      const x = cpu.dataView.getUint16(26, true);
      cpu.writeData(x, cpu.data[(opcode & 496) >> 4]);
      cpu.dataView.setUint16(26, x + 1, true);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37390) {
      const i = cpu.data[(opcode & 496) >> 4];
      const x = cpu.dataView.getUint16(26, true) - 1;
      cpu.dataView.setUint16(26, x, true);
      cpu.writeData(x, i);
      cpu.cycles++;
    } else if ((opcode & 65039) === 33288) {
      cpu.writeData(cpu.dataView.getUint16(28, true), cpu.data[(opcode & 496) >> 4]);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37385) {
      const i = cpu.data[(opcode & 496) >> 4];
      const y = cpu.dataView.getUint16(28, true);
      cpu.writeData(y, i);
      cpu.dataView.setUint16(28, y + 1, true);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37386) {
      const i = cpu.data[(opcode & 496) >> 4];
      const y = cpu.dataView.getUint16(28, true) - 1;
      cpu.dataView.setUint16(28, y, true);
      cpu.writeData(y, i);
      cpu.cycles++;
    } else if ((opcode & 53768) === 33288 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
      cpu.writeData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
      cpu.cycles++;
    } else if ((opcode & 65039) === 33280) {
      cpu.writeData(cpu.dataView.getUint16(30, true), cpu.data[(opcode & 496) >> 4]);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37377) {
      const z = cpu.dataView.getUint16(30, true);
      cpu.writeData(z, cpu.data[(opcode & 496) >> 4]);
      cpu.dataView.setUint16(30, z + 1, true);
      cpu.cycles++;
    } else if ((opcode & 65039) === 37378) {
      const i = cpu.data[(opcode & 496) >> 4];
      const z = cpu.dataView.getUint16(30, true) - 1;
      cpu.dataView.setUint16(30, z, true);
      cpu.writeData(z, i);
      cpu.cycles++;
    } else if ((opcode & 53768) === 33280 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
      cpu.writeData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
      cpu.cycles++;
    } else if ((opcode & 64512) === 6144) {
      const val1 = cpu.data[(opcode & 496) >> 4];
      const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      const R = val1 - val2;
      cpu.data[(opcode & 496) >> 4] = R;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= val2 > val1 ? 1 : 0;
      sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 61440) === 20480) {
      const val1 = cpu.data[((opcode & 240) >> 4) + 16];
      const val2 = opcode & 15 | (opcode & 3840) >> 4;
      const R = val1 - val2;
      cpu.data[((opcode & 240) >> 4) + 16] = R;
      let sreg = cpu.data[95] & 192;
      sreg |= R ? 0 : 2;
      sreg |= 128 & R ? 4 : 0;
      sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
      sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
      sreg |= val2 > val1 ? 1 : 0;
      sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
      cpu.data[95] = sreg;
    } else if ((opcode & 65039) === 37890) {
      const d = (opcode & 496) >> 4;
      const i = cpu.data[d];
      cpu.data[d] = (15 & i) << 4 | (240 & i) >>> 4;
    } else if (opcode === 38312) {
      cpu.onWatchdogReset();
    } else if ((opcode & 65039) === 37380) {
      const r = (opcode & 496) >> 4;
      const val1 = cpu.data[r];
      const val2 = cpu.data[cpu.dataView.getUint16(30, true)];
      cpu.data[cpu.dataView.getUint16(30, true)] = val1;
      cpu.data[r] = val2;
    }
    cpu.pc = (cpu.pc + 1) % cpu.progMem.length;
    cpu.cycles++;
  }

  // node_modules/avr8js/dist/esm/peripherals/adc.js
  var ADCReference;
  (function(ADCReference2) {
    ADCReference2[ADCReference2["AVCC"] = 0] = "AVCC";
    ADCReference2[ADCReference2["AREF"] = 1] = "AREF";
    ADCReference2[ADCReference2["Internal1V1"] = 2] = "Internal1V1";
    ADCReference2[ADCReference2["Internal2V56"] = 3] = "Internal2V56";
    ADCReference2[ADCReference2["Reserved"] = 4] = "Reserved";
  })(ADCReference || (ADCReference = {}));
  var ADCMuxInputType;
  (function(ADCMuxInputType2) {
    ADCMuxInputType2[ADCMuxInputType2["SingleEnded"] = 0] = "SingleEnded";
    ADCMuxInputType2[ADCMuxInputType2["Differential"] = 1] = "Differential";
    ADCMuxInputType2[ADCMuxInputType2["Constant"] = 2] = "Constant";
    ADCMuxInputType2[ADCMuxInputType2["Temperature"] = 3] = "Temperature";
  })(ADCMuxInputType || (ADCMuxInputType = {}));
  var atmega328Channels = {
    0: { type: ADCMuxInputType.SingleEnded, channel: 0 },
    1: { type: ADCMuxInputType.SingleEnded, channel: 1 },
    2: { type: ADCMuxInputType.SingleEnded, channel: 2 },
    3: { type: ADCMuxInputType.SingleEnded, channel: 3 },
    4: { type: ADCMuxInputType.SingleEnded, channel: 4 },
    5: { type: ADCMuxInputType.SingleEnded, channel: 5 },
    6: { type: ADCMuxInputType.SingleEnded, channel: 6 },
    7: { type: ADCMuxInputType.SingleEnded, channel: 7 },
    8: { type: ADCMuxInputType.Temperature },
    14: { type: ADCMuxInputType.Constant, voltage: 1.1 },
    15: { type: ADCMuxInputType.Constant, voltage: 0 }
  };
  var fallbackMuxInput = {
    type: ADCMuxInputType.Constant,
    voltage: 0
  };
  var adcConfig = {
    ADMUX: 124,
    ADCSRA: 122,
    ADCSRB: 123,
    ADCL: 120,
    ADCH: 121,
    DIDR0: 126,
    adcInterrupt: 42,
    numChannels: 8,
    muxInputMask: 15,
    muxChannels: atmega328Channels,
    adcReferences: [
      ADCReference.AREF,
      ADCReference.AVCC,
      ADCReference.Reserved,
      ADCReference.Internal1V1
    ]
  };
  var ADPS_MASK = 7;
  var ADIE = 8;
  var ADIF = 16;
  var ADSC = 64;
  var ADEN = 128;
  var MUX_MASK = 31;
  var ADLAR = 32;
  var MUX5 = 8;
  var REFS2 = 8;
  var REFS_MASK = 3;
  var REFS_SHIFT = 6;
  var AVRADC = class {
    constructor(cpu, config) {
      this.cpu = cpu;
      this.config = config;
      this.channelValues = new Array(this.config.numChannels);
      this.avcc = 5;
      this.aref = 5;
      this.onADCRead = (input) => {
        var _a;
        let voltage = 0;
        switch (input.type) {
          case ADCMuxInputType.Constant:
            voltage = input.voltage;
            break;
          case ADCMuxInputType.SingleEnded:
            voltage = (_a = this.channelValues[input.channel]) !== null && _a !== void 0 ? _a : 0;
            break;
          case ADCMuxInputType.Differential:
            voltage = input.gain * ((this.channelValues[input.positiveChannel] || 0) - (this.channelValues[input.negativeChannel] || 0));
            break;
          case ADCMuxInputType.Temperature:
            voltage = 0.378125;
            break;
        }
        const rawValue = voltage / this.referenceVoltage * 1024;
        const result = Math.min(Math.max(Math.floor(rawValue), 0), 1023);
        this.cpu.addClockEvent(() => this.completeADCRead(result), this.sampleCycles);
      };
      this.converting = false;
      this.conversionCycles = 25;
      this.ADC = {
        address: this.config.adcInterrupt,
        flagRegister: this.config.ADCSRA,
        flagMask: ADIF,
        enableRegister: this.config.ADCSRA,
        enableMask: ADIE
      };
      cpu.writeHooks[config.ADCSRA] = (value, oldValue) => {
        var _a;
        if (value & ADEN && !(oldValue && ADEN)) {
          this.conversionCycles = 25;
        }
        cpu.data[config.ADCSRA] = value;
        cpu.updateInterruptEnable(this.ADC, value);
        if (!this.converting && value & ADSC) {
          if (!(value & ADEN)) {
            this.cpu.addClockEvent(() => this.completeADCRead(0), this.sampleCycles);
            return true;
          }
          let channel = this.cpu.data[this.config.ADMUX] & MUX_MASK;
          if (cpu.data[config.ADCSRB] & MUX5) {
            channel |= 32;
          }
          channel &= config.muxInputMask;
          const muxInput = (_a = config.muxChannels[channel]) !== null && _a !== void 0 ? _a : fallbackMuxInput;
          this.converting = true;
          this.onADCRead(muxInput);
          return true;
        }
      };
    }
    completeADCRead(value) {
      const { ADCL, ADCH, ADMUX, ADCSRA } = this.config;
      this.converting = false;
      this.conversionCycles = 13;
      if (this.cpu.data[ADMUX] & ADLAR) {
        this.cpu.data[ADCL] = value << 6 & 255;
        this.cpu.data[ADCH] = value >> 2;
      } else {
        this.cpu.data[ADCL] = value & 255;
        this.cpu.data[ADCH] = value >> 8 & 3;
      }
      this.cpu.data[ADCSRA] &= ~ADSC;
      this.cpu.setInterruptFlag(this.ADC);
    }
    get prescaler() {
      const { ADCSRA } = this.config;
      const adcsra = this.cpu.data[ADCSRA];
      const adps = adcsra & ADPS_MASK;
      switch (adps) {
        case 0:
        case 1:
          return 2;
        case 2:
          return 4;
        case 3:
          return 8;
        case 4:
          return 16;
        case 5:
          return 32;
        case 6:
          return 64;
        case 7:
        default:
          return 128;
      }
    }
    get referenceVoltageType() {
      var _a;
      const { ADMUX, adcReferences } = this.config;
      let refs = this.cpu.data[ADMUX] >> REFS_SHIFT & REFS_MASK;
      if (adcReferences.length > 4 && this.cpu.data[ADMUX] & REFS2) {
        refs |= 4;
      }
      return (_a = adcReferences[refs]) !== null && _a !== void 0 ? _a : ADCReference.Reserved;
    }
    get referenceVoltage() {
      switch (this.referenceVoltageType) {
        case ADCReference.AVCC:
          return this.avcc;
        case ADCReference.AREF:
          return this.aref;
        case ADCReference.Internal1V1:
          return 1.1;
        case ADCReference.Internal2V56:
          return 2.56;
        default:
          return this.avcc;
      }
    }
    get sampleCycles() {
      return this.conversionCycles * this.prescaler;
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/clock.js
  var CLKPCE = 128;
  var clockConfig = {
    CLKPR: 97
  };
  var prescalers = [
    1,
    2,
    4,
    8,
    16,
    32,
    64,
    128,
    256,
    // The following values are "reserved" according to the datasheet, so we measured
    // with a scope to figure them out (on ATmega328p)
    2,
    4,
    8,
    16,
    32,
    64,
    128
  ];
  var AVRClock = class {
    constructor(cpu, baseFreqHz, config = clockConfig) {
      this.cpu = cpu;
      this.baseFreqHz = baseFreqHz;
      this.config = config;
      this.clockEnabledCycles = 0;
      this.prescalerValue = 1;
      this.cyclesDelta = 0;
      this.cpu.writeHooks[this.config.CLKPR] = (clkpr) => {
        if ((!this.clockEnabledCycles || this.clockEnabledCycles < cpu.cycles) && clkpr === CLKPCE) {
          this.clockEnabledCycles = this.cpu.cycles + 4;
        } else if (this.clockEnabledCycles && this.clockEnabledCycles >= cpu.cycles) {
          this.clockEnabledCycles = 0;
          const index = clkpr & 15;
          const oldPrescaler = this.prescalerValue;
          this.prescalerValue = prescalers[index];
          this.cpu.data[this.config.CLKPR] = index;
          if (oldPrescaler !== this.prescalerValue) {
            this.cyclesDelta = (cpu.cycles + this.cyclesDelta) * (oldPrescaler / this.prescalerValue) - cpu.cycles;
          }
        }
        return true;
      };
    }
    get frequency() {
      return this.baseFreqHz / this.prescalerValue;
    }
    get prescaler() {
      return this.prescalerValue;
    }
    get timeNanos() {
      return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e9;
    }
    get timeMicros() {
      return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e6;
    }
    get timeMillis() {
      return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e3;
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/eeprom.js
  var EEPROMMemoryBackend = class {
    constructor(size) {
      this.memory = new Uint8Array(size);
      this.memory.fill(255);
    }
    readMemory(addr) {
      return this.memory[addr];
    }
    writeMemory(addr, value) {
      this.memory[addr] &= value;
    }
    eraseMemory(addr) {
      this.memory[addr] = 255;
    }
  };
  var eepromConfig = {
    eepromReadyInterrupt: 44,
    EECR: 63,
    EEDR: 64,
    EEARL: 65,
    EEARH: 66,
    eraseCycles: 28800,
    // 1.8ms at 16MHz
    writeCycles: 28800
    // 1.8ms at 16MHz
  };
  var EERE = 1 << 0;
  var EEPE = 1 << 1;
  var EEMPE = 1 << 2;
  var EERIE = 1 << 3;
  var EEPM0 = 1 << 4;
  var EEPM1 = 1 << 5;
  var EECR_WRITE_MASK = EEPE | EEMPE | EERIE | EEPM0 | EEPM1;
  var AVREEPROM = class {
    constructor(cpu, backend, config = eepromConfig) {
      this.cpu = cpu;
      this.backend = backend;
      this.config = config;
      this.writeEnabledCycles = 0;
      this.writeCompleteCycles = 0;
      this.EER = {
        address: this.config.eepromReadyInterrupt,
        flagRegister: this.config.EECR,
        flagMask: EEPE,
        enableRegister: this.config.EECR,
        enableMask: EERIE,
        constant: true,
        inverseFlag: true
      };
      this.cpu.writeHooks[this.config.EECR] = (eecr) => {
        const { EEARH, EEARL, EECR, EEDR } = this.config;
        const addr = this.cpu.data[EEARH] << 8 | this.cpu.data[EEARL];
        this.cpu.data[EECR] = this.cpu.data[EECR] & ~EECR_WRITE_MASK | eecr & EECR_WRITE_MASK;
        this.cpu.updateInterruptEnable(this.EER, eecr);
        if (eecr & EERE) {
          this.cpu.clearInterrupt(this.EER);
        }
        if (eecr & EEMPE) {
          const eempeCycles = 4;
          this.writeEnabledCycles = this.cpu.cycles + eempeCycles;
          this.cpu.addClockEvent(() => {
            this.cpu.data[EECR] &= ~EEMPE;
          }, eempeCycles);
        }
        if (eecr & EERE) {
          this.cpu.data[EEDR] = this.backend.readMemory(addr);
          this.cpu.cycles += 4;
          return true;
        }
        if (eecr & EEPE) {
          if (this.cpu.cycles >= this.writeEnabledCycles) {
            this.cpu.data[EECR] &= ~EEPE;
            return true;
          }
          if (this.cpu.cycles < this.writeCompleteCycles) {
            return true;
          }
          const eedr = this.cpu.data[EEDR];
          this.writeCompleteCycles = this.cpu.cycles;
          if (!(eecr & EEPM1)) {
            this.backend.eraseMemory(addr);
            this.writeCompleteCycles += this.config.eraseCycles;
          }
          if (!(eecr & EEPM0)) {
            this.backend.writeMemory(addr, eedr);
            this.writeCompleteCycles += this.config.writeCycles;
          }
          this.cpu.data[EECR] |= EEPE;
          this.cpu.addClockEvent(() => {
            this.cpu.setInterruptFlag(this.EER);
          }, this.writeCompleteCycles - this.cpu.cycles);
          this.cpu.cycles += 2;
        }
        return true;
      };
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/gpio.js
  var INT0 = {
    EICR: 105,
    EIMSK: 61,
    EIFR: 60,
    index: 0,
    iscOffset: 0,
    interrupt: 2
  };
  var INT1 = {
    EICR: 105,
    EIMSK: 61,
    EIFR: 60,
    index: 1,
    iscOffset: 2,
    interrupt: 4
  };
  var PCINT0 = {
    PCIE: 0,
    PCICR: 104,
    PCIFR: 59,
    PCMSK: 107,
    pinChangeInterrupt: 6,
    mask: 255,
    offset: 0
  };
  var PCINT1 = {
    PCIE: 1,
    PCICR: 104,
    PCIFR: 59,
    PCMSK: 108,
    pinChangeInterrupt: 8,
    mask: 255,
    offset: 0
  };
  var PCINT2 = {
    PCIE: 2,
    PCICR: 104,
    PCIFR: 59,
    PCMSK: 109,
    pinChangeInterrupt: 10,
    mask: 255,
    offset: 0
  };
  var portBConfig = {
    PIN: 35,
    DDR: 36,
    PORT: 37,
    // Interrupt settings
    pinChange: PCINT0,
    externalInterrupts: []
  };
  var portCConfig = {
    PIN: 38,
    DDR: 39,
    PORT: 40,
    // Interrupt settings
    pinChange: PCINT1,
    externalInterrupts: []
  };
  var portDConfig = {
    PIN: 41,
    DDR: 42,
    PORT: 43,
    // Interrupt settings
    pinChange: PCINT2,
    externalInterrupts: [null, null, INT0, INT1]
  };
  var PinState;
  (function(PinState2) {
    PinState2[PinState2["Low"] = 0] = "Low";
    PinState2[PinState2["High"] = 1] = "High";
    PinState2[PinState2["Input"] = 2] = "Input";
    PinState2[PinState2["InputPullUp"] = 3] = "InputPullUp";
  })(PinState || (PinState = {}));
  var PinOverrideMode;
  (function(PinOverrideMode2) {
    PinOverrideMode2[PinOverrideMode2["None"] = 0] = "None";
    PinOverrideMode2[PinOverrideMode2["Enable"] = 1] = "Enable";
    PinOverrideMode2[PinOverrideMode2["Set"] = 2] = "Set";
    PinOverrideMode2[PinOverrideMode2["Clear"] = 3] = "Clear";
    PinOverrideMode2[PinOverrideMode2["Toggle"] = 4] = "Toggle";
  })(PinOverrideMode || (PinOverrideMode = {}));
  var InterruptMode;
  (function(InterruptMode2) {
    InterruptMode2[InterruptMode2["LowLevel"] = 0] = "LowLevel";
    InterruptMode2[InterruptMode2["Change"] = 1] = "Change";
    InterruptMode2[InterruptMode2["FallingEdge"] = 2] = "FallingEdge";
    InterruptMode2[InterruptMode2["RisingEdge"] = 3] = "RisingEdge";
  })(InterruptMode || (InterruptMode = {}));
  var AVRIOPort = class {
    constructor(cpu, portConfig) {
      var _a, _b, _c, _d;
      this.cpu = cpu;
      this.portConfig = portConfig;
      this.externalClockListeners = [];
      this.listeners = [];
      this.pinValue = 0;
      this.overrideMask = 255;
      this.overrideValue = 0;
      this.lastValue = 0;
      this.lastDdr = 0;
      this.lastPin = 0;
      this.openCollector = 0;
      cpu.gpioPorts.add(this);
      cpu.gpioByPort[portConfig.PORT] = this;
      cpu.writeHooks[portConfig.DDR] = (value) => {
        const portValue = cpu.data[portConfig.PORT];
        cpu.data[portConfig.DDR] = value;
        this.writeGpio(portValue, value);
        this.updatePinRegister(value);
        return true;
      };
      cpu.writeHooks[portConfig.PORT] = (value) => {
        const ddrMask = cpu.data[portConfig.DDR];
        cpu.data[portConfig.PORT] = value;
        this.writeGpio(value, ddrMask);
        this.updatePinRegister(ddrMask);
        return true;
      };
      cpu.writeHooks[portConfig.PIN] = (value, oldValue, addr, mask) => {
        const oldPortValue = cpu.data[portConfig.PORT];
        const ddrMask = cpu.data[portConfig.DDR];
        const portValue = oldPortValue ^ value & mask;
        cpu.data[portConfig.PORT] = portValue;
        this.writeGpio(portValue, ddrMask);
        this.updatePinRegister(ddrMask);
        return true;
      };
      const { externalInterrupts } = portConfig;
      this.externalInts = externalInterrupts.map((externalConfig) => externalConfig ? {
        address: externalConfig.interrupt,
        flagRegister: externalConfig.EIFR,
        flagMask: 1 << externalConfig.index,
        enableRegister: externalConfig.EIMSK,
        enableMask: 1 << externalConfig.index
      } : null);
      const EICR = new Set(externalInterrupts.map((item) => item === null || item === void 0 ? void 0 : item.EICR));
      for (const EICRx of EICR) {
        this.attachInterruptHook(EICRx || 0);
      }
      const EIMSK = (_b = (_a = externalInterrupts.find((item) => item && item.EIMSK)) === null || _a === void 0 ? void 0 : _a.EIMSK) !== null && _b !== void 0 ? _b : 0;
      this.attachInterruptHook(EIMSK, "mask");
      const EIFR = (_d = (_c = externalInterrupts.find((item) => item && item.EIFR)) === null || _c === void 0 ? void 0 : _c.EIFR) !== null && _d !== void 0 ? _d : 0;
      this.attachInterruptHook(EIFR, "flag");
      const { pinChange } = portConfig;
      this.PCINT = pinChange ? {
        address: pinChange.pinChangeInterrupt,
        flagRegister: pinChange.PCIFR,
        flagMask: 1 << pinChange.PCIE,
        enableRegister: pinChange.PCICR,
        enableMask: 1 << pinChange.PCIE
      } : null;
      if (pinChange) {
        const { PCIFR, PCMSK } = pinChange;
        cpu.writeHooks[PCIFR] = (value) => {
          for (const gpio of this.cpu.gpioPorts) {
            const { PCINT } = gpio;
            if (PCINT) {
              cpu.clearInterruptByFlag(PCINT, value);
            }
          }
          return true;
        };
        cpu.writeHooks[PCMSK] = (value) => {
          cpu.data[PCMSK] = value;
          for (const gpio of this.cpu.gpioPorts) {
            const { PCINT } = gpio;
            if (PCINT) {
              cpu.updateInterruptEnable(PCINT, value);
            }
          }
          return true;
        };
      }
    }
    addListener(listener) {
      this.listeners.push(listener);
    }
    removeListener(listener) {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
    /**
     * Get the state of a given GPIO pin
     *
     * @param index Pin index to return from 0 to 7
     * @returns PinState.Low or PinState.High if the pin is set to output, PinState.Input if the pin is set
     *   to input, and PinState.InputPullUp if the pin is set to input and the internal pull-up resistor has
     *   been enabled.
     */
    pinState(index) {
      const ddr = this.cpu.data[this.portConfig.DDR];
      const port = this.cpu.data[this.portConfig.PORT];
      const bitMask = 1 << index;
      const openState = port & bitMask ? PinState.InputPullUp : PinState.Input;
      const highValue = this.openCollector & bitMask ? openState : PinState.High;
      if (ddr & bitMask) {
        return this.lastValue & bitMask ? highValue : PinState.Low;
      } else {
        return openState;
      }
    }
    /**
     * Sets the input value for the given pin. This is the value that
     * will be returned when reading from the PIN register.
     */
    setPin(index, value) {
      const bitMask = 1 << index;
      this.pinValue &= ~bitMask;
      if (value) {
        this.pinValue |= bitMask;
      }
      this.updatePinRegister(this.cpu.data[this.portConfig.DDR]);
    }
    /**
     * Internal method - do not call this directly!
     * Used by the timer compare output units to override GPIO pins.
     */
    timerOverridePin(pin, mode) {
      const { cpu, portConfig } = this;
      const pinMask = 1 << pin;
      if (mode === PinOverrideMode.None) {
        this.overrideMask |= pinMask;
        this.overrideValue &= ~pinMask;
      } else {
        this.overrideMask &= ~pinMask;
        switch (mode) {
          case PinOverrideMode.Enable:
            this.overrideValue &= ~pinMask;
            this.overrideValue |= cpu.data[portConfig.PORT] & pinMask;
            break;
          case PinOverrideMode.Set:
            this.overrideValue |= pinMask;
            break;
          case PinOverrideMode.Clear:
            this.overrideValue &= ~pinMask;
            break;
          case PinOverrideMode.Toggle:
            this.overrideValue ^= pinMask;
            break;
        }
      }
      const ddrMask = cpu.data[portConfig.DDR];
      this.writeGpio(cpu.data[portConfig.PORT], ddrMask);
      this.updatePinRegister(ddrMask);
    }
    updatePinRegister(ddr) {
      var _a, _b;
      const newPin = this.pinValue & ~ddr | this.lastValue & ddr;
      this.cpu.data[this.portConfig.PIN] = newPin;
      if (this.lastPin !== newPin) {
        for (let index = 0; index < 8; index++) {
          if ((newPin & 1 << index) !== (this.lastPin & 1 << index)) {
            const value = !!(newPin & 1 << index);
            this.toggleInterrupt(index, value);
            (_b = (_a = this.externalClockListeners)[index]) === null || _b === void 0 ? void 0 : _b.call(_a, value);
          }
        }
        this.lastPin = newPin;
      }
    }
    toggleInterrupt(pin, risingEdge) {
      const { cpu, portConfig, externalInts, PCINT } = this;
      const { externalInterrupts, pinChange } = portConfig;
      const externalConfig = externalInterrupts[pin];
      const external = externalInts[pin];
      if (external && externalConfig) {
        const { EIMSK, index, EICR, iscOffset } = externalConfig;
        if (cpu.data[EIMSK] & 1 << index) {
          const configuration = cpu.data[EICR] >> iscOffset & 3;
          let generateInterrupt = false;
          external.constant = false;
          switch (configuration) {
            case InterruptMode.LowLevel:
              generateInterrupt = !risingEdge;
              external.constant = true;
              break;
            case InterruptMode.Change:
              generateInterrupt = true;
              break;
            case InterruptMode.FallingEdge:
              generateInterrupt = !risingEdge;
              break;
            case InterruptMode.RisingEdge:
              generateInterrupt = risingEdge;
              break;
          }
          if (generateInterrupt) {
            cpu.setInterruptFlag(external);
          } else if (external.constant) {
            cpu.clearInterrupt(external, true);
          }
        }
      }
      if (pinChange && PCINT && pinChange.mask & 1 << pin) {
        const { PCMSK } = pinChange;
        if (cpu.data[PCMSK] & 1 << pin + pinChange.offset) {
          cpu.setInterruptFlag(PCINT);
        }
      }
    }
    attachInterruptHook(register, registerType = "other") {
      if (!register) {
        return;
      }
      const { cpu } = this;
      cpu.writeHooks[register] = (value) => {
        if (registerType !== "flag") {
          cpu.data[register] = value;
        }
        for (const gpio of cpu.gpioPorts) {
          for (const external of gpio.externalInts) {
            if (external && registerType === "mask") {
              cpu.updateInterruptEnable(external, value);
            }
            if (external && !external.constant && registerType === "flag") {
              cpu.clearInterruptByFlag(external, value);
            }
          }
          gpio.checkExternalInterrupts();
        }
        return true;
      };
    }
    checkExternalInterrupts() {
      const { cpu } = this;
      const { externalInterrupts } = this.portConfig;
      for (let pin = 0; pin < 8; pin++) {
        const external = externalInterrupts[pin];
        if (!external) {
          continue;
        }
        const pinValue = !!(this.lastPin & 1 << pin);
        const { EIFR, EIMSK, index, EICR, iscOffset, interrupt } = external;
        if (!(cpu.data[EIMSK] & 1 << index) || pinValue) {
          continue;
        }
        const configuration = cpu.data[EICR] >> iscOffset & 3;
        if (configuration === InterruptMode.LowLevel) {
          cpu.queueInterrupt({
            address: interrupt,
            flagRegister: EIFR,
            flagMask: 1 << index,
            enableRegister: EIMSK,
            enableMask: 1 << index,
            constant: true
          });
        }
      }
    }
    writeGpio(value, ddr) {
      const newValue = (value & this.overrideMask | this.overrideValue) & ddr | value & ~ddr;
      const prevValue = this.lastValue;
      if (newValue !== prevValue || ddr !== this.lastDdr) {
        this.lastValue = newValue;
        this.lastDdr = ddr;
        for (const listener of this.listeners) {
          listener(newValue, prevValue);
        }
      }
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/spi.js
  var SPCR_SPR1 = 2;
  var SPCR_SPR0 = 1;
  var SPSR_SPR_MASK = SPCR_SPR1 | SPCR_SPR0;

  // node_modules/avr8js/dist/esm/peripherals/timer.js
  var timer01Dividers = {
    0: 0,
    1: 1,
    2: 8,
    3: 64,
    4: 256,
    5: 1024,
    6: 0,
    // External clock - see ExternalClockMode
    7: 0
    // Ditto
  };
  var ExternalClockMode;
  (function(ExternalClockMode2) {
    ExternalClockMode2[ExternalClockMode2["FallingEdge"] = 6] = "FallingEdge";
    ExternalClockMode2[ExternalClockMode2["RisingEdge"] = 7] = "RisingEdge";
  })(ExternalClockMode || (ExternalClockMode = {}));
  var defaultTimerBits = {
    // TIFR bits
    TOV: 1,
    OCFA: 2,
    OCFB: 4,
    OCFC: 0,
    // Unused
    // TIMSK bits
    TOIE: 1,
    OCIEA: 2,
    OCIEB: 4,
    OCIEC: 0
    // Unused
  };
  var timer0Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 28, compBInterrupt: 30, compCInterrupt: 0, ovfInterrupt: 32, TIFR: 53, OCRA: 71, OCRB: 72, OCRC: 0, ICR: 0, TCNT: 70, TCCRA: 68, TCCRB: 69, TCCRC: 0, TIMSK: 110, dividers: timer01Dividers, compPortA: portDConfig.PORT, compPinA: 6, compPortB: portDConfig.PORT, compPinB: 5, compPortC: 0, compPinC: 0, externalClockPort: portDConfig.PORT, externalClockPin: 4 }, defaultTimerBits);
  var timer1Config = Object.assign({ bits: 16, captureInterrupt: 20, compAInterrupt: 22, compBInterrupt: 24, compCInterrupt: 0, ovfInterrupt: 26, TIFR: 54, OCRA: 136, OCRB: 138, OCRC: 0, ICR: 134, TCNT: 132, TCCRA: 128, TCCRB: 129, TCCRC: 130, TIMSK: 111, dividers: timer01Dividers, compPortA: portBConfig.PORT, compPinA: 1, compPortB: portBConfig.PORT, compPinB: 2, compPortC: 0, compPinC: 0, externalClockPort: portDConfig.PORT, externalClockPin: 5 }, defaultTimerBits);
  var timer2Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 14, compBInterrupt: 16, compCInterrupt: 0, ovfInterrupt: 18, TIFR: 55, OCRA: 179, OCRB: 180, OCRC: 0, ICR: 0, TCNT: 178, TCCRA: 176, TCCRB: 177, TCCRC: 0, TIMSK: 112, dividers: {
    0: 0,
    1: 1,
    2: 8,
    3: 32,
    4: 64,
    5: 128,
    6: 256,
    7: 1024
  }, compPortA: portBConfig.PORT, compPinA: 3, compPortB: portDConfig.PORT, compPinB: 3, compPortC: 0, compPinC: 0, externalClockPort: 0, externalClockPin: 0 }, defaultTimerBits);
  var TimerMode;
  (function(TimerMode2) {
    TimerMode2[TimerMode2["Normal"] = 0] = "Normal";
    TimerMode2[TimerMode2["PWMPhaseCorrect"] = 1] = "PWMPhaseCorrect";
    TimerMode2[TimerMode2["CTC"] = 2] = "CTC";
    TimerMode2[TimerMode2["FastPWM"] = 3] = "FastPWM";
    TimerMode2[TimerMode2["PWMPhaseFrequencyCorrect"] = 4] = "PWMPhaseFrequencyCorrect";
    TimerMode2[TimerMode2["Reserved"] = 5] = "Reserved";
  })(TimerMode || (TimerMode = {}));
  var TOVUpdateMode;
  (function(TOVUpdateMode2) {
    TOVUpdateMode2[TOVUpdateMode2["Max"] = 0] = "Max";
    TOVUpdateMode2[TOVUpdateMode2["Top"] = 1] = "Top";
    TOVUpdateMode2[TOVUpdateMode2["Bottom"] = 2] = "Bottom";
  })(TOVUpdateMode || (TOVUpdateMode = {}));
  var OCRUpdateMode;
  (function(OCRUpdateMode2) {
    OCRUpdateMode2[OCRUpdateMode2["Immediate"] = 0] = "Immediate";
    OCRUpdateMode2[OCRUpdateMode2["Top"] = 1] = "Top";
    OCRUpdateMode2[OCRUpdateMode2["Bottom"] = 2] = "Bottom";
  })(OCRUpdateMode || (OCRUpdateMode = {}));
  var TopOCRA = 1;
  var TopICR = 2;
  var OCToggle = 1;
  var { Normal, PWMPhaseCorrect, CTC, FastPWM, Reserved, PWMPhaseFrequencyCorrect } = TimerMode;
  var wgmModes8Bit = [
    /*0*/
    [Normal, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*1*/
    [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
    /*2*/
    [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*3*/
    [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Max, 0],
    /*4*/
    [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*5*/
    [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
    /*6*/
    [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*7*/
    [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
  ];
  var wgmModes16Bit = [
    /*0 */
    [Normal, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*1 */
    [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
    /*2 */
    [PWMPhaseCorrect, 511, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
    /*3 */
    [PWMPhaseCorrect, 1023, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
    /*4 */
    [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*5 */
    [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
    /*6 */
    [FastPWM, 511, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
    /*7 */
    [FastPWM, 1023, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
    /*8 */
    [PWMPhaseFrequencyCorrect, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, 0],
    /*9 */
    [PWMPhaseFrequencyCorrect, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, OCToggle],
    /*10*/
    [PWMPhaseCorrect, TopICR, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
    /*11*/
    [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
    /*12*/
    [CTC, TopICR, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*13*/
    [Reserved, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
    /*14*/
    [FastPWM, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle],
    /*15*/
    [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
  ];
  function compToOverride(comp) {
    switch (comp) {
      case 1:
        return PinOverrideMode.Toggle;
      case 2:
        return PinOverrideMode.Clear;
      case 3:
        return PinOverrideMode.Set;
      default:
        return PinOverrideMode.Enable;
    }
  }
  var FOCA = 1 << 7;
  var FOCB = 1 << 6;
  var FOCC = 1 << 5;
  var AVRTimer = class {
    constructor(cpu, config) {
      this.cpu = cpu;
      this.config = config;
      this.MAX = this.config.bits === 16 ? 65535 : 255;
      this.lastCycle = 0;
      this.ocrA = 0;
      this.nextOcrA = 0;
      this.ocrB = 0;
      this.nextOcrB = 0;
      this.hasOCRC = this.config.OCRC > 0;
      this.ocrC = 0;
      this.nextOcrC = 0;
      this.ocrUpdateMode = OCRUpdateMode.Immediate;
      this.tovUpdateMode = TOVUpdateMode.Max;
      this.icr = 0;
      this.tcnt = 0;
      this.tcntNext = 0;
      this.tcntUpdated = false;
      this.updateDivider = false;
      this.countingUp = true;
      this.divider = 0;
      this.externalClockRisingEdge = false;
      this.highByteTemp = 0;
      this.OVF = {
        address: this.config.ovfInterrupt,
        flagRegister: this.config.TIFR,
        flagMask: this.config.TOV,
        enableRegister: this.config.TIMSK,
        enableMask: this.config.TOIE
      };
      this.OCFA = {
        address: this.config.compAInterrupt,
        flagRegister: this.config.TIFR,
        flagMask: this.config.OCFA,
        enableRegister: this.config.TIMSK,
        enableMask: this.config.OCIEA
      };
      this.OCFB = {
        address: this.config.compBInterrupt,
        flagRegister: this.config.TIFR,
        flagMask: this.config.OCFB,
        enableRegister: this.config.TIMSK,
        enableMask: this.config.OCIEB
      };
      this.OCFC = {
        address: this.config.compCInterrupt,
        flagRegister: this.config.TIFR,
        flagMask: this.config.OCFC,
        enableRegister: this.config.TIMSK,
        enableMask: this.config.OCIEC
      };
      this.count = (reschedule = true, external = false) => {
        const { divider, lastCycle, cpu: cpu2 } = this;
        const { cycles } = cpu2;
        const delta = cycles - lastCycle;
        if (divider && delta >= divider || external) {
          const counterDelta = external ? 1 : Math.floor(delta / divider);
          this.lastCycle += counterDelta * divider;
          const val = this.tcnt;
          const { timerMode, TOP } = this;
          const phasePwm = timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
          const newVal = phasePwm ? this.phasePwmCount(val, counterDelta) : (val + counterDelta) % (TOP + 1);
          const overflow = val + counterDelta > TOP;
          if (!this.tcntUpdated) {
            this.tcnt = newVal;
            if (!phasePwm) {
              this.timerUpdated(newVal, val);
            }
          }
          if (!phasePwm) {
            if (timerMode === FastPWM && overflow) {
              const { compA, compB } = this;
              if (compA) {
                this.updateCompPin(compA, "A", true);
              }
              if (compB) {
                this.updateCompPin(compB, "B", true);
              }
            }
            if (this.ocrUpdateMode == OCRUpdateMode.Bottom && overflow) {
              this.ocrA = this.nextOcrA;
              this.ocrB = this.nextOcrB;
              this.ocrC = this.nextOcrC;
            }
            if (overflow && (this.tovUpdateMode == TOVUpdateMode.Top || TOP === this.MAX)) {
              cpu2.setInterruptFlag(this.OVF);
            }
          }
        }
        if (this.tcntUpdated) {
          this.tcnt = this.tcntNext;
          this.tcntUpdated = false;
          if (this.tcnt === 0 && this.ocrUpdateMode === OCRUpdateMode.Bottom || this.tcnt === this.TOP && this.ocrUpdateMode === OCRUpdateMode.Top) {
            this.ocrA = this.nextOcrA;
            this.ocrB = this.nextOcrB;
            this.ocrC = this.nextOcrC;
          }
        }
        if (this.updateDivider) {
          const { CS } = this;
          const { externalClockPin } = this.config;
          const newDivider = this.config.dividers[CS];
          this.lastCycle = newDivider ? this.cpu.cycles : 0;
          this.updateDivider = false;
          this.divider = newDivider;
          if (this.config.externalClockPort && !this.externalClockPort) {
            this.externalClockPort = this.cpu.gpioByPort[this.config.externalClockPort];
          }
          if (this.externalClockPort) {
            this.externalClockPort.externalClockListeners[externalClockPin] = null;
          }
          if (newDivider) {
            cpu2.addClockEvent(this.count, this.lastCycle + newDivider - cpu2.cycles);
          } else if (this.externalClockPort && (CS === ExternalClockMode.FallingEdge || CS === ExternalClockMode.RisingEdge)) {
            this.externalClockPort.externalClockListeners[externalClockPin] = this.externalClockCallback;
            this.externalClockRisingEdge = CS === ExternalClockMode.RisingEdge;
          }
          return;
        }
        if (reschedule && divider) {
          cpu2.addClockEvent(this.count, this.lastCycle + divider - cpu2.cycles);
        }
      };
      this.externalClockCallback = (value) => {
        if (value === this.externalClockRisingEdge) {
          this.count(false, true);
        }
      };
      this.updateWGMConfig();
      this.cpu.readHooks[config.TCNT] = (addr) => {
        this.count(false);
        if (this.config.bits === 16) {
          this.cpu.data[addr + 1] = this.tcnt >> 8;
        }
        return this.cpu.data[addr] = this.tcnt & 255;
      };
      this.cpu.writeHooks[config.TCNT] = (value) => {
        this.tcntNext = this.highByteTemp << 8 | value;
        this.countingUp = true;
        this.tcntUpdated = true;
        this.cpu.updateClockEvent(this.count, 0);
        if (this.divider) {
          this.timerUpdated(this.tcntNext, this.tcntNext);
        }
      };
      this.cpu.writeHooks[config.OCRA] = (value) => {
        this.nextOcrA = this.highByteTemp << 8 | value;
        if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
          this.ocrA = this.nextOcrA;
        }
      };
      this.cpu.writeHooks[config.OCRB] = (value) => {
        this.nextOcrB = this.highByteTemp << 8 | value;
        if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
          this.ocrB = this.nextOcrB;
        }
      };
      if (this.hasOCRC) {
        this.cpu.writeHooks[config.OCRC] = (value) => {
          this.nextOcrC = this.highByteTemp << 8 | value;
          if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
            this.ocrC = this.nextOcrC;
          }
        };
      }
      if (this.config.bits === 16) {
        this.cpu.writeHooks[config.ICR] = (value) => {
          this.icr = this.highByteTemp << 8 | value;
        };
        const updateTempRegister = (value) => {
          this.highByteTemp = value;
        };
        const updateOCRHighRegister = (value, old, addr) => {
          this.highByteTemp = value & this.ocrMask >> 8;
          cpu.data[addr] = this.highByteTemp;
          return true;
        };
        this.cpu.writeHooks[config.TCNT + 1] = updateTempRegister;
        this.cpu.writeHooks[config.OCRA + 1] = updateOCRHighRegister;
        this.cpu.writeHooks[config.OCRB + 1] = updateOCRHighRegister;
        if (this.hasOCRC) {
          this.cpu.writeHooks[config.OCRC + 1] = updateOCRHighRegister;
        }
        this.cpu.writeHooks[config.ICR + 1] = updateTempRegister;
      }
      cpu.writeHooks[config.TCCRA] = (value) => {
        this.cpu.data[config.TCCRA] = value;
        this.updateWGMConfig();
        return true;
      };
      cpu.writeHooks[config.TCCRB] = (value) => {
        if (!config.TCCRC) {
          this.checkForceCompare(value);
          value &= ~(FOCA | FOCB);
        }
        this.cpu.data[config.TCCRB] = value;
        this.updateDivider = true;
        this.cpu.clearClockEvent(this.count);
        this.cpu.addClockEvent(this.count, 0);
        this.updateWGMConfig();
        return true;
      };
      if (config.TCCRC) {
        cpu.writeHooks[config.TCCRC] = (value) => {
          this.checkForceCompare(value);
        };
      }
      cpu.writeHooks[config.TIFR] = (value) => {
        this.cpu.data[config.TIFR] = value;
        this.cpu.clearInterruptByFlag(this.OVF, value);
        this.cpu.clearInterruptByFlag(this.OCFA, value);
        this.cpu.clearInterruptByFlag(this.OCFB, value);
        return true;
      };
      cpu.writeHooks[config.TIMSK] = (value) => {
        this.cpu.updateInterruptEnable(this.OVF, value);
        this.cpu.updateInterruptEnable(this.OCFA, value);
        this.cpu.updateInterruptEnable(this.OCFB, value);
      };
    }
    reset() {
      this.divider = 0;
      this.lastCycle = 0;
      this.ocrA = 0;
      this.nextOcrA = 0;
      this.ocrB = 0;
      this.nextOcrB = 0;
      this.ocrC = 0;
      this.nextOcrC = 0;
      this.icr = 0;
      this.tcnt = 0;
      this.tcntNext = 0;
      this.tcntUpdated = false;
      this.countingUp = false;
      this.updateDivider = true;
    }
    get TCCRA() {
      return this.cpu.data[this.config.TCCRA];
    }
    get TCCRB() {
      return this.cpu.data[this.config.TCCRB];
    }
    get TIMSK() {
      return this.cpu.data[this.config.TIMSK];
    }
    get CS() {
      return this.TCCRB & 7;
    }
    get WGM() {
      const mask = this.config.bits === 16 ? 24 : 8;
      return (this.TCCRB & mask) >> 1 | this.TCCRA & 3;
    }
    get TOP() {
      switch (this.topValue) {
        case TopOCRA:
          return this.ocrA;
        case TopICR:
          return this.icr;
        default:
          return this.topValue;
      }
    }
    get ocrMask() {
      switch (this.topValue) {
        case TopOCRA:
        case TopICR:
          return 65535;
        default:
          return this.topValue;
      }
    }
    /** Expose the raw value of TCNT, for use by the unit tests */
    get debugTCNT() {
      return this.tcnt;
    }
    updateWGMConfig() {
      const { config, WGM } = this;
      const wgmModes = config.bits === 16 ? wgmModes16Bit : wgmModes8Bit;
      const TCCRA = this.cpu.data[config.TCCRA];
      const [timerMode, topValue, ocrUpdateMode, tovUpdateMode, flags] = wgmModes[WGM];
      this.timerMode = timerMode;
      this.topValue = topValue;
      this.ocrUpdateMode = ocrUpdateMode;
      this.tovUpdateMode = tovUpdateMode;
      const pwmMode = timerMode === FastPWM || timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
      const prevCompA = this.compA;
      this.compA = TCCRA >> 6 & 3;
      if (this.compA === 1 && pwmMode && !(flags & OCToggle)) {
        this.compA = 0;
      }
      if (!!prevCompA !== !!this.compA) {
        this.updateCompA(this.compA ? PinOverrideMode.Enable : PinOverrideMode.None);
      }
      const prevCompB = this.compB;
      this.compB = TCCRA >> 4 & 3;
      if (this.compB === 1 && pwmMode) {
        this.compB = 0;
      }
      if (!!prevCompB !== !!this.compB) {
        this.updateCompB(this.compB ? PinOverrideMode.Enable : PinOverrideMode.None);
      }
      if (this.hasOCRC) {
        const prevCompC = this.compC;
        this.compC = TCCRA >> 2 & 3;
        if (this.compC === 1 && pwmMode) {
          this.compC = 0;
        }
        if (!!prevCompC !== !!this.compC) {
          this.updateCompC(this.compC ? PinOverrideMode.Enable : PinOverrideMode.None);
        }
      }
    }
    phasePwmCount(value, delta) {
      const { ocrA, ocrB, ocrC, hasOCRC, TOP, MAX, tcntUpdated } = this;
      if (!value && !TOP) {
        delta = 0;
        if (this.ocrUpdateMode === OCRUpdateMode.Top) {
          this.ocrA = this.nextOcrA;
          this.ocrB = this.nextOcrB;
          this.ocrC = this.nextOcrC;
        }
      }
      while (delta > 0) {
        if (this.countingUp) {
          value++;
          if (value === TOP && !tcntUpdated) {
            this.countingUp = false;
            if (this.ocrUpdateMode === OCRUpdateMode.Top) {
              this.ocrA = this.nextOcrA;
              this.ocrB = this.nextOcrB;
              this.ocrC = this.nextOcrC;
            }
          }
        } else {
          value--;
          if (!value && !tcntUpdated) {
            this.countingUp = true;
            this.cpu.setInterruptFlag(this.OVF);
            if (this.ocrUpdateMode === OCRUpdateMode.Bottom) {
              this.ocrA = this.nextOcrA;
              this.ocrB = this.nextOcrB;
              this.ocrC = this.nextOcrC;
            }
          }
        }
        if (!tcntUpdated) {
          if (value === ocrA) {
            this.cpu.setInterruptFlag(this.OCFA);
            if (this.compA) {
              this.updateCompPin(this.compA, "A");
            }
          }
          if (value === ocrB) {
            this.cpu.setInterruptFlag(this.OCFB);
            if (this.compB) {
              this.updateCompPin(this.compB, "B");
            }
          }
          if (hasOCRC && value === ocrC) {
            this.cpu.setInterruptFlag(this.OCFC);
            if (this.compC) {
              this.updateCompPin(this.compC, "C");
            }
          }
        }
        delta--;
      }
      return value & MAX;
    }
    timerUpdated(value, prevValue) {
      const { ocrA, ocrB, ocrC, hasOCRC } = this;
      const overflow = prevValue > value;
      if ((prevValue < ocrA || overflow) && value >= ocrA || prevValue < ocrA && overflow) {
        this.cpu.setInterruptFlag(this.OCFA);
        if (this.compA) {
          this.updateCompPin(this.compA, "A");
        }
      }
      if ((prevValue < ocrB || overflow) && value >= ocrB || prevValue < ocrB && overflow) {
        this.cpu.setInterruptFlag(this.OCFB);
        if (this.compB) {
          this.updateCompPin(this.compB, "B");
        }
      }
      if (hasOCRC && ((prevValue < ocrC || overflow) && value >= ocrC || prevValue < ocrC && overflow)) {
        this.cpu.setInterruptFlag(this.OCFC);
        if (this.compC) {
          this.updateCompPin(this.compC, "C");
        }
      }
    }
    checkForceCompare(value) {
      if (this.timerMode == TimerMode.FastPWM || this.timerMode == TimerMode.PWMPhaseCorrect || this.timerMode == TimerMode.PWMPhaseFrequencyCorrect) {
        return;
      }
      if (value & FOCA) {
        this.updateCompPin(this.compA, "A");
      }
      if (value & FOCB) {
        this.updateCompPin(this.compB, "B");
      }
      if (this.config.compPortC && value & FOCC) {
        this.updateCompPin(this.compC, "C");
      }
    }
    updateCompPin(compValue, pinName, bottom = false) {
      let newValue = PinOverrideMode.None;
      const invertingMode = compValue === 3;
      const isSet = this.countingUp === invertingMode;
      switch (this.timerMode) {
        case Normal:
        case CTC:
          newValue = compToOverride(compValue);
          break;
        case FastPWM:
          if (compValue === 1) {
            newValue = bottom ? PinOverrideMode.None : PinOverrideMode.Toggle;
          } else {
            newValue = invertingMode !== bottom ? PinOverrideMode.Set : PinOverrideMode.Clear;
          }
          break;
        case PWMPhaseCorrect:
        case PWMPhaseFrequencyCorrect:
          if (compValue === 1) {
            newValue = PinOverrideMode.Toggle;
          } else {
            newValue = isSet ? PinOverrideMode.Set : PinOverrideMode.Clear;
          }
          break;
      }
      if (newValue !== PinOverrideMode.None) {
        if (pinName === "A") {
          this.updateCompA(newValue);
        } else if (pinName === "B") {
          this.updateCompB(newValue);
        } else {
          this.updateCompC(newValue);
        }
      }
    }
    updateCompA(value) {
      const { compPortA, compPinA } = this.config;
      const port = this.cpu.gpioByPort[compPortA];
      port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinA, value);
    }
    updateCompB(value) {
      const { compPortB, compPinB } = this.config;
      const port = this.cpu.gpioByPort[compPortB];
      port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinB, value);
    }
    updateCompC(value) {
      const { compPortC, compPinC } = this.config;
      const port = this.cpu.gpioByPort[compPortC];
      port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinC, value);
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/timer-attiny.js
  var CTC1 = 1 << 7;
  var PWM1A = 1 << 6;
  var PWM1B_BIT = 1 << 6;
  var FOC1B = 1 << 3;
  var FOC1A = 1 << 2;
  var PSR1 = 1 << 1;
  var attinyTimer1Config = {
    TCCR1: 80,
    GTCCR: 76,
    TCNT1: 79,
    OCR1A: 78,
    OCR1B: 75,
    OCR1C: 77,
    TIFR: 88,
    TIMSK: 89,
    ovfInterrupt: 4,
    compAInterrupt: 3,
    compBInterrupt: 9,
    TOV1: 1 << 2,
    OCF1A: 1 << 6,
    OCF1B: 1 << 5,
    TOIE1: 1 << 2,
    OCIE1A: 1 << 6,
    OCIE1B: 1 << 5,
    compPortB: 56,
    compPinA: 1,
    // PB1
    compPinB: 4,
    // PB4
    dividers: {
      0: 0,
      1: 1,
      2: 2,
      3: 4,
      4: 8,
      5: 16,
      6: 32,
      7: 64,
      8: 128,
      9: 256,
      10: 512,
      11: 1024,
      12: 2048,
      13: 4096,
      14: 8192,
      15: 16384
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/twi.js
  var TWCR_TWINT = 128;
  var TWCR_TWEA = 64;
  var TWCR_TWSTA = 32;
  var TWCR_TWSTO = 16;
  var TWCR_TWEN = 4;
  var TWCR_TWIE = 1;
  var TWSR_TWS_MASK = 248;
  var TWSR_TWPS1 = 2;
  var TWSR_TWPS0 = 1;
  var TWSR_TWPS_MASK = TWSR_TWPS1 | TWSR_TWPS0;
  var STATUS_TWI_IDLE = 248;
  var STATUS_START = 8;
  var STATUS_REPEATED_START = 16;
  var STATUS_SLAW_ACK = 24;
  var STATUS_SLAW_NACK = 32;
  var STATUS_DATA_SENT_ACK = 40;
  var STATUS_DATA_SENT_NACK = 48;
  var STATUS_SLAR_ACK = 64;
  var STATUS_SLAR_NACK = 72;
  var STATUS_DATA_RECEIVED_ACK = 80;
  var STATUS_DATA_RECEIVED_NACK = 88;
  var twiConfig = {
    twiInterrupt: 48,
    TWBR: 184,
    TWSR: 185,
    TWAR: 186,
    TWDR: 187,
    TWCR: 188,
    TWAMR: 189
  };
  var NoopTWIEventHandler = class {
    constructor(twi) {
      this.twi = twi;
    }
    start() {
      this.twi.completeStart();
    }
    stop() {
      this.twi.completeStop();
    }
    connectToSlave() {
      this.twi.completeConnect(false);
    }
    writeByte() {
      this.twi.completeWrite(false);
    }
    readByte() {
      this.twi.completeRead(255);
    }
  };
  var AVRTWI = class {
    constructor(cpu, config, freqHz) {
      this.cpu = cpu;
      this.config = config;
      this.freqHz = freqHz;
      this.eventHandler = new NoopTWIEventHandler(this);
      this.busy = false;
      this.TWI = {
        address: this.config.twiInterrupt,
        flagRegister: this.config.TWCR,
        flagMask: TWCR_TWINT,
        enableRegister: this.config.TWCR,
        enableMask: TWCR_TWIE
      };
      this.updateStatus(STATUS_TWI_IDLE);
      this.cpu.writeHooks[config.TWCR] = (value) => {
        this.cpu.data[config.TWCR] = value;
        const clearInt = value & TWCR_TWINT;
        this.cpu.clearInterruptByFlag(this.TWI, value);
        this.cpu.updateInterruptEnable(this.TWI, value);
        const { status } = this;
        if (clearInt && value & TWCR_TWEN && !this.busy) {
          const twdrValue = this.cpu.data[this.config.TWDR];
          this.cpu.addClockEvent(() => {
            if (value & TWCR_TWSTA) {
              this.busy = true;
              this.eventHandler.start(status !== STATUS_TWI_IDLE);
            } else if (value & TWCR_TWSTO) {
              this.busy = true;
              this.eventHandler.stop();
            } else if (status === STATUS_START || status === STATUS_REPEATED_START) {
              this.busy = true;
              this.eventHandler.connectToSlave(twdrValue >> 1, twdrValue & 1 ? false : true);
            } else if (status === STATUS_SLAW_ACK || status === STATUS_DATA_SENT_ACK) {
              this.busy = true;
              this.eventHandler.writeByte(twdrValue);
            } else if (status === STATUS_SLAR_ACK || status === STATUS_DATA_RECEIVED_ACK) {
              this.busy = true;
              const ack = !!(value & TWCR_TWEA);
              this.eventHandler.readByte(ack);
            }
          }, 0);
          return true;
        }
      };
    }
    get prescaler() {
      switch (this.cpu.data[this.config.TWSR] & TWSR_TWPS_MASK) {
        case 0:
          return 1;
        case 1:
          return 4;
        case 2:
          return 16;
        case 3:
          return 64;
      }
      throw new Error("Invalid prescaler value!");
    }
    get sclFrequency() {
      return this.freqHz / (16 + 2 * this.cpu.data[this.config.TWBR] * this.prescaler);
    }
    completeStart() {
      this.busy = false;
      this.updateStatus(this.status === STATUS_TWI_IDLE ? STATUS_START : STATUS_REPEATED_START);
    }
    completeStop() {
      this.busy = false;
      this.cpu.data[this.config.TWCR] &= ~TWCR_TWSTO;
      this.updateStatus(STATUS_TWI_IDLE);
    }
    completeConnect(ack) {
      this.busy = false;
      if (this.cpu.data[this.config.TWDR] & 1) {
        this.updateStatus(ack ? STATUS_SLAR_ACK : STATUS_SLAR_NACK);
      } else {
        this.updateStatus(ack ? STATUS_SLAW_ACK : STATUS_SLAW_NACK);
      }
    }
    completeWrite(ack) {
      this.busy = false;
      this.updateStatus(ack ? STATUS_DATA_SENT_ACK : STATUS_DATA_SENT_NACK);
    }
    completeRead(value) {
      this.busy = false;
      const ack = !!(this.cpu.data[this.config.TWCR] & TWCR_TWEA);
      this.cpu.data[this.config.TWDR] = value;
      this.updateStatus(ack ? STATUS_DATA_RECEIVED_ACK : STATUS_DATA_RECEIVED_NACK);
    }
    get status() {
      return this.cpu.data[this.config.TWSR] & TWSR_TWS_MASK;
    }
    updateStatus(value) {
      const { TWSR } = this.config;
      this.cpu.data[TWSR] = this.cpu.data[TWSR] & ~TWSR_TWS_MASK | value;
      this.cpu.setInterruptFlag(this.TWI);
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/usart.js
  var usart0Config = {
    rxCompleteInterrupt: 36,
    dataRegisterEmptyInterrupt: 38,
    txCompleteInterrupt: 40,
    UCSRA: 192,
    UCSRB: 193,
    UCSRC: 194,
    UBRRL: 196,
    UBRRH: 197,
    UDR: 198
  };
  var UCSRA_RXC = 128;
  var UCSRA_TXC = 64;
  var UCSRA_UDRE = 32;
  var UCSRA_U2X = 2;
  var UCSRA_MPCM = 1;
  var UCSRA_CFG_MASK = UCSRA_U2X;
  var UCSRB_RXCIE = 128;
  var UCSRB_TXCIE = 64;
  var UCSRB_UDRIE = 32;
  var UCSRB_RXEN = 16;
  var UCSRB_TXEN = 8;
  var UCSRB_UCSZ2 = 4;
  var UCSRB_CFG_MASK = UCSRB_UCSZ2 | UCSRB_RXEN | UCSRB_TXEN;
  var UCSRC_UPM1 = 32;
  var UCSRC_UPM0 = 16;
  var UCSRC_USBS = 8;
  var UCSRC_UCSZ1 = 4;
  var UCSRC_UCSZ0 = 2;
  var rxMasks = {
    5: 31,
    6: 63,
    7: 127,
    8: 255,
    9: 255
  };
  var AVRUSART = class {
    constructor(cpu, config, freqHz) {
      this.cpu = cpu;
      this.config = config;
      this.freqHz = freqHz;
      this.onByteTransmit = null;
      this.onLineTransmit = null;
      this.onRxComplete = null;
      this.onConfigurationChange = null;
      this.rxBusyValue = false;
      this.rxByte = 0;
      this.lineBuffer = "";
      this.RXC = {
        address: this.config.rxCompleteInterrupt,
        flagRegister: this.config.UCSRA,
        flagMask: UCSRA_RXC,
        enableRegister: this.config.UCSRB,
        enableMask: UCSRB_RXCIE,
        constant: true
      };
      this.UDRE = {
        address: this.config.dataRegisterEmptyInterrupt,
        flagRegister: this.config.UCSRA,
        flagMask: UCSRA_UDRE,
        enableRegister: this.config.UCSRB,
        enableMask: UCSRB_UDRIE
      };
      this.TXC = {
        address: this.config.txCompleteInterrupt,
        flagRegister: this.config.UCSRA,
        flagMask: UCSRA_TXC,
        enableRegister: this.config.UCSRB,
        enableMask: UCSRB_TXCIE
      };
      this.reset();
      this.cpu.writeHooks[config.UCSRA] = (value, oldValue) => {
        var _a;
        cpu.data[config.UCSRA] = value & (UCSRA_MPCM | UCSRA_U2X);
        cpu.clearInterruptByFlag(this.TXC, value);
        if ((value & UCSRA_CFG_MASK) !== (oldValue & UCSRA_CFG_MASK)) {
          (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
        }
        return true;
      };
      this.cpu.writeHooks[config.UCSRB] = (value, oldValue) => {
        var _a;
        cpu.updateInterruptEnable(this.RXC, value);
        cpu.updateInterruptEnable(this.UDRE, value);
        cpu.updateInterruptEnable(this.TXC, value);
        if (value & UCSRB_RXEN && oldValue & UCSRB_RXEN) {
          cpu.clearInterrupt(this.RXC);
        }
        if (value & UCSRB_TXEN && !(oldValue & UCSRB_TXEN)) {
          cpu.setInterruptFlag(this.UDRE);
        }
        cpu.data[config.UCSRB] = value;
        if ((value & UCSRB_CFG_MASK) !== (oldValue & UCSRB_CFG_MASK)) {
          (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
        }
        return true;
      };
      this.cpu.writeHooks[config.UCSRC] = (value) => {
        var _a;
        cpu.data[config.UCSRC] = value;
        (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
        return true;
      };
      this.cpu.readHooks[config.UDR] = () => {
        var _a;
        const mask = (_a = rxMasks[this.bitsPerChar]) !== null && _a !== void 0 ? _a : 255;
        const result = this.rxByte & mask;
        this.rxByte = 0;
        this.cpu.clearInterrupt(this.RXC);
        return result;
      };
      this.cpu.writeHooks[config.UDR] = (value) => {
        if (this.onByteTransmit) {
          this.onByteTransmit(value);
        }
        if (this.onLineTransmit) {
          const ch = String.fromCharCode(value);
          if (ch === "\n") {
            this.onLineTransmit(this.lineBuffer);
            this.lineBuffer = "";
          } else {
            this.lineBuffer += ch;
          }
        }
        this.cpu.addClockEvent(() => {
          cpu.setInterruptFlag(this.UDRE);
          cpu.setInterruptFlag(this.TXC);
        }, this.cyclesPerChar);
        this.cpu.clearInterrupt(this.TXC);
        this.cpu.clearInterrupt(this.UDRE);
      };
      this.cpu.writeHooks[config.UBRRH] = (value) => {
        var _a;
        this.cpu.data[config.UBRRH] = value;
        (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
        return true;
      };
      this.cpu.writeHooks[config.UBRRL] = (value) => {
        var _a;
        this.cpu.data[config.UBRRL] = value;
        (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
        return true;
      };
    }
    reset() {
      this.cpu.data[this.config.UCSRA] = UCSRA_UDRE;
      this.cpu.data[this.config.UCSRB] = 0;
      this.cpu.data[this.config.UCSRC] = UCSRC_UCSZ1 | UCSRC_UCSZ0;
      this.rxBusyValue = false;
      this.rxByte = 0;
      this.lineBuffer = "";
    }
    get rxBusy() {
      return this.rxBusyValue;
    }
    writeByte(value, immediate = false) {
      var _a;
      const { cpu } = this;
      if (this.rxBusyValue || !this.rxEnable) {
        return false;
      }
      if (immediate) {
        this.rxByte = value;
        cpu.setInterruptFlag(this.RXC);
        (_a = this.onRxComplete) === null || _a === void 0 ? void 0 : _a.call(this);
      } else {
        this.rxBusyValue = true;
        cpu.addClockEvent(() => {
          this.rxBusyValue = false;
          this.writeByte(value, true);
        }, this.cyclesPerChar);
        return true;
      }
    }
    get cyclesPerChar() {
      const symbolsPerChar = 1 + this.bitsPerChar + this.stopBits + (this.parityEnabled ? 1 : 0);
      return (this.UBRR + 1) * this.multiplier * symbolsPerChar;
    }
    get UBRR() {
      const { UBRRH, UBRRL } = this.config;
      return this.cpu.data[UBRRH] << 8 | this.cpu.data[UBRRL];
    }
    get multiplier() {
      return this.cpu.data[this.config.UCSRA] & UCSRA_U2X ? 8 : 16;
    }
    get rxEnable() {
      return !!(this.cpu.data[this.config.UCSRB] & UCSRB_RXEN);
    }
    get txEnable() {
      return !!(this.cpu.data[this.config.UCSRB] & UCSRB_TXEN);
    }
    get baudRate() {
      return Math.floor(this.freqHz / (this.multiplier * (1 + this.UBRR)));
    }
    get bitsPerChar() {
      const ucsz = (this.cpu.data[this.config.UCSRC] & (UCSRC_UCSZ1 | UCSRC_UCSZ0)) >> 1 | this.cpu.data[this.config.UCSRB] & UCSRB_UCSZ2;
      switch (ucsz) {
        case 0:
          return 5;
        case 1:
          return 6;
        case 2:
          return 7;
        case 3:
          return 8;
        default:
        // 4..6 are reserved
        case 7:
          return 9;
      }
    }
    get stopBits() {
      return this.cpu.data[this.config.UCSRC] & UCSRC_USBS ? 2 : 1;
    }
    get parityEnabled() {
      return this.cpu.data[this.config.UCSRC] & UCSRC_UPM1 ? true : false;
    }
    get parityOdd() {
      return this.cpu.data[this.config.UCSRC] & UCSRC_UPM0 ? true : false;
    }
  };

  // node_modules/avr8js/dist/esm/peripherals/usi.js
  var USIDC = 1 << 4;
  var USIPF = 1 << 5;
  var USIOIF = 1 << 6;
  var USISIF = 1 << 7;
  var USITC = 1 << 0;
  var USICLK = 1 << 1;
  var USICS0 = 1 << 2;
  var USICS1 = 1 << 3;
  var USIWM0 = 1 << 4;
  var USIWM1 = 1 << 5;
  var USIOIE = 1 << 6;
  var USISIE = 1 << 7;

  // node_modules/avr8js/dist/esm/peripherals/watchdog.js
  var MCUSR_WDRF = 8;
  var WDTCSR_WDIF = 128;
  var WDTCSR_WDIE = 64;
  var WDTCSR_WDP3 = 32;
  var WDTCSR_WDCE = 16;
  var WDTCSR_WDE = 8;
  var WDTCSR_WDP2 = 4;
  var WDTCSR_WDP1 = 2;
  var WDTCSR_WDP0 = 1;
  var WDTCSR_WDP210 = WDTCSR_WDP2 | WDTCSR_WDP1 | WDTCSR_WDP0;
  var WDTCSR_PROTECT_MASK = WDTCSR_WDE | WDTCSR_WDP3 | WDTCSR_WDP210;
  var watchdogConfig = {
    watchdogInterrupt: 12,
    MCUSR: 84,
    WDTCSR: 96
  };
  var AVRWatchdog = class {
    constructor(cpu, config, clock) {
      this.cpu = cpu;
      this.config = config;
      this.clock = clock;
      this.clockFrequency = 128e3;
      this.changeEnabledCycles = 0;
      this.watchdogTimeout = 0;
      this.enabledValue = false;
      this.scheduled = false;
      this.Watchdog = {
        address: this.config.watchdogInterrupt,
        flagRegister: this.config.WDTCSR,
        flagMask: WDTCSR_WDIF,
        enableRegister: this.config.WDTCSR,
        enableMask: WDTCSR_WDIE
      };
      this.checkWatchdog = () => {
        if (this.enabled && this.cpu.cycles >= this.watchdogTimeout) {
          const wdtcsr = this.cpu.data[this.config.WDTCSR];
          if (wdtcsr & WDTCSR_WDIE) {
            this.cpu.setInterruptFlag(this.Watchdog);
          }
          if (wdtcsr & WDTCSR_WDE) {
            if (wdtcsr & WDTCSR_WDIE) {
              this.cpu.data[this.config.WDTCSR] &= ~WDTCSR_WDIE;
            } else {
              this.cpu.reset();
              this.scheduled = false;
              this.cpu.data[this.config.MCUSR] |= MCUSR_WDRF;
              return;
            }
          }
          this.resetWatchdog();
        }
        if (this.enabled) {
          this.scheduled = true;
          this.cpu.addClockEvent(this.checkWatchdog, this.watchdogTimeout - this.cpu.cycles);
        } else {
          this.scheduled = false;
        }
      };
      const { WDTCSR } = config;
      this.cpu.onWatchdogReset = () => {
        this.resetWatchdog();
      };
      cpu.writeHooks[WDTCSR] = (value, oldValue) => {
        if (value & WDTCSR_WDCE && value & WDTCSR_WDE) {
          this.changeEnabledCycles = this.cpu.cycles + 4;
          value = value & ~WDTCSR_PROTECT_MASK;
        } else {
          if (this.cpu.cycles >= this.changeEnabledCycles) {
            value = value & ~WDTCSR_PROTECT_MASK | oldValue & WDTCSR_PROTECT_MASK;
          }
          this.enabledValue = !!(value & WDTCSR_WDE || value & WDTCSR_WDIE);
          this.cpu.data[WDTCSR] = value;
        }
        if (this.enabled) {
          this.resetWatchdog();
        }
        if (this.enabled && !this.scheduled) {
          this.cpu.addClockEvent(this.checkWatchdog, this.watchdogTimeout - this.cpu.cycles);
        }
        this.cpu.clearInterruptByFlag(this.Watchdog, value);
        return true;
      };
    }
    resetWatchdog() {
      const cycles = Math.floor(this.clock.frequency / this.clockFrequency * this.prescaler);
      this.watchdogTimeout = this.cpu.cycles + cycles;
    }
    get enabled() {
      return this.enabledValue;
    }
    /**
     * The base clock frequency is 128KHz. Thus, a prescaler of 2048 gives 16ms timeout.
     */
    get prescaler() {
      const wdtcsr = this.cpu.data[this.config.WDTCSR];
      const value = (wdtcsr & WDTCSR_WDP3) >> 2 | wdtcsr & WDTCSR_WDP210;
      return 2048 << value;
    }
  };

  // src/avr_engine.js
  var CPU_FREQ_HZ = 8e6;
  var SRAM_BYTES = 2048;
  var AVR_DATA_SPACE_BYTES = 256 + SRAM_BYTES;
  var SRAM_START_ADDR = 256;
  var SRAM_END_ADDR = SRAM_START_ADDR + SRAM_BYTES - 1;
  var FLASH_WORDS = 16384;
  var FLASH_BYTES = FLASH_WORDS * 2;
  var FLASH_APP_LIMIT_BYTES = 32256;
  var EEPROM_BYTES = 1024;
  var SMCR = 83;
  var SPL_ADDR = 93;
  var SREG_ADDR = 95;
  var SE_BIT = 1;
  var SLEEP_OPCODE = 38280;
  var USART_RXC = 128;
  var BAT_DIVIDER_TOP_OHMS = 1e6;
  var BAT_DIVIDER_BOTTOM_OHMS = 33e4;
  var BAT_ADC_REF_V = 1.1;
  var AIR780_WARN_MV = 3300;
  var AIR780_BROWNOUT_MV = 3e3;
  var AIR780_CRITICAL_MV = 2800;
  var AIR780_BROWNOUT_HOLD_MS = 80;
  var AIR780_CRITICAL_HOLD_MS = 3;
  var AIR780_DEFAULT_TX_PEAK_MA = 430;
  var AIR780_DEFAULT_TX_PULSE_MS = 0.5;
  var AIR780_TX_PERIOD_MS = 1200;
  var AIR780_UART_BAUD = 9600;
  var AIR780_IDLE_MA = 4;
  var AIR780_BOOT_MA = 24;
  var AIR780_ATTACH_SCAN_MA = 36;
  var AIR780_RX_MA = 24;
  var AIR780_UART_BIT_MA = 2;
  var ER14505_DEFAULT_COUNT = 2;
  var ER14505_DEFAULT_CONTINUOUS_LIMIT_MA = 100;
  var ER14505_DEFAULT_PULSE_LIMIT_MA = 200;
  var SUPERCAP_DEFAULT_F = 0.5;
  var SUPERCAP_DEFAULT_COUNT = 2;
  var SUPERCAP_DEFAULT_CHARGE_OHMS = 10;
  var SUPERCAP_DEFAULT_CHARGE_RESISTORS = 2;
  var SUPERCAP_DEFAULT_ESR_MOHM = 800;
  var SUPERCAP_DEFAULT_LEAKAGE_UA = 25;
  var SUPERCAP_DEFAULT_DIODE_MV = 250;
  var SUPPLY_SWITCH_DEFAULT_MOHM = 80;
  var LTE_BURST_DEFAULT_GLITCH_MV = 90;
  var SUPPLY_MEASUREMENT_DEFAULT_NOISE_MV = 12;
  var LDO_DROPOUT_MV = 150;
  var AVR_ACTIVE_DEFAULT_MA = 5.5;
  var AVR_SLEEP_DEFAULT_UA = 6;
  var BOARD_QUIESCENT_DEFAULT_UA = 120;
  var DS3231_DEFAULT_VBAT_MV = 3e3;
  var DS3231_VCC_MIN_MV = 2300;
  var DS3231_VBAT_MIN_MV = 2e3;
  var FIRST_BOOT_CAP_CHARGE_WAIT_MS = 3e4;
  var EPD_FULL_REFRESH_CYCLES = Math.round(CPU_FREQ_HZ * 2);
  var EPD_PARTIAL_REFRESH_CYCLES = Math.round(CPU_FREQ_HZ * 0.3);
  var EPD_PARTIAL_SETUP_CYCLES = Math.round(CPU_FREQ_HZ * 0.08);
  var EPD_REGISTER_BUSY_CYCLES = Math.round(CPU_FREQ_HZ * 0.02);
  var PIN = {
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
    EPD_BUSY: 7
  };
  function bcd(value) {
    return (Math.floor(value / 10) % 10 << 4 | value % 10) & 255;
  }
  function fromBcd(value) {
    return (value >> 4 & 15) * 10 + (value & 15);
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
    return names.filter((name, bit) => value & 1 << bit);
  }
  function padAlarm(value) {
    return String(value).padStart(2, "0");
  }
  function monotonicNow() {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
  }
  function pixelNoise(x, y, salt = 0) {
    let v = x * 1103515245 + y * 12345 + salt * 2654435761 >>> 0;
    v ^= v >>> 16;
    v = Math.imul(v, 2246822519) >>> 0;
    v ^= v >>> 13;
    return (v & 255) / 255;
  }
  function loadIntelHex(hex) {
    const program = new Uint16Array(FLASH_WORDS);
    program.fill(65535);
    const bytes = new Uint8Array(program.buffer);
    const covered = new Uint8Array(bytes.length);
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
      let sum = length + (addr >> 8) + (addr & 255) + type;
      for (let i = 0; i < length; i += 1) {
        const value = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
        data.push(value);
        sum += value;
      }
      const checksum = parseInt(line.slice(9 + length * 2, 11 + length * 2), 16);
      if ((sum + checksum & 255) !== 0) {
        throw new Error(`Bad Intel HEX checksum at ${line}`);
      }
      if (type === 0) {
        const base = upper + addr;
        for (let i = 0; i < data.length; i += 1) {
          if (base + i < bytes.length) {
            bytes[base + i] = data[i];
            covered[base + i] = 1;
          }
        }
      } else if (type === 1) {
        break;
      } else if (type === 4) {
        upper = (data[0] << 8 | data[1]) << 16 >>> 0;
      }
    }
    program.coveredBytes = covered;
    return program;
  }
  var DS3231Model = class {
    constructor({ log, getTimeMs = monotonicNow, getVccMv = () => 3300, setRtcInt }) {
      this.log = log;
      this.getTimeMs = getTimeMs;
      this.getVccMv = getVccMv;
      this.setRtcInt = setRtcInt;
      this.baseDate = /* @__PURE__ */ new Date();
      this.baseTimeMs = this.getTimeMs();
      this.vbatMv = DS3231_DEFAULT_VBAT_MV;
      this.regs = new Uint8Array(32);
      this.regs[14] = 28;
      this.regs[15] = 0;
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
      const eosc = !!(this.regs[14] & 128);
      return this.hasVcc() || this.hasVbat() && !eosc;
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
      this.regs[15] &= ~128;
      this.lastAlarmSecondKey = Math.floor(this.baseDate.getTime() / 1e3);
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
        this.regs[15] |= 128;
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
      this.regs[15] |= 1;
      this.updateIntPin();
      this.log("DS3231 INT low: alarm flag A1F set");
    }
    updateIntPin() {
      const control = this.regs[14];
      const status = this.regs[15];
      const alarmLow = !!(control & 4) && (control & 1 && status & 1 || control & 2 && status & 2);
      this.intLow = this.hasOscillatorPower() && alarmLow;
      this.setRtcInt(!this.intLow);
    }
    checkAlarms(date) {
      const secondKey = Math.floor(date.getTime() / 1e3);
      if (secondKey === this.lastAlarmSecondKey) {
        return;
      }
      this.lastAlarmSecondKey = secondKey;
      let fired = false;
      if (this.regs[14] & 1 && this.matchesAlarm1(date)) {
        if ((this.regs[15] & 1) === 0) {
          this.log("DS3231 Alarm1 match: A1F set");
        }
        this.regs[15] |= 1;
        fired = true;
      }
      if (this.regs[14] & 2 && this.matchesAlarm2(date)) {
        if ((this.regs[15] & 2) === 0) {
          this.log("DS3231 Alarm2 match: A2F set");
        }
        this.regs[15] |= 2;
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
      const dyDt = !!(regValue & 64);
      const value = fromBcd(regValue & 63);
      return dyDt ? value === this.dsDay(date) : value === date.getDate();
    }
    alarmHourMatches(regValue, date) {
      if (regValue & 64) {
        const hour12 = fromBcd(regValue & 31);
        const pm = !!(regValue & 32);
        const normalized = hour12 % 12 + (pm ? 12 : 0);
        return normalized === date.getHours();
      }
      return fromBcd(regValue & 63) === date.getHours();
    }
    matchesAlarm1(date) {
      const sec = this.regs[7];
      const min = this.regs[8];
      const hour = this.regs[9];
      const day = this.regs[10];
      if (!(sec & 128) && fromBcd(sec & 127) !== date.getSeconds()) {
        return false;
      }
      if (!(min & 128) && fromBcd(min & 127) !== date.getMinutes()) {
        return false;
      }
      if (!(hour & 128) && !this.alarmHourMatches(hour, date)) {
        return false;
      }
      if (!(day & 128) && !this.alarmDateMatches(day, date)) {
        return false;
      }
      return true;
    }
    matchesAlarm2(date) {
      if (date.getSeconds() !== 0) {
        return false;
      }
      const min = this.regs[11];
      const hour = this.regs[12];
      const day = this.regs[13];
      if (!(min & 128) && fromBcd(min & 127) !== date.getMinutes()) {
        return false;
      }
      if (!(hour & 128) && !this.alarmHourMatches(hour, date)) {
        return false;
      }
      if (!(day & 128) && !this.alarmDateMatches(day, date)) {
        return false;
      }
      return true;
    }
    readRegister(reg) {
      this.step();
      const date = this.currentDate();
      switch (reg & 255) {
        case 0:
          return bcd(date.getSeconds());
        case 1:
          return bcd(date.getMinutes());
        case 2:
          return bcd(date.getHours());
        case 3:
          return this.dsDay(date);
        case 4:
          return bcd(date.getDate());
        case 5:
          return bcd(date.getMonth() + 1);
        case 6:
          return bcd(date.getFullYear() - 2e3);
        case 17:
          return 25;
        case 18:
          return 0;
        default:
          return this.regs[reg & 31];
      }
    }
    writeSequential(bytes) {
      if (bytes.length === 0 || !this.busAvailable()) {
        return;
      }
      this.pointer = bytes[0] & 255;
      for (let i = 1; i < bytes.length; i += 1) {
        this.writeRegister(this.pointer + i - 1 & 255, bytes[i]);
      }
    }
    writeRegister(reg, value) {
      const r = reg & 31;
      const v = value & 255;
      this.regs[r] = v;
      if (r >= 0 && r <= 6) {
        const current = this.currentDate();
        const year = r === 6 ? 2e3 + fromBcd(v) : current.getFullYear();
        const month = r === 5 ? fromBcd(v) - 1 : current.getMonth();
        const day = r === 4 ? fromBcd(v) : current.getDate();
        const hour = r === 2 ? fromBcd(v & 63) : current.getHours();
        const minute = r === 1 ? fromBcd(v) : current.getMinutes();
        const second = r === 0 ? fromBcd(v & 127) : current.getSeconds();
        this.baseDate = new Date(year, month, day, hour, minute, second);
        this.baseTimeMs = this.getTimeMs();
        this.lastAlarmSecondKey = Math.floor(this.baseDate.getTime() / 1e3);
      }
      if (r === 14 || r === 15 || r >= 7 && r <= 13) {
        this.step();
        this.updateIntPin();
      }
    }
    alarmMode1() {
      return (this.regs[7] & 128) >> 7 | (this.regs[8] & 128) >> 6 | (this.regs[9] & 128) >> 5 | (this.regs[10] & 128) >> 4 | (this.regs[10] & 64) >> 2;
    }
    alarmMode2() {
      return (this.regs[11] & 128) >> 7 | (this.regs[12] & 128) >> 6 | (this.regs[13] & 128) >> 5 | (this.regs[13] & 64) >> 3;
    }
    describeAlarm1() {
      const sec = fromBcd(this.regs[7] & 127);
      const min = fromBcd(this.regs[8] & 127);
      const hour = fromBcd(this.regs[9] & 63);
      const day = fromBcd(this.regs[10] & 63);
      const mode = this.alarmMode1();
      if (mode === 15) {
        return "once per second";
      }
      if (mode === 14) {
        return `sec=${sec}`;
      }
      if (mode === 12) {
        return `${padAlarm(min)}:${padAlarm(sec)}`;
      }
      if (mode === 8) {
        return `${padAlarm(hour)}:${padAlarm(min)}:${padAlarm(sec)}`;
      }
      const dayKind = this.regs[10] & 64 ? "dow" : "date";
      return `${dayKind}=${day} ${padAlarm(hour)}:${padAlarm(min)}:${padAlarm(sec)}`;
    }
    describeAlarm2() {
      const min = fromBcd(this.regs[11] & 127);
      const hour = fromBcd(this.regs[12] & 63);
      const day = fromBcd(this.regs[13] & 63);
      const mode = this.alarmMode2();
      if (mode === 7) {
        return "once per minute";
      }
      if (mode === 6) {
        return `min=${min}`;
      }
      if (mode === 4) {
        return `${padAlarm(hour)}:${padAlarm(min)}`;
      }
      const dayKind = this.regs[13] & 64 ? "dow" : "date";
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
        if (candidate.getMonth() === (month % 12 + 12) % 12 && candidate.getTime() > date.getTime()) {
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
      if ((this.regs[14] & 1) === 0) {
        return null;
      }
      const sec = fromBcd(this.regs[7] & 127);
      const min = fromBcd(this.regs[8] & 127);
      const hour = fromBcd(this.regs[9] & 63);
      const day = fromBcd(this.regs[10] & 63);
      switch (this.alarmMode1()) {
        case 15:
          return new Date(Math.floor(date.getTime() / 1e3) * 1e3 + 1e3);
        case 14:
          return this.nextSecondMatch(date, sec);
        case 12:
          return this.nextMinuteMatch(date, min, sec);
        case 8:
          return this.nextHourMatch(date, hour, min, sec);
        case 16:
          return this.nextDayMatch(date, day, hour, min, sec);
        default:
          return this.nextDateMatch(date, day, hour, min, sec);
      }
    }
    nextAlarm2Date(date) {
      if ((this.regs[14] & 2) === 0) {
        return null;
      }
      const min = fromBcd(this.regs[11] & 127);
      const hour = fromBcd(this.regs[12] & 63);
      const day = fromBcd(this.regs[13] & 63);
      switch (this.alarmMode2()) {
        case 7:
          return this.nextMinuteMatch(date, date.getMinutes() + 1, 0);
        case 6:
          return this.nextMinuteMatch(date, min, 0);
        case 4:
          return this.nextHourMatch(date, hour, min, 0);
        case 8:
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
      const control = this.regs[14];
      const status = this.regs[15];
      return {
        vccMv: Math.round(this.getVccMv()),
        vbatMv: Math.round(this.vbatMv),
        domain: this.hasVcc() ? "VCC" : this.hasVbat() ? "VBAT" : "OFF",
        i2cOnline: this.busAvailable(),
        oscillatorRunning: this.oscillatorRunning,
        intLow: this.intLow,
        control,
        status,
        intcn: !!(control & 4),
        a1Enabled: !!(control & 1),
        a2Enabled: !!(control & 2),
        a1F: !!(status & 1),
        a2F: !!(status & 2),
        en32k: !!(status & 8),
        osf: !!(status & 128),
        alarm1: this.describeAlarm1(),
        alarm2: this.describeAlarm2(),
        alarm1NextMs: alarm1Next ? alarm1Next.getTime() : null,
        alarm2NextMs: alarm2Next ? alarm2Next.getTime() : null,
        alarm1CountdownMs: alarm1Next ? Math.max(0, alarm1Next.getTime() - date.getTime()) : null,
        alarm2CountdownMs: alarm2Next ? Math.max(0, alarm2Next.getTime() - date.getTime()) : null,
        temperatureC: 25,
        pointer: this.pointer & 255
      };
    }
  };
  var DS3231TWIHandler = class {
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
      if (this.addr === 104 && this.writeMode && this.writeBuffer.length > 0) {
        this.ds3231.writeSequential(this.writeBuffer);
        this.log(`TWI DS3231 write ${this.writeBuffer.map(hexByte).join(" ")}`);
      }
      this.writeBuffer = [];
      this.twi.completeStop();
    }
    connectToSlave(addr, write) {
      this.addr = addr;
      this.writeMode = write;
      this.twi.completeConnect(addr === 104 && this.ds3231.busAvailable());
    }
    writeByte(value) {
      if (this.addr === 104 && this.ds3231.busAvailable()) {
        this.writeBuffer.push(value & 255);
        this.twi.completeWrite(true);
      } else {
        this.twi.completeWrite(false);
      }
    }
    readByte() {
      if (this.addr !== 104 || !this.ds3231.busAvailable()) {
        this.twi.completeRead(255);
        return;
      }
      if (this.writeBuffer.length > 0) {
        this.ds3231.pointer = this.writeBuffer[0] & 255;
        this.writeBuffer = [];
      }
      const reg = this.ds3231.pointer & 255;
      const value = this.ds3231.readRegister(reg);
      this.ds3231.pointer = this.ds3231.pointer + 1 & 255;
      this.twi.completeRead(value);
    }
  };
  var Air780Model = class {
    constructor({ usart, cpu, log, supplyOk = () => true, addPowerEvent = () => {
    } }) {
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
      this.subscribedTopics = /* @__PURE__ */ new Set();
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
          protocolStep: "SIM READY"
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
      this.subscribedTopics = /* @__PURE__ */ new Set();
    }
    scheduleResponse(delayMs, text, { state, protocolStep, apply } = {}) {
      this.pendingResponses.push({
        dueMs: monotonicNow() + Math.max(0, Number(delayMs) || 0),
        text,
        state,
        protocolStep,
        apply
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
        bytes: text.length
      });
      for (let i = 0; i < text.length; i += 1) {
        this.rxQueue.push(text.charCodeAt(i) & 255);
      }
    }
    uartFrameMs(byteLength) {
      return Math.max(0, byteLength) * 10 * 1e3 / AIR780_UART_BAUD;
    }
    commandPower(cmd) {
      const bytes = cmd.length + 2;
      this.addPowerEvent({
        type: "uart-tx",
        durationMs: this.uartFrameMs(bytes),
        currentMa: AIR780_UART_BIT_MA,
        bytes
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
          glitchMv: 70 + Math.min(80, i * 8)
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
            protocolStep: "NETWORK SEARCH"
          });
        } else {
          this.scheduleResponse(850, "\r\n+CEREG: 0,5\r\n\r\nOK\r\n", {
            state: "CEREG OK",
            protocolStep: "REGISTERED",
            apply: () => {
              this.registered = true;
            }
          });
        }
      } else if (cmd === "AT+CGATT?") {
        this.protocolStep = "CGATT QUERY";
        if (this.failAttach || !this.registered) {
          this.scheduleResponse(500, "\r\n+CGATT: 0\r\n\r\nOK\r\n", {
            state: "PDP DETACHED",
            protocolStep: "ATTACH WAIT"
          });
        } else {
          this.scheduleResponse(500, "\r\n+CGATT: 1\r\n\r\nOK\r\n", {
            state: "PDP ATTACHED",
            protocolStep: "PDP ACTIVE",
            apply: () => {
              this.attached = true;
              this.pdpActive = true;
            }
          });
        }
      } else if (cmd.startsWith("AT+MCONFIG=")) {
        this.scheduleResponse(120, "\r\nOK\r\n", {
          state: "MQTT CONFIG",
          protocolStep: "MQTT CONFIGURED",
          apply: () => {
            this.mqttConfigured = true;
          }
        });
      } else if (cmd.startsWith("AT+MIPSTART=")) {
        this.protocolStep = "TCP SYN";
        if (this.failAttach || !this.pdpActive) {
          this.scheduleResponse(900, "\r\nCONNECT FAIL\r\n", {
            state: "TCP FAIL",
            protocolStep: "TCP CLOSED"
          });
        } else {
          this.scheduleResponse(900, "\r\nCONNECT OK\r\n", {
            state: "TCP OK",
            protocolStep: "TCP CONNECTED",
            apply: () => {
              this.tcpConnected = true;
            }
          });
        }
      } else if (cmd.startsWith("AT+MCONNECT=")) {
        this.protocolStep = "MQTT CONNECT";
        if (this.failMqtt || !this.tcpConnected || !this.mqttConfigured) {
          this.scheduleResponse(700, "\r\nERROR\r\n", {
            state: "MQTT FAIL",
            protocolStep: "MQTT CLOSED"
          });
        } else {
          this.scheduleResponse(700, "\r\nCONNACK OK\r\n", {
            state: "MQTT OK",
            protocolStep: "MQTT CONNECTED",
            apply: () => {
              this.mqttConnected = true;
            }
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
          }
        });
        if (topic === "epaper2/cmd") {
          this.scheduleResponse(900, `+MSUB: "epaper2/cmd",${this.datePayload.length} byte,${this.datePayload}\r
`, {
            protocolStep: "MQTT DOWNLINK"
          });
        } else if (topic === "epaper2/rx") {
          this.scheduleResponse(900, `+MSUB: "epaper2/rx",${this.rxMessage.length} byte,${this.rxMessage}\r
`, {
            protocolStep: "MQTT DOWNLINK"
          });
        }
      } else if (cmd.startsWith("AT+MPUB=")) {
        this.protocolStep = "MQTT PUBLISH";
        this.scheduleResponse(this.mqttConnected ? 220 : 120, this.mqttConnected ? "\r\nOK\r\n" : "\r\nERROR\r\n", {
          state: this.mqttConnected ? "PUB OK" : "PUB FAIL",
          protocolStep: this.mqttConnected ? "MQTT UPLOAD" : "MQTT NOT CONNECTED"
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
          }
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
        topics: Array.from(this.subscribedTopics)
      };
    }
  };
  var PowerReservoirModel = class {
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
      measurementNoiseMv
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
    simulinkRequest({ horizonMs = 8e3, stepMs = 1 } = {}) {
      this.step();
      const now = this.getTimeMs();
      const step = clamp(Number(stepMs) || 1, 0.1, 20);
      const horizon = clamp(Number(horizonMs) || 8e3, 100, 6e4);
      const count = Math.floor(horizon / step) + 1;
      const tMs = [];
      const loadMa = [];
      for (let i = 0; i < count; i += 1) {
        const start = now + i * step;
        tMs.push(Math.round(i * step * 1e3) / 1e3);
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
        ldoDropoutMv: LDO_DROPOUT_MV
      };
    }
    addLoadEvent({
      type = "event",
      delayMs = 0,
      durationMs = 1,
      currentMa = 0,
      glitchMv = 0,
      bitRate = null,
      bytes = 0
    } = {}) {
      const startMs = this.getTimeMs() + Math.max(0, Number(delayMs) || 0);
      const duration = Math.max(1e-3, Number(durationMs) || 1e-3);
      this.loadEvents.push({
        type,
        startMs,
        endMs: startMs + duration,
        durationMs: duration,
        currentMa: Math.max(0, Number(currentMa) || 0),
        glitchMv: Math.max(0, Number(glitchMv) || 0),
        bitRate,
        bytes
      });
      this.pruneLoadEvents(startMs);
    }
    pruneLoadEvents(now = this.getTimeMs()) {
      const keepAfter = now - 2e3;
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
      const avrMa = this.avrSleeping ? this.avrSleepUa / 1e3 : this.avrActiveMa;
      const boardMa = this.boardQuiescentUa / 1e3;
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
        const avrMa2 = this.avrSleeping ? this.avrSleepUa / 1e3 : this.avrActiveMa;
        return avrMa2 + this.boardQuiescentUa / 1e3;
      }
      const durationMs = Math.max(1, endMs - startMs);
      const eventMaMs = this.loadEvents.reduce((sum, event) => {
        const overlap = Math.max(0, Math.min(endMs, event.endMs) - Math.max(startMs, event.startMs));
        return sum + overlap * event.currentMa;
      }, 0);
      const avrMa = this.avrSleeping ? this.avrSleepUa / 1e3 : this.avrActiveMa;
      return avrMa + this.boardQuiescentUa / 1e3 + this.airSustainMa + eventMaMs / durationMs;
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
        return mix(0.72, 1, this.temperatureC / 20);
      }
      if (this.temperatureC > 70) {
        return mix(1, 0.82, (this.temperatureC - 70) / 15);
      }
      return 1;
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
        return Number.isFinite(limitMa) ? limitMa : 1e6;
      }
      return Math.min(limitMa, (sourceMv - railMv) * 1e3 / resistanceMohm);
    }
    solveLoadRail(loadMa, batteryLimitMa) {
      if (loadMa <= 0) {
        return {
          railMv: this.capMv,
          batteryLoadMa: 0,
          capLoadMa: 0
        };
      }
      if (!this.airOn) {
        const batteryLoadMa2 = Math.min(loadMa, batteryLimitMa);
        return {
          railMv: Math.max(0, this.batteryMv - batteryLoadMa2 * this.effectiveBatteryResistanceMohm() / 1e3),
          batteryLoadMa: batteryLoadMa2,
          capLoadMa: 0
        };
      }
      const batteryResistanceMohm = this.effectiveBatteryResistanceMohm() + this.switchResistanceMohm;
      const capSourceMv = Math.max(0, this.capMv - this.diodeDropMv);
      const capResistanceMohm = Math.max(1, this.supercapEsrMohm + this.switchResistanceMohm);
      const batteryCurrentAt = (railMv2) => this.sourceCurrentMa(this.batteryMv, railMv2, Math.max(1, batteryResistanceMohm), batteryLimitMa);
      const capCurrentAt = (railMv2) => this.sourceCurrentMa(capSourceMv, railMv2, capResistanceMohm);
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
        capLoadMa
      };
    }
    step(forcedDtSeconds = null) {
      const now = this.getTimeMs();
      const dtSeconds = forcedDtSeconds === null ? clamp((now - this.lastTimeMs) / 1e3, 0, 0.25) : Math.max(0, forcedDtSeconds);
      this.lastTimeMs = now;
      const startMs = now - dtSeconds * 1e3;
      const loadMa = this.currentLoadMa();
      const energyLoadMa = dtSeconds > 0 ? this.averageLoadMa(startMs, now) : loadMa;
      const pulseWindow = this.isTxPulseWindow(now);
      const batteryLimitMa = this.batteryLimitMa(loadMa, pulseWindow || this.lastActiveEvents.length > 0);
      let railSolution = this.solveLoadRail(loadMa, batteryLimitMa);
      const remainingBatteryBudgetMa = this.airOn ? Math.max(0, batteryLimitMa - railSolution.batteryLoadMa) : this.effectiveContinuousLimitMa() * this.temperatureDerating();
      const requestedChargeMa = Math.max(0, (this.batteryMv - this.capMv) / this.chargeOhms);
      const chargeMa = Math.min(requestedChargeMa, remainingBatteryBudgetMa);
      const leakageMa = this.supercapLeakageUa / 1e3;
      if (dtSeconds > 0) {
        const energyPulseWindow = this.pulseOverlapMs(startMs, now) > 0 || this.loadEvents.some((event) => event.startMs < now && event.endMs > startMs);
        const energyBatteryLimitMa = this.batteryLimitMa(energyLoadMa, energyPulseWindow);
        const energyRailSolution = this.solveLoadRail(energyLoadMa, energyBatteryLimitMa);
        const netCapMa = chargeMa - energyRailSolution.capLoadMa - leakageMa;
        this.capMv += netCapMa / 1e3 / this.capacitanceF * dtSeconds * 1e3;
      }
      this.capMv = clamp(this.capMv, 0, this.batteryMv);
      railSolution = this.solveLoadRail(loadMa, batteryLimitMa);
      const batteryTerminalMv = this.batteryMv - (railSolution.batteryLoadMa + chargeMa) * this.effectiveBatteryResistanceMohm() / 1e3;
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
      this.updateAirSupplyState(dtSeconds * 1e3);
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
      this.airBrownout = this.airCriticalMs >= AIR780_CRITICAL_HOLD_MS || this.airUndervoltageMs >= AIR780_BROWNOUT_HOLD_MS;
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
        externalTraceRemainingMs: this.externalTrace ? Math.max(0, Number(this.externalTrace.tMs[this.externalTrace.tMs.length - 1]) - (now - this.externalTraceStartMs)) : 0,
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
        airSupplyOk: !this.airOn || !this.airBrownout
      };
    }
  };
  var EpdControllerModel = class {
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
      this.oldRam.fill(255);
      this.newRam.fill(255);
      this.visibleRam.fill(255);
      this.previousVisibleRam.fill(255);
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
      this.dataEntryMode = 3;
      this.lutMode = "unknown";
      this.borderWaveform = 0;
      this.partialPrepared = false;
      this.analogOn = false;
      this.memoryArea = {
        xStart: 0,
        xEnd: this.bytesPerRow - 1,
        yStart: 0,
        yEnd: this.height - 1
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
        yEnd: this.height - 1
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
      const rst = !!(value & 1 << PIN.EPD_RST);
      const dc = !!(value & 1 << PIN.EPD_DC);
      const cs = !!(value & 1 << PIN.EPD_CS);
      const mosi = !!(value & 1 << PIN.EPD_MOSI);
      const sck = !!(value & 1 << PIN.EPD_SCK);
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
        this.bitBuffer = (this.bitBuffer << 1 | (mosi ? 1 : 0)) & 255;
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
      this.currentCommand = command & 255;
      this.commandData = [];
      if (command === 18) {
        this.softwareReset();
        return;
      }
      if (command === 32) {
        this.masterActivation();
        return;
      }
      if (command === 36) {
        this.log("EPD RAM write start: new RAM (0x24)");
      } else if (command === 38) {
        this.log("EPD RAM write start: old/base RAM (0x26)");
      } else if (command === 16) {
        this.log("EPD deep-sleep command pending");
      }
    }
    acceptData(value) {
      if (this.currentCommand === null) {
        return;
      }
      if (this.currentCommand === 36 || this.currentCommand === 38) {
        this.writeRamByte(this.currentCommand, value);
        return;
      }
      this.commandData.push(value & 255);
      const expected = this.paramLength(this.currentCommand);
      if (expected >= 0 && this.commandData.length >= expected) {
        this.finishCommand(this.currentCommand, this.commandData);
      }
    }
    paramLength(command) {
      const lengths = {
        1: 3,
        3: 1,
        4: 3,
        16: 1,
        17: 1,
        33: 2,
        34: 1,
        44: 1,
        60: 1,
        63: 1,
        68: 2,
        69: 4,
        78: 1,
        79: 2
      };
      if (command === 50) {
        return 153;
      }
      if (command === 55) {
        return 10;
      }
      return Object.prototype.hasOwnProperty.call(lengths, command) ? lengths[command] : -1;
    }
    finishCommand(command, data) {
      switch (command) {
        case 16:
          this.sleep();
          break;
        case 34:
          this.updateControl = data[0] & 255;
          break;
        case 17:
          this.dataEntryMode = data[0] & 255;
          break;
        case 50:
          this.lutMode = this.detectLutMode(data);
          this.log(`EPD LUT loaded from host: ${this.lutMode}`);
          break;
        case 55:
          this.displayOption = Uint8Array.from(data);
          break;
        case 60:
          this.borderWaveform = data[0] & 255;
          break;
        case 68:
          this.memoryArea.xStart = clamp(data[0], 0, this.bytesPerRow - 1);
          this.memoryArea.xEnd = clamp(data[1], 0, this.bytesPerRow - 1);
          break;
        case 69:
          this.memoryArea.yStart = clamp(data[0] | data[1] << 8, 0, this.height - 1);
          this.memoryArea.yEnd = clamp(data[2] | data[3] << 8, 0, this.height - 1);
          break;
        case 78:
          this.ptrX = clamp(data[0], 0, this.bytesPerRow - 1);
          break;
        case 79:
          this.ptrY = clamp(data[0] | data[1] << 8, 0, this.height - 1);
          break;
        default:
          break;
      }
    }
    detectLutMode(data) {
      if (data.length >= 14 && data[0] === 0 && data[1] === 64 && data[12] === 128 && data[13] === 128) {
        return "partial";
      }
      if (data.length >= 14 && data[0] === 128 && data[1] === 102 && data[12] === 16 && data[13] === 102) {
        return "full";
      }
      return "custom";
    }
    writeRamByte(command, value) {
      const area = this.memoryArea;
      if (this.ptrX < area.xStart || this.ptrX > area.xEnd || this.ptrY < area.yStart || this.ptrY > area.yEnd) {
        this.ptrX = area.xStart;
        this.ptrY = area.yStart;
      }
      const index = this.ptrY * this.bytesPerRow + this.ptrX;
      if (index >= 0 && index < this.byteLength) {
        if (command === 36) {
          this.newRam[index] = value & 255;
          this.newValid[index] = 1;
        } else {
          this.oldRam[index] = value & 255;
          this.oldValid[index] = 1;
        }
      }
      this.advanceRamPointer();
    }
    advanceRamPointer() {
      const area = this.memoryArea;
      const xIncrement = (this.dataEntryMode & 1) !== 0;
      const yIncrement = (this.dataEntryMode & 2) !== 0;
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
      const control = this.updateControl & 255;
      if (control === 192) {
        this.analogOn = true;
        this.partialPrepared = this.lutMode === "partial";
        this.partialFault = false;
        this.log(
          this.partialPrepared ? "EPD Mode 2 partial setup: clock/analog enabled, glass unchanged" : "EPD 0xC0 activation without partial LUT; glass unchanged"
        );
        this.setBusy(true, EPD_PARTIAL_SETUP_CYCLES);
        this.onFrame?.();
        return;
      }
      if (control === 3) {
        this.analogOn = false;
        this.log("EPD clock/analog disabled; glass unchanged");
        this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
        this.onFrame?.();
        return;
      }
      if (control === 145 || control === 177 || control === 153 || control === 185) {
        this.log(`EPD update option 0x${control.toString(16)} loads LUT only; glass unchanged`);
        this.setBusy(true, EPD_REGISTER_BUSY_CYCLES);
        this.onFrame?.();
        return;
      }
      if (control === 199 || control === 247) {
        this.displayUpdate("full");
        return;
      }
      if (control === 15 || control === 207 || control === 255) {
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
        this.partialFault = !this.partialPrepared || this.lutMode !== "partial" || !(oldComplete && newComplete && oldMatchesVisible);
        this.log(
          this.partialFault ? "EPD partial refresh fault: Mode 2 LUT/base SRAM/visible differential state invalid" : "EPD partial refresh accepted: differential area update"
        );
      } else {
        this.partialFault = false;
        this.partialPrepared = false;
        this.log(
          newComplete ? "EPD full refresh: BW RAM drives visible glass" : "EPD full refresh with incomplete BW RAM; invalid bytes shown as unknown"
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
        seq: this.refreshSeq += 1
      };
      this.setBusy(true, duration);
      this.onFrame?.();
    }
    fullArea() {
      return {
        xStart: 0,
        xEnd: this.bytesPerRow - 1,
        yStart: 0,
        yEnd: this.height - 1
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
          const noise = (pixelNoise(xb * 8, y, salt) * 255 | 0) & 255;
          this.visibleRam[index] = (this.visibleRam[index] ^ this.newRam[index] ^ noise) & 255;
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
        let value = ram[i] ^ 255;
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
            const black = (value & 128 >> bit) === 0;
            let shade = !valid ? 178 : black ? 24 : 218;
            if (effect) {
              const oldBlack = (oldValue & 128 >> bit) === 0;
              shade = this.refreshShade({
                x,
                y,
                oldShade: oldBlack ? 30 : 218,
                newShade: black ? 24 : 218,
                effect
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
        seq: this.refreshEffect.seq
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
        const block = ((x >> 3) * 17 + (y >> 3) * 31 + effect.seq * 13 & 7) < 4 ? 38 : 226;
        const ghost = mix(oldShade, newShade, 0.45);
        const pulse2 = Math.sin(phase * Math.PI * 5) * 28 * (1 - phase);
        return clamp(mix(ghost, block, 0.55) + pulse2 + noise, 0, 255);
      }
      if (!effect.partial) {
        if (phase < 0.18) {
          const t3 = smoothstep(0, 0.18, phase);
          return clamp(mix(oldShade, 238, t3) + rowWave * 10, 0, 255);
        }
        if (phase < 0.42) {
          const t3 = smoothstep(0.18, 0.42, phase);
          return clamp(mix(238, 18, t3) + rowWave * 18 + noise * 0.5, 0, 255);
        }
        if (phase < 0.62) {
          const t3 = smoothstep(0.42, 0.62, phase);
          return clamp(mix(18, 232, t3) - rowWave * 22 + noise * 0.4, 0, 255);
        }
        if (phase < 0.78) {
          const t3 = smoothstep(0.62, 0.78, phase);
          const predrive = newShade < 128 ? 28 : 226;
          return clamp(mix(232, predrive, t3) + rowWave * (newShade < 128 ? 16 : -16), 0, 255);
        }
        const t2 = smoothstep(0.78, 1, phase);
        const settle = Math.sin(phase * Math.PI * 12) * (1 - t2) * 9;
        return clamp(mix(newShade < 128 ? 28 : 226, newShade, t2) + settle, 0, 255);
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
        height: this.height
      };
    }
  };
  var Epaper2Avr = class {
    constructor({ log = () => {
    }, onChange = () => {
    } } = {}) {
      this.log = log;
      this.onChange = onChange;
      this.program = null;
      this.cpu = null;
      this.running = false;
      this.sleeping = false;
      this.frameBudgetMs = 18;
      this.maxInstructionsPerSlice = 8e5;
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
      this.flashCovered = this.program.coveredBytes?.slice(0, FLASH_BYTES) ?? new Uint8Array(FLASH_BYTES);
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
        setRtcInt: (high) => this.ports.b.setPin(PIN.RTC_INT, high)
      });
      this.twi.eventHandler = new DS3231TWIHandler(this.twi, this.ds3231, this.log);
      this.epd = new EpdControllerModel({
        log: this.log,
        getCycles: () => this.cpu.cycles,
        setBusyPin: (busyHigh) => this.ports.d.setPin(PIN.EPD_BUSY, busyHigh),
        onFrame: () => this.requestUiUpdate()
      });
      this.epd.attach(this.ports.b);
      this.air780 = new Air780Model({
        usart: this.usart,
        cpu: this.cpu,
        log: this.log,
        supplyOk: () => this.powerModel?.snapshot().airSupplyOk ?? true,
        addPowerEvent: (event) => this.powerModel?.addLoadEvent(event)
      });
      this.usart.onLineTransmit = (line) => this.air780.onLine(line);
      this.ports.d.addListener((value) => {
        const ddr = this.cpu.data[portDConfig.DDR];
        const airDriven = !!(ddr & 1 << PIN.AIR780_PMOS);
        const airOn = airDriven && (value & 1 << PIN.AIR780_PMOS) === 0;
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
      return this.cycleAnchor + Math.floor(elapsedMs * CPU_FREQ_HZ * this.speedMultiplier / 1e3);
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
      return !!(ddrD & 1 << PIN.BAT_SWITCH) && !!(portDOut & 1 << PIN.BAT_SWITCH);
    }
    updateBatteryAdc() {
      if (!this.adc) {
        return;
      }
      const vbat = Number(this.batteryMv) / 1e3;
      const dividerRatio = BAT_DIVIDER_BOTTOM_OHMS / (BAT_DIVIDER_TOP_OHMS + BAT_DIVIDER_BOTTOM_OHMS);
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
      while (this.running && !this.sleeping && this.cpu.cycles < targetCycles && executed < this.maxInstructionsPerSlice && !timeExpired) {
        const opcode = this.cpu.progMem[this.cpu.pc];
        avrInstruction(this.cpu);
        this.cpu.tick();
        executed += 1;
        if ((executed & 511) === 0) {
          this.epd.updateBusy();
          this.air780.pump(4);
        }
        if ((executed & 255) === 0) {
          timeExpired = monotonicNow() >= deadline;
        }
        if (opcode === SLEEP_OPCODE && this.cpu.data[SMCR] & SE_BIT) {
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
      if (this.sleeping || this.epd.summary().refreshActive || now - this.lastUiWall > 250 || this.cpu.cycles - this.lastUiCycles > CPU_FREQ_HZ) {
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
      const stackPeakBytes = stackPointerOk && this.stackLowWaterSp >= SRAM_START_ADDR ? SRAM_END_ADDR - this.stackLowWaterSp : null;
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
        nonZeroSramBytes
      };
    }
    flashSummary() {
      const bytes = this.cpu.progBytes.slice(0, FLASH_BYTES);
      const covered = this.flashCovered?.slice(0, FLASH_BYTES) ?? new Uint8Array(FLASH_BYTES);
      let usedBytes = 0;
      let coveredBytes = 0;
      let coveredFfBytes = 0;
      let nonFfBytes = 0;
      let nonZeroBytes = 0;
      for (let i = 0; i < bytes.length; i += 1) {
        if (covered[i]) {
          coveredBytes += 1;
          usedBytes = i + 1;
          if (bytes[i] === 255) {
            coveredFfBytes += 1;
          }
        }
        if (bytes[i] !== 255) {
          nonFfBytes += 1;
        }
        if (bytes[i] !== 0) {
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
        covered,
        usedBytes,
        appFreeBytes: Math.max(0, FLASH_APP_LIMIT_BYTES - usedBytes),
        coveredBytes,
        coveredFfBytes,
        uncoveredBytes: FLASH_BYTES - coveredBytes,
        nonFfBytes,
        nonZeroBytes,
        pcByte: this.cpu.pc * 2,
        pcByteHex: hexWord(this.cpu.pc * 2)
      };
    }
    eepromSummary() {
      const source = this.eepromBackend?.memory ?? new Uint8Array(EEPROM_BYTES);
      const bytes = source.slice(0, EEPROM_BYTES);
      let nonFfBytes = 0;
      let nonZeroBytes = 0;
      for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] !== 255) {
          nonFfBytes += 1;
        }
        if (bytes[i] !== 0) {
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
        eear: this.cpu.data[eepromConfig.EEARH] << 8 | this.cpu.data[eepromConfig.EEARL],
        eedr: this.cpu.data[eepromConfig.EEDR],
        writeBusy: !!(this.cpu.data[eepromConfig.EECR] & 2)
      };
    }
    timerSummary(name, timer, config) {
      const readReg = (addr) => addr ? this.cpu.data[addr] : 0;
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
        cs: timer?.CS ?? readReg(config.TCCRB) & 7,
        wgm: timer?.WGM ?? null
      };
    }
    watchdogSummary() {
      const wdtcsr = this.cpu.data[watchdogConfig.WDTCSR];
      const mcusr = this.cpu.data[watchdogConfig.MCUSR];
      const enabled = !!this.watchdog?.enabled;
      const remainingCycles = enabled ? Math.max(0, (this.watchdog.watchdogTimeout ?? this.cpu.cycles) - this.cpu.cycles) : null;
      return {
        enabled,
        interruptEnable: !!(wdtcsr & 64),
        resetEnable: !!(wdtcsr & 8),
        flag: !!(wdtcsr & 128),
        changeEnable: !!(wdtcsr & 16),
        wdtcsr,
        mcusr,
        prescaler: this.watchdog?.prescaler ?? null,
        timeoutMs: this.watchdog?.prescaler !== void 0 ? this.watchdog.prescaler / 128e3 * 1e3 : null,
        remainingMs: remainingCycles === null ? null : remainingCycles / CPU_FREQ_HZ * 1e3
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
          cache: "none"
        },
        memory: this.sramSummary(),
        flash: this.flashSummary(),
        eeprom: this.eepromSummary(),
        watchdog: this.watchdogSummary(),
        timers: {
          t0: this.timerSummary("T0", this.timer0, timer0Config),
          t1: this.timerSummary("T1", this.timer1, timer1Config),
          t2: this.timerSummary("T2", this.timer2, timer2Config)
        },
        interrupts: {
          next: this.cpu.nextInterrupt,
          max: this.cpu.maxInterrupt,
          pendingCount: this.cpu.pendingInterrupts.filter(Boolean).length
        }
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
        airSupplyOk: true
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
          capWaitMs: FIRST_BOOT_CAP_CHARGE_WAIT_MS
        },
        running: this.running,
        sleeping: this.sleeping,
        soc: this.socSummary(),
        rtc: rtcDate,
        rtcSummary,
        buttons: {
          s1: !!(pinD & 1 << PIN.BUTTON1),
          s2: !!(pinD & 1 << PIN.BUTTON2),
          s3: !!(pinC & 1 << PIN.BUTTON3)
        },
        rtcIntHigh: !!(pinB & 1 << PIN.RTC_INT),
        epdPins: {
          rst: !!(portBOut & 1 << PIN.EPD_RST),
          dc: !!(portBOut & 1 << PIN.EPD_DC),
          cs: !!(portBOut & 1 << PIN.EPD_CS),
          mosi: !!(portBOut & 1 << PIN.EPD_MOSI),
          sck: !!(portBOut & 1 << PIN.EPD_SCK),
          busy: !!(pinD & 1 << PIN.EPD_BUSY)
        },
        power: {
          ...powerSnapshot,
          batSwitchOn: this.isBatterySwitchOn(),
          airPmosOn: !!(ddrD & 1 << PIN.AIR780_PMOS) && (portDOut & 1 << PIN.AIR780_PMOS) === 0
        },
        air: {
          ...this.air780.summary()
        },
        epd: this.epd.summary()
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
      this.epd.updateControl = 15;
      this.epd.masterActivation();
      this.requestUiUpdate(true);
    }
  };
  return __toCommonJS(avr_engine_exports);
})();
