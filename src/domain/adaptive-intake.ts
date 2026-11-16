import { addDays, daysBetween, type DayKey } from './dates';

// La meta de calorías de mantenimiento, medida en vez de calculada. La fórmula (metabolismo basal × un nivel de actividad) se aparta
// del gasto real de una persona en ±20 %; pero con el peso de las últimas semanas y lo que se anotó comer, el gasto sale por balance:
// lo comido menos lo que ha engordado (o adelgazado) esa persona, a 7700 kcal por kilo. Es lo que hacen las apps de seguimiento serias
// y no necesita saber nada de su actividad: la lleva dentro. docs/estimaciones.md → Alimentación explica sus límites.

/** Energía de un kilo de peso corporal que sube o baja (mezcla de grasa y agua/músculo: 7700 es la cifra habitual). */
export const KCAL_PER_KG = 7700;

/** Cuánto se mira atrás desde hoy. */
const WINDOW_DAYS = 56;
/** Con menos días entre el primer y el último peso no hay tendencia: un kilo de agua son 500 kcal al día en dos semanas. */
const MIN_SPAN_DAYS = 14;
/** Desde esta separación entre pesos la medida manda por completo (entre las dos cifras se mezcla con la fórmula). */
const FULL_SPAN_DAYS = 42;
/** Días con comida anotada que hacen falta, y la parte de los días del periodo que deben tenerla (entera para fiarse del todo). */
const MIN_LOGGED_DAYS = 10;
const MIN_COVERAGE = 0.5;
const FULL_COVERAGE = 0.8;
/** Un día solo cuenta como anotado si lo anotado llega a esta parte del mantenimiento: con menos, casi seguro faltan comidas. */
export const COMPLETE_DAY_SHARE = 0.5;
/** Por debajo de esta confianza no merece la pena mover nada. */
const MIN_CONFIDENCE = 0.15;
/** Lo medido no se aparta de la fórmula más de esto (una tendencia de peso con ruido no debe proponer 900 kcal ni 5000). */
const MAX_BELOW = 0.7;
const MAX_ABOVE = 1.4;

export type AdaptiveSource = 'formula' | 'mixed' | 'adaptive';

export interface AdaptiveInput {
  /** Hoy (el día del Resumen): sus comidas están a medias y no cuentan. */
  today: DayKey;
  /** Las calorías de mantenimiento por fórmula: de donde se parte, el tope de lo que se aparta y lo que se usa si faltan datos. */
  formulaKcal: number;
  /** Por debajo de esto nunca se propone nada (el metabolismo basal). */
  floorKcal: number;
  /** Lo comido cada día (solo los días con alguna comida anotada). */
  intake: ReadonlyMap<DayKey, number>;
  /** El peso en cada fecha en que se anotó. Se supone que la persona se pesa a diario: entre una entrada y la siguiente el peso es el de la primera. */
  weights: ReadonlyArray<{ day: DayKey; kg: number }>;
}

