import type { DayKey } from './dates';
import { baseStride, strideFactor } from './estimation';
import { profileAt, type ProfileEntry } from './profile';
import type { WorkoutRecord } from './workout';

// La distancia de cada día sale de pasos × zancada, y la zancada por altura (0,415 × altura) se aparta de la de cada persona un 8–10 %
// de media. Cada paseo con GPS es una medida de la zancada de ESTE anillo con ESTE cuerpo (el GPS da los metros y el anillo los
// pasos): con unos cuantos paseos la zancada sale con un error de pocos por ciento, sin que haya que calibrar nada.

/** Cuántos paseos con GPS hacen falta para fiarse de lo que sale. */
export const MIN_LEARN_WALKS = 3;
/** Se miran los paseos más recientes: la zancada cambia con el calzado, la forma física… */
const MAX_LEARN_WALKS = 10;
const MIN_STEPS = 600;
const MIN_DISTANCE_M = 600;
const MIN_ACTIVE_MS = 8 * 60_000;
/** Fracción mínima de minutos con lectura del GPS: con menos, buena parte de la distancia sería la de los pasos (la zancada que se quiere medir). */
const MIN_GPS_COVERAGE = 0.8;
/** Cadencias de un paseo normal: por debajo se va parado a ratos y por encima se corre (la zancada se alarga, ver `strideFactor`). */
const MIN_CADENCE_SPM = 80;
const MAX_CADENCE_SPM = 135;
/** Lo máximo que una medida creíble se aparta de la zancada por altura: más es un GPS que se fue, o pasos mal contados (un carrito, una mochila). */
const MAX_DEVIATION = 0.3;
/** Dispersión máxima entre paseos (desviación mediana absoluta sobre la mediana): paseos que no se parecen entre sí no miden nada. */
const MAX_SPREAD = 0.1;
/** La zancada solo se reajusta si cambia más que esto: por debajo es ruido, y cada ajuste es una entrada más en el perfil. */
const MIN_CHANGE = 0.03;

