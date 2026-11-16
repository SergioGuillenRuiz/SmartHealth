import { dayWindow, type DayKey } from './dates';
import { maxOf, minOf } from './extent';
import type { HeartSample, Spo2Sample } from './types';

export interface HeartDay {
  day: DayKey;
  count: number;
  minBpm: number;
  maxBpm: number;
  avgBpm: number;
  /** FC en reposo estimada: media de las 3 lecturas más bajas del día (con ≥ 6 lecturas). */
  restingBpm: number | null;
  last: { tsMs: number; bpm: number };
  samples: HeartSample[];
}

/** Con menos lecturas que esto no se dibuja una evolución: sería inventarse una curva. */
export const MIN_SAMPLES_FOR_CURVE = 4;
export const MIN_SAMPLES_FOR_RESTING = 6;

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Lecturas posibles: fuera de estos rangos el anillo ha medido mal (o ha puesto un valor de relleno) y no cuentan. */
const isBpm = (bpm: number): boolean => bpm >= 30 && bpm <= 220;
const isPercent = (percent: number): boolean => percent >= 70 && percent <= 100;

/** `dayStartHour`: a qué hora empieza el día (0 = medianoche; el Resumen cuenta desde las 08:00): ver `dayWindow`. */
export function summarizeHeart(samples: readonly HeartSample[], day: DayKey, dayStartHour = 0): HeartDay | null {
  const { startMs: start, endMs: end } = dayWindow(day, dayStartHour);
  const inDay = samples.filter((s) => s.tsMs >= start && s.tsMs < end && isBpm(s.bpm)).sort((a, b) => a.tsMs - b.tsMs);
  const last = inDay[inDay.length - 1];
  if (!last) return null;
  const bpms = inDay.map((s) => s.bpm);
  const lowest = [...bpms].sort((a, b) => a - b).slice(0, 3);
  return {
    day,
    count: inDay.length,
    minBpm: minOf(bpms),
    maxBpm: maxOf(bpms),
    avgBpm: Math.round(mean(bpms)),
    restingBpm: inDay.length >= MIN_SAMPLES_FOR_RESTING ? Math.round(mean(lowest)) : null,
    last: { tsMs: last.tsMs, bpm: last.bpm },
    samples: inDay,
  };
}

export interface Spo2Day {
  day: DayKey;
  count: number;
  avg: number;
  min: number;
}

export function summarizeSpo2(samples: readonly Spo2Sample[], day: DayKey, dayStartHour = 0): Spo2Day | null {
  const { startMs: start, endMs: end } = dayWindow(day, dayStartHour);
  const values = samples.filter((s) => s.tsMs >= start && s.tsMs < end && isPercent(s.percent)).map((s) => s.percent);
  if (values.length === 0) return null;
  return { day, count: values.length, avg: Math.round(mean(values) * 10) / 10, min: minOf(values) };
}
