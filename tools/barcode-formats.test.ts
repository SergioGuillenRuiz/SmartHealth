import { beforeAll, describe, expect, it } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { framePlan, MATRIX_OPTIONS, READER_OPTIONS, validCodes } from '../src/app/barcode-scanner';
import { centered, crop, prepareZXing, renderBarcode, rotate90 } from './barcode-raster';

// Cada formato de código que lee el escáner, dibujado con el escritor de ZXing y leído con su lector, sin cámara: de cada uno tiene que salir el código del producto.

beforeAll(() => prepareZXing());

const readLinear = async (image: Awaited<ReturnType<typeof renderBarcode>>) => validCodes(await readBarcodes(image, READER_OPTIONS));
const readAll = async (image: Awaited<ReturnType<typeof renderBarcode>>) => validCodes(await readBarcodes(image, MATRIX_OPTIONS));

describe('formatos lineales', () => {
  it.each([
    ['EAN-13', '8410000000016', '8410000000016'],
    ['EAN-8', '96385074', '96385074'],
    ['UPC-A', '036000291452', '0036000291452'], // ZXing da el UPC-A como EAN-13 con un cero delante: es el mismo producto
    ['UPC-E', '04252614', '0042100005264'], // y el UPC-E ya expandido
    ['ITF', '10012345678902', '10012345678902'], // el código ITF-14 de una caja
    ['Code128', '(01)08410000000016', '08410000000016'], // GS1-128: el GTIN va con su identificador 01
    ['DataBar', '0841000000001', '08410000000016'], // GS1 DataBar (fruta y verdura, cupones)
  ] as const)('%s «%s» → %s', async (format, text, expected) => {
    expect(await readLinear(await renderBarcode(text, format))).toEqual([expected]);
  });

  it('un Code 128 que no es un producto no vale', async () => {
    expect(await readLinear(await renderBarcode('LOTE-2024-A', 'Code128'))).toEqual([]);
  });

  it('un ITF con cifra de control mala no vale', async () => {
    expect(await readLinear(await renderBarcode('10012345678903', 'ITF'))).toEqual([]);
  });

  it('también girado 90° (el móvil en vertical)', async () => {
    expect(await readLinear(rotate90(await renderBarcode('8410000000016', 'EAN-13')))).toEqual(['8410000000016']);
    expect(await readLinear(rotate90(await renderBarcode('96385074', 'EAN-8')))).toEqual(['96385074']);
  });
});

describe('formatos de dos dimensiones (cada pocos fotogramas)', () => {
  it('un QR con un enlace GS1 da el GTIN', async () => {
    expect(await readAll(await renderBarcode('https://id.gs1.org/01/08410000000016', 'QRCode'))).toEqual(['08410000000016']);
  });

  it('un QR con otra cosa no es un producto', async () => {
    expect(await readAll(await renderBarcode('https://marca.es/recetas', 'QRCode'))).toEqual([]);
  });

  it('un DataMatrix GS1 da el GTIN aunque lleve lote y caducidad detrás', async () => {
    expect(await readAll(await renderBarcode('0108410000000016', 'DataMatrix'))).toEqual(['08410000000016']);
    expect(await readAll(await renderBarcode('010841000000001617261231', 'DataMatrix'))).toEqual(['08410000000016']);
  });

  it('el pase de dos dimensiones también lee los lineales', async () => {
    expect(await readAll(await renderBarcode('8410000000016', 'EAN-13'))).toEqual(['8410000000016']);
  });

  it('los pases normales no buscan 2D (cuestan más)', async () => {
    expect(await readLinear(await renderBarcode('https://id.gs1.org/01/08410000000016', 'QRCode'))).toEqual([]);
  });
});

describe('framePlan: qué parte del fotograma se lee', () => {
  it('el centro va a su tamaño real (hasta 1280 de ancho), el entero se reduce a 960', () => {
    expect(framePlan(1920, 1080, 'center')).toEqual({ sx: 288, sy: 270, sw: 1344, sh: 540, width: 1280, height: 514 });
    expect(framePlan(1280, 720, 'center')).toEqual({ sx: 192, sy: 180, sw: 896, sh: 360, width: 896, height: 360 });
    expect(framePlan(1920, 1080, 'full')).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080, width: 960, height: 540 });
    expect(framePlan(1920, 1080, 'matrix')).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080, width: 1280, height: 720 });
    expect(framePlan(640, 480, 'full')).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480, width: 640, height: 480 });
  });

  it('un código pequeño en el centro de un fotograma grande se lee en el recorte', async () => {
    const frame = centered(await renderBarcode('8410000000016', 'EAN-13', { scale: 2, margin: 6 }), 1920, 1080);
    const plan = framePlan(frame.width, frame.height, 'center');
    const piece = crop(frame, plan.sx, plan.sy, plan.sw, plan.sh, plan.width, plan.height);
    expect(await readLinear(piece)).toEqual(['8410000000016']);
  });
});
