import type { ReaderOptions } from 'zxing-wasm/reader';
import { gtinFromScan } from '../domain/barcode';

// Escáner de códigos de barras con la cámara trasera. Los fotogramas se leen en el propio móvil con ZXing-C++ (compilado a
// WebAssembly, dentro del APK: ni la imagen ni el código salen del móvil hasta que se consulta el producto). El detector de formas
// del navegador no se usa porque un WebView de Android no lo trae.

/** Cada cuánto se lee un fotograma (ms): lo bastante rápido para sentirse inmediato y sin agotar la batería. */
const FRAME_EVERY_MS = 180;
/** El fotograma entero se reduce a esta anchura antes de leerlo: un código se lee igual y se ahorra memoria y tiempo. */
const MAX_WIDTH = 960;
/** Lo que se lee del centro (donde la persona pone el código) va a su tamaño real, hasta esta anchura: así las barras salen más grandes que en el fotograma reducido. */
const MAX_CROP_WIDTH = 1280;

/** Los códigos de barras de los productos: EAN-13, EAN-8, UPC-A y UPC-E (los de siempre), ITF (las cajas) y los de GS1 (DataBar y Code 128, de la fruta y de los lotes). */
export const LINEAR_FORMATS: NonNullable<ReaderOptions['formats']> = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF', 'Code128', 'DataBar', 'DataBarLtd', 'DataBarExp'];
/** Los de dos dimensiones que llevan un GTIN: el QR con enlace GS1 y el DataMatrix (suplementos, lotes). Se buscan de vez en cuando: cuestan más. */
export const MATRIX_FORMATS: NonNullable<ReaderOptions['formats']> = ['QRCode', 'DataMatrix'];

/** Qué busca el lector casi siempre: los códigos de barras lineales, en cualquier orientación. */
export const READER_OPTIONS: ReaderOptions = { formats: LINEAR_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 3 };
/** Y cada pocos fotogramas, los de dos dimensiones. */
export const MATRIX_OPTIONS: ReaderOptions = { formats: [...MATRIX_FORMATS, ...LINEAR_FORMATS], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 3 };

/** Qué parte del fotograma se lee y a qué tamaño: el centro a su tamaño real, o todo reducido. */
export type FramePass = 'center' | 'full' | 'matrix';
/** El orden de las lecturas: dos de cada tres miran el centro; cada cuarta, el fotograma entero y también con los códigos de dos dimensiones. */
export const PASS_ORDER: readonly FramePass[] = ['center', 'full', 'center', 'matrix'];

export interface FramePlan {
  /** Qué trozo del vídeo se copia (en píxeles del vídeo)… */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** …y a qué tamaño se pinta en el lienzo que se lee. */
  width: number;
  height: number;
}

/**
 * Cómo se lee un fotograma de `videoWidth × videoHeight`. «Centro»: el 70 % del ancho y el 50 % del alto del medio, sin reducir (hasta {@link MAX_CROP_WIDTH}): es
 * donde se pone el código y ahí las barras ocupan más píxeles. «Entero» y «matrix»: todo el fotograma, reducido a 960 o 1280 de ancho.
 */
export function framePlan(videoWidth: number, videoHeight: number, pass: FramePass): FramePlan {
  if (pass === 'center') {
    const sw = Math.round(videoWidth * 0.7);
    const sh = Math.round(videoHeight * 0.5);
    const scale = Math.min(1, MAX_CROP_WIDTH / sw);
    return { sx: Math.round((videoWidth - sw) / 2), sy: Math.round((videoHeight - sh) / 2), sw, sh, width: Math.round(sw * scale), height: Math.round(sh * scale) };
  }
  const scale = Math.min(1, (pass === 'full' ? MAX_WIDTH : MAX_CROP_WIDTH) / videoWidth);
  return { sx: 0, sy: 0, sw: videoWidth, sh: videoHeight, width: Math.round(videoWidth * scale), height: Math.round(videoHeight * scale) };
}

export type ScannerFailure = 'denied' | 'no-camera' | 'unsupported' | 'failed';