/** La zancada (m) que sale de un paseo con GPS, o `null` si ese paseo no sirve para medirla. */
export function observedStrideM(workout: WorkoutRecord): number | null {
  if (workout.sport !== 'walk' || workout.source !== 'live' || workout.distanceSource !== 'gps') return null;
  const { steps, distanceM, splitsM } = workout;
  if (steps === undefined || distanceM === undefined || steps < MIN_STEPS || distanceM < MIN_DISTANCE_M) return null;
  const activeMs = workout.endMs - workout.startMs - workout.pausedMs;
  if (!(activeMs >= MIN_ACTIVE_MS)) return null;
  if (splitsM && splitsM.length > 0 && splitsM.filter((m) => m >= 0).length / splitsM.length < MIN_GPS_COVERAGE) return null;
  const cadence = steps / (activeMs / 60_000);
  if (cadence < MIN_CADENCE_SPM || cadence > MAX_CADENCE_SPM) return null;
  const stride = distanceM / (steps * strideFactor(cadence));
  return stride >= 0.3 && stride <= 1.5 ? stride : null;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export interface LearnedStride {
  cm: number;
  /** Paseos de los que sale. */
  walks: number;
}

/**
 * La zancada de la persona según sus paseos con GPS más recientes: la mediana de lo que sale de cada uno. `heightStrideM` es la
 * zancada por altura: una medida que se aparta mucho de ella se descarta, y no se aprende nada si los paseos no se parecen entre sí.
 */
export function learnStride(workouts: readonly WorkoutRecord[], heightStrideM: number): LearnedStride | null {
  const observed = [...workouts]
    .sort((a, b) => b.startMs - a.startMs)
    .map(observedStrideM)
    .filter((stride): stride is number => stride !== null && Math.abs(stride - heightStrideM) / heightStrideM <= MAX_DEVIATION)
    .slice(0, MAX_LEARN_WALKS);
  if (observed.length < MIN_LEARN_WALKS) return null;
  const middle = median(observed);
  const spread = median(observed.map((stride) => Math.abs(stride - middle))) / middle;
  if (spread > MAX_SPREAD) return null;
  return { cm: Math.round(middle * 1000) / 10, walks: observed.length };
}

/**
 * La entrada de perfil que fija la zancada aprendida de los paseos, o `null` si no hay que tocar nada: no hay perfil, la fijó la persona
 * (manda siempre), no hay paseos que la midan, o ya vale la que se usa. Rige desde hoy, como una calibración a mano: el pasado no se
 * recalcula.
 */
export function autoStrideEntry(history: readonly ProfileEntry[], today: DayKey, workouts: readonly WorkoutRecord[]): ProfileEntry | null {
  const current = profileAt(history, today);
  if (!current) return null;
  if (current.strideCm !== undefined && current.strideCm > 0 && !current.strideAuto) return null;
  const learned = learnStride(workouts, baseStride({ heightCm: current.heightCm, sex: current.sex }).meters);
  if (!learned) return null;
  const inUseCm = baseStride(current).meters * 100;
  if (Math.abs(learned.cm - inUseCm) / inUseCm < MIN_CHANGE) return null;
  const todays = history.find((entry) => entry.date === today);
  if (todays) return { ...todays, strideCm: learned.cm, strideAuto: true };
  const { extrapolated: _extrapolated, ...base } = current;
  return { ...base, date: today, strideCm: learned.cm, strideAuto: true, strideOnly: true };
}

// ───────────────────────────── calibración guiada ─────────────────────────────
// Un paseo hecho a propósito para medir la zancada: el GPS da los metros (velocidad Doppler, sin el ruido de la posición) y el anillo los pasos. A diferencia del
// aprendizaje de arriba (paseos sueltos, que pide 600 m, 600 pasos y 8 minutos), aquí la persona camina sin parar con la app guiándola, así que bastan 300 m: con
// ellos el GPS y el contador de pasos se equivocan unos pocos por ciento cada uno, y la zancada sale con un error de ese orden (no medido con anillo real).

/** Metros a partir de los cuales se puede terminar: por debajo, un solo paso de más o de menos pesa demasiado. */
export const CALIBRATION_MIN_M = 150;
/** Metros a los que la app termina sola. */
export const CALIBRATION_TARGET_M = 300;
/** Menos de esto no es un paseo que se pueda medir. */
const CALIBRATION_FLOOR_M = 100;
const CALIBRATION_FLOOR_STEPS = 100;
/** Hasta aquí es una marcha normal; por encima se trota y la zancada se alarga (ver `strideFactor`). */
const CALIBRATION_MAX_CADENCE = 135;

/** Lo que resta fiabilidad a una medida. */
export type StrideFlaw = 'short' | 'gps-gaps' | 'cadence' | 'far-from-height';

export interface StrideMeasurement {
  /** La zancada de la persona (cm), a su cadencia de marcha normal. */
  cm: number;
  distanceM: number;
  steps: number;
  /** Pasos por minuto de todo el tiempo activo (incluye el rato de espera del GPS, así que puede quedar algo baja); `null` si fue muy corto para saberlo. */
  cadenceSpm: number | null;
  /** `good`: se puede fijar sin más; `fair`: sirve pero conviene repetirla; `poor`: repetirla. */
  verdict: 'good' | 'fair' | 'poor';
  flaws: StrideFlaw[];
}

export type StrideOutcome =
  | { ok: true; measurement: StrideMeasurement }
  | { ok: false; reason: 'no-gps' | 'no-steps' | 'too-short' | 'implausible' };

/**
 * La zancada que sale de un paseo de calibración, o por qué no sale. `heightStrideM` es la zancada que correspondería por altura: no se usa para
 * calcular nada (la medida es del GPS y del anillo), solo para avisar de una medida que se aparta mucho de lo esperable.
 */
export function measureCalibrationWalk(
  walk: Pick<WorkoutRecord, 'startMs' | 'endMs' | 'pausedMs' | 'steps' | 'distanceM' | 'distanceSource' | 'splitsM'>,
  heightStrideM: number,
): StrideOutcome {
  const { distanceM, steps } = walk;
  if (walk.distanceSource !== 'gps' || distanceM === undefined || !(distanceM > 0)) return { ok: false, reason: 'no-gps' };
  if (steps === undefined || steps < 10) return { ok: false, reason: 'no-steps' };
  if (distanceM < CALIBRATION_FLOOR_M || steps < CALIBRATION_FLOOR_STEPS) return { ok: false, reason: 'too-short' };
  const activeMs = walk.endMs - walk.startMs - walk.pausedMs;
  const cadence = activeMs >= 60_000 ? steps / (activeMs / 60_000) : null;
  const metres = distanceM / (steps * strideFactor(cadence));
  const cm = Math.round(metres * 1000) / 10;
  if (!(cm >= 30 && cm <= 150)) return { ok: false, reason: 'implausible' };

  const flaws: StrideFlaw[] = [];
  const splits = walk.splitsM ?? [];
  const coverage = splits.length > 0 ? splits.filter((m) => m >= 0).length / splits.length : 1;
  const deviation = heightStrideM > 0 ? Math.abs(metres - heightStrideM) / heightStrideM : 0;
  if (distanceM < CALIBRATION_MIN_M) flaws.push('short');
  if (coverage < 0.8) flaws.push('gps-gaps');
  if (cadence !== null && cadence > CALIBRATION_MAX_CADENCE) flaws.push('cadence');
  if (deviation > 0.2) flaws.push('far-from-height');
  const poor = distanceM < CALIBRATION_MIN_M || coverage < 0.6 || deviation > 0.3;
  const fair = distanceM < 250 || flaws.length > 0;
  return {
    ok: true,
    measurement: { cm, distanceM: Math.round(distanceM), steps, cadenceSpm: cadence === null ? null : Math.round(cadence), verdict: poor ? 'poor' : fair ? 'fair' : 'good', flaws },
  };
}
