import { dayKeyOf, startOfDayMs, type DayKey } from './dates';
import { proteinReferenceKg } from './nutrition';
import { ageAt, type ProfileEntry } from './profile';

// Hidratación: cuánta agua conviene beber al día, lo que se ha bebido y cómo va el día. Todo son ESTIMACIONES a partir de lo que la persona anota, de
// su perfil y de lo que se ha movido (pasos y entrenos): no hay forma de medir la hidratación real (osmolalidad de la orina o la sangre, sed, sudor) con un anillo y
// un diario. docs/estimaciones.md → Hidratación explica de dónde sale cada cifra y qué no cuenta (el calor, el embarazo, la lactancia, la enfermedad).

/** Una toma de agua. */
export interface WaterEntry {
  id: string;
  /** Cuándo se bebió: decide a qué día cuenta (el de calendario). */
  tsMs: number;
  ml: number;
}

/** Un vaso: lo que suma el botón rápido (un vaso normal, de 200 a 250 ml). */
export const GLASS_ML = 250;
/** Lo mínimo y lo máximo de una toma que se admite (un error de dedo como 25000 ml no entra). */
export const MIN_WATER_ML = 10;
export const MAX_WATER_ML = 2_000;

// ───────────────────────────── meta ─────────────────────────────

/**
 * Agua total (bebidas y la de los alimentos) por kilo de peso: 35 ml/kg a los adultos y 30 ml/kg a los mayores (ESPEN 2019 y la práctica clínica habitual:
 * 30–35 ml/kg), con una transición lineal entre los 55 y los 65 años.
 */
const ML_PER_KG_ADULT = 35;
const ML_PER_KG_OLDER = 30;
const OLDER_FROM = 65;
const ADULT_UNTIL = 55;
/**
 * Límites del agua total: la ingesta adecuada de la EFSA (2010) es 2,0 l a una mujer y 2,5 l a un hombre; la del IOM (2004), 2,7 y 3,7 l. Una persona muy pequeña
 * no baja de 1,5 l ni una muy grande pasa de 3,7 l.
 */
const TOTAL_MIN_ML = 1_500;
const TOTAL_MAX_ML = 3_700;
/** Parte del agua total que entra por lo que se bebe: el resto (en torno a una quinta parte, según la EFSA) llega con los alimentos. */
const DRINKS_SHARE = 0.8;

/**
 * La meta de agua para beber en un día, en ml (redondeada a 50): 35 ml por kilo (30 en mayores) de agua total, entre 1,5 y 3,7 l, y el 80 % de eso en bebidas. Con obesidad se
 * usa el peso ajustado (`proteinReferenceKg`: el exceso de grasa casi no necesita agua). Con 80 kg y 40 años salen 2250 ml; con 60 kg, 1700 ml.
 *
 * Es la meta de un día SIN ejercicio y a temperatura normal: lo que se pierde con el ejercicio se suma aparte (`exerciseWater`), y el calor no se cuenta.
 */
export function waterGoalMl(profile: Pick<ProfileEntry, 'heightCm' | 'weightKg' | 'birthDate'>, day: DayKey): number {
  const age = ageAt(profile.birthDate, day);
  const t = Math.min(1, Math.max(0, (age - ADULT_UNTIL) / (OLDER_FROM - ADULT_UNTIL)));
  const mlPerKg = ML_PER_KG_ADULT + (ML_PER_KG_OLDER - ML_PER_KG_ADULT) * t;
  const total = Math.min(TOTAL_MAX_ML, Math.max(TOTAL_MIN_ML, mlPerKg * proteinReferenceKg(profile)));
  return Math.round((total * DRINKS_SHARE) / 50) * 50;
}

// ───────────────────────────── ejercicio ─────────────────────────────

/**
 * Lo que se pierde con el ejercicio y hay que beber de más: **sudor** y **respiración**. El sudor aparece cuando el cuerpo produce más calor del que se va por la piel sin
 * sudar y crece con la energía que se gasta: con 160 kcal/h netas (por encima del reposo; un paseo tranquilo) casi no suda, y por cada kcal/h más suda unos 2,1 ml/h (calibrado con
 * lo medido en la literatura: ~150 ml/h andando a paso vivo —230 kcal/h netas—, ~700 ml/h en bici a 20 km/h —490— y ~1 l/h corriendo a 10 km/h —630—; ACSM 2007, Sawka; los
 * valores en la práctica van de 0,5 a 2 l/h según la persona y el calor). La respiración pierde, además, unos 0,15 ml de agua por kcal gastada. Se supone una temperatura
 * templada: en verano o en un gimnasio caldeado se suda más y la app no lo sabe.
 */
