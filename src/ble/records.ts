import { u16, u24, u32, u8, type Bytes } from './bytes';
import { HISTORY, type HistoryType } from './constants';
import { ringSecondsToMs } from './time';

// Decodificadores de los registros del historial. Trabajan sobre el buffer COMPLETO reensamblado de
// una transferencia, nunca sobre una trama suelta: el anillo concatena registros de tamaño fijo y
// luego corta el flujo donde caiga el límite de trama, así que un registro cruza dos tramas con
// frecuencia. Decodificar por trama pierde esos registros y desalinea todo lo que sigue.
//
// Aquí solo se descartan los "rellenos" del anillo (un cero en un campo que el firmware nunca deja en
// blanco cuando hay lectura). Los rangos de plausibilidad viven en un único sitio: `sanitize.ts`.

/** Tramo de actividad. Son cubos acumulables (cada uno cubre inicio→fin), no un contador corrido. */
export interface SportRecord {
  startMs: number;
  endMs: number;
  steps: number;
  /** Distancia que calcula el propio anillo, en metros (unidad sin verificar). Solo informativa. */
  distanceM: number;
  /** Calorías según el anillo, en unidades sin verificar. Solo informativas. */
  calories: number;
}

export interface HeartRecord {
  tsMs: number;
  bpm: number;
}

export interface Spo2Record {
  tsMs: number;
  percent: number;
}

/** Registro periódico de constantes. `steps` es un CONTADOR ACUMULADO del día, no un incremento. */
export interface AllRecord {
  tsMs: number;
  steps: number;
  bpm: number;
  spo2: number;
  respiratoryRate: number;
}

export type SleepStage = 'deep' | 'light' | 'rem' | 'awake' | 'nap';

export interface SleepSegment {
  stage: SleepStage;
  startMs: number;
  durationSec: number;
}

export interface SleepSession {
  startMs: number;
  endMs: number;
  segments: SleepSegment[];
  /** Totales por fase que el propio anillo escribe en la cabecera (segundos). Sirven para contrastar la suma de tramos. */
  headerTotalsSec?: { rem: number; deep: number; light: number };
}

export interface HistoryRecords {
  sport: SportRecord[];
  sleep: SleepSession[];
  heart: HeartRecord[];
  all: AllRecord[];
  spo2: Spo2Record[];
}

export function emptyHistory(): HistoryRecords {
  return { sport: [], sleep: [], heart: [], all: [], spo2: [] };
}

