// Dibuja con el ESCRITOR de ZXing (el mismo WebAssembly que lee, en su variante de escritura) los códigos de barras de los formatos que lee el escáner, como imágenes
// que se pasan por el LECTOR real: así se comprueba sin cámara que cada formato se reconoce y que de él sale el código de producto. Solo para pruebas.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule as prepareReader } from 'zxing-wasm/reader';
import { prepareZXingModule as prepareWriter, writeBarcode, type WriterOptions } from 'zxing-wasm/writer';
import type { Raster } from './ean13';

let ready = false;

/** En Node no hay `fetch` de ficheros: se les da a los dos módulos su .wasm leído (en el navegador lo sirve la propia app). */
export function prepareZXing(): void {
  if (ready) return;
  const require = createRequire(import.meta.url);
  prepareReader({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) as unknown as ArrayBuffer }, fireImmediately: false });
  prepareWriter({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/writer/zxing_writer.wasm')) as unknown as ArrayBuffer }, fireImmediately: false });
  ready = true;
}

const num = (text: string | undefined): number => Number(text ?? 0);

/** El SVG que escribe ZXing (barras y cuadros como `<path d="M7 0h1v55h-1Z…">` y `<rect>`) pintado en negro sobre blanco, `scale` píxeles por módulo y un margen en blanco. */
export function rasterOfSvg(svg: string, scale = 3, margin = 12): Raster {
  const width = (num(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]) + 2 * margin) * scale;
  const height = (num(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1]) + 2 * margin) * scale;
  const data = new Uint8ClampedArray(Math.round(width) * Math.round(height) * 4).fill(255);
  const w = Math.round(width);
  const fill = (x: number, y: number, rw: number, rh: number): void => {
    for (let yy = Math.round((y + margin) * scale); yy < Math.round((y + rh + margin) * scale); yy++) {
      for (let xx = Math.round((x + margin) * scale); xx < Math.round((x + rw + margin) * scale); xx++) {
        const offset = (yy * w + xx) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = 0;
      }
    }
  };
  for (const m of svg.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h-/g)) fill(num(m[1]), num(m[2]), num(m[3]), num(m[4]));
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>/g)) if (!/#FFFFFF/i.test(m[0])) fill(num(m[1]), num(m[2]), num(m[3]), num(m[4]));
  return { width: w, height: Math.round(height), data, colorSpace: 'srgb' };
}

/** Un código de barras de `format` con `text`, como imagen. */
export async function renderBarcode(text: string, format: WriterOptions['format'], options: { scale?: number; margin?: number } = {}): Promise<Raster> {
  prepareZXing();
  const written = await writeBarcode(text, { format });
  if (written.error) throw new Error(`No se pudo dibujar ${format} «${text}»: ${written.error}`);
  return rasterOfSvg(written.svg, options.scale, options.margin);
}

/** La imagen girada 90° a la derecha. */
export function rotate90(image: Raster): Raster {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      const to = (x * image.height + (image.height - 1 - y)) * 4;
      data.set(image.data.subarray(from, from + 4), to);
    }
  }
  return { width: image.height, height: image.width, data, colorSpace: 'srgb' };
}

/** `image` pegada en el centro de un lienzo blanco de `width × height` (un fotograma de cámara con el código pequeño en medio). */
export function centered(image: Raster, width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const left = Math.floor((width - image.width) / 2);
  const top = Math.floor((height - image.height) / 2);
  for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((top + y) * width + left) * 4);
  return { width, height, data, colorSpace: 'srgb' };
}

/** El trozo `sw × sh` de `image` que empieza en (`sx`, `sy`) y se pinta a `width × height` (vecino más próximo): lo que hace el escáner con `drawImage`. */
export function crop(image: Raster, sx: number, sy: number, sw: number, sh: number, width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((sy + Math.min(sh - 1, Math.floor((y * sh) / height))) * image.width + sx + Math.min(sw - 1, Math.floor((x * sw) / width))) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data, colorSpace: 'srgb' };
}
