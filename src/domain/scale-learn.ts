import { isPlausibleWeight, isPrintable, numbersIn, readFloat32, readUint, type Divisor, type ScaleDecoder, type ScaleFrame } from './scale';

// Aprender dónde va el peso en las tramas de una báscula cuyo protocolo no se conoce.
//
// La persona pone algo en la báscula y escribe lo que marca la pantalla (en gramos). Con las tramas que llegaron justo antes se busca QUÉ campo —qué bytes, en qué orden
// y con qué divisor— vale exactamente eso, y lo mismo con otra pesada y con la báscula vacía (que debe dar 0). Un campo que cuadra en todas las observaciones y cambia con
// el peso es, casi seguro, el peso. Solo se prueban formas habituales: enteros de 1 a 4 bytes (big o little endian) partidos por 1, 10, 100 o 1000, números de coma flotante
// de 4 bytes y texto con el número escrito. Si el protocolo es otra cosa (la báscula pide un «saludo» antes de mandar nada, o cifra los datos), no sale ningún candidato y se
// dice: docs/bascula.md explica qué hacer entonces.

/** Lo que marcaba la pantalla de la báscula en un momento. */
export interface ScaleLabel {
  /** El número escrito por la persona, en gramos. */
  value: number;
  /** Cuándo (ms): se miran las tramas que llegaron justo antes. */
  atMs: number;
}

export interface LearnInput {
  frames: readonly ScaleFrame[];
  /** Lo que marcaba la pantalla con algo encima (una o dos pesadas distintas son mejor que una). */
  labels: readonly ScaleLabel[];
  /** Cuándo estaba la báscula vacía y marcando 0 (opcional: ayuda a descartar campos que no son el peso). */
  restAtMs?: number | null;
}

export interface LearnCandidate {
  decoder: ScaleDecoder;
  /** Cuántas observaciones cuadran (todas las que había datos). */
  matched: number;
  /** Cuántos valores distintos toma el campo en lo recibido: uno que no cambia no puede ser el peso. */
  distinct: number;
  rank: number;
}

export interface SourceSummary {
  source: string;
  frames: number;
  /** Longitudes distintas de trama vistas en esa fuente. */
  lengths: number[];
}

export interface LearnResult {
  candidates: LearnCandidate[];
  sources: SourceSummary[];
  /** Por qué no hay candidatos: no llegó ninguna trama / no cuadra ningún campo. `null` si los hay. */
  problem: 'no-frames' | 'no-match' | null;
}

/** La pantalla marca enteros: un campo cuadra si está a menos de medio gramo de lo escrito (con un margen para el redondeo de un divisor). */
const TOLERANCE_G = 0.51;
/**
 * Cuántas tramas anteriores a cada observación se miran, hasta cuánto tiempo atrás, y qué parte de ellas debe cuadrar (las primeras pueden ser de cuando se estabilizaba).
 * Si en esa ventana no llegó ninguna (hay básculas que solo mandan una trama cuando cambia el peso) vale la última que mandó, de hasta `HOLD_MS` antes: la báscula sigue
 * marcando lo último que dijo.
 */
const WINDOW_FRAMES = 6;
const WINDOW_MS = 2_000;
const HOLD_MS = 60_000;
const MIN_RATIO = 0.7;
/** Qué parte de lo que da el campo en toda la fuente debe ser un peso creíble. */
const MIN_PLAUSIBLE_RATIO = 0.9;
const MAX_FRAMES = 4_000;
const MAX_CANDIDATES = 20;
const MAX_ASCII_NUMBERS = 4;

type Field = Pick<ScaleDecoder, 'kind' | 'offset' | 'width' | 'little' | 'divisor' | 'index'>;

const DIVISORS: readonly Divisor[] = [1, 10, 100, 1000];

