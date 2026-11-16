// CRC-16/CCITT-FALSE: polinomio 0x1021, valor inicial 0xFFFF, sin reflexión y sin XOR final.
// Es el CRC de las tramas YCBT y también el de verificación del bloque terminal del historial.
// Valor de comprobación: "123456789" → 0x29B1.

const TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

export function crc16(data: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    const byte = (data[i] ?? 0) & 0xff;
    crc = ((crc << 8) & 0xffff) ^ (TABLE[((crc >> 8) ^ byte) & 0xff] ?? 0);
  }
  return crc;
}
