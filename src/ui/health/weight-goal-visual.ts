import { addDays, parseDayKey, type DayKey } from '../../domain/dates';
import { HEALTH_GOALS, type HealthGoal } from '../../domain/nutrition';
import { INTAKE_MIN_DAYS, LOW_BMI, MAX_WEEKS, STEADY_KG_PER_WEEK, TREND_MIN_DAYS, type WeightGoalPlan } from '../../domain/weight-goal';
import { fmtMonthShort, fmtUpTo1, fmtUpTo2 } from '../format';

// Lo que enseña el bloque «Objetivo de peso» de Salud, en cifras y dibujos y con el mínimo de texto: cuánto falta, cuánto del camino está hecho y, en tres tarjetas, cuándo
// se llegaría según el plan que se propone, según lo que se come de verdad y según el ritmo real del peso. Aquí solo se decide QUÉ se dibuja; `WeightGoalPanel.tsx` lo pinta.

export type ScenarioTone = 'good' | 'bad' | 'steady' | 'none';

export interface GoalScenario {
  key: 'plan' | 'eaten' | 'real';
  /** Lo que mide la tarjeta: «Tu plan», «Lo comido», «Ritmo real». */
  label: string;
  /** La cifra grande: «14 sem», «Sin cambio», «No llegas» o «—» si aún no se sabe. */
  headline: string;
  /** Una o dos líneas cortas: el ritmo y el mes, o lo que falta para poder decirlo. */
  detail: string[];
  tone: ScenarioTone;
}

export interface WeightGoalVisual {
  targetKg: number;
  currentKg: number;
  /** Con qué peso se empezó (la primera pesada si va del lado contrario al objetivo; si no, el peso de hoy): extremo izquierdo de la barra. */
  startKg: number;
  needs: WeightGoalPlan['needs'];
  /** Lo que falta (kg, siempre positivo) y cuánto del camino está hecho (0 a 1). */
  missingKg: number;
  progress: number;
  /** Tres tarjetas, o ninguna si ya se llegó. */
  scenarios: GoalScenario[];
  /** Avisos de una línea: el objetivo de salud no lleva al peso, ya se llegó, o el peso elegido es demasiado bajo. */
  warns: string[];
}

const MINUS = '−';
/**
 * «−0,44 kg/sem», «+0,3 kg/sem». Con dos decimales: las semanas de cada tarjeta se calculan con este mismo ritmo, y con uno solo («−0,4») la cuenta de cabeza
 * (kilos que faltan entre kilos por semana) no salía: 4,8 ÷ 0,4 son 12 semanas y la tarjeta decía 11 porque el ritmo real era 0,44.
 */
const rateText = (kgPerWeek: number): string => `${kgPerWeek < 0 ? MINUS : '+'}${fmtUpTo2(Math.abs(kgPerWeek))} kg/sem`;

