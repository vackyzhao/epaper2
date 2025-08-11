/*
 * Copyright (c) 2014, Majenko Technologies
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without modification, 
 * are permitted provided that the following conditions are met:
 * 
 *  1. Redistributions of source code must retain the above copyright notice, 
 *     this list of conditions and the following disclaimer.
 * 
 *  2. Redistributions in binary form must reproduce the above copyright notice,
 *     this list of conditions and the following disclaimer in the documentation
 *      and/or other materials provided with the distribution.
 * 
 *  3. Neither the name of Majenko Technologies nor the names of its contributors may be used
 *     to endorse or promote products derived from this software without 
 *     specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#pragma once
#include <Arduino.h>

#if !defined(__AVR__)
# error "This SoftSPI implementation is AVR-only."
#endif

class SoftSPI {
public:
  // miso 参数保留但不使用（只写场景可传 0xFF 或 -1）
  SoftSPI(uint8_t mosi, uint8_t miso, uint8_t sck);

  // 初始化：缓存端口/掩码，设置 SCK=0、MOSI=0（MODE0 空闲电平）
  void begin();

  // 发送单字节（固定 MODE0+MSB，纯写，返回值恒 0）
  uint8_t transfer(uint8_t v);

private:
  // 引脚号
  uint8_t _mosi, _miso, _sck;

  // 端口寄存器与掩码缓存（AVR）
  volatile uint8_t* _mosi_port = nullptr;
  volatile uint8_t* _sck_port  = nullptr;
  volatile uint8_t* _sck_pinr  = nullptr; // PINx: 写1翻转输出
  uint8_t           _mosi_mask = 0;
  uint8_t           _sck_mask  = 0;
};
