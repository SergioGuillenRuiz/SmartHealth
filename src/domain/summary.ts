import { summarizeActivity } from './activity';
import { mealDay } from './day-credit';
import { addDays, dayKeyOf, startOfDayMs, startOfMonth, startOfWeek, type DayKey } from './dates';
import { maxOf, minOf } from './extent';
import { summarizeHeart, summarizeSpo2 } from './heart';
import { GENERIC_PROFILE, profileAt, type ProfileEntry, type ResolvedProfile } from './profile';
import { intakeOf, type MealEntry } from './nutrition';
import { exerciseWater, waterGoalMl, type WaterEntry } from './hydration';
import { groupSleep } from './sleep';
import type { CounterSample, HeartSample, SleepSessionRecord, Spo2Sample, StepBucket } from './types';
import { estimateWorkout, type WorkoutRecord } from './workout';

/** Todo lo almacenado para un rango de días (más margen para sueño y tramos que cruzan la medianoche). */
export interface RawRange {
  buckets: readonly StepBucket[];
  counters: readonly CounterSample[];
  heart: readonly HeartSample[];
  spo2: readonly Spo2Sample[];
  sleep: readonly SleepSessionRecord[];
  workouts: readonly WorkoutRecord[];
  /** Entrenos que empezaron antes del rango y siguen dentro de su primer día (cruzan la medianoche). */
  carryWorkouts?: readonly WorkoutRecord[];
  /** Comidas anotadas en el rango. */
  meals?: readonly MealEntry[];
  /** Tomas de agua anotadas en el rango. */
  water?: readonly WaterEntry[];
}

export interface DaySummary {
  day: DayKey;
  steps: number | null;
  distanceM: number | null;
  activeKcal: number | null;
  workoutCount: number;
  workoutMin: number;
  sleepAsleepSec: number | null;
  sleepInBedSec: number | null;
  /** Hora de acostarse, en minutos desde la medianoche. */
  sleepBedMin: number | null;
  sleepWakeMin: number | null;
  restingBpm: number | null;
  avgBpm: number | null;
  minBpm: number | null;
  maxBpm: number | null;
  spo2Avg: number | null;
  spo2Min: number | null;
  /** Lo que se anotó de comida ese día (`null`: nada anotado, que no es lo mismo que haber comido cero). */
  intakeKcal: number | null;
  intakeProteinG: number | null;
  intakeCarbsG: number | null;
  intakeFatG: number | null;
  /** Fibra y azúcares (g) y sal (g, con una décima) de lo anotado ese día; `null`: nada anotado. */
  intakeFiberG: number | null;
  intakeSugarsG: number | null;
  intakeSaltG: number | null;
  /** El agua anotada ese día en ml (`null`: nada anotado, que no es lo mismo que haber bebido cero). */
  waterMl: number | null;
  /** La meta de agua de ese día: la de su perfil más lo que se suma por los pasos y los entrenos (`exerciseWater`). */
  waterGoalMl: number;
}

function indexByDay<T>(items: readonly T[], range: (item: T) => [number, number]): Map<DayKey, T[]> {
  const out = new Map<DayKey, T[]>();
  for (const item of items) {
    const [start, end] = range(item);
    const last = dayKeyOf(Math.max(start, end - 1));
    for (let day = dayKeyOf(start); day <= last; day = addDays(day, 1)) {
      const list = out.get(day) ?? [];
      list.push(item);
      out.set(day, list);
    }
  }
  return out;
}

const minutesOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/** Perfil a usar un día concreto: el vigente o, si no hay ninguno, los valores genéricos. */
export function resolveProfile(history: readonly ProfileEntry[], day: DayKey): { profile: ResolvedProfile; generic: boolean } {
  const found = profileAt(history, day);
  if (found) return { profile: found, generic: false };
  return { profile: { ...GENERIC_PROFILE, date: day, extrapolated: false }, generic: true };
}