/** «14 sem», «1 sem», «+2 años». */
export function weeksText(weeks: number): string {
  if (weeks > MAX_WEEKS) return '+2 años';
  return weeks === 1 ? '1 sem' : `${weeks} sem`;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Cuánto del camino de `startKg` a `targetKg` se ha recorrido ya estando en `currentKg` (0 a 1). */
export function progressToward(startKg: number, currentKg: number, targetKg: number): number {
  const span = startKg - targetKg;
  if (Math.abs(span) < 1e-9) return 1;
  return clamp01((startKg - currentKg) / span);
}

/** El peso de partida: el de la primera pesada si estaba del lado contrario al objetivo (de ahí se viene); si no, el de hoy (sin camino recorrido que enseñar). */
export function startingWeight(firstKg: number | null, currentKg: number, targetKg: number): number {
  if (firstKg === null) return currentKg;
  return targetKg < currentKg ? Math.max(firstKg, currentKg) : Math.min(firstKg, currentKg);
}

/** El mes de llegada («hacia mar», «hacia ene 2027» si es de otro año), sin día: con un ritmo que cambia por el camino un día concreto prometería una precisión que no hay. */
export function monthOf(weeks: number, today: DayKey): string | null {
  if (weeks > MAX_WEEKS) return null;
  const day = addDays(today, weeks * 7);
  const { year } = parseDayKey(day);
  return `hacia ${fmtMonthShort(day)}${year === parseDayKey(today).year ? '' : ` ${year}`}`;
}

function arriving(weeks: number, kgPerWeek: number, today: DayKey): { headline: string; detail: string[] } {
  const month = monthOf(weeks, today);
  return { headline: weeksText(weeks), detail: month === null ? [rateText(kgPerWeek)] : [rateText(kgPerWeek), month] };
}

function planScenario(plan: WeightGoalPlan, goal: HealthGoal, today: DayKey): GoalScenario {
  const label = 'Tu plan';
  if (plan.fit === 'conflict') return { key: 'plan', label, headline: 'No llega', detail: [`con «${HEALTH_GOALS[goal].label}»`], tone: 'bad' };
  if (plan.plannedWeeks === null) return { key: 'plan', label, headline: 'Sin cambio', detail: ['con tus calorías'], tone: 'steady' };
  return { key: 'plan', label, ...arriving(plan.plannedWeeks, plan.plannedKgPerWeek, today), tone: 'good' };
}

function eatenScenario(plan: WeightGoalPlan, today: DayKey): GoalScenario {
  const label = 'Lo comido';
  const rate = plan.eatenKgPerWeek;
  if (plan.eaten === null || rate === null) return { key: 'eaten', label, headline: '—', detail: [`anota ${INTAKE_MIN_DAYS} días`], tone: 'none' };
  if (plan.eatenWeeks !== null) return { key: 'eaten', label, ...arriving(plan.eatenWeeks, rate, today), tone: 'good' };
  if (Math.abs(rate) < STEADY_KG_PER_WEEK) return { key: 'eaten', label, headline: 'Sin cambio', detail: ['comiendo así'], tone: 'steady' };
  return { key: 'eaten', label, headline: 'No llegas', detail: [rateText(rate), 'al revés'], tone: 'bad' };
}

function realScenario(plan: WeightGoalPlan, today: DayKey): GoalScenario {
  const label = 'Ritmo real';
  const rate = plan.measuredKgPerWeek;
  if (rate === null) {
    // Se supone que la persona se pesa a diario: si no hay ritmo es solo porque lleva menos de dos semanas con un peso anotado.
    const missing = TREND_MIN_DAYS - plan.trendDays;
    return { key: 'real', label, headline: '—', detail: [plan.trendDays <= 0 ? 'anota tu peso' : `faltan ${missing} ${missing === 1 ? 'día' : 'días'}`], tone: 'none' };
  }
  if (Math.abs(rate) < STEADY_KG_PER_WEEK) return { key: 'real', label, headline: 'Estable', detail: ['últimas semanas'], tone: 'steady' };
  if (plan.measuredWeeks !== null) return { key: 'real', label, ...arriving(plan.measuredWeeks, rate, today), tone: 'good' };
  return { key: 'real', label, headline: 'Al revés', detail: [rateText(rate)], tone: 'bad' };
}

/** Todo lo que se dibuja del peso objetivo. `firstKg`: la primera pesada anotada (para el camino recorrido), si hay. */
export function weightGoalVisual(plan: WeightGoalPlan, goal: HealthGoal, today: DayKey, firstKg: number | null): WeightGoalVisual {
  const reached = plan.needs === 'reached';
  const startKg = startingWeight(firstKg, plan.currentKg, plan.targetKg);
  const warns: string[] = [];
  if (plan.fit === 'conflict') {
    warns.push(`«${HEALTH_GOALS[goal].label}» no apunta a tu peso objetivo: cámbialo en el perfil.`);
  } else if (plan.fit === 'reached') {
    warns.push(`Para mantenerlo, elige «${HEALTH_GOALS.maintain.label}» en el perfil.`);
  }
  if (plan.needs !== 'gain' && plan.targetBmi !== null && plan.targetBmi < LOW_BMI) {
    warns.push(`Ese peso es un IMC de ${fmtUpTo1(plan.targetBmi)}, por debajo de lo saludable.`);
  }
  return {
    targetKg: plan.targetKg,
    currentKg: plan.currentKg,
    startKg,
    needs: plan.needs,
    missingKg: Math.abs(plan.deltaKg),
    progress: reached ? 1 : progressToward(startKg, plan.currentKg, plan.targetKg),
    scenarios: reached ? [] : [planScenario(plan, goal, today), eatenScenario(plan, today), realScenario(plan, today)],
    warns,
  };
}
