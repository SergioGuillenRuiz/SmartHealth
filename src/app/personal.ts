import { effect, signal } from '@preact/signals';
import type { Store } from '../data/types';
import { adaptiveMaintenance, type AdaptiveMaintenance } from '../domain/adaptive-intake';
import { addDays, DAY_MS, type DayKey } from '../domain/dates';
import { mealDay } from '../domain/day-credit';
import { bmrKcalPerDay } from '../domain/estimation';
import { personalHrMax, workoutPeakBpm, type HrProfile } from '../domain/hrzones';
import { ACTIVITY_LEVEL, type TargetOptions } from '../domain/nutrition';
import { ageAt, type ProfileEntry } from '../domain/profile';
import { resolveProfile } from '../domain/summary';
import { recentIntakeOf, INTAKE_WINDOW_DAYS, type RecentIntake } from '../domain/weight-goal';
import { activeMsOf } from '../domain/workout';
import { dataVersion, profileHistory, todayKey } from './state';
import { svc } from './services';

// Lo que la app aprende de la propia persona y sustituye a las fórmulas genéricas cuando hay datos suficientes:
//  · sus calorías de mantenimiento (lo que come menos lo que cambia su peso: `adaptiveMaintenance`);
//  · su pulso máximo (el que alcanza en sus entrenos), para las zonas de pulso.
// Sin datos (o con un perfil que aún es el genérico) las señales quedan en `null` y todo usa las fórmulas de siempre.

/** Las calorías de mantenimiento medidas (`null`: se usa la fórmula). */
export const adaptive = signal<AdaptiveMaintenance | null>(null);
/** Lo que come de verdad (media de los últimos días anotados), para decirle si con ello llegará a su peso objetivo (`null`: pocos días anotados o perfil genérico). */
export const recentIntake = signal<RecentIntake | null>(null);
/** Los pulsos personales (`null`: sin perfil; el máximo sale entonces de la edad genérica). */
export const hrProfile = signal<HrProfile | null>(null);

/** Cómo se calculan las metas hoy: con el mantenimiento medido si ya hay datos, y con la fórmula si no. Leerlo suscribe a quien pinta. */
export function targetOptions(): TargetOptions {
  const measured = adaptive.value;
  return measured !== null && measured.source !== 'formula' ? { maintenanceKcal: measured.kcal } : {};
}

const WINDOW_DAYS = 56;
const WORKOUT_DAYS = 365;
/** El pulso se vuelve a calcular como mucho cada tanto: leer tres semanas de lecturas en cada guardado de un entreno gastaría batería. */
const HR_EVERY_MS = 10 * 60_000;

/** Las calorías de mantenimiento medidas de esta persona hoy, o `null` si el perfil aún es el genérico. */
export async function computeAdaptive(store: Pick<Store, 'listMealsByDay'>, history: readonly ProfileEntry[], today: DayKey): Promise<AdaptiveMaintenance | null> {
  const { profile, generic } = resolveProfile(history, today);
  if (generic) return null;
  // Cada comida cuenta para el día al que se pasó (la cena de después de medianoche, para el día anterior), no para el de su hora.
  const meals = await store.listMealsByDay(addDays(today, -WINDOW_DAYS - 7), addDays(today, -1));
  const intake = new Map<DayKey, number>();
  for (const meal of meals) intake.set(mealDay(meal), (intake.get(mealDay(meal)) ?? 0) + meal.kcal);
  const bmr = bmrKcalPerDay(profile, today);
  return adaptiveMaintenance({
    today,
    formulaKcal: bmr * ACTIVITY_LEVEL,
    floorKcal: bmr,
    intake,
    weights: history.map((entry) => ({ day: entry.date, kg: entry.weightKg })),
  });
}

/** Lo comido de media las dos últimas semanas, o `null` si el perfil aún es el genérico o hay pocos días anotados. */
export async function computeRecentIntake(store: Pick<Store, 'listMealsByDay'>, history: readonly ProfileEntry[], today: DayKey): Promise<RecentIntake | null> {
  const { profile, generic } = resolveProfile(history, today);
  if (generic) return null;
  const meals = await store.listMealsByDay(addDays(today, -INTAKE_WINDOW_DAYS - 1), addDays(today, -1));
  const intake = new Map<DayKey, number>();
  for (const meal of meals) intake.set(mealDay(meal), (intake.get(mealDay(meal)) ?? 0) + meal.kcal);
  return recentIntakeOf(intake, today, bmrKcalPerDay(profile, today) * ACTIVITY_LEVEL);
}

/** El pulso máximo de esta persona (el más alto sostenido en sus entrenos, si llega a la fórmula; si no, la fórmula), con el que se miden las zonas de pulso. */
export async function computeHr(store: Pick<Store, 'listWorkouts'>, history: readonly ProfileEntry[], today: DayKey, now: number): Promise<HrProfile | null> {
  const { profile, generic } = resolveProfile(history, today);
  if (generic) return null;
  const workouts = await store.listWorkouts(now - WORKOUT_DAYS * DAY_MS, now);
  const peaks = workouts.map((w) => workoutPeakBpm(w.hr ?? [], activeMsOf(w))).filter((peak): peak is number => peak !== null);
  const { hrMax, source } = personalHrMax(ageAt(profile.birthDate, today), peaks);
  return { hrMax, maxSource: source };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

let lastHrMs = 0;
let running = false;
let again = false;

/** Recalcula lo personal. Una sola vez a la vez: si llega otro aviso mientras tanto, se repite al acabar. */
export async function refreshPersonal(force = false): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const { store, now } = svc();
      const history = profileHistory.peek();
      const today = todayKey.peek();
      const next = await computeAdaptive(store, history, today);
      if (!same(next, adaptive.peek())) adaptive.value = next;
      const eaten = await computeRecentIntake(store, history, today);
      if (!same(eaten, recentIntake.peek())) recentIntake.value = eaten;
      const t = now();
      if (force || t - lastHrMs >= HR_EVERY_MS || hrProfile.peek() === null) {
        lastHrMs = t;
        const hr = await computeHr(store, history, today, t);
        if (!same(hr, hrProfile.peek())) hrProfile.value = hr;
      }
    } while (again);
  } catch {
    // Sin esto la app seguiría con las fórmulas de siempre: un fallo al leer no debe romper nada.
  } finally {
    running = false;
  }
}

/** Lo personal se recalcula al cambiar los datos, el perfil, el día o la hora de inicio del día. Devuelve cómo dejar de escuchar. */
export function startPersonal(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = effect(() => {
    dataVersion.value;
    profileHistory.value;
    todayKey.value;
    clearTimeout(timer);
    // Un guardado de entreno o una sincronización avisan varias veces seguidas: se espera un momento y se calcula una sola vez.
    timer = setTimeout(() => void refreshPersonal(), 1500);
  });
  void refreshPersonal(true);
  return () => {
    stop();
    clearTimeout(timer);
  };
}

/** Para las pruebas: vuelve a empezar. */
export function resetPersonal(): void {
  adaptive.value = null;
  recentIntake.value = null;
  hrProfile.value = null;
  lastHrMs = 0;
  running = false;
  again = false;
}