export function buildDaySummaries(days: readonly DayKey[], raw: RawRange, history: readonly ProfileEntry[], nowMs: number): DaySummary[] {
  const buckets = indexByDay(raw.buckets, (b) => [b.startMs, Math.max(b.endMs, b.startMs + 1)]);
  const counters = indexByDay(raw.counters, (c) => [c.tsMs, c.tsMs + 1]);
  const workouts = indexByDay(raw.workouts, (w) => [w.startMs, w.startMs + 1]);
  // Las comidas cuentan para el día al que se pasaron (por omisión, el día en que se comieron: ver `day-credit.ts`).
  const meals = new Map<DayKey, MealEntry[]>();
  for (const meal of raw.meals ?? []) meals.set(mealDay(meal), [...(meals.get(mealDay(meal)) ?? []), meal]);
  // El agua cuenta para el día de su hora.
  const water = new Map<DayKey, number>();
  for (const entry of raw.water ?? []) water.set(dayKeyOf(entry.tsMs), (water.get(dayKeyOf(entry.tsMs)) ?? 0) + entry.ml);
  const sleepDays = groupSleep(raw.sleep);
  const carryCandidates = [...(raw.carryWorkouts ?? []), ...raw.workouts];

  return days.map((day) => {
    const { profile, generic } = resolveProfile(history, day);
    const dayWorkouts = workouts.get(day) ?? [];
    const dayStart = startOfDayMs(day);
    // Entrenos de un día anterior que siguen dentro de este: su parte posterior a medianoche no es un paseo aparte.
    const carryOverWorkouts = carryCandidates.filter((w) => w.startMs < dayStart && w.endMs > dayStart);
    const activity = summarizeActivity({
      day,
      nowMs,
      profile,
      profileIsGeneric: generic,
      buckets: buckets.get(day) ?? [],
      counters: counters.get(day) ?? [],
      workouts: dayWorkouts,
      carryOverWorkouts,
    });
    const heart = summarizeHeart(raw.heart, day);
    const spo2 = summarizeSpo2(raw.spo2, day);
    const night = sleepDays.get(day)?.night ?? null;
    const intake = intakeOf(meals.get(day) ?? []);
    const workoutMin = dayWorkouts.reduce((a, w) => a + estimateWorkout(w, profile).activeMs / 60_000, 0);
    return {
      day,
      steps: activity.steps,
      distanceM: activity.distanceM,
      activeKcal: activity.activeKcal,
      workoutCount: dayWorkouts.length,
      workoutMin: Math.round(workoutMin),
      sleepAsleepSec: night && night.asleepSec > 0 ? night.asleepSec : null,
      sleepInBedSec: night ? night.inBedSec : null,
      sleepBedMin: night ? minutesOfDay(night.startMs) : null,
      sleepWakeMin: night ? minutesOfDay(night.endMs) : null,
      restingBpm: heart?.restingBpm ?? null,
      avgBpm: heart?.avgBpm ?? null,
      minBpm: heart?.minBpm ?? null,
      maxBpm: heart?.maxBpm ?? null,
      spo2Avg: spo2?.avg ?? null,
      spo2Min: spo2?.min ?? null,
      intakeKcal: intake?.kcal ?? null,
      intakeProteinG: intake?.proteinG ?? null,
      intakeCarbsG: intake?.carbsG ?? null,
      intakeFatG: intake?.fatG ?? null,
      intakeFiberG: intake?.fiberG ?? null,
      intakeSugarsG: intake?.sugarsG ?? null,
      intakeSaltG: intake?.saltG ?? null,
      waterMl: water.has(day) ? Math.round(water.get(day)!) : null,
      waterGoalMl: waterGoalMl(profile, day) + exerciseWater({ workouts: activity.workouts, walkingKcal: activity.walking.kcal, walkingSteps: activity.walking.steps }).totalMl,
    };
  });
}

// ───────────────────────────── agregación por periodos ─────────────────────────────

export type Granularity = 'day' | 'week' | 'month';

export interface AggregatePoint {
  /** Primer día del periodo (lunes para semanas, día 1 para meses). */
  start: DayKey;
  /** Último día del periodo incluido en el rango. */
  end: DayKey;
  daysWithData: number;
  /** Noches con sueño registrado dentro del periodo (no es lo mismo que los días con algún dato). */
  sleepNights: number;
  /** Días que entran en la media de pasos, distancia y calorías (no cuenta el día en curso si se dejó fuera). */
  activityDays: number;
  /** Medias POR DÍA CON DATOS (un día sin datos no cuenta como cero). */
  steps: number | null;
  distanceM: number | null;
  activeKcal: number | null;
  sleepAsleepSec: number | null;
  restingBpm: number | null;
  avgBpm: number | null;
  /** El pulso más bajo y el más alto de todo el periodo (no medias: los extremos). */
  minBpm: number | null;
  maxBpm: number | null;
  /** Días del periodo con alguna lectura de pulso. */
  heartDays: number;
  spo2Avg: number | null;
  /** Lo anotado de comida: media por día CON comidas anotadas (como los pasos, sin el día en curso en semanas y meses). */
  intakeKcal: number | null;
  /** Días con comidas anotadas que entran en esa media. */
  intakeDays: number;
  /** El agua anotada: media por día CON agua anotada (sin el día en curso en semanas y meses), y la meta media de esos días. */
  waterMl: number | null;
  waterGoalMl: number | null;
  /** Días con agua anotada que entran en esa media. */
  waterDays: number;
}

