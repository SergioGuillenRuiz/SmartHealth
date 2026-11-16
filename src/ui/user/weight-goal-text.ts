import { addDays, type DayKey } from '../../domain/dates';
import { HEALTH_GOALS, type HealthGoal } from '../../domain/nutrition';
import { LOW_BMI, MAX_WEEKS, STEADY_KG_PER_WEEK, type WeightGoalPlan } from '../../domain/weight-goal';
import { fmtInt, fmtMonthLong, fmtUpTo1, fmtUpTo2, NBSP } from '../format';

/** Una frase bajo el peso objetivo; `warn` las que conviene leer (el objetivo de salud no lleva al peso, o el peso elegido es demasiado bajo). */
export interface WeightGoalNote {
  text: string;
  tone: 'info' | 'warn';
}

export interface WeightGoalMessage {
  notes: WeightGoalNote[];
  /** Un cambio de objetivo de salud que cuadraría con el peso objetivo, para ofrecerlo con un toque. */
  suggestion: { goal: HealthGoal; label: string } | null;
}

/** «74,5 kg» con un espacio que no deja la unidad sola al final de una línea. */
const kg = (value: number): string => `${fmtUpTo1(value)}${NBSP}kg`;
/** Un ritmo («0,44 kg» a la semana): con dos decimales para que las semanas que se dicen salgan de la cuenta (kilos que faltan entre kilos por semana). */
const kgWeek = (value: number): string => `${fmtUpTo2(value)}${NBSP}kg`;

/**
 * «una semana (hacia noviembre)», «unas 14 semanas (hacia febrero)», «más de dos años». La fecha es del MES, no del día: con el mantenimiento calculado por
 * fórmula (que se aparta hasta un 20 % del real) y un ritmo que cambia por el camino, un día concreto prometería una precisión que no hay.
 */
function whenText(weeks: number, today: DayKey): string {
  if (weeks > MAX_WEEKS) return 'más de dos años';
  const span = weeks === 1 ? 'una semana' : `unas ${weeks} semanas`;
  return `${span} (hacia ${fmtMonthLong(addDays(today, weeks * 7), today)})`;
}

/** Las calorías redondeadas a la decena: «unas 2150», no «2147». */
const kcalRounded = (value: number): string => fmtInt(Math.round(value / 10) * 10);

/**
 * Lo que pasaría con lo que la persona COME DE VERDAD (la media de los últimos días anotados frente a su mantenimiento): si lo seguirá comiendo así, ¿llega a su peso
 * objetivo y cuándo? Es la respuesta a «¿voy a conseguirlo?»; lo que se le propone comer (`plannedWeeks`) es otra pregunta. Sin días anotados suficientes se dice qué falta.
 */
function eatenNotes(plan: WeightGoalPlan, today: DayKey, info: (text: string) => void, warn: (text: string) => void): void {
  const { eaten, eatenKgPerWeek: rate } = plan;
  if (eaten === null || rate === null) {
    info('Anota lo que comes unos días más (hacen falta 4 en las dos últimas semanas) y te diré si con ello llegarás a tu peso objetivo y cuándo.');
    return;
  }
  const lead = `Con lo que has comido estos últimos ${eaten.days} días (unas ${kcalRounded(eaten.avgKcal)}${NBSP}kcal al día, frente a unas ${kcalRounded(plan.maintenanceKcal)} de mantenimiento)`;
  const verb = plan.needs === 'lose' ? 'bajarías' : 'subirías';
  if (plan.eatenWeeks !== null) {
    info(`${lead} ${verb} unos ${kgWeek(Math.abs(rate))} a la semana: llegarías a ${kg(plan.targetKg)} en ${whenText(plan.eatenWeeks, today)}.`);
  } else if (Math.abs(rate) < STEADY_KG_PER_WEEK) {
    warn(`${lead} tu peso apenas cambiaría: comiendo así no llegarías a ${kg(plan.targetKg)}.`);
  } else {
    warn(`${lead} ${rate > 0 ? 'subirías' : 'bajarías'} unos ${kgWeek(Math.abs(rate))} a la semana, al revés de lo que buscas: comiendo así no llegarías a ${kg(plan.targetKg)}.`);
  }
}

