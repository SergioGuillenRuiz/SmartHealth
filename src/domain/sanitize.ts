import type { HistoryRecords } from '../ble/records';
import type { LiveStatus } from '../ble/session';
import { dayKeyOf, DAY_MS, HOUR_MS, startOfDayMs } from './dates';
import type { CounterSample, HeartSample, SleepSessionRecord, Spo2Sample, StepBucket } from './types';

// Único sitio donde viven los rangos de plausibilidad. Los decodificadores solo descartan los
// "rellenos" del anillo; aquí se rechaza lo que, aun siendo un valor decodificable, no puede ser
// una medida real. Un dato dudoso que se guarda se vuelve a guardar en cada sincronización (el anillo
// reenvía todo su registro), así que es mejor descartarlo y contarlo que dejarlo contaminar el historial.

export interface IngestRows {
  buckets: StepBucket[];
  counters: CounterSample[];
  heart: HeartSample[];
  spo2: Spo2Sample[];
  sleep: SleepSessionRecord[];
  /** Cuántos registros se descartaron y por qué, para el informe de sincronización. */
  dropped: Record<string, number>;
}

/** Antigüedad máxima aceptada de un registro. El anillo conserva días, no años: más allá es un reloj roto. */
const MAX_AGE_MS = 400 * DAY_MS;
/** Margen hacia el futuro: relojes ligeramente adelantados. */
const MAX_FUTURE_MS = HOUR_MS;

const MAX_BUCKET_STEPS = 30_000;
const MAX_CADENCE_SPM = 260;
const MAX_COUNTER_STEPS = 60_000;
/** Margen fijo (pasos) sobre el ritmo máximo para el total del día: la muñeca puede contar de más y el reloj del anillo va unos segundos atrás. */
const COUNTER_SLACK_STEPS = 100;
const MIN_SLEEP_SEC = 10 * 60;
const MAX_SLEEP_SEC = 20 * 3600;

/**
 * Lo máximo que puede marcar el contador de pasos del día a esa hora: el ritmo máximo creíble desde medianoche, con un margen
 * fijo. A las 00:00:00,5 un contador de ayer (12 000) no es un día nuevo que empieza: el reloj del anillo va unos segundos atrás y
 * aún no ha cambiado de día; guardado con la fecha de hoy se quedaría todo el día como el máximo del contador.
 */
export function maxCounterAt(tsMs: number): number {
  const sinceMidnightMin = Math.max(0, tsMs - startOfDayMs(dayKeyOf(tsMs))) / 60_000;
  return Math.min(MAX_COUNTER_STEPS, MAX_CADENCE_SPM * sinceMidnightMin + COUNTER_SLACK_STEPS);
}

/**
 * `live` (los pasos de hoy en directo, `06 00`) se sella con `liveAtMs`, la hora en que se LEYERON, y no con `nowMs`, la de
 * guardar: una sincronización que cruza la medianoche leería el contador de ayer y lo guardaría como el de hoy.
 */
