import { YCBT_SERVICE } from '../ble/constants';
import type { LiveEvent } from '../ble/session';
import type { ScanEntry } from '../ble/transport';

// Funciones puras de la prueba guiada: qué dispositivo es el anillo, cómo se resumen los tiempos y las lecturas en directo.
// Están aparte del ejecutor para poder probarlas con datos inventados.

/** El identificador de un dispositivo, abreviado: en el informe no van direcciones Bluetooth completas. */
export const maskId = (id: string): string => (id.length <= 5 ? id : `…${id.slice(-5)}`);

/** Código de empresa de Yucheng (0x7810) tal y como lo da `ScanEntry.manufacturer`: 4 cifras hexadecimales. */
const YUCHENG_COMPANY = '7810';

/**
 * Cuánto se parece un dispositivo al anillo: el nombre «R99…» es lo más fiable; después, que anuncie el servicio de Smart
 * Health (YCBT); lo más débil son los datos de fabricante de Yucheng. 0 = no lo parece.
 */
export function ringScore(entry: ScanEntry): number {
  let score = 0;
  if (entry.name !== null && /^r99/i.test(entry.name.trim())) score += 4;
  if (entry.services.some((uuid) => uuid.toLowerCase() === YCBT_SERVICE)) score += 2;
  if (YUCHENG_COMPANY in entry.manufacturer) score += 1;
  return score;
}

/** El dispositivo que más se parece al anillo (el de mejor señal si hay varios), o `null` si ninguno lo parece. */
export function pickRing(entries: readonly ScanEntry[]): ScanEntry | null {
  let best: ScanEntry | null = null;
  for (const entry of entries) {
    const score = ringScore(entry);
    if (score === 0) continue;
    if (best === null || score > ringScore(best) || (score === ringScore(best) && (entry.rssi ?? -999) > (best.rssi ?? -999))) best = entry;
  }
  return best;
}

/**
 * Tapa la dirección Bluetooth (`AA:BB:CC:DD:EE:FF`) si aparece dentro de unos bytes en hexadecimal separados por espacios (los
 * anuncios de estos anillos suelen llevar la dirección, en uno u otro orden). Como en `maskId`, solo se dejan a la vista los
 * dos últimos bytes de la dirección.
 */
export function maskAddressIn(hex: string, id: string): string {
  const bytes = id.split(':').map((byte) => byte.toLowerCase());
  if (bytes.length !== 6 || !bytes.every((byte) => /^[0-9a-f]{2}$/.test(byte))) return hex;
  const forward = bytes.join(' ');
  const backward = [...bytes].reverse().join(' ');
  return hex.split(forward).join(`xx xx xx xx ${forward.slice(-5)}`).split(backward).join(`${backward.slice(0, 5)} xx xx xx xx`);
}

/** Un dispositivo para el informe. El anillo va entero (menos la dirección); los demás, lo justo para saber qué hay alrededor. */
export function describeDevice(entry: ScanEntry, full: boolean): Record<string, unknown> {
  const base = { id: maskId(entry.id), name: entry.name, rssi: entry.rssi, services: entry.services };
  if (!full) return { ...base, companyIds: Object.keys(entry.manufacturer) };
  const manufacturer = Object.fromEntries(Object.entries(entry.manufacturer).map(([company, hex]) => [company, maskAddressIn(hex, entry.id)]));
  return { ...base, manufacturer, raw: entry.raw === null ? null : maskAddressIn(entry.raw, entry.id) };
}

export interface GapStats {
  count: number;
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
}

/** Separación entre instantes consecutivos (ms): cada cuánto llegan los datos. */
export function gapStats(times: readonly number[]): GapStats {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] as number) - (sorted[i - 1] as number));
  if (gaps.length === 0) return { count: 0, minMs: null, medianMs: null, maxMs: null };
  const ordered = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 1 ? (ordered[middle] as number) : ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
  return { count: gaps.length, minMs: ordered[0] as number, medianMs: Math.round(median), maxMs: ordered[ordered.length - 1] as number };
}

/** Una lectura de pasos en directo (`06 00`), con su instante relativo al inicio de la ventana de medida. */
export interface StepSample {
  t: number;
  steps: number;
  distanceM: number;
  calories: number;
}

export interface StepsAnalysis {
  /** Cuántas veces mandó el anillo el contador, y cuántas de ellas con un valor distinto del anterior. */
  updates: number;
  changes: number;
  first: StepSample | null;
  last: StepSample | null;
  /** Último − primero: lo que subió el contador en toda la ventana. */
  delta: number | null;
  /** Subidas del contador quieto al principio (debería ser 0) y durante la marcha. */
  changesAtRest: number;
  changesWhileWalking: number;
  /** Separación entre tramas recibidas y entre cambios del contador. */
  gapsBetweenUpdates: GapStats;
  gapsBetweenChanges: GapStats;
  /** Tiempo desde que empezó la marcha hasta el primer cambio del contador; `null` si no cambió. */
  firstChangeAfterWalkStartMs: number | null;
  /** Tiempo desde que acabó la marcha hasta el último cambio (negativo: el contador ya había parado). */
  lastChangeAfterWalkEndMs: number | null;
}

