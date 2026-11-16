import type { Worker as TessWorker } from 'tesseract.js';
import type { LabelReading } from '../domain/label-text';
import { stretchContrast } from './label-image';
import { PhotoDecodeError, planPhoto, readPlan, type OcrEngine, type OcrMode, type PhotoPlan } from './label-reader';

export { stretchContrast };

// Leer la tabla nutricional de la FOTO de un envase, en el propio móvil y sin internet: Tesseract (OCR) compilado a WebAssembly, con el trabajador, el núcleo y los datos del español
// dentro de la app (`ocr/`, ver `tools/ocr-assets.ts`). La foto no sale del móvil. Lo que se lee pasa por `readLabelText`, el mismo lector que entiende lo dictado, y la persona
// revisa las cifras en el formulario antes de guardar nada: un OCR de una foto torcida o con reflejos se equivoca.
//
// Rapidez (lo que importa en un móvil, que tarda de 5 a 10 veces más que un ordenador):
//  · el motor (3,9 MB de núcleo + 2 MB del idioma) se arranca en cuanto se abre la cámara de la tabla (`warmLabelReader`), mientras la persona encuadra y hace la foto, y se queda
//    listo un rato por si repite; se suelta al salir (`releaseLabelReader`) o tras {@link IDLE_MS} sin usarse (en un móvil ocupa memoria);
//  · no se le pasa la foto entera: `label-reader.ts` busca dónde está la tabla, la recorta de la foto original, la endereza y la lleva a un tamaño que Tesseract lee bien (ronda 46:
//    antes salía el 5 % de las cifras bien con fotos de envases enteros), y sin el segundo intento «en negativo» que Tesseract hace con cada línea dudosa (`tessedit_do_invert`);
//  · nada queda colgado: arrancar el motor y leer tienen un tiempo máximo ({@link ENGINE_TIMEOUT_MS}, {@link READ_TIMEOUT_MS}) y se puede cancelar en cualquier momento.

export type LabelOcrFailure = 'unsupported' | 'failed' | 'timeout' | 'image';

/** En qué va la lectura: preparar la foto, arrancar el motor (solo la primera vez, o si no dio tiempo a calentarlo) o leerla. */
export type LabelStage = 'prepare' | 'load' | 'read';

export function describeOcrFailure(failure: LabelOcrFailure): string {
  switch (failure) {
    case 'unsupported':
      return 'Este móvil no puede leer fotos aquí.';
    case 'timeout':
      return 'La lectura tarda demasiado en este móvil. Prueba con una foto solo de la tabla, o cuéntalo con palabras.';
    case 'image':
      return 'No se pudo abrir esa foto. Prueba con otra.';
    default:
      return 'No se pudo leer la foto.';
  }
}

export class LabelOcrError extends Error {
  constructor(readonly failure: LabelOcrFailure) {
    super(describeOcrFailure(failure));
    this.name = 'LabelOcrError';
  }
}

/** Tiempo máximo para arrancar el motor (cargar el núcleo y el idioma): si no ha podido, algo falla y no es cuestión de esperar más. */
export const ENGINE_TIMEOUT_MS = 60_000;
/** Tiempo máximo para leer una foto con el motor ya listo. */
export const READ_TIMEOUT_MS = 120_000;
/** A partir de este tiempo leyendo no se empieza otra pasada (si ya hay alguna hecha): se devuelve lo leído hasta entonces. */
export const READ_SOFT_MS = 70_000;
/** Cuánto se queda el motor listo sin usarse antes de soltarlo. */
export const IDLE_MS = 90_000;

