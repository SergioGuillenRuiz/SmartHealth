/** FC máxima teórica de Tanaka (2001): 208 − 0,7 × edad. Más ajustada que 220 − edad en adultos. */
export const hrMaxForAge = (age: number): number => Math.round(208 - 0.7 * Math.max(0, age));

export interface HrZone {
  index: 1 | 2 | 3 | 4 | 5;
  name: string;
  /** Porcentaje de la FC máxima en el que empieza la zona. */
  fromPct: number;
}

export const HR_ZONES: readonly HrZone[] = [
  { index: 1, name: 'Muy suave', fromPct: 0.5 },
  { index: 2, name: 'Suave', fromPct: 0.6 },
  { index: 3, name: 'Aeróbica', fromPct: 0.7 },
  { index: 4, name: 'Intensa', fromPct: 0.8 },
  { index: 5, name: 'Máxima', fromPct: 0.9 },
];

/**
 * Zona de un pulso: su porcentaje del pulso máximo (el personal, ver `personalHrMax`), con los límites al 50, 60, 70, 80 y 90 %; `null` por debajo del 50 % (reposo). Es la convención
 * de casi todos los relojes y pulseras (y de Smart Health): con un máximo de 190, 95 lpm ya es la zona 1 y 110 lpm la 1 o la 2.
 *
 * [Seguro] Hasta la ronda 40 se calculaba por reserva cardiaca (Karvonen, con el pulso en reposo del anillo) y quien tiene el reposo bajo no entraba en la zona 1 hasta pasar de ~125 lpm: con
 * 44 de reposo y 195 de máximo, 110 lpm es el 44 % de la reserva y salía «sin zona» aunque se estuviera trotando. Se quitó por eso.
 */
export function zoneOf(bpm: number, hrMax: number): HrZone | null {
  const pct = bpm / hrMax;
  let found: HrZone | null = null;
  for (const zone of HR_ZONES) if (pct >= zone.fromPct) found = zone;
  return found;
}

/** Los pulsos personales con los que se calculan las zonas, y de dónde salió el máximo. */
export interface HrProfile {
  hrMax: number;
  /** `observed`: el pulso más alto que ha llegado a tener en sus entrenos; `age`: la fórmula por edad (aún no hay entrenos con esfuerzo). */
  maxSource: 'observed' | 'age';
}

/** Para fiarse del pulso de un entreno hacen falta ratos de verdad (10 min y 20 lecturas): un entreno de 2 minutos no dice nada del máximo. */
const MIN_WORKOUT_MS = 10 * 60_000;
const MIN_WORKOUT_READINGS = 20;
/** Entrenos hacen falta para dar por bueno un máximo observado, y cuánto puede pasarse de la fórmula (más es casi seguro un fallo del sensor). */
const MIN_WORKOUTS_FOR_MAX = 3;
const MAX_ABOVE_AGE = 25;
const ABSOLUTE_MAX = 220;
/** Un pulso observado más de esto por debajo de la fórmula quiere decir que nunca se llegó cerca del máximo: no es el máximo y se usa la fórmula. */
const NEAR_AGE_MARGIN = 5;

/**
 * El pulso más alto de un entreno con garantías: el segundo de mayor valor, para no dar por bueno un pico suelto del sensor óptico (que a
 * veces se engancha al ritmo de la zancada). `null` si el entreno es demasiado corto o tiene pocas lecturas.
 */
export function workoutPeakBpm(hr: ReadonlyArray<readonly [number, number]>, activeMs: number): number | null {
  if (activeMs < MIN_WORKOUT_MS) return null;
  const bpms = hr.map(([, bpm]) => bpm).filter((bpm) => bpm >= 35 && bpm <= ABSOLUTE_MAX);
  if (bpms.length < MIN_WORKOUT_READINGS) return null;
  return [...bpms].sort((a, b) => b - a)[1] ?? null;
}

/**
 * El pulso máximo de una persona. Con al menos tres entrenos con pulso, el segundo más alto de sus picos (así un entreno raro no lo decide), si
 * llega al menos hasta la fórmula por edad menos 5 lpm (si no, esa persona nunca ha apretado lo bastante y su máximo observado no es su máximo:
 * se queda con la fórmula). Nunca pasa de la fórmula + 25 ni de 220. Un deportista que supera la fórmula (la de Tanaka sale baja con
 * muchos) pasa a usar su máximo real.
 */
export function personalHrMax(age: number, peaks: readonly number[]): { hrMax: number; source: HrProfile['maxSource'] } {
  const byAge = hrMaxForAge(age);
  if (peaks.length >= MIN_WORKOUTS_FOR_MAX) {
    const observed = [...peaks].sort((a, b) => b - a)[1]!;
    if (observed >= byAge - NEAR_AGE_MARGIN) return { hrMax: Math.min(Math.round(observed), byAge + MAX_ABOVE_AGE, ABSOLUTE_MAX), source: 'observed' };
  }
  return { hrMax: byAge, source: 'age' };
}
