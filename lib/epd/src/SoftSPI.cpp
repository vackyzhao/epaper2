#include <Arduino.h>
#include "SoftSPI.h"

#if !defined(__AVR__)
# error "This SoftSPI fast path is AVR-only."
#endif

SoftSPI::SoftSPI(uint8_t mosi, uint8_t miso, uint8_t sck)
: _mosi(mosi), _miso(miso), _sck(sck) {}


inline void spi_delay() {
  // 你可以根据频率调整，比如 4 次 NOP ≈ 250ns（@16MHz）
  //asm volatile("nop\nnop\n");
   delayMicroseconds(1);
}

void SoftSPI::begin() {
  pinMode(_mosi, OUTPUT);
  pinMode(_sck,  OUTPUT);

  // 缓存端口与掩码（成员）
  _mosi_port = portOutputRegister(digitalPinToPort(_mosi));
  _sck_port  = portOutputRegister(digitalPinToPort(_sck));
  _sck_pinr  = portInputRegister( digitalPinToPort(_sck)); // 用于 PINx 翻转
  _mosi_mask = digitalPinToBitMask(_mosi);
  _sck_mask  = digitalPinToBitMask(_sck);

  // 固定 MODE0：空闲 SCK=0；顺手把 MOSI 拉低
  *_sck_port  &= (uint8_t)~_sck_mask;
  *_mosi_port &= (uint8_t)~_mosi_mask;
}

uint8_t SoftSPI::transfer(uint8_t val) {
  // 将成员缓存到局部，便于编译器寄存器分配（微优化）
  volatile uint8_t* mosi_port = _mosi_port;
  volatile uint8_t* sck_pinr  = _sck_pinr;
  const uint8_t     mosi_mask = _mosi_mask;
  const uint8_t     sck_mask  = _sck_mask;

 
  // 固定 MODE0 + MSB，纯写：SCK低时摆数据 → SCK↑采样 → SCK↓准备下一位
  for (uint8_t mask = 0x80; mask; mask >>= 1) {

    if (val & mask) *mosi_port |=  mosi_mask;      // MOSI = 1
    else            *mosi_port &= (uint8_t)~mosi_mask; // MOSI = 0


    *sck_pinr = sck_mask; // SCK ↑（PINx 写1翻转）
    spi_delay();
    *sck_pinr = sck_mask; // SCK ↓
    spi_delay();
  }
  
  *mosi_port &= ~mosi_mask;
  return 0; // 只写：不返回有效读值
}