export interface ScannerHandle {
  /** Para la cámara y deja de leer. Se puede llamar varias veces. */
  stop(): void;
}

/** Los dos únicos motivos de fallo que cambian lo que se le dice a la persona. */
export function describeScannerFailure(failure: ScannerFailure): string {
  switch (failure) {
    case 'denied':
      return 'No hay permiso para usar la cámara. Actívalo en los ajustes de Android o teclea el código.';
    case 'no-camera':
      return 'Este móvil no tiene una cámara que se pueda usar. Teclea el código.';
    case 'unsupported':
      return 'La cámara no está disponible aquí. Teclea el código.';
    default:
      return 'No se pudo abrir la cámara. Teclea el código.';
  }
}

export class ScannerError extends Error {
  constructor(readonly failure: ScannerFailure) {
    super(describeScannerFailure(failure));
    this.name = 'ScannerError';
  }
}

/**
 * Lector de ZXing cargado la primera vez (el WebAssembly pesa cerca de 1 MB y no hace falta hasta escanear). La promesa se guarda: la
 * librería vuelve a compilar y a instanciar el módulo si se le pasan otras opciones (aunque sean iguales), y eso en cada apertura del escáner.
 */
let readerLoad: Promise<typeof import('zxing-wasm/reader')> | null = null;
function loadReader(): Promise<typeof import('zxing-wasm/reader')> {
  readerLoad ??= (async () => {
    const [reader, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')]);
    // El .wasm va dentro de la app (precacheado y servido desde ella): la política de contenido no deja ir a buscarlo a otro sitio.
    reader.prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
      fireImmediately: false,
    });
    return reader;
  })().catch((error: unknown) => {
    readerLoad = null; // si falla (sin memoria, un fallo puntual) se vuelve a intentar la próxima vez
    throw error;
  });
  return readerLoad;
}

/**
 * Los códigos de producto que valen de lo que leyó ZXing: el GTIN (con su dígito de control correcto) de lo leído, ya sea unas cifras sueltas o un código GS1
 * (DataBar, Code 128, DataMatrix o el enlace de un QR). Lo demás es ruido: el texto de un QR cualquiera no es un producto.
 */
export function validCodes(results: ReadonlyArray<{ isValid: boolean; text: string }>): string[] {
  const codes: string[] = [];
  for (const result of results) {
    if (!result.isValid) continue;
    const code = gtinFromScan(result.text);
    if (code !== null && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Abre la cámara trasera en `video` y llama a `onCode` con el primer código de producto que lea (una sola vez: después se para).
 * Lanza `ScannerError` si no se puede abrir la cámara.
 */
export async function startScanner(video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScannerHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new ScannerError('unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new ScannerError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new ScannerError('no-camera');
    throw new ScannerError('failed');
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  try {
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    await video.play();
    // Enfoque continuo si la cámara lo ofrece (los códigos pequeños salen borrosos con el enfoque fijo); si no, no pasa nada.
    for (const track of stream.getVideoTracks()) {
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
      } catch {
        /* sin enfoque continuo */
      }
    }
    const reader = await loadReader();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new ScannerError('failed');

    let frame = 0;
    const scan = async (): Promise<void> => {
      if (stopped) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const pass = PASS_ORDER[frame++ % PASS_ORDER.length]!;
          const plan = framePlan(video.videoWidth, video.videoHeight, pass);
          canvas.width = plan.width;
          canvas.height = plan.height;
          context.drawImage(video, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
          const results = await reader.readBarcodes(context.getImageData(0, 0, plan.width, plan.height), pass === 'matrix' ? MATRIX_OPTIONS : READER_OPTIONS);
          const [code] = validCodes(results);
          if (code !== undefined && !stopped) {
            stop();
            onCode(code);
            return;
          }
        }
      } catch {
        /* un fotograma que no se puede leer no para el escáner: se prueba con el siguiente */
      }
      if (!stopped) timer = setTimeout(() => void scan(), FRAME_EVERY_MS);
    };
    void scan();
  } catch (error) {
    stop();
    throw error instanceof ScannerError ? error : new ScannerError('failed');
  }
  return { stop };
}
