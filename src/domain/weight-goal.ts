import { carriedWeights, COMPLETE_DAY_SHARE, KCAL_PER_KG, slopeKgPerDay } from './adaptive-intake';
import { addDays, daysBetween, type DayKey } from './dates';
import type { HealthGoal } from './nutrition';

// El peso objetivo: hasta dónde quiere llegar la persona. Va junto al objetivo de salud, y se complementan: el objetivo de salud es CÓMO come (las
// calorías y la proteína que se le proponen: perder, definir, mantener, ganar músculo o peso) y el peso objetivo es el DESTINO. Uno pone la
// dirección y el ritmo, el otro dice dónde parar; por eso se comprueba que apunten al mismo lado y se calcula cuánto tardaría en llegar.
// docs/estimaciones.md → Peso objetivo explica de dónde salen las cifras y sus límites.

/** El rango del peso objetivo (kg): el mismo que admite el perfil. */
export const MIN_TARGET_KG = 25;
export const MAX_TARGET_KG = 300;

export const isTargetWeight = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= MIN_TARGET_KG && value <= MAX_TARGET_KG;

/** Una báscula varía medio kilo de un día a otro (agua, comida, hora): a medio kilo o menos el peso objetivo se da por alcanzado. */
export const REACHED_MARGIN_KG = 0.5;

/** Por debajo de este IMC (el límite del bajo peso, según la OMS) no se recomienda buscar un peso. */
export const LOW_BMI = 18.5;

/**
 * Cuánto se mira atrás para ver el ritmo real del peso y cuántos días deben llevar pesándose para fiarse (el agua mueve un kilo en unos días). Se supone que la persona
 * **se pesa a diario** y solo anota el peso cuando cambia (ver `carriedWeights`): un peso que no se mueve en semanas no es «faltan pesadas», es un peso estable.
 */
const TREND_WINDOW_DAYS = 56;
const TREND_MIN_SPAN_DAYS = 14;
/** Por debajo de este ritmo (kg por semana) se entiende que el peso está quieto. */
export const STEADY_KG_PER_WEEK = 0.1;
/** Más allá de esto (semanas: dos años) no se promete una fecha: el ritmo cambia por el camino. */
export const MAX_WEEKS = 104;

/** Cuántos días atrás se mira lo que se ha comido de verdad y cuántos días anotados hacen falta para fiarse de su media. */
export const INTAKE_WINDOW_DAYS = 14;
export const INTAKE_MIN_DAYS = 4;

/** Lo que la persona come de verdad, de media, los últimos días con comidas anotadas. */
export interface RecentIntake {
  /** Calorías al día (media de los días anotados). */
  avgKcal: number;
  /** Días anotados que entran en la media. */
  days: number;
}

/**
 * Lo comido de media en las dos últimas semanas (sin hoy, que está a medias), o `null` si hay menos de cuatro días anotados. Un día solo cuenta si lo anotado llega a la mitad
 * del mantenimiento: con menos casi seguro faltan comidas y la media saldría baja.
 */
export function recentIntakeOf(intake: ReadonlyMap<DayKey, number>, today: DayKey, maintenanceKcal: number): RecentIntake | null {
  let days = 0;
  let total = 0;
  for (let back = 1; back <= INTAKE_WINDOW_DAYS; back++) {
    const kcal = intake.get(addDays(today, -back));
    if (kcal !== undefined && kcal >= maintenanceKcal * COMPLETE_DAY_SHARE) {
      days++;
      total += kcal;
    }
  }
  return days < INTAKE_MIN_DAYS ? null : { avgKcal: Math.round(total / days), days };
}

/** Hacia dónde empuja cada objetivo de salud: bajar, subir o quedarse. */
export type WeightDirection = 'lose' | 'gain' | 'keep';

export const directionOfGoal = (goal: HealthGoal): WeightDirection => (goal === 'lose' || goal === 'define' ? 'lose' : goal === 'muscle' || goal === 'gain' ? 'gain' : 'keep');

/** Un peso con el que empezar al fijar un peso objetivo: cerca del actual, hacia el lado que pide el objetivo de salud. */
export function startingTarget(currentKg: number | null, goal: HealthGoal): number {
  const base = currentKg ?? 70;
  const direction = directionOfGoal(goal);
  const shifted = direction === 'lose' ? base - 5 : direction === 'gain' ? base + 5 : base;
  return Math.min(MAX_TARGET_KG, Math.max(MIN_TARGET_KG, Math.round(shifted)));
}

/**
 * El ritmo real del peso (kg por semana; negativo: baja) en las últimas ocho semanas, con el peso de cada día (el último anotado hasta que se anota otro: se supone que la
 * persona se pesa a diario y solo anota los cambios), o `null` mientras lleve menos de dos semanas con un peso anotado.
 */
export function weightTrendKgPerWeek(weights: ReadonlyArray<{ day: DayKey; kg: number }>, today: DayKey): number | null {
  const points = carriedWeights(weights, addDays(today, -TREND_WINDOW_DAYS), today);
  const first = points[0];
  if (!first || points.length < 2 || daysBetween(first.day, today) < TREND_MIN_SPAN_DAYS) return null;
  const slope = slopeKgPerDay(points.map((p) => ({ x: daysBetween(first.day, p.day), kg: p.kg })));
  return slope === null ? null : Math.round(slope * 7 * 100) / 100;
}

/** Cuántos días de peso conocido hay para el ritmo real (de la primera pesada a hoy, con tope en la ventana que se mira): lo que falta para llegar a dos semanas. */
export function trendDaysKnown(weights: ReadonlyArray<{ day: DayKey; kg: number }>, today: DayKey): number {
  const points = carriedWeights(weights, addDays(today, -TREND_WINDOW_DAYS), today);
  return points.length === 0 ? 0 : points.length - 1;
}

