import { isConfidentReading, readingScore, readLabelText, readLabelTexts, type LabelReading } from '../domain/label-text';
import { binarizeAdaptive, estimateGlyphHeight, estimateSkewDegrees, flattenBackground, inkIsLight, invertGrays, medianFilter, removeRuledLines, sharpen, stretchContrast } from './label-image';
import { expandBox, findTextBlocks, grayOf, type Box } from './label-locate';

// Leer la tabla nutricional de la FOTO de un envase (ronda 46). Una foto de verdad no es una tabla recortada: es un envase entero, con marca, ingredientes, colores y brillos, y la tabla
// ocupa una parte pequeña y torcida. El lector anterior le pasaba toda la foto a Tesseract y este, con un envase oscuro o mucho texto alrededor, no leía casi nada (medido con fotos de
// envases dibujadas: 5 % de las cifras bien). Ahora se hace en dos tiempos:
//  1. se busca DÓNDE está la tabla sin OCR (`label-locate.ts`: bloques de texto con filas), y
//  2. cada candidato se recorta de la foto ORIGINAL (no de la reducida), se agranda a un tamaño que Tesseract lee bien y se lee; se para en cuanto sale una lectura completa y coherente.
// Si ningún bloque da una lectura, se lee la foto entera como antes. El motor de OCR llega inyectado (`OcrEngine`), así que esto se prueba sin Tesseract.

/** Una palabra o línea leída, con su caja en la imagen que se leyó. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: Box;
}
export interface OcrLine {
  text: string;
  bbox: Box;
  words: OcrWord[];
}
export interface OcrPage {
  text: string;
  lines: OcrLine[];
}

/** Cómo ve la página el OCR: un bloque de texto, análisis automático, texto disperso, una sola línea o una sola palabra. */
export type OcrMode = 'block' | 'auto' | 'sparse' | 'line' | 'word';

export interface RecognizeOptions {
  /** Solo estos caracteres (p. ej. las cifras): el motor no puede dar otros. */
  whitelist?: string;
  /** Avance de 0 a 1 de esta lectura. */
  onProgress?: (fraction: number) => void;
}

export interface OcrEngine {
  recognize(image: HTMLCanvasElement, mode: OcrMode, options?: RecognizeOptions): Promise<OcrPage>;
}

export interface ReadHooks {
  /** Avance de 0 a 1 de la parte de lectura (el motor ya está listo). */
  progress?: (fraction: number) => void;
  /** Si devuelve `true`, la lectura se corta en cuanto puede. */
  aborted?: () => boolean;
  /** Hora (ms) a partir de la cual no se empieza otra pasada si ya hay alguna hecha: en un móvil lento, mejor lo que se leyó que un fallo por tardar (el tope duro lo pone quien llama). */
  deadline?: number;
}

/** El lado más largo al que se baja una foto enorme (una de galería de 50 MP) antes de buscar y recortar: lo bastante grande para que el recorte tenga letra legible. */
export const FULL_MAX_SIDE = 2600;
/** El lado largo de la copia pequeña con la que se busca la tabla (más pequeña, más rápido; el recorte sale de la grande). */
export const LOCATE_SIDE = 1280;
/** El alto (px) al que se lleva una mayúscula o una cifra antes de leer: Tesseract lee mejor con letras de unos 25–35 px; más grandes no leen mejor y tardan más. */
export const CAP_HEIGHT = 28;
/** Un recorte nunca se agranda más de estas veces (letra de 6 px agrandada diez veces sigue siendo ilegible) ni se reduce de más de esto. */
const MAX_UPSCALE = 4.5;
const MIN_SCALE = 0.35;
/** El ancho de un recorte que se lee tal cual cuando no se puede medir la letra (muy poco texto): el ancho al que se leía una tabla entera con letra normal. */
const FALLBACK_WIDTH = 1100;
/** Cuántos bloques de la foto se prueban como mucho antes de leerla entera. */
export const MAX_CANDIDATES = 4;
/** El lado más largo de lo que se le da al OCR: agrandar una foto entera hasta que su letra pequeña mida 28 px daría un lienzo enorme y una lectura de minutos. */
export const MAX_SIDE = 2000;