// Una prueba mínima de WebAssembly SIMD (la de `wasm-feature-detect`): el núcleo que lleva la app lo necesita. Si el WebView es tan viejo que no lo tiene, mejor decirlo que
// quedarse esperando a un trabajador que no arranca.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** ¿Puede este móvil leer fotos? (WebAssembly con SIMD y trabajadores.) */
export function labelReaderSupported(): boolean {
  if (typeof WebAssembly !== 'object' || typeof Worker === 'undefined') return false;
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

const OCR_BASE = (): string => new URL('./ocr/', document.baseURI).href;

// ───────────────────────────── el motor, compartido y calentado de antemano ─────────────────────────────

interface Engine {
  promise: Promise<TessWorker>;
}

let engine: Engine | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Quien está esperando al motor o a una lectura y quiere saber cómo va (el motor avisa de cada paso). */
let listener: ((status: string, progress: number) => void) | null = null;
/** Quien espera una lectura y debe enterarse si el motor falla por dentro (Tesseract, sin manejador de errores, los lanza al vacío y la espera no acaba nunca). */
let onEngineError: ((message: string) => void) | null = null;

function clearIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdle(): void {
  clearIdle();
  idleTimer = setTimeout(releaseLabelReader, IDLE_MS);
}

/** Arranca el motor si no lo está (o devuelve el que ya hay). Un arranque fallido no se queda guardado: la siguiente vez se intenta de nuevo. */
function startEngine(): Promise<TessWorker> {
  if (engine !== null) return engine.promise;
  const entry: Engine = {
    promise: (async () => {
      const { createWorker, OEM, PSM } = await import('tesseract.js');
      const base = OCR_BASE();
      // Si algo falla mientras arranca (p. ej. no encuentra el idioma), Tesseract no rechaza la promesa: avisa a su manejador de errores. Sin él lanza el error al vacío y quien
      // espera se queda esperando para siempre (era lo que se veía en el APK: «Leyendo…» sin acabar). Aquí el error corta la espera en el acto.
      let failStart: (error: Error) => void = () => undefined;
      const failed = new Promise<never>((_, reject) => {
        failStart = reject;
      });
      failed.catch(() => undefined);
      const starting = createWorker('spa', OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
        // El idioma lo contesta el propio trabajador con los bytes de `spa-data.js` (ver `tools/ocr-assets.ts`); la dirección solo tiene que ser de la app.
        langPath: base.replace(/\/$/, ''),
        // Sin trabajador desde un `blob:` (la política de contenido solo admite los de la propia app) y sin guardar nada aparte: todo está ya dentro de la app.
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (message) => listener?.(message.status, message.progress),
        errorHandler: (data: unknown) => {
          failStart(new LabelOcrError('failed'));
          onEngineError?.(String(data));
        },
      });
      // Si gana el fallo, el trabajador que se estaba creando se termina en cuanto exista (no queda un hilo suelto).
      let lost = false;
      starting.then(
        (late) => {
          if (lost) void late.terminate().catch(() => undefined);
        },
        () => undefined,
      );
      let worker: TessWorker;
      try {
        worker = await Promise.race([starting, failed]);
      } catch (error) {
        lost = true;
        throw error instanceof LabelOcrError ? error : new LabelOcrError('failed');
      }
      try {
        // Una tabla es "un bloque de texto" con columnas: se conservan los espacios entre palabras para no pegar la cifra al nutriente. Sin el reintento «en negativo» de
        // las líneas dudosas (la tinta de una etiqueta siempre es más oscura que el papel): casi una cuarta parte menos de tiempo en una foto con mucho texto.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1', tessedit_do_invert: '0' });
      } catch (error) {
        await worker.terminate();
        throw error;
      }
      return worker;
    })(),
  };
  engine = entry;
  entry.promise.catch(() => {
    if (engine === entry) engine = null;
  });
  return entry.promise;
}

/** Suelta el motor ya (si lo hay): termina su trabajador y libera la memoria. */
export function releaseLabelReader(): void {
  clearIdle();
  const entry = engine;
  engine = null;
  if (entry === null) return;
  entry.promise.then(
    (worker) => void worker.terminate(),
    () => undefined,
  );
}

/**
 * Empieza a arrancar el motor sin esperar a nadie: se llama al abrir la cámara de la tabla, para que cuando haya foto ya esté listo. No avisa de nada si falla (la lectura
 * lo volverá a intentar y entonces sí lo dirá). Se suelta solo si pasa {@link IDLE_MS} sin usarse.
 */
export function warmLabelReader(): void {
  if (!labelReaderSupported()) return;
  clearIdle();
  startEngine().then(armIdle, () => undefined);
}

/** Espera `work`, pero no más de `ms` ni más allá de `signal`; si se pasa o se cancela, avisa a `giveUp` (que suelta lo que haga falta) y falla con el motivo. */
function guard<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, giveUp: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const stop = (failure: LabelOcrFailure): void => {
      finish();
      giveUp();
      reject(new LabelOcrError(failure));
    };
    const onAbort = (): void => stop('failed');
    const timer = setTimeout(() => stop('timeout'), ms);
    if (signal?.aborted) return stop('failed');
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

const PSM_OF: Readonly<Record<OcrMode, 'SINGLE_BLOCK' | 'AUTO' | 'SPARSE_TEXT' | 'SINGLE_LINE' | 'SINGLE_WORD'>> = {
  block: 'SINGLE_BLOCK',
  auto: 'AUTO',
  sparse: 'SPARSE_TEXT',
  line: 'SINGLE_LINE',
  word: 'SINGLE_WORD',
};