const SWEAT_THRESHOLD_KCAL_H = 160;
const SWEAT_ML_PER_KCAL_H = 2.1;
const RESPIRATORY_ML_PER_KCAL = 0.15;
/** Ni el atleta más sudoroso pierde más de 2 l/h de sudor: un dato raro (calorías disparatadas) no dispara la meta. */
const MAX_SWEAT_ML_H = 2_000;
/** Lo más que se suma en un día por ejercicio (una jornada de ultrarresistencia): la meta no puede ser un disparate. */
const MAX_EXERCISE_ML = 4_000;
/** Pasos por hora al andar (105 por minuto): da el rato que se ha andado, del que sale a qué ritmo se gastó la energía. */
const WALK_STEPS_PER_HOUR = 6_300;
/** Por debajo de esto no se suma nada (ruido). */
const MIN_EXTRA_ML = 25;

/** Agua (ml) que se pierde en `hours` horas de ejercicio en las que se gastaron `kcalNet` kcal por encima del reposo. */
export function exerciseLossMl(kcalNet: number, hours: number): number {
  if (!(kcalNet > 0) || !(hours > 0)) return 0;
  const rate = kcalNet / hours;
  const sweat = Math.min(MAX_SWEAT_ML_H, SWEAT_ML_PER_KCAL_H * Math.max(0, rate - SWEAT_THRESHOLD_KCAL_H)) * hours;
  return sweat + RESPIRATORY_ML_PER_KCAL * kcalNet;
}

/** Lo que se ha movido un día: los entrenos (sus kcal netas y su duración activa) y el andar fuera de ellos (kcal netas y pasos). */
export interface ExerciseInput {
  workouts: ReadonlyArray<{ kcal: number; activeMs: number }>;
  walkingKcal: number;
  walkingSteps: number;
}

export interface ExerciseWater {
  /** Lo que suman los entrenos y el andar de fuera de ellos (ml, sin redondear a 50). */
  workoutsMl: number;
  walkingMl: number;
  /** El total que se suma a la meta (redondeado a 50 ml; 0 si es poco). */
  totalMl: number;
}

/**
 * El agua extra de un día por lo que se ha movido: cada entreno (por su ritmo de gasto y su duración) y el andar de fuera de los entrenos (a 105 pasos por minuto). Los pasos
 * solos aportan poco (10 000 pasos, unos 100–150 ml); un entreno intenso, de medio litro a más de un litro.
 */
export function exerciseWater(input: ExerciseInput): ExerciseWater {
  const workoutsMl = input.workouts.reduce((sum, w) => sum + exerciseLossMl(w.kcal, w.activeMs / 3_600_000), 0);
  const walkingMl = exerciseLossMl(input.walkingKcal, input.walkingSteps / WALK_STEPS_PER_HOUR);
  const total = Math.min(MAX_EXERCISE_ML, workoutsMl + walkingMl);
  return { workoutsMl, walkingMl, totalMl: total < MIN_EXTRA_ML ? 0 : Math.round(total / 50) * 50 };
}

// ───────────────────────────── cómo va el día ─────────────────────────────

/**
 * - `none`: no hay ninguna toma anotada (no se puede decir nada: no es lo mismo que estar deshidratado).
 * - `low`, `fair`, `good`: cuánto de lo que tocaría llevar bebido a esta hora se lleva.
 * - `excess`: se ha bebido mucho más de lo necesario.
 */
export type HydrationLevel = 'none' | 'low' | 'fair' | 'good' | 'excess';

export interface HydrationStatus {
  intakeMl: number;
  /** La meta del día: la base más lo que se suma por el ejercicio (`exerciseMl`). */
  goalMl: number;
  /** La parte de la meta que se suma por el ejercicio hecho hasta ahora (0 si no hay). */
  exerciseMl: number;
  /** Lo que tocaría llevar bebido a esta hora (en un día que ya acabó, la meta entera). */
  expectedMl: number;
  level: HydrationLevel;
  /** De 0 a 1: lo bebido frente a lo esperado a esta hora. */
  score: number;
  /** Vasos de 250 ml que son las tomas del día. */
  glasses: number;
  lastDrinkMs: number | null;
}

