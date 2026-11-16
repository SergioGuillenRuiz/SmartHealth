import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { READER_OPTIONS, validCodes } from '../src/app/barcode-scanner';
import { isBarcode } from '../src/domain/nutrition';
import { ean13Bars, ean13Y4m, renderEan13 } from './ean13';

// El escáner de la app lee los fotogramas con ZXing-C++ (WebAssembly). Aquí se comprueba, sin cámara, que el lector acepta lo que
// dibuja el generador de pruebas y que el filtro de la app deja pasar solo códigos de producto con su dígito de control.

beforeAll(() => {
  // En Node no hay `fetch` de ficheros: se le da el .wasm leído (en el navegador lo sirve la propia app).
  const wasm = createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm');
  prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasm) as unknown as ArrayBuffer }, fireImmediately: false });
});

describe('el generador de EAN-13 de las pruebas', () => {
  it('dibuja 95 barras que empiezan y acaban con la guarda', () => {
    const bars = ean13Bars('8410000000016');
    expect(bars).toHaveLength(95);
    expect(bars.startsWith('101')).toBe(true);
    expect(bars.endsWith('101')).toBe(true);
    expect(bars.slice(45, 50)).toBe('01010'); // la guarda del centro
  });

  it('el vídeo falso tiene su cabecera y fotogramas completos', () => {
    const video = ean13Y4m('8410000000016', { width: 64, height: 48, frames: 2 });
    const header = 'YUV4MPEG2 W64 H48 F10:1 Ip A1:1 C420jpeg\n';
    expect(new TextDecoder().decode(video.slice(0, header.length))).toBe(header);
    expect(video.length).toBe(header.length + 2 * ('FRAME\n'.length + 64 * 48 * 1.5));
  });
});

describe('lectura con ZXing', () => {
  it('lee un EAN-13 dibujado, y la app lo da por bueno', async () => {
    const results = await readBarcodes(renderEan13('8410000000016'), READER_OPTIONS);
    expect(results.map((r) => r.text)).toEqual(['8410000000016']);
    expect(validCodes(results)).toEqual(['8410000000016']);
  });

  it('lo lee también en un fotograma grande, con el código pequeño en el centro (como una cámara)', async () => {
    const results = await readBarcodes(renderEan13('5449000000996', { moduleWidth: 2, barHeight: 90, width: 640, height: 480 }), READER_OPTIONS);
    expect(validCodes(results)).toEqual(['5449000000996']);
  });

  it('una imagen en blanco no da ningún código', async () => {
    const blank = { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4).fill(255), colorSpace: 'srgb' as const };
    expect(await readBarcodes(blank, READER_OPTIONS)).toEqual([]);
  });
});

describe('validCodes: solo códigos de producto con su dígito de control', () => {
  it('descarta lecturas no válidas, con letras o de otra longitud', () => {
    expect(
      validCodes([
        { isValid: true, text: '8410000000016' },
        { isValid: false, text: '8410000000016' },
        { isValid: true, text: '8410000000019' },
        { isValid: true, text: 'HOLA' },
        { isValid: true, text: '12345' },
      ]),
    ).toEqual(['8410000000016']);
    expect(isBarcode('5449000000996')).toBe(true);
  });
});