/** Los días que hacen falta con peso conocido para dar un ritmo real. */
export const TREND_MIN_DAYS = TREND_MIN_SPAN_DAYS;

export interface WeightGoalInput {
  currentKg: number;
  targetKg: number;
  goal: HealthGoal;
  /** Las calorías de mantenimiento y las que se proponen con el objetivo de salud (`nutritionTargets`). */
  maintenanceKcal: number;
  plannedKcal: number;
  /** El ritmo real del peso (`weightTrendKgPerWeek`), si se sabe. */
  trendKgPerWeek: number | null;
  /** Lo que come de verdad (`recentIntakeOf`), si hay días anotados suficientes. */
  eaten?: RecentIntake | null;
  /** Para el IMC del peso objetivo. */
  heightCm: number | null;
  /** Días con peso conocido (`trendDaysKnown`), para decir cuánto falta cuando aún no hay ritmo real. */
  trendDays?: number;
}

export interface WeightGoalPlan {
  currentKg: number;
  targetKg: number;
  /** Lo que falta: negativo = hay que bajar, positivo = hay que subir. */
  deltaKg: number;
  /** Lo que pide el peso objetivo. */
  needs: 'lose' | 'gain' | 'reached';
  /**
   * Si el objetivo de salud lleva hacia el peso objetivo: `ok`; si ya se llegó y conviene pasar a mantener: `reached`; si empuja al otro lado
   * (o no empuja: «mantener peso» con kilos por perder): `conflict`.
   */
  fit: 'ok' | 'reached' | 'conflict';
  /** El objetivo de salud que cuadraría con el peso objetivo, si el elegido no cuadra. */
  suggestedGoal: HealthGoal | null;
  /** Lo que cambiaría el peso por semana con las calorías que se proponen (balance a 7700 kcal por kilo; negativo = baja) y las semanas hasta llegar así. */
  plannedKgPerWeek: number;
  plannedWeeks: number | null;
  /** Lo que ha cambiado de verdad (kg por semana) y las semanas que tardaría a ese ritmo (`null` si el peso está quieto o va al otro lado). */
  measuredKgPerWeek: number | null;
  measuredWeeks: number | null;
  /** Lo que ha comido de verdad estos días y lo que cambiaría su peso por semana con ello (balance a 7700 kcal por kilo frente al mantenimiento), y las semanas que tardaría. */
  eaten: RecentIntake | null;
  eatenKgPerWeek: number | null;
  eatenWeeks: number | null;
  /** Las calorías de mantenimiento con las que se hicieron las cuentas. */
  maintenanceKcal: number;
  /** El IMC del peso objetivo. */
  targetBmi: number | null;
  /** Días con peso conocido para el ritmo real (0 si no hay ninguno). */
  trendDays: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Semanas para recorrer `deltaKg` a `kgPerWeek`, o `null` si ese ritmo no lleva allí (quieto, o al otro lado). */
function weeksTo(deltaKg: number, kgPerWeek: number): number | null {
  if (Math.abs(kgPerWeek) < STEADY_KG_PER_WEEK / 2 || Math.sign(kgPerWeek) !== Math.sign(deltaKg)) return null;
  return Math.max(1, Math.round(Math.abs(deltaKg) / Math.abs(kgPerWeek)));
}

export function weightGoalPlan(input: WeightGoalInput): WeightGoalPlan {
  const deltaKg = round1(input.targetKg - input.currentKg);
  const needs: WeightGoalPlan['needs'] = Math.abs(deltaKg) <= REACHED_MARGIN_KG ? 'reached' : deltaKg < 0 ? 'lose' : 'gain';
  const direction = directionOfGoal(input.goal);

  let fit: WeightGoalPlan['fit'] = 'ok';
  let suggestedGoal: HealthGoal | null = null;
  if (needs === 'reached') {
    // Con «Perder peso» o «Ganar peso» lo que sigue es mantener; con «Definir» y «Ganar masa muscular» el peso puede quedarse quieto mientras cambia el cuerpo: no se empuja a nada.
    if (input.goal === 'lose' || input.goal === 'gain') {
      fit = 'reached';
      suggestedGoal = 'maintain';
    }
  } else if (direction !== needs) {
    fit = 'conflict';
    suggestedGoal = needs;
  }

  const plannedKgPerWeek = round2(((input.plannedKcal - input.maintenanceKcal) * 7) / KCAL_PER_KG);
  const measured = input.trendKgPerWeek;
  const eaten = input.eaten ?? null;
  const eatenKgPerWeek = eaten === null ? null : round2(((eaten.avgKcal - input.maintenanceKcal) * 7) / KCAL_PER_KG);
  return {
    currentKg: input.currentKg,
    targetKg: input.targetKg,
    deltaKg,
    needs,
    fit,
    suggestedGoal,
    plannedKgPerWeek,
    plannedWeeks: fit === 'ok' && needs !== 'reached' ? weeksTo(deltaKg, plannedKgPerWeek) : null,
    measuredKgPerWeek: measured,
    measuredWeeks: needs !== 'reached' && measured !== null && Math.abs(measured) >= STEADY_KG_PER_WEEK ? weeksTo(deltaKg, measured) : null,
    eaten,
    eatenKgPerWeek,
    eatenWeeks: needs !== 'reached' && eatenKgPerWeek !== null ? weeksTo(deltaKg, eatenKgPerWeek) : null,
    maintenanceKcal: input.maintenanceKcal,
    targetBmi: input.heightCm !== null && input.heightCm > 0 ? round1(input.targetKg / (input.heightCm / 100) ** 2) : null,
    trendDays: input.trendDays ?? 0,
  };
}