export interface AdaptiveMaintenance {
  kcal: number;
  formulaKcal: number;
  source: AdaptiveSource;
  /** 0 = solo la fórmula, 1 = solo lo medido. */
  confidence: number;
  /** Días con comida anotada que se usaron, y días entre el primer y el último peso. */
  loggedDays: number;
  spanDays: number;
  /** Lo que sube o baja el peso por semana (negativo: baja), si se pudo calcular. */
  trendKgPerWeek: number | null;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function byFormula(input: AdaptiveInput, extra: Partial<AdaptiveMaintenance> = {}): AdaptiveMaintenance {
  return { kcal: Math.round(input.formulaKcal), formulaKcal: input.formulaKcal, source: 'formula', confidence: 0, loggedDays: 0, spanDays: 0, trendKgPerWeek: null, ...extra };
}

/**
 * El peso de cada día desde `from` hasta `to`, **suponiendo que la persona se pesa a diario** y solo anota cuando el peso cambia: un día sin entrada nueva no es un día sin
 * pesar, es un día en que el peso siguió siendo el último anotado. Así un peso que lleva semanas igual cuenta como semanas de datos (una tendencia plana), no como «faltan pesadas».
 * La serie empieza en `from` si ya había un peso entonces y, si no, el día de la primera entrada (antes no se sabe nada); sin ninguna entrada hasta `to`, sale vacía.
 */
export function carriedWeights(weights: ReadonlyArray<{ day: DayKey; kg: number }>, from: DayKey, to: DayKey): Array<{ day: DayKey; kg: number }> {
  const sorted = weights.filter((w) => Number.isFinite(w.kg) && w.day <= to).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const first = sorted[0];
  if (!first) return [];
  const series: Array<{ day: DayKey; kg: number }> = [];
  let index = 0;
  let current = first.kg;
  for (let day = first.day > from ? first.day : from; day <= to; day = addDays(day, 1)) {
    while (index < sorted.length && sorted[index]!.day <= day) current = sorted[index++]!.kg;
    series.push({ day, kg: current });
  }
  return series;
}

/** La pendiente (kg por día) de la recta que mejor pasa por los pesos. */
export function slopeKgPerDay(points: ReadonlyArray<{ x: number; kg: number }>): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.kg, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.kg - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

/**
 * Las calorías de mantenimiento de esta persona: lo comido en el periodo menos lo que cambió su peso. Con poco que mirar (pocos pesos, pocos
 * días anotados, menos de dos semanas) se queda en la fórmula; con mucho (seis semanas, la mayoría de los días anotados) manda lo medido por
 * completo; en medio se mezclan de forma continua, para que la meta no dé saltos.
 */
export function adaptiveMaintenance(input: AdaptiveInput): AdaptiveMaintenance {
  // El peso de cada día del periodo, suponiendo que se pesa a diario (un peso que no cambia no se vuelve a anotar: ver `carriedWeights`).
  const points = carriedWeights(input.weights, addDays(input.today, -WINDOW_DAYS), input.today);
  if (points.length < 2) return byFormula(input);

  const first = points[0]!.day;
  const spanDays = daysBetween(first, input.today);
  if (spanDays < MIN_SPAN_DAYS) return byFormula(input, { spanDays });

  // Los días de los que habla el cambio de peso: del primer peso a ayer (hoy está a medias).
  const end = addDays(input.today, -1);
  const periodDays = daysBetween(first, end) + 1;
  if (periodDays < MIN_LOGGED_DAYS) return byFormula(input, { spanDays });
  let logged = 0;
  let total = 0;
  for (let day = first; day <= end; day = addDays(day, 1)) {
    const kcal = input.intake.get(day);
    if (kcal !== undefined && kcal >= input.formulaKcal * COMPLETE_DAY_SHARE) {
      logged++;
      total += kcal;
    }
  }
  const coverage = logged / periodDays;
  if (logged < MIN_LOGGED_DAYS || coverage < MIN_COVERAGE) return byFormula(input, { spanDays, loggedDays: logged });

  const slope = slopeKgPerDay(points.map((p) => ({ x: daysBetween(first, p.day), kg: p.kg })));
  if (slope === null) return byFormula(input, { spanDays, loggedDays: logged });
  const trendKgPerWeek = Math.round(slope * 7 * 100) / 100;

  const measured = clamp(total / logged - slope * KCAL_PER_KG, Math.max(input.floorKcal, input.formulaKcal * MAX_BELOW), input.formulaKcal * MAX_ABOVE);
  const confidence =
    clamp((spanDays - MIN_SPAN_DAYS) / (FULL_SPAN_DAYS - MIN_SPAN_DAYS), 0, 1) * clamp((coverage - MIN_COVERAGE) / (FULL_COVERAGE - MIN_COVERAGE), 0, 1);
  if (confidence < MIN_CONFIDENCE) return byFormula(input, { spanDays, loggedDays: logged, trendKgPerWeek });

  return {
    kcal: Math.round(input.formulaKcal + (measured - input.formulaKcal) * confidence),
    formulaKcal: input.formulaKcal,
    source: confidence >= 0.999 ? 'adaptive' : 'mixed',
    confidence,
    loggedDays: logged,
    spanDays,
    trendKgPerWeek,
  };
}