/** Cómo se comporta el contador de pasos en directo: si sube al andar, con qué retraso y a qué ritmo llegan los datos. */
export function analyzeLiveSteps(samples: readonly StepSample[], walk: { startMs: number; endMs: number }): StepsAnalysis {
  const first = samples[0] ?? null;
  const last = samples.at(-1) ?? null;
  const changeTimes: number[] = [];
  samples.forEach((sample, index) => {
    const before = samples[index - 1];
    if (before && sample.steps !== before.steps) changeTimes.push(sample.t);
  });
  const firstChange = changeTimes.find((t) => t >= walk.startMs);
  const lastChange = changeTimes.at(-1);
  return {
    updates: samples.length,
    changes: changeTimes.length,
    first,
    last,
    delta: first && last ? last.steps - first.steps : null,
    changesAtRest: changeTimes.filter((t) => t < walk.startMs).length,
    changesWhileWalking: changeTimes.filter((t) => t >= walk.startMs && t < walk.endMs).length,
    gapsBetweenUpdates: gapStats(samples.map((s) => s.t)),
    gapsBetweenChanges: gapStats(changeTimes),
    firstChangeAfterWalkStartMs: firstChange === undefined ? null : firstChange - walk.startMs,
    lastChangeAfterWalkEndMs: lastChange === undefined ? null : lastChange - walk.endMs,
  };
}

export interface StepsRunAnalysis {
  /** El primer envío al activar el empuje (el contador de partida). */
  baseline: StepSample | null;
  /** El último envío recibido mientras se andaba, antes de la relectura. */
  streamLast: StepSample | null;
  /** El primer envío tras apagar y volver a encender el empuje (la relectura pedida al terminar). */
  reread: StepSample | null;
  /** Cuánto subió el contador según lo que el anillo fue avisando solo, y según la relectura. */
  streamCounted: number;
  rereadCounted: number | null;
  /** El mayor de los dos: lo que el anillo contó de verdad. */
  counted: number;
  /** El anillo avisó de los pasos mientras se andaba (el contador cambió en el flujo, no solo en la relectura). */
  pushed: boolean;
  stream: StepsAnalysis;
}

/**
 * La prueba de pasos lee el contador al empezar, deja andar y lo lee otra vez al terminar apagando y encendiendo el empuje.
 * Así distingue «el anillo no cuenta» de «cuenta pero no avisa»: el R99 solo manda `06 00` cuando el contador cambia, y puede
 * tardar ~9 s en contar los primeros pasos mientras valida que se camina.
 * `split` es cuántos envíos había antes de la relectura.
 */
export function analyzeStepsRun(samples: readonly StepSample[], split: number, walk: { startMs: number; endMs: number }): StepsRunAnalysis {
  const stream = samples.slice(0, split);
  const baseline = stream[0] ?? null;
  const streamLast = stream.at(-1) ?? null;
  const reread = samples[split] ?? null;
  const streamCounted = baseline && streamLast ? Math.max(0, streamLast.steps - baseline.steps) : 0;
  const rereadCounted = baseline && reread ? Math.max(0, reread.steps - baseline.steps) : null;
  const analysis = analyzeLiveSteps(stream, walk);
  return {
    baseline,
    streamLast,
    reread,
    streamCounted,
    rereadCounted,
    counted: Math.max(streamCounted, rereadCounted ?? 0),
    pushed: analysis.changes > 0,
    stream: analysis,
  };
}

/** Un aviso del anillo durante la medida de pulso, con su instante relativo al inicio de la medida. */
export type HeartEvent = { t: number } & (
  | { kind: 'heartRate'; bpm: number }
  | { kind: 'spo2'; percent: number }
  | { kind: 'measurementEnd'; mode: number; success: boolean }
  | { kind: 'battery'; percent: number; charging: boolean }
  | { kind: 'status'; steps: number }
);

/** Lo que el anillo manda mientras mide el pulso, en forma compacta para el informe. */
export function toHeartEvent(event: LiveEvent, t: number): HeartEvent {
  switch (event.kind) {
    case 'heartRate':
      return { t, kind: 'heartRate', bpm: event.bpm };
    case 'spo2':
      return { t, kind: 'spo2', percent: event.percent };
    case 'measurementEnd':
      return { t, kind: 'measurementEnd', mode: event.mode, success: event.success };
    case 'battery':
      return { t, kind: 'battery', percent: event.percent, charging: event.charging };
    case 'status':
      return { t, kind: 'status', steps: event.status.steps };
  }
}