export function sanitizeHistory(records: HistoryRecords, nowMs: number, live: LiveStatus | null = null, liveAtMs: number = nowMs): IngestRows {
  const rows: IngestRows = { buckets: [], counters: [], heart: [], spo2: [], sleep: [], dropped: {} };
  // La FC y el SpO2 llegan por dos vías (historial dedicado y registro de constantes) con el mismo sello:
  // se indexan por instante para guardar una sola fila, y la fuente dedicada tiene la última palabra.
  const heart = new Map<number, HeartSample>();
  const spo2 = new Map<number, Spo2Sample>();
  const counters = new Map<number, CounterSample>();
  const drop = (reason: string): void => {
    rows.dropped[reason] = (rows.dropped[reason] ?? 0) + 1;
  };
  const timeOk = (ms: number): boolean => ms >= nowMs - MAX_AGE_MS && ms <= nowMs + MAX_FUTURE_MS;

  for (const r of records.sport) {
    if (!timeOk(r.startMs) || !timeOk(r.endMs) || r.endMs < r.startMs) {
      drop('tramo de actividad con fecha imposible');
      continue;
    }
    const durationMs = r.endMs - r.startMs;
    if (durationMs > DAY_MS) {
      drop('tramo de actividad de más de un día');
      continue;
    }
    if (r.steps < 1 || r.steps > MAX_BUCKET_STEPS) {
      drop('tramo con pasos imposibles');
      continue;
    }
    // Un tramo de segundos (o de duración 0) con miles de pasos es tan imposible como uno largo: la cadencia se mide
    // al menos sobre un minuto.
    if (r.steps / (Math.max(durationMs, 60_000) / 60_000) > MAX_CADENCE_SPM) {
      drop('tramo con cadencia imposible');
      continue;
    }
    rows.buckets.push({ startMs: r.startMs, endMs: r.endMs, steps: r.steps, ringDistanceM: r.distanceM, ringCalories: r.calories });
  }

  // El registro "All" aporta el contador acumulado y, cuando existen, lecturas de FC/SpO2 con el mismo sello.
  // Se procesan antes que los historiales dedicados: ante un mismo instante, estos últimos tienen la última palabra.
  for (const r of records.all) {
    if (!timeOk(r.tsMs)) {
      drop('constantes con fecha imposible');
      continue;
    }
    if (r.steps <= MAX_COUNTER_STEPS) counters.set(r.tsMs, { tsMs: r.tsMs, steps: r.steps });
    else drop('contador de pasos imposible');
    if (r.bpm >= 30 && r.bpm <= 220) heart.set(r.tsMs, { tsMs: r.tsMs, bpm: r.bpm, source: 'ring-auto' });
    if (r.spo2 >= 70 && r.spo2 <= 100) spo2.set(r.tsMs, { tsMs: r.tsMs, percent: r.spo2 });
  }

  for (const r of records.heart) {
    if (!timeOk(r.tsMs)) {
      drop('FC con fecha imposible');
      continue;
    }
    if (r.bpm < 30 || r.bpm > 220) {
      drop('FC fuera de rango');
      continue;
    }
    heart.set(r.tsMs, { tsMs: r.tsMs, bpm: r.bpm, source: 'ring-auto' });
  }

  for (const r of records.spo2) {
    if (!timeOk(r.tsMs)) {
      drop('SpO2 con fecha imposible');
      continue;
    }
    if (r.percent < 70 || r.percent > 100) {
      drop('SpO2 fuera de rango');
      continue;
    }
    spo2.set(r.tsMs, { tsMs: r.tsMs, percent: r.percent });
  }

  for (const s of records.sleep) {
    const durationSec = (s.endMs - s.startMs) / 1000;
    if (!timeOk(s.startMs) || !timeOk(s.endMs) || durationSec < MIN_SLEEP_SEC || durationSec > MAX_SLEEP_SEC) {
      drop('sesión de sueño imposible');
      continue;
    }
    // Las fases no pueden sumar más que la propia sesión (un tramo de 20 h dentro de una noche de 7 h es un registro roto):
    // no se enseñan más fases que tiempo en la cama. La noche NO se pierde por eso: el anillo dice que se durmió de tal hora a tal
    // hora, y eso vale aunque sus fases no cuadren; se guarda sin ellas (solo la duración) y se deja dicho.
    const phasesSec = s.segments.reduce((sum, g) => sum + g.durationSec, 0);
    if (phasesSec > durationSec * 1.05 + 120) {
      drop('fases de sueño que no cuadran con la duración de la noche (se guarda solo la duración)');
      rows.sleep.push({ startMs: s.startMs, endMs: s.endMs, segments: [] });
      continue;
    }
    rows.sleep.push({ startMs: s.startMs, endMs: s.endMs, segments: s.segments.map((g) => ({ stage: g.stage, startMs: g.startMs, durationSec: g.durationSec })) });
  }

  // Pasos del día en curso leídos en directo (06 00): un punto más del contador acumulado.
  if (live) {
    if (live.steps > MAX_COUNTER_STEPS) drop('contador de pasos imposible');
    else if (live.steps > maxCounterAt(liveAtMs)) drop('contador de pasos que no cuadra con la hora del día');
    else counters.set(liveAtMs, { tsMs: liveAtMs, steps: live.steps });
  }

  rows.heart = [...heart.values()];
  rows.spo2 = [...spo2.values()];
  rows.counters = [...counters.values()];
  return rows;
}