/** Todos los campos que se prueban en una trama de esa longitud. */
function fieldsFor(length: number, printable: boolean): Field[] {
  const out: Field[] = [];
  for (const width of [1, 2, 3, 4] as const) {
    for (let offset = 0; offset + width <= length; offset++) {
      for (const little of width === 1 ? [false] : [false, true]) {
        for (const divisor of DIVISORS) out.push({ kind: 'uint', offset, width, little, divisor, index: 0 });
      }
    }
  }
  for (let offset = 0; offset + 4 <= length; offset++) {
    for (const little of [false, true]) out.push({ kind: 'float32', offset, width: 4, little, divisor: 1, index: 0 });
  }
  if (printable) for (let index = 0; index < MAX_ASCII_NUMBERS; index++) out.push({ kind: 'ascii', offset: 0, width: 1, little: false, divisor: 1, index });
  return out;
}

function valueAt(field: Field, bytes: Uint8Array, text: number[] | null): number | null {
  if (field.kind === 'uint') {
    const raw = readUint(bytes, field.offset, field.width, field.little);
    return raw === null ? null : raw / field.divisor;
  }
  if (field.kind === 'float32') return readFloat32(bytes, field.offset, field.little);
  return text?.[field.index] ?? null;
}

const close = (value: number | null, expected: number): boolean => value !== null && Math.abs(value - expected) <= TOLERANCE_G;

/** Las últimas tramas del grupo hasta `atMs` (dentro de la ventana), o la última que mandó si en la ventana no hubo ninguna. */
function recent(frames: readonly ScaleFrame[], atMs: number): ScaleFrame[] {
  const inWindow = frames.filter((f) => f.atMs <= atMs && f.atMs >= atMs - WINDOW_MS).slice(-WINDOW_FRAMES);
  if (inWindow.length > 0) return inWindow;
  const last = frames.filter((f) => f.atMs <= atMs).pop();
  return last && atMs - last.atMs <= HOLD_MS ? [last] : [];
}

// Penalizaciones al ordenar candidatos que cuadran por igual: lo más corriente primero (divisor 1, dos bytes) y lo raro después.
const DIVISOR_PENALTY: Record<number, number> = { 1: 0, 10: 30, 100: 60, 1000: 90 };
const WIDTH_PENALTY: Record<number, number> = { 2: 0, 3: 8, 4: 20, 1: 40 };

function rankOf(field: Field, matched: number, distinct: number): number {
  const shape = field.kind === 'uint' ? DIVISOR_PENALTY[field.divisor]! + WIDTH_PENALTY[field.width]! : field.kind === 'float32' ? 50 : 25;
  // Un campo que no cambia nunca (una cabecera, un contador fijo) solo cuadraría por casualidad con un número escrito: va el último.
  const constant = distinct <= 1 ? -500 : 0;
  return matched * 1000 + Math.min(distinct, 40) * 4 - shape + constant;
}

function guardOf(field: Field, frames: readonly ScaleFrame[]): Array<[number, number]> {
  // Los primeros bytes (la cabecera) que no cambian en las tramas que cuadran, y que están antes del campo del peso.
  if (field.kind === 'ascii' || frames.length === 0) return [];
  const guard: Array<[number, number]> = [];
  for (let position = 0; position < Math.min(3, field.offset); position++) {
    const first = frames[0]?.bytes[position];
    if (first !== undefined && frames.every((f) => f.bytes[position] === first)) guard.push([position, first]);
  }
  return guard;
}

/**
 * Busca los campos de las tramas que valen lo que marcaba la pantalla en cada observación, y devuelve los candidatos del mejor al peor. Con una sola pesada puede haber
 * varios que cuadran (un valor menor de 256 cabe en un byte o en dos): otra pesada distinta los separa.
 */