/**
 * Lo que se le dice a la persona sobre su peso objetivo junto al objetivo de salud: cuánto le falta, si el objetivo de salud la lleva hasta allí, en
 * cuánto tiempo llegaría (con las calorías que se le proponen y, si hay pesadas suficientes, con el ritmo real de las últimas semanas) y un aviso si el
 * peso elegido es demasiado bajo. Las cifras son estimaciones y así se dicen («unas», «hacia»).
 */
export function weightGoalMessage(plan: WeightGoalPlan, goal: HealthGoal, today: DayKey): WeightGoalMessage {
  const message: WeightGoalMessage = { notes: [], suggestion: null };
  const info = (text: string): void => void message.notes.push({ text, tone: 'info' });
  const warn = (text: string): void => void message.notes.push({ text, tone: 'warn' });
  const offer = (target: HealthGoal): void => {
    message.suggestion = { goal: target, label: HEALTH_GOALS[target].label };
  };
  const label = HEALTH_GOALS[goal].label;

  if (plan.needs === 'reached') {
    const reached = `Ya estás en tu peso objetivo (${kg(plan.targetKg)}).`;
    if (plan.fit === 'reached') {
      info(`${reached} Para mantenerlo, el objetivo de salud adecuado es «${HEALTH_GOALS.maintain.label}».`);
      offer('maintain');
    } else if (goal === 'maintain') {
      info(`${reached} Mantenerlo es lo que buscas.`);
    } else {
      info(`${reached} Con «${label}» el peso puede quedarse quieto mientras cambia tu cuerpo.`);
    }
  } else {
    const missing = Math.abs(plan.deltaKg);
    info(`${missing === 1 ? 'Te falta' : 'Te faltan'} ${kg(missing)} para llegar a ${kg(plan.targetKg)} (tu último peso anotado: ${kg(plan.currentKg)}).`);
    const verb = plan.needs === 'lose' ? 'bajar' : 'subir';
    if (plan.fit === 'conflict' && plan.suggestedGoal) {
      warn(`«${label}» no te lleva a ${verb} esos kilos: ese objetivo de salud no apunta a tu peso objetivo.`);
      offer(plan.suggestedGoal);
    } else if (plan.plannedWeeks !== null) {
      info(`Comiendo lo que se te propone ${plan.needs === 'lose' ? 'bajarías' : 'subirías'} unos ${kgWeek(Math.abs(plan.plannedKgPerWeek))} a la semana: llegarías en ${whenText(plan.plannedWeeks, today)}.`);
    } else {
      info('Con las calorías que se te proponen tu peso apenas cambiaría, así que no se le puede poner fecha.');
    }
    eatenNotes(plan, today, info, warn);
    const trend = plan.measuredKgPerWeek;
    if (trend !== null) {
      if (Math.abs(trend) < STEADY_KG_PER_WEEK) {
        info('En las últimas semanas tu peso se ha mantenido estable.');
      } else if (plan.measuredWeeks !== null) {
        info(`Tu peso de las últimas semanas ${trend < 0 ? 'baja' : 'sube'} a un ritmo de unos ${kgWeek(Math.abs(trend))} a la semana: a ese ritmo llegarías en ${whenText(plan.measuredWeeks, today)}.`);
      } else {
        warn(`En las últimas semanas tu peso ${trend > 0 ? 'ha subido' : 'ha bajado'} a un ritmo de unos ${kgWeek(Math.abs(trend))} a la semana, al revés de lo que buscas.`);
      }
    }
  }

  // Un peso bajo es un aviso para quien baja hacia él; quien sube desde un peso aún más bajo ya va en la buena dirección.
  if (plan.needs !== 'gain' && plan.targetBmi !== null && plan.targetBmi < LOW_BMI) {
    warn(`${kg(plan.targetKg)} sería un IMC de ${fmtUpTo1(plan.targetBmi)}, por debajo de lo saludable (${fmtUpTo1(LOW_BMI)}). Mejor consúltalo con un profesional antes de buscarlo.`);
  }
  return message;
}