/** El menor / mayor de los valores presentes (`null` si no hay ninguno). */
const extremeOf = (values: ReadonlyArray<number | null>, pick: (list: readonly number[]) => number): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? pick(present) : null;
};

function meanOf(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

/**
 * Media POR DÍA CON DATOS de un valor diario: un día sin dato (`null`) no cuenta como cero. Con `skipDay` se deja fuera
 * un día concreto (el de hoy, que aún no ha terminado, para pasos, distancia y calorías). Es la media que hay que usar
 * sobre los días: la media de las medias de varios periodos pesaría igual una semana de 2 días que una de 7.
 */
export function meanPerDay(summaries: readonly DaySummary[], pick: (day: DaySummary) => number | null, options: { skipDay?: DayKey } = {}): number | null {
  return meanOf(summaries.filter((d) => d.day !== options.skipDay).map(pick));
}

const rounded = (value: number | null, decimals = 0): number | null =>
  value === null ? null : Math.round(value * 10 ** decimals) / 10 ** decimals;

function pointOf(start: DayKey, end: DayKey, days: readonly DaySummary[], partialDay?: DayKey): AggregatePoint {
  // El día en curso lleva pasos, distancia y calorías PARCIALES: contado como un día entero hundiría la media de la semana
  // o del mes (el lunes por la mañana, la «media diaria» de la semana sería la de unos pocos cientos de pasos).
  const complete = partialDay === undefined ? days : days.filter((d) => d.day !== partialDay);
  return {
    start,
    end,
    daysWithData: days.filter((d) => d.steps !== null || d.sleepAsleepSec !== null || d.avgBpm !== null).length,
    sleepNights: days.filter((d) => d.sleepAsleepSec !== null).length,
    activityDays: complete.filter((d) => d.steps !== null).length,
    steps: rounded(meanOf(complete.map((d) => d.steps))),
    distanceM: rounded(meanOf(complete.map((d) => d.distanceM))),
    activeKcal: rounded(meanOf(complete.map((d) => d.activeKcal))),
    sleepAsleepSec: rounded(meanOf(days.map((d) => d.sleepAsleepSec))),
    restingBpm: rounded(meanOf(days.map((d) => d.restingBpm))),
    avgBpm: rounded(meanOf(days.map((d) => d.avgBpm))),
    minBpm: extremeOf(days.map((d) => d.minBpm), minOf),
    maxBpm: extremeOf(days.map((d) => d.maxBpm), maxOf),
    heartDays: days.filter((d) => d.avgBpm !== null).length,
    spo2Avg: rounded(meanOf(days.map((d) => d.spo2Avg)), 1),
    // Como los pasos, lo comido a medias del día en curso hundiría la media de la semana o del mes.
    intakeKcal: rounded(meanOf(complete.map((d) => d.intakeKcal))),
    intakeDays: complete.filter((d) => d.intakeKcal !== null).length,
    // Igual que lo comido: el agua del día en curso, a medias, hundiría la media.
    waterMl: rounded(meanOf(complete.map((d) => d.waterMl))),
    waterGoalMl: rounded(meanOf(complete.filter((d) => d.waterMl !== null).map((d) => d.waterGoalMl)) ?? meanOf(complete.map((d) => d.waterGoalMl))),
    waterDays: complete.filter((d) => d.waterMl !== null).length,
  };
}

export interface AggregateOptions {
  /**
   * Día aún en curso: en las medias por semana o por mes se deja fuera de pasos, distancia y calorías (no del sueño ni del
   * pulso, que no se acumulan a lo largo del día). Por días no cambia nada: su barra es la de ese día, a medias.
   */
  partialDay?: DayKey;
}

export function aggregate(summaries: readonly DaySummary[], granularity: Granularity, options: AggregateOptions = {}): AggregatePoint[] {
  if (granularity === 'day') return summaries.map((d) => pointOf(d.day, d.day, [d]));
  const groups = new Map<DayKey, DaySummary[]>();
  for (const d of summaries) {
    const key = granularity === 'week' ? startOfWeek(d.day) : startOfMonth(d.day);
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, list]) => pointOf(start, list[list.length - 1]?.day ?? start, list, options.partialDay));
}
