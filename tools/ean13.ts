// Dibujo de un código de barras EAN-13 como imagen, para PROBAR el escáner sin cámara: las pruebas unitarias lo pasan por el lector de
// ZXing y la prueba e2e lo convierte en el «vídeo» de una cámara falsa (ver `tests/e2e/global-setup.ts`).

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
/** Qué juego (L o G) usa cada una de las seis primeras cifras según la primera cifra del código. */
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Las 95 barras (1 = negra) de un EAN-13 de 13 cifras. */
export function ean13Bars(code: string): string {
  if (!/^\d{13}$/.test(code)) throw new Error('Un EAN-13 tiene 13 cifras.');
  const d = [...code].map(Number);
  const parity = PARITY[d[0] as number] as string;
  let bars = '101';
  for (let i = 0; i < 6; i++) bars += ((parity[i] === 'L' ? L : G)[d[i + 1] as number] as string);
  bars += '01010';
  for (let i = 0; i < 6; i++) bars += R[d[i + 7] as number] as string;
  return `${bars}101`;
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes por píxel. */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** Como `ImageData` (que es lo que lee ZXing en el navegador): las imágenes de aquí son sRGB. */
  colorSpace: 'srgb';
}

/** El código dibujado en negro sobre blanco, con su margen en blanco, centrado en una imagen de `width × height` si se pide. */
export function renderEan13(code: string, options: { moduleWidth?: number; barHeight?: number; width?: number; height?: number } = {}): Raster {
  const bars = ean13Bars(code);
  const moduleWidth = options.moduleWidth ?? 3;
  const barHeight = options.barHeight ?? 80;
  const quiet = 10 * moduleWidth;
  const width = options.width ?? bars.length * moduleWidth + 2 * quiet;
  const height = options.height ?? barHeight + 40;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const left = Math.floor((width - bars.length * moduleWidth) / 2);
  const top = Math.floor((height - barHeight) / 2);
  for (let y = top; y < top + barHeight; y++) {
    for (let i = 0; i < bars.length; i++) {
      if (bars[i] !== '1') continue;
      for (let k = 0; k < moduleWidth; k++) {
        const offset = (y * width + left + i * moduleWidth + k) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = 0;
      }
    }
  }
  return { width, height, data, colorSpace: 'srgb' };
}

/**
 * Un vídeo Y4M (el formato que admite `--use-file-for-fake-video-capture` de Chromium) de `frames` fotogramas iguales con el código
 * en el centro. Sirve para probar el escáner de punta a punta en el navegador sin una cámara de verdad.
 */
export function ean13Y4m(code: string, options: { width?: number; height?: number; frames?: number } = {}): Uint8Array {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const frames = options.frames ?? 3;
  const image = renderEan13(code, { moduleWidth: 4, barHeight: 200, width, height });
  const header = new TextEncoder().encode(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  const frameTag = new TextEncoder().encode('FRAME\n');
  const lumaSize = width * height;
  const chromaSize = (width / 2) * (height / 2);
  const frameBytes = frameTag.length + lumaSize + 2 * chromaSize;
  const out = new Uint8Array(header.length + frames * frameBytes);
  out.set(header, 0);
  for (let f = 0; f < frames; f++) {
    let at = header.length + f * frameBytes;
    out.set(frameTag, at);
    at += frameTag.length;
    for (let i = 0; i < lumaSize; i++) out[at + i] = image.data[i * 4] as number; // negro o blanco: el rojo vale como brillo
    at += lumaSize;
    out.fill(128, at, at + 2 * chromaSize); // sin color
  }
  return out;
}