export function learnDecoder(input: LearnInput): LearnResult {
  const frames = [...input.frames].sort((a, b) => a.atMs - b.atMs).slice(-MAX_FRAMES);
  const sourceCount = new Map<string, { frames: number; lengths: Set<number> }>();
  const groups = new Map<string, ScaleFrame[]>();
  for (const frame of frames) {
    const summary = sourceCount.get(frame.source) ?? { frames: 0, lengths: new Set<number>() };
    summary.frames++;
    summary.lengths.add(frame.bytes.length);
    sourceCount.set(frame.source, summary);
    const key = `${frame.source}#${frame.bytes.length}`;
    const group = groups.get(key);
    if (group) group.push(frame);
    else groups.set(key, [frame]);
  }
  const sources = [...sourceCount.entries()].map(([source, s]) => ({ source, frames: s.frames, lengths: [...s.lengths].sort((a, b) => a - b) }));
  if (frames.length === 0) return { candidates: [], sources, problem: 'no-frames' };

  const targets: ScaleLabel[] = input.labels.filter((l) => Number.isFinite(l.value) && l.value > 0);
  const rest = input.restAtMs ?? null;
  const observations: ScaleLabel[] = [...targets, ...(rest !== null ? [{ value: 0, atMs: rest }] : [])];
  if (targets.length === 0) return { candidates: [], sources, problem: 'no-match' };

  const candidates: LearnCandidate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const windows = observations.map((o) => ({ ...o, win: recent(group, o.atMs) }));
    // Cada pesada tiene que tener tramas de este grupo; la de la báscula vacía puede no tenerlas (hay básculas que callan sin peso).
    if (windows.some((w, i) => i < targets.length && w.win.length === 0)) continue;
    const usable = windows.filter((w) => w.win.length > 0);
    const printable = group.every((f) => isPrintable(f.bytes));
    const texts = printable ? group.map((f) => numbersIn(String.fromCharCode(...f.bytes)).slice(0, MAX_ASCII_NUMBERS)) : null;
    const textOf = new Map<ScaleFrame, number[]>();
    if (texts) group.forEach((f, i) => textOf.set(f, texts[i] ?? []));

    for (const field of fieldsFor(first.bytes.length, printable)) {
      const read = (f: ScaleFrame): number | null => valueAt(field, f.bytes, textOf.get(f) ?? null);
      let ok = true;
      const matchedFrames: ScaleFrame[] = [];
      for (const w of usable) {
        const last = w.win[w.win.length - 1];
        const hits = w.win.filter((f) => close(read(f), w.value));
        if (!last || !close(read(last), w.value) || hits.length / w.win.length < MIN_RATIO) {
          ok = false;
          break;
        }
        matchedFrames.push(...hits);
      }
      if (!ok) continue;
      const guard = guardOf(field, matchedFrames);
      const carrying = group.filter((f) => guard.every(([position, value]) => f.bytes[position] === value));
      const values = carrying.map(read).filter((v): v is number => v !== null);
      if (values.length === 0) continue;
      const plausible = values.filter(isPlausibleWeight);
      if (plausible.length / values.length < MIN_PLAUSIBLE_RATIO) continue;
      const distinct = new Set(plausible.map((v) => Math.round(v * 10))).size;
      // Con dos o más observaciones distintas, un campo constante no puede cuadrar (lo hemos comprobado arriba): no hace falta más.
      candidates.push({
        decoder: { v: 1, source: first.source, length: first.bytes.length, kind: field.kind, offset: field.offset, width: field.width, little: field.little, divisor: field.divisor, guard, index: field.index },
        matched: usable.length,
        distinct,
        rank: rankOf(field, usable.length, distinct),
      });
    }
  }
  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates.slice(0, MAX_CANDIDATES);
  return { candidates: best, sources, problem: best.length === 0 ? 'no-match' : null };
}

/** Cómo se lee un decodificador, en una frase para el informe («FFE1 · tramas de 8 bytes · bytes 3–4 (big-endian) ÷ 1»). */
export function describeDecoder(decoder: ScaleDecoder): string {
  const where = `${decoder.source}${decoder.length !== null ? ` · tramas de ${decoder.length} bytes` : ''}`;
  if (decoder.kind === 'ascii') return `${where} · el número n.º ${decoder.index + 1} del texto`;
  if (decoder.kind === 'float32') return `${where} · byte ${decoder.offset} (decimal de 4 bytes, ${decoder.little ? 'little' : 'big'}-endian)`;
  const span = decoder.width === 1 ? `byte ${decoder.offset}` : `bytes ${decoder.offset}–${decoder.offset + decoder.width - 1} (${decoder.little ? 'little' : 'big'}-endian)`;
  return `${where} · ${span}${decoder.divisor !== 1 ? ` ÷ ${decoder.divisor}` : ''}`;
}