/** Una pasada de lectura: cómo se prepara la imagen y cómo ve la página el OCR. */
export type Pass = PrepareOptions & {
  mode: OcrMode;
  /** Solo se hace si, con las pasadas anteriores de este recorte, aún no se leyeron ni tres cifras (es el caso de cambiar la polaridad: si ya leyó algo, no hace falta). */
  rescue?: boolean;
  /** Solo se hace si las pasadas anteriores de este recorte leyeron alguna cifra: en un recorte donde no hay nada que leer (una marca, un párrafo) no se gasta tiempo en otro tamaño. */
  needsSome?: boolean;
  /** Solo se hace si, con todo lo leído hasta ahora, no hay ni tres cifras: la foto entera es el último recurso, no un complemento. */
  fallback?: boolean;
};

/**
 * Las pasadas con que se lee cada recorte, por orden (la segunda solo si la primera no da una lectura completa y coherente, y las lecturas se juntan). Cada una ve la tabla a otro tamaño
 * y con otro realce, y se equivoca en otras cifras: juntarlas con la comprobación de la energía acierta bastante más que cualquiera sola. Medido con fotos de envases dibujadas
 * (docs/estimaciones.md → «Leer la tabla nutricional de una foto»): en grises mejor que en blanco y negro (el umbral adaptativo emborrona la letra grande), con mediana y realce.
 */
export const CROP_PASSES: readonly Pass[] = [
  { mode: 'block', binary: false, capHeight: 28, denoise: true, sharpen: { radius: 10, amount: 1.5 } },
  // Un recorte que mezcla una tabla clara y letras claras sobre fondo oscuro no tiene una polaridad buena para las dos: si no se leyó casi nada, se prueba la contraria.
  { mode: 'block', binary: false, capHeight: 28, denoise: true, sharpen: { radius: 10, amount: 1.5 }, polarity: 'flip', rescue: true },
  { mode: 'block', binary: false, capHeight: 38, denoise: true, needsSome: true },
];
/** Las pasadas con la foto entera cuando ningún bloque dio una lectura completa: lo mismo, más una con el análisis de página automático. */
export const WHOLE_PASSES: readonly Pass[] = [
  { mode: 'block', binary: false, capHeight: 28, maxSide: 1600, denoise: true, sharpen: { radius: 10, amount: 1.5 }, fallback: true },
  { mode: 'auto', binary: false, capHeight: 28, maxSide: 1600, denoise: true, fallback: true },
];

/**
 * Cada cuadrante de la foto cuando no se encontró la tabla (o el único «bloque» fue la foto entera): una pasada por cuadrante, solo si con todo lo leído aún no hay ni tres cifras. Un cuadrante
 * se lleva al tamaño de letra que lee el OCR midiendo SU texto: si la tabla es lo que más texto tiene en el cuadrante, su letra queda bien aunque en la foto entera mandara el título del
 * envase (medido con fotos de envases dibujadas: la tabla que el localizador no separaba pasó de 0 de 7 cifras a leerse).
 */
export const TILE_PASSES: readonly Pass[] = [{ mode: 'block', binary: false, capHeight: 28, denoise: true, sharpen: { radius: 10, amount: 1.5 }, fallback: true }];