export interface HeartAnalysis {
  /** Lecturas de pulso recibidas (con ceros y ecos incluidos) y cuántas son distintas de cero. */
  readings: number;
  nonZero: number;
  /** Instante de la primera lectura distinta de cero y de la primera dentro del rango plausible (30–220 lpm). */
  firstNonZeroMs: number | null;
  firstPlausibleMs: number | null;
  /** Cuándo cerró el anillo la medida (`04 0e`) y si la dio por buena. */
  verdictMs: number | null;
  verdictSuccess: boolean | null;
  /** Valores distintos entre las lecturas plausibles: una meseta sin converger tiene muy pocos. */
  distinctPlausible: number;
  /**
   * La meseta inicial que a veces da el sensor en frío: varias lecturas casi iguales entre sí y muy lejos (≥ 20 lpm) de las que
   * vienen después (46-47 lpm y de golpe 86). No es un pulso; `bpm` es su valor, `count` cuántas lecturas y `untilMs` hasta cuándo.
   */
  plateau: { bpm: number; count: number; untilMs: number } | null;
  /** Instante de la primera lectura real: la primera tras la meseta o, si no la hubo, la primera plausible. */
  firstRealMs: number | null;
}

export function analyzeHeartEvents(events: readonly HeartEvent[]): HeartAnalysis {
  const readings = events.filter((e): e is Extract<HeartEvent, { kind: 'heartRate' }> => e.kind === 'heartRate');
  const plausible = readings.filter((e) => e.bpm >= 30 && e.bpm <= 220);
  const verdict = events.find((e): e is Extract<HeartEvent, { kind: 'measurementEnd' }> => e.kind === 'measurementEnd');

  // Meseta inicial: las lecturas hasta el primer salto de ≥ 20 lpm, si son al menos tres y casi iguales entre sí.
  const jump = plausible.findIndex((e) => Math.abs(e.bpm - (plausible[0]?.bpm ?? 0)) >= 20);
  const head = jump > 0 ? plausible.slice(0, jump) : [];
  const flat = head.length >= 3 && Math.max(...head.map((e) => e.bpm)) - Math.min(...head.map((e) => e.bpm)) <= 3;
  const sorted = head.map((e) => e.bpm).sort((a, b) => a - b);
  const plateau = flat ? { bpm: sorted[Math.floor(sorted.length / 2)] as number, count: head.length, untilMs: (head.at(-1) as { t: number }).t } : null;

  return {
    readings: readings.length,
    nonZero: readings.filter((e) => e.bpm > 0).length,
    firstNonZeroMs: readings.find((e) => e.bpm > 0)?.t ?? null,
    firstPlausibleMs: plausible[0]?.t ?? null,
    verdictMs: verdict?.t ?? null,
    verdictSuccess: verdict ? verdict.success : null,
    distinctPlausible: new Set(plausible.map((e) => e.bpm)).size,
    plateau,
    firstRealMs: (plateau ? plausible[jump] : plausible[0])?.t ?? null,
  };
}

export interface ForeignTraffic {
  /** Cuántas respuestas de «poner en hora» o «pedir información» llegaron sin que esta app las pidiera. */
  count: number;
  /** Instante (ms desde el inicio de la traza) de la primera. */
  firstMs: number;
  /** Claves `grupo:orden` de esas respuestas, sin repetir. */
  keys: string[];
}

/**
 * ¿Habló otra app con el anillo mientras tanto? Una conexión de Android se comparte entre apps: si Smart Health sigue viva en
 * segundo plano, su apretón de manos (poner en hora, información del dispositivo, mapa de capacidades) llega también a esta
 * app, que nunca lo pidió. En la traza queda como «respuesta sin petición pendiente» de los grupos 1 (ajustes) o 2 (consultas).
 */
export function foreignTraffic(trace: string): ForeignTraffic | null {
  const keys = new Set<string>();
  let count = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  for (const match of trace.matchAll(/^\s*(\d+) ms info\s+respuesta sin petición pendiente: ([12]):(\d+)\s*$/gm)) {
    count++;
    keys.add(`${match[2]}:${match[3]}`);
    firstMs = Math.min(firstMs, Number(match[1]));
  }
  return count > 0 ? { count, firstMs, keys: [...keys] } : null;
}

/** `1 min 05 s`, `42 s`, `3,4 s`: duraciones para el resumen del informe (con un decimal por debajo de los 10 s). */
export function fmtSeconds(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')} s`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, '0')} s` : `${seconds} s`;
}

/** `1 envío`, `3 envíos`. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** La versión de Android sin el «Android » que a veces trae delante (en el navegador la da así): `14`, no `Android 14`. */
export const androidVersion = (osVersion: string | undefined): string => (osVersion ?? '?').replace(/^Android\s*/i, '');