/** Corta el buffer en registros de tamaño fijo; descarta una cola incompleta (igual que el bucle del SDK). */
function slice(buffer: Bytes, size: number): Bytes[] {
  const out: Bytes[] = [];
  for (let i = 0; i + size <= buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
}

/** `[inicio:u32][fin:u32][pasos:u16@8][distancia:u16@10][calorías:u16@12]` */
export function decodeSport(buffer: Bytes): SportRecord[] {
  const out: SportRecord[] = [];
  for (const r of slice(buffer, 14)) {
    const steps = u16(r, 8);
    const distanceM = u16(r, 10);
    if (steps === 0 && distanceM === 0) continue; // tramo vacío
    const startMs = ringSecondsToMs(u32(r, 0));
    out.push({
      startMs,
      // La duración es la que dice el reloj del anillo (que no salta con el cambio de hora): convertir cada extremo por separado
      // daba tramos de otra duración (o del revés) si caían a ambos lados del cambio.
      endMs: startMs + (u32(r, 4) - u32(r, 0)) * 1000,
      steps,
      distanceM,
      calories: u16(r, 12),
    });
  }
  return out;
}

/** `[ts:u32][modo@4][fc@5]`; `fc == 0` es una muestra sin anillo puesto. */
export function decodeHeart(buffer: Bytes): HeartRecord[] {
  const out: HeartRecord[] = [];
  for (const r of slice(buffer, 6)) {
    const bpm = u8(r, 5);
    if (bpm > 0) out.push({ tsMs: ringSecondsToMs(u32(r, 0)), bpm });
  }
  return out;
}

/** `[ts:u32][tipo@4][valor@5]`; el tipo distingue muestreo automático de lectura manual (se tratan igual). */
export function decodeSpo2(buffer: Bytes): Spo2Record[] {
  const out: Spo2Record[] = [];
  for (const r of slice(buffer, 6)) {
    const percent = u8(r, 5);
    if (percent > 0) out.push({ tsMs: ringSecondsToMs(u32(r, 0)), percent });
  }
  return out;
}

/**
 * `[ts:u32][pasos:u16@4][fc@6][sys@7][dia@8][spo2@9][resp@10][hrv@11]…` (20 bytes).
 * La presión, la HRV y la temperatura se ignoran: ni el R99 las mide de forma útil ni la app las usa.
 */
export function decodeAll(buffer: Bytes): AllRecord[] {
  const out: AllRecord[] = [];
  for (const r of slice(buffer, 20)) {
    out.push({
      tsMs: ringSecondsToMs(u32(r, 0)),
      steps: u16(r, 4),
      bpm: u8(r, 6),
      spo2: u8(r, 9),
      respiratoryRate: u8(r, 10),
    });
  }
  return out;
}

const SLEEP_HEADER = 20;
const SLEEP_SEGMENT = 8;
/** Cada sesión de sueño empieza por esta firma (el SDK del fabricante la lee y la descarta). */
const SLEEP_SIGNATURE = [0xaf, 0xfa] as const;

const isSleepSignature = (buffer: Bytes, at: number): boolean =>
  at + 1 < buffer.length && buffer[at] === SLEEP_SIGNATURE[0] && buffer[at + 1] === SLEEP_SIGNATURE[1];

function findSleepSignature(buffer: Bytes, from: number): number | null {
  for (let i = from; i + 1 < buffer.length; i++) if (isSleepSignature(buffer, i)) return i;
  return null;
}

/** `tag & 0x0F`: 1 profundo, 2 ligero, 3 REM, 4 despierto, 5 siesta. El nibble alto son banderas. */
function sleepStage(tag: number): SleepStage | null {
  switch (tag & 0x0f) {
    case 1:
      return 'deep';
    case 2:
      return 'light';
    case 3:
      return 'rem';
    case 4:
      return 'awake';
    case 5:
      return 'nap';
    default:
      return null;
  }
}

/** Tope de un tramo: ninguno real dura más de un día, y un campo de 24 bits a unos son 194 días. */
const MAX_SEGMENT_SEC = 24 * 3600;
/**
 * Una sesión sin ningún tramo legible solo se conserva si su cabecera es de fiar: dura al menos esto y empieza en este siglo (unos
 * bytes cualesquiera no la cumplen por casualidad). Sirve para el día en que un anillo escriba los tramos de otra forma: se pierden las
 * fases pero no la noche.
 */
const MIN_HEADER_ONLY_SEC = 30 * 60;
const HEADER_ONLY_FROM_MS = Date.UTC(2020, 0, 1);

/**
 * El buffer contiene SESIONES consecutivas. Cada una: cabecera de 20 bytes
 * `[flags:2][longitudRegistro:u16@2][inicio:u32@4][fin:u32@8][totales@12…19]` seguida de tramos de 8 bytes
 * `[etiqueta:1][inicioTramo:u32][duración:u24]`. `longitudRegistro` incluye la cabecera.
 *
 * - La duración es de 3 bytes: con 2 se truncaría cualquier tramo de más de 18 h 12 min.
 * - Una etiqueta desconocida se SALTA, nunca termina la lectura (una siesta no debe truncar la noche).
 * - Se descartan los tramos repetidos por hora de inicio dentro de la sesión, como hace el SDK; pero uno de duración
 *   0 no cuenta como tal (el anillo los emite con la misma hora que uno real y no deben taparlo).
 * - Se limita a lo realmente recibido: el bucle del SDK no comprueba el final del buffer.
 * - Si el buffer trae la firma `af fa` y el cursor no apunta a una (una longitud declarada que no cuadra deja el cursor a
 *   mitad de un registro), se resincroniza buscando la siguiente: así una sesión rara no estropea las demás de la noche.
 *   Si no trae NINGUNA (la firma solo consta en una captura de otro modelo, no de un R99), no se puede resincronizar con
 *   ella y se decodifica por longitud, en secuencia: mejor eso que descartar toda la noche.
 */
export function decodeSleep(buffer: Bytes, notes?: string[]): SleepSession[] {
  const sessions: SleepSession[] = [];
  const skipped = new Map<number, { count: number; sec: number }>();
  const signed = findSleepSignature(buffer, 0) !== null;
  if (!signed && buffer.length >= SLEEP_HEADER) notes?.push('sueño: el registro no trae la firma af fa de sesión: se ha decodificado por longitud');
  let cursor = 0;
  let resyncedBytes = 0;
  while (cursor + SLEEP_HEADER <= buffer.length) {
    if (signed && !isSleepSignature(buffer, cursor)) {
      const next = findSleepSignature(buffer, cursor + 1);
      if (next === null) {
        resyncedBytes += buffer.length - cursor;
        break;
      }
      resyncedBytes += next - cursor;
      cursor = next;
      continue;
    }
    const recordLength = u16(buffer, cursor + 2);
    const segmentsStart = cursor + SLEEP_HEADER;
    const declared = Math.floor(Math.max(0, recordLength - SLEEP_HEADER) / SLEEP_SEGMENT);
    const available = Math.floor((buffer.length - segmentsStart) / SLEEP_SEGMENT);
    const count = Math.min(declared, available);

    const rawSegments: Array<{ stage: SleepStage; startSec: number; durationSec: number }> = [];
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const at = segmentsStart + i * SLEEP_SEGMENT;
      const tag = u8(buffer, at);
      const stage = sleepStage(tag);
      const startSec = u32(buffer, at + 1);
      const durationSec = Math.min(u24(buffer, at + 5), MAX_SEGMENT_SEC);
      if (stage === null) {
        // Se omite, pero se anota: así el diagnóstico de la primera prueba real dice si hay fases que no entendemos.
        const entry = skipped.get(tag) ?? { count: 0, sec: 0 };
        entry.count++;
        entry.sec += durationSec;
        skipped.set(tag, entry);
        continue;
      }
      // Un tramo de duración 0 no cuenta ni ocupa la hora de inicio: el anillo los emite compartiendo hora con
      // uno real (incidencia #63 de PulseLoop) y, si «ganara» al real, la noche perdería ese tramo.
      if (durationSec <= 0) continue;
      if (seen.has(startSec)) continue;
      seen.add(startSec);
      rawSegments.push({ stage, startSec, durationSec });
    }

    const rawStart = u32(buffer, cursor + 4);
    const rawEnd = u32(buffer, cursor + 8);
    // Si la cabecera es incoherente (inicio 0, fin ≤ inicio o más de un día) manda lo que dicen los tramos.
    const headerOk = rawStart > 0 && rawEnd > rawStart && rawEnd - rawStart <= MAX_SEGMENT_SEC;
    // Los totales por fase de la cabecera (todos a 0, o ninguno) dicen que el anillo no vio sueño en ella: no se inventa una noche.
    const headerTotal = u16(buffer, cursor + 14) + u16(buffer, cursor + 16) + u16(buffer, cursor + 18);
    const headerOnly =
      rawSegments.length === 0 && headerOk && rawEnd - rawStart >= MIN_HEADER_ONLY_SEC && ringSecondsToMs(rawStart) >= HEADER_ONLY_FROM_MS && headerTotal > 0;
    if (rawSegments.length > 0 || headerOnly) {
      if (headerOnly) notes?.push('sueño: una sesión sin tramos legibles: solo se conserva su duración (la que dice su cabecera)');
      // TODOS los instantes de la sesión se miden desde su inicio con los segundos del reloj del anillo, que no salta con el
      // cambio de hora: la noche que lo cruza dura lo que duró (8 h) y no 7 u 9 según cómo se convierta cada extremo por separado
      // (con 7 h de tramo y 8 h de fases, `sanitize` descartaba la noche entera, y el anillo la reenvía en cada sincronización).
      const baseSec = headerOk ? rawStart : (rawSegments[0]?.startSec ?? rawStart);
      const baseMs = ringSecondsToMs(baseSec);
      const toMs = (sec: number): number => baseMs + (sec - baseSec) * 1000;
      const segments: SleepSegment[] = rawSegments.map((g) => ({ stage: g.stage, startMs: toMs(g.startSec), durationSec: g.durationSec }));
      const first = segments[0];
      const last = segments[segments.length - 1];
      const headerStart = toMs(rawStart);
      const headerEnd = toMs(rawEnd);
      const spanStart = first ? first.startMs : headerStart;
      const spanEnd = last ? last.startMs + last.durationSec * 1000 : headerEnd;
      const session: SleepSession = {
        startMs: headerOk ? Math.min(headerStart, spanStart) : spanStart,
        endMs: headerOk ? Math.max(headerEnd, spanEnd) : spanEnd,
        segments,
      };
      const rem = u16(buffer, cursor + 14);
      const deep = u16(buffer, cursor + 16);
      const light = u16(buffer, cursor + 18);
      if (rem !== 0xffff && deep !== 0xffff && light !== 0xffff) {
        session.headerTotalsSec = { rem, deep, light };
      }
      sessions.push(session);
    }
    // Avanza hasta el final de los tramos consumidos; con una longitud absurda se mueve al menos la cabecera.
    cursor = segmentsStart + count * SLEEP_SEGMENT;
  }
  for (const [tag, { count, sec }] of skipped) {
    notes?.push(`sueño: ${count} tramo(s) con etiqueta desconocida 0x${tag.toString(16).padStart(2, '0')} (${Math.round(sec / 60)} min) omitidos`);
  }
  if (resyncedBytes > 0) notes?.push(`sueño: ${resyncedBytes} byte(s) fuera de una sesión omitidos al resincronizar con la firma af fa`);
  return sessions;
}