/**
 * Lee el texto de la foto de una etiqueta. `onProgress` recibe de 0 a 1 (y en qué va) mientras trabaja; `signal` la cancela. Lanza `LabelOcrError` si no puede.
 * Devuelve el texto leído y lo que `readLabelText` saca de él.
 */
export async function readLabelFromImage(
  source: Blob,
  onProgress?: (fraction: number, stage: LabelStage) => void,
  signal?: AbortSignal,
): Promise<{ text: string; reading: LabelReading }> {
  if (!labelReaderSupported()) throw new LabelOcrError('unsupported');
  const report = (fraction: number, stage: LabelStage): void => {
    if (signal?.aborted !== true) onProgress?.(Math.min(1, fraction), stage);
  };
  clearIdle();
  report(0.02, 'prepare');
  // El motor se arranca ya, mientras se abre la foto y se busca la tabla, si no lo estaba (si se calentó al abrir la cámara, esto no cuesta nada).
  const starting = startEngine();
  starting.catch(() => undefined);
  let plan: PhotoPlan;
  try {
    plan = await planPhoto(source);
  } catch (error) {
    armIdle();
    throw new LabelOcrError(error instanceof PhotoDecodeError ? 'image' : 'failed');
  }
  report(0.1, 'load');
  const loading = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api'];
  // Solo una lectura a la vez escucha al motor; si una cancelada llega tarde a su `finally`, no apaga la oyente de la que la sustituyó.
  let mine: typeof listener = (status, progress) => {
    const step = loading.indexOf(status);
    if (step >= 0) report(0.1 + 0.15 * ((step + Math.max(0, Math.min(1, progress))) / loading.length), 'load');
  };
  listener = mine;
  try {
    // Si el motor no arranca a tiempo o se cancela, se suelta (si se canceló a mitad de arrancar, quien se fue lo suelta del todo con `releaseLabelReader`).
    const worker = await guard(starting, ENGINE_TIMEOUT_MS, signal, () => {
      if (signal?.aborted !== true) releaseLabelReader();
    });
    const { PSM } = await import('tesseract.js');
    report(0.25, 'read');
    // Si el motor falla por dentro a mitad de leer, la lectura falla en el acto (en vez de esperar al tope de tiempo).
    let failRead: (error: Error) => void = () => undefined;
    const readFailed = new Promise<never>((_, reject) => {
      failRead = reject;
    });
    readFailed.catch(() => undefined);
    onEngineError = () => failRead(new LabelOcrError('failed'));
    const tesseract: OcrEngine = {
      async recognize(image, mode, options) {
        await worker.setParameters({ tessedit_pageseg_mode: PSM[PSM_OF[mode]], tessedit_char_whitelist: options?.whitelist ?? '' });
        mine = (status, progress) => {
          if (status === 'recognizing text') options?.onProgress?.(Math.max(0, Math.min(1, progress)));
        };
        listener = mine;
        const { data } = await Promise.race([worker.recognize(image), readFailed]);
        return { text: data.text, lines: [] };
      },
    };
    // Una lectura a medias no se puede parar: si se pasa de tiempo o se cancela, el trabajador se termina (la próxima vez se arranca otro).
    const reading = readPlan(tesseract, plan, { progress: (fraction) => report(0.25 + 0.75 * fraction, 'read'), aborted: () => signal?.aborted === true, deadline: Date.now() + READ_SOFT_MS });
    const result = await guard(reading, READ_TIMEOUT_MS, signal, releaseLabelReader);
    report(1, 'read');
    // Solo la demostración tiene este gancho (ver `main.tsx`): el banco de medida lee de aquí el texto de cada pasada.
    (globalThis as { __smartringLabel?: { reads: unknown[] } }).__smartringLabel?.reads.push({ texts: result.texts, passes: result.passes, boxes: plan.steps.map((step) => ({ ...step.box })), size: [plan.full.width, plan.full.height] });
    return { text: result.text, reading: result.reading };
  } catch (error) {
    // Un motor que falló no se reutiliza (salvo si solo se canceló mientras arrancaba: ese sigue valiendo para el siguiente intento).
    if (signal?.aborted !== true) releaseLabelReader();
    throw error instanceof LabelOcrError ? error : new LabelOcrError('failed');
  } finally {
    onEngineError = null;
    if (listener === mine) listener = null;
    if (engine !== null) armIdle();
  }
}
