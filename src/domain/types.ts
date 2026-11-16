// Tipos de los datos persistidos que consume el dominio.

/** De dónde sale un dato: medido por el anillo o por el GPS del móvil, calculado por la app o introducido por el usuario. */
export type Provenance = 'ring' | 'estimated' | 'manual' | 'phone';

/** Tramo de actividad del anillo (cubo acumulable). Clave: `startMs`. */
export interface StepBucket {
  startMs: number;
  endMs: number;
  steps: number;
  /** Distancia que calcula el propio anillo (m). Solo informativa. */
  ringDistanceM: number;
  /** Calorías que calcula el propio anillo (unidad sin verificar). Solo informativas. */
  ringCalories: number;
}

/** Lectura del contador ACUMULADO de pasos del día (sube durante el día y se reinicia a medianoche). */
export interface CounterSample {
  tsMs: number;
  steps: number;
}

export type HeartSource = 'ring-auto' | 'ring-spot' | 'workout';

export interface HeartSample {
  tsMs: number;
  bpm: number;
  source: HeartSource;
}

export interface Spo2Sample {
  tsMs: number;
  percent: number;
}

export type SleepStageName = 'deep' | 'light' | 'rem' | 'awake' | 'nap';

export interface SleepSegmentRecord {
  stage: SleepStageName;
  startMs: number;
  durationSec: number;
}

/** Sesión de sueño tal y como la entrega el anillo. Clave: `startMs`. */
export interface SleepSessionRecord {
  startMs: number;
  endMs: number;
  segments: SleepSegmentRecord[];
  /** La calcula la app con el pulso y la falta de pasos (el anillo no guardó esa noche); no se guarda nunca (`sleep-estimate.ts`). */
  estimated?: true;
  /** Las horas las puso la persona a mano (corrigiendo una noche estimada): se guarda como una noche normal, sin fases, y el anillo la sustituye si luego la da él. */
  manual?: true;
}