/** Añade todos los elementos sin pasarlos como argumentos: con decenas de miles, `push(...lista)` desborda la pila. */
function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** Qué dio una transferencia al decodificarla (para el diagnóstico). */
export interface DecodeSummary {
  /** Registros obtenidos (sesiones, en el sueño). */
  records: number;
  /** Cosas que el decodificador omitió o no entendió. */
  notes: string[];
}

/** Decodifica una transferencia completa y la vuelca en el lote que le corresponde. */
export function decodeInto(type: HistoryType, buffer: Bytes, into: HistoryRecords): DecodeSummary {
  const notes: string[] = [];
  let records = 0;
  switch (type.id) {
    case HISTORY.sport.id: {
      const decoded = decodeSport(buffer);
      pushAll(into.sport, decoded);
      records = decoded.length;
      break;
    }
    case HISTORY.sleep.id: {
      const decoded = decodeSleep(buffer, notes);
      pushAll(into.sleep, decoded);
      records = decoded.length;
      break;
    }
    case HISTORY.heart.id: {
      const decoded = decodeHeart(buffer);
      pushAll(into.heart, decoded);
      records = decoded.length;
      break;
    }
    case HISTORY.all.id: {
      const decoded = decodeAll(buffer);
      pushAll(into.all, decoded);
      records = decoded.length;
      break;
    }
    case HISTORY.spo2.id: {
      const decoded = decodeSpo2(buffer);
      pushAll(into.spo2, decoded);
      records = decoded.length;
      break;
    }
    default:
      break; // tipos sin decodificador (p. ej. presión arterial): se confirman y se descartan
  }
  return { records, notes };
}