/** Las horas despierto en las que se reparte la meta: desde que la persona se levanta (por omisión, a las 07:00). */
const AWAKE_MS = 16 * 3_600_000;
const DEFAULT_WAKE_HOUR = 7;
/** A primera hora lo esperado es casi nada: se compara al menos con esta parte de la meta para que un solo vaso no parezca poco ni 0 ml de nada parezca mucho. */
const MIN_EXPECTED_SHARE = 0.1;
/** Desde esta parte de lo esperado, bien; desde esta otra, algo por debajo; por debajo, baja. */
const GOOD_FROM = 1;
const FAIR_FROM = 0.75;
/** Mucho más de lo necesario: más de 1,6 veces la meta y al menos 3,5 l. */
const EXCESS_SHARE = 1.6;
const EXCESS_MIN_ML = 3_500;

export interface HydrationInput {
  /** Las tomas del día. */
  entries: readonly WaterEntry[];
  /** La meta base del día (`waterGoalMl`), sin el ejercicio. */
  goalMl: number;
  /** Lo que se suma por el ejercicio hecho hasta ahora (`exerciseWater`): ya ha pasado, así que lo esperado a cualquier hora lo lleva entero. */
  exerciseMl?: number;
  /** Ahora (el día de hoy se reparte por horas; uno pasado cuenta con la meta entera). */
  nowMs: number;
  day: DayKey;
  /** Cuándo se levantó ese día si se sabe (el fin del sueño del anillo). Sin él, a las 07:00. */
  wakeMs?: number | null;
}

/**
 * Cómo va la hidratación de un día. Se reparte la meta por las 16 horas despierto desde que la persona se levanta (el fin del sueño del anillo si lo hay; si no, las
 * 07:00) y se compara lo bebido con lo que tocaría llevar a esta hora. Es una estimación del ritmo, no una medida: con las tomas anotadas y la hora solo se puede decir
 * si va al ritmo de la meta.
 */
export function hydrationStatus({ entries, goalMl: baseGoalMl, exerciseMl = 0, nowMs, day, wakeMs }: HydrationInput): HydrationStatus {
  const intakeMl = Math.round(entries.reduce((sum, e) => sum + e.ml, 0));
  const lastDrinkMs = entries.length > 0 ? Math.max(...entries.map((e) => e.tsMs)) : null;
  const dayStart = startOfDayMs(day);
  const isToday = day === dayKeyOf(nowMs);
  const goalMl = baseGoalMl + exerciseMl;
  let expectedMl = goalMl;
  if (isToday) {
    const wake = wakeMs !== undefined && wakeMs !== null && wakeMs >= dayStart && wakeMs < dayStart + 14 * 3_600_000 ? wakeMs : dayStart + DEFAULT_WAKE_HOUR * 3_600_000;
    // La base se reparte por las horas despierto; lo del ejercicio ya ha pasado (solo cuenta el hecho hasta ahora) y toca haberlo bebido.
    expectedMl = baseGoalMl * Math.min(1, Math.max(0, (nowMs - wake) / AWAKE_MS)) + exerciseMl;
  }
  const base = { intakeMl, goalMl, exerciseMl, expectedMl: Math.round(expectedMl), glasses: Math.round((intakeMl / GLASS_ML) * 10) / 10, lastDrinkMs };
  if (intakeMl === 0) return { ...base, level: 'none', score: 0 };
  const ratio = intakeMl / Math.max(expectedMl, goalMl * MIN_EXPECTED_SHARE);
  const score = Math.min(1, ratio);
  if (intakeMl >= EXCESS_MIN_ML && intakeMl > goalMl * EXCESS_SHARE) return { ...base, level: 'excess', score: 1 };
  return { ...base, level: ratio >= GOOD_FROM ? 'good' : ratio >= FAIR_FROM ? 'fair' : 'low', score };
}

/** Lo que se dice de cada nivel. */
export const HYDRATION_LABEL: Readonly<Record<HydrationLevel, string>> = {
  none: 'Sin agua anotada',
  low: 'Hidratación baja',
  fair: 'Algo por debajo',
  good: 'Bien hidratado',
  excess: 'Más agua de la necesaria',
};