/** Los cuatro cuadrantes de la foto, cada uno de un 62 % de ancho y alto (se solapan, para que una tabla en el centro no se parta entre dos). */
export function tileBoxes(width: number, height: number): Box[] {
  const w = Math.round(width * 0.62);
  const h = Math.round(height * 0.62);
  return [
    { x0: 0, y0: 0, x1: w, y1: h },
    { x0: width - w, y0: 0, x1: width, y1: h },
    { x0: 0, y0: height - h, x1: w, y1: height },
    { x0: width - w, y0: height - h, x1: width, y1: height },
  ];
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** La foto no se puede abrir (no es una imagen, está dañada o es demasiado grande para el móvil). */
export class PhotoDecodeError extends Error {
  constructor() {
    super('No se pudo abrir la foto.');
    this.name = 'PhotoDecodeError';
  }
}

/** La foto entera en un lienzo, reducida a lo sumo a {@link FULL_MAX_SIDE} de lado largo (con la orientación EXIF puesta: `createImageBitmap` la aplica). */
export async function decodePhoto(source: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new PhotoDecodeError();
  }
  const scale = Math.min(1, FULL_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = newCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('no 2d context');
  }
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

export interface PrepareOptions {
  /** En blanco y negro con umbral adaptativo (para luz desigual y reflejos). */
  binary: boolean;
  /** Enderezar el texto si la foto está torcida (de serie, sí). */
  deskew?: boolean;
  /** Alto (px) al que se lleva una mayúscula o una cifra (de serie {@link CAP_HEIGHT}). */
  capHeight?: number;
  /** Lado más largo (px) que puede tener la imagen que se lee, aunque la letra quede más pequeña (de serie {@link MAX_SIDE}). */
  maxSide?: number;
  /** Quitar la luz desigual (de serie, sí). */
  flatten?: boolean;
  /** Qué color de tinta se supone: `auto` (la clase minoritaria del recorte) o `flip` (lo contrario, para un recorte que mezcla una tabla clara y letras claras sobre fondo oscuro). */
  polarity?: 'auto' | 'flip';
  /** Realzar los bordes de las letras: radio y cantidad (de serie, no). */
  sharpen?: { radius: number; amount: number };
  /** Quitar el ruido de grano con una mediana 3 × 3 (de serie, no). */
  denoise?: boolean;
}

/** Gira un lienzo `degrees` (en el sentido de las agujas del reloj) sobre fondo blanco; el lienzo nuevo es lo bastante grande para que no se corte nada. */
export function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const width = Math.max(1, Math.ceil(source.width * cos + source.height * sin));
  const height = Math.max(1, Math.ceil(source.width * sin + source.height * cos));
  const canvas = newCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(rad);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/**
 * Un recorte (`box`, en píxeles de `full`) listo para el OCR: en grises, con el contraste estirado, las letras oscuras sobre claro, sin luz desigual ni grano, **llevado al tamaño de letra
 * que el OCR lee mejor** (se mide el alto de las letras del propio recorte, así no importa a qué distancia se hizo la foto ni cuánto sitio sobra alrededor de la tabla), enderezado si la
 * foto está torcida y sin las rayas de la tabla; con `binary`, además, en blanco y negro adaptativo.
 */
export function prepareCrop(full: HTMLCanvasElement, box: Box, options: PrepareOptions): HTMLCanvasElement {
  const sw = Math.max(1, Math.round(box.x1 - box.x0));
  const sh = Math.max(1, Math.round(box.y1 - box.y0));
  // Primero a tamaño real (o algo menos si es enorme): la luz, el grano y la medida de la letra se hacen aquí, que es lo más barato.
  const native = Math.min(1, 2200 / Math.max(sw, sh));
  const nw = Math.max(1, Math.round(sw * native));
  const nh = Math.max(1, Math.round(sh * native));
  let canvas = newCanvas(nw, nh);
  let context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, nw, nh);
  context.drawImage(full, Math.round(box.x0), Math.round(box.y0), sw, sh, 0, 0, nw, nh);
  let image = context.getImageData(0, 0, nw, nh);
  if (!stretchContrast(image.data)) return canvas;
  const light = inkIsLight(image.data, nw, nh);
  if (options.polarity === 'flip' ? !light : light) invertGrays(image.data);
  if (options.denoise === true) medianFilter(image.data, nw, nh);
  if (options.flatten !== false) {
    flattenBackground(image.data, nw, nh);
    stretchContrast(image.data);
  }
  context.putImageData(image, 0, 0);

  // El tamaño: que una mayúscula mida `capHeight` px. Con poca letra que medir, se lleva el recorte a un ancho normal para una tabla.
  const glyph = estimateGlyphHeight(image.data, nw, nh);
  const wanted = options.capHeight ?? CAP_HEIGHT;
  const wantedScale = Math.min(MAX_UPSCALE, Math.max(MIN_SCALE, glyph !== null ? wanted / glyph : Math.min(MAX_UPSCALE, (FALLBACK_WIDTH * (wanted / CAP_HEIGHT)) / nw)));
  const scale = Math.min(wantedScale, (options.maxSide ?? MAX_SIDE) / Math.max(nw, nh));
  if (Math.abs(scale - 1) > 0.06) {
    const width = Math.max(1, Math.round(nw * scale));
    const height = Math.max(1, Math.round(nh * scale));
    const scaled = newCanvas(width, height);
    const scaledContext = scaled.getContext('2d', { willReadFrequently: true });
    if (!scaledContext) throw new Error('no 2d context');
    scaledContext.imageSmoothingEnabled = true;
    scaledContext.imageSmoothingQuality = 'high';
    scaledContext.drawImage(canvas, 0, 0, nw, nh, 0, 0, width, height);
    canvas = scaled;
    context = scaledContext;
    image = context.getImageData(0, 0, width, height);
  }
  if (options.sharpen) sharpen(image.data, canvas.width, canvas.height, options.sharpen.radius, options.sharpen.amount);
  if (options.deskew !== false) {
    const degrees = estimateSkewDegrees(image.data, canvas.width, canvas.height);
    if (Math.abs(degrees) >= 0.4) {
      context.putImageData(image, 0, 0);
      canvas = rotateCanvas(canvas, degrees);
      context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('no 2d context');
      image = context.getImageData(0, 0, canvas.width, canvas.height);
    }
  }
  removeRuledLines(image.data, canvas.width, canvas.height);
  if (options.binary) binarizeAdaptive(image.data, canvas.width, canvas.height);
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Los candidatos a ser la tabla, en píxeles de la foto grande: los bloques de texto que halla `findTextBlocks`, ampliados un poco (la tabla casi nunca queda justa) y, el último, la foto entera. */
export function candidateBoxes(full: HTMLCanvasElement): Box[] {
  const side = Math.max(full.width, full.height);
  const scale = Math.min(1, LOCATE_SIDE / side);
  const work = newCanvas(Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
  const context = work.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(full, 0, 0, work.width, work.height);
  const image = context.getImageData(0, 0, work.width, work.height);
  const blocks = findTextBlocks(grayOf(image.data), work.width, work.height).slice(0, MAX_CANDIDATES);
  return blocks.map((block) => {
    const box = expandBox(block, 0.08, 8, work.width, work.height);
    return { x0: box.x0 / scale, y0: box.y0 / scale, x1: Math.min(full.width, box.x1 / scale), y1: Math.min(full.height, box.y1 / scale) };
  });
}

export interface PhotoReading {
  /** El texto de la pasada que mejor leyó. */
  text: string;
  /** El texto de cada pasada, por orden (para medir y depurar). */
  texts: string[];
  /** Lo que se saca juntando todas las pasadas. */
  reading: LabelReading;
  /** Cuántas veces se llamó al OCR (para medir). */
  passes: number;
}

/** Lo que se va a leer de una foto: la foto grande y, por orden, los recortes con las pasadas de cada uno. */
export interface PhotoPlan {
  full: HTMLCanvasElement;
  steps: Array<{ box: Box; passes: readonly Pass[] }>;
}

/**
 * Abre la foto y decide qué leer: los bloques de texto candidatos y, al final, la foto entera. No usa el OCR: se puede hacer mientras el motor aún está cargando.
 */
export async function planPhoto(source: Blob): Promise<PhotoPlan> {
  const full = await decodePhoto(source);
  const boxes = candidateBoxes(full);
  const whole: Box = { x0: 0, y0: 0, x1: full.width, y1: full.height };
  // La foto entera es el último recurso; si un bloque ya la ocupa casi toda, no se repite.
  const coversAll = boxes.some((box) => (box.x1 - box.x0) * (box.y1 - box.y0) > 0.85 * full.width * full.height);
  const everything = coversAll ? [] : [{ box: whole, passes: WHOLE_PASSES }];
  // Último recurso: por cuadrantes (solo se hacen si lo anterior no dio ni tres cifras).
  const tiles = tileBoxes(full.width, full.height).map((box) => ({ box, passes: TILE_PASSES }));
  return { full, steps: [...boxes.map((box) => ({ box, passes: CROP_PASSES })), ...everything, ...tiles] };
}

/** Cuántas lecturas del OCR hay como mucho en este plan (para el avance). */
export const passCount = (plan: PhotoPlan): number => plan.steps.reduce((sum, step) => sum + step.passes.length, 0);

/**
 * Lee un plan con el motor `engine`: cada recorte con sus pasadas, juntando lo que sale y parando en cuanto la lectura es completa y coherente. `hooks.progress` recibe de 0 a 1 y
 * `hooks.aborted` la corta.
 */
export async function readPlan(engine: OcrEngine, plan: PhotoPlan, hooks: ReadHooks = {}): Promise<PhotoReading> {
  const total = passCount(plan);
  const texts: string[] = [];
  const readings: LabelReading[] = [];
  /** Lo que sale juntando las pasadas de un conjunto de textos: se juntan las lecturas posibles de CADA cifra (`readLabelTexts`), no solo la lectura entera mejor. */
  const joined = (list: readonly string[]): LabelReading => readLabelTexts(list, { ocr: true });
  let done = 0;
  outer: for (const step of plan.steps) {
    const own: string[] = [];
    for (const pass of step.passes) {
      if (hooks.aborted?.() === true) break outer;
      if (pass.rescue === true && own.length > 0 && joined(own).found >= 3) continue;
      if (pass.needsSome === true && (own.length === 0 || joined(own).found === 0)) continue;
      if (pass.fallback === true && texts.length > 0 && joined(texts).found >= 3) continue;
      if (hooks.deadline !== undefined && done > 0 && Date.now() > hooks.deadline) break outer;
      const canvas = prepareCrop(plan.full, step.box, pass);
      const index = done;
      const page = await engine.recognize(canvas, pass.mode, { onProgress: (fraction) => hooks.progress?.(Math.min(1, (index + Math.max(0, Math.min(1, fraction))) / total)) });
      done++;
      texts.push(page.text);
      own.push(page.text);
      readings.push(readLabelText(page.text, { ocr: true }));
      hooks.progress?.(Math.min(1, done / total));
      // Con una lectura completa y coherente (juntando lo que dieron las pasadas hechas) no hace falta más.
      if (isConfidentReading(joined(texts))) break outer;
    }
  }
  let best = 0;
  readings.forEach((reading, i) => {
    if (readingScore(reading) > readingScore(readings[best] as LabelReading)) best = i;
  });
  hooks.progress?.(1);
  return { text: texts[best] ?? '', texts, reading: texts.length === 0 ? readLabelText('', { ocr: true }) : joined(texts), passes: done };
}

/** Abre la foto y la lee (planPhoto + readPlan). */
export async function readLabelPhoto(engine: OcrEngine, source: Blob, hooks: ReadHooks = {}): Promise<PhotoReading> {
  return readPlan(engine, await planPhoto(source), hooks);
}
