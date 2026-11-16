import { describe, expect, it } from 'vitest';
import { crc16 } from './crc';

describe('crc16 (CCITT-FALSE)', () => {
  it('cumple el valor de comprobación estándar', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc16(data)).toBe(0x29b1);
  });

  it('de una entrada vacía es el valor inicial', () => {
    expect(crc16(new Uint8Array())).toBe(0xffff);
  });

  it('coincide con la trama de ejemplo documentada (05 06 06 00 → 0x2083)', () => {
    expect(crc16([0x05, 0x06, 0x06, 0x00])).toBe(0x2083);
  });
});
