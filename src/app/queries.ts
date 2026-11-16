import { estimateDayWorkouts, summarizeActivity, type DayActivity } from '../domain/activity';
import type { Store } from '../data/types';
import { dayOfMs, dayWindow, endOfDayMs, startOfDayMs, type DayKey } from '../domain/dates';
import { summarizeHeart, summarizeSpo2, type HeartDay, type Spo2Day } from '../domain/heart';
import type { WaterEntry } from '../domain/hydration';
import type { MealEntry } from '../domain/nutrition';
import { periodRange, type HistoryPeriod } from '../domain/periods';
import type { ProfileEntry } from '../domain/profile';
import { groupSleep, type SleepDay } from '../domain/sleep';
import { resolveProfile } from '../domain/summary';
import type { StepBucket } from '../domain/types';
import { estimateWorkout, type WorkoutEstimate, type WorkoutRecord } from '../domain/workout';
import { svc } from './services';

/** Todo lo que pinta la pantalla de resumen para un día. */
export interface DayBundle {
  day: DayKey;
  activity: DayActivity;
  heart: HeartDay | null;
  spo2: Spo2Day | null;
  /** La noche que ACABA este día (más siestas). */
  sleep: SleepDay | null;
  /** Las comidas anotadas ese día, de la más antigua a la más reciente. */
  meals: readonly MealEntry[];
  /** Las tomas de agua del día. */
  water: readonly WaterEntry[];
}

/**
 * `dayStartHour`: a qué hora empieza el día (el del Resumen, a las 08:00 por omisión de los ajustes; 0 = medianoche). El día va de
 * esa hora a la misma del día siguiente, y en él caen la actividad, las comidas, el pulso y el sueño que acaba en esas horas.
 */
export async function loadDayBundle(
  day: DayKey,
  nowMs: number,
  history: readonly ProfileEntry[],
  dayStartHour = 0,
  store: Pick<Store, 'loadWindow'> = svc().store,
): Promise<DayBundle> {
  const window = dayWindow(day, dayStartHour);
  const raw = await store.loadWindow(window.startMs, window.endMs);
  const { profile, generic } = resolveProfile(history, day);
  const activity = summarizeActivity({
    day,
    dayStartHour,
    nowMs,
    profile,
    profileIsGeneric: generic,
    buckets: raw.buckets,
    counters: raw.counters,
    workouts: raw.workouts,
    carryOverWorkouts: raw.carryWorkouts ?? [],
  });
  const sleep = groupSleep(raw.sleep, dayStartHour).get(day) ?? null;
  return {
    day,
    activity,
    heart: summarizeHeart(raw.heart, day, dayStartHour),
    spo2: summarizeSpo2(raw.spo2, day, dayStartHour),
    sleep,
    meals: raw.meals ?? [],
    water: raw.water ?? [],
  };
}

/**
 * Lo que hace falta de un día para estimar sus entrenos igual que lo hace el resumen: los tramos de pasos del anillo y
 * los entrenos guardados (que se reparten esos pasos). Estimar un entreno sin ello daría otras cifras que las del día.
 */
export interface WorkoutDay {
  day: DayKey;
  buckets: readonly StepBucket[];
  workouts: readonly WorkoutRecord[];
}

/** Los entrenos de un día tal y como los ve el Resumen (que empieza a las `dayStartHour`: ver `loadDayBundle`). */
export async function loadWorkoutDay(day: DayKey, dayStartHour = 0): Promise<WorkoutDay> {
  const window = dayWindow(day, dayStartHour);
  const raw = await svc().store.loadWindow(window.startMs, window.endMs);
  return { day, buckets: raw.buckets, workouts: raw.workouts };
}

/**
 * Estima `record` con las reglas del resumen del día. `record` puede ser una versión aún sin guardar (corregida a mano o
 * recién terminada): sustituye a la guardada con su mismo id. `null` si `context` es de otro día.
 */
export function estimateWithin(record: WorkoutRecord, context: WorkoutDay, history: readonly ProfileEntry[], dayStartHour = 0): WorkoutEstimate | null {
  const day = dayOfMs(record.startMs, dayStartHour);
  if (context.day !== day) return null;
  const { profile } = resolveProfile(history, day);
  const others = context.workouts.filter((w) => w.id !== record.id);
  const estimates = estimateDayWorkouts(day, [...others, record], context.buckets, profile, dayStartHour);
  return estimates[estimates.length - 1] ?? estimateWorkout(record, profile);
}

/** Estimaciones de entrenos guardados (de cualquier día) con las mismas reglas que el resumen, por id. */
export async function estimateStoredWorkouts(workouts: readonly WorkoutRecord[], history: readonly ProfileEntry[], dayStartHour = 0): Promise<Map<string, WorkoutEstimate>> {
  const out = new Map<string, WorkoutEstimate>();
  for (const day of new Set(workouts.map((w) => dayOfMs(w.startMs, dayStartHour)))) {
    const context = await loadWorkoutDay(day, dayStartHour);
    const { profile } = resolveProfile(history, day);
    const estimates = estimateDayWorkouts(day, context.workouts, context.buckets, profile, dayStartHour);
    context.workouts.forEach((w, i) => {
      const estimate = estimates[i];
      if (estimate) out.set(w.id, estimate);
    });
  }
  return out;
}

/** Un entreno del historial con sus cifras (las mismas que en el resumen del día). */
export interface HistoryItem {
  record: WorkoutRecord;
  estimate: WorkoutEstimate;
}

export interface HistoryPage {
  /** Más recientes primero. */
  items: HistoryItem[];
  /** Hay más entrenos antiguos que los devueltos (solo con `all`). */
  more: boolean;
}

/**
 * Entrenos del historial: los del día, la semana o el mes que contiene a `anchor`, o —con `all`— los `limit` más
 * recientes (con `more` para saber si hay más). Siempre de más reciente a más antiguo.
 */
export async function loadHistory(period: HistoryPeriod, anchor: DayKey, history: readonly ProfileEntry[], limit: number, dayStartHour = 0): Promise<HistoryPage> {
  const { store } = svc();
  const range = periodRange(period, anchor);
  let workouts: WorkoutRecord[];
  let more = false;
  if (range === null) {
    // Uno de más para saber si quedan: no se pinta.
    workouts = await store.recentWorkouts(limit + 1);
    more = workouts.length > limit;
    workouts = workouts.slice(0, limit);
  } else {
    workouts = (await store.listWorkouts(startOfDayMs(range.from), endOfDayMs(range.to))).reverse();
  }
  // Con las mismas reglas que el resumen del día, para que cada entreno muestre aquí las cifras que suma allí.
  const estimates = await estimateStoredWorkouts(workouts, history, dayStartHour);
  return {
    items: workouts.map((record) => ({ record, estimate: estimates.get(record.id) ?? estimateWorkout(record, resolveProfile(history, dayOfMs(record.startMs, dayStartHour)).profile) })),
    more,
  };
}
