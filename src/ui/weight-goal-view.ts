import { recentIntake, targetOptions } from '../app/personal';
import { nowMs, profileHistory } from '../app/state';
import { dayKeyOf, type DayKey } from '../domain/dates';
import { nutritionTargets, type HealthGoal } from '../domain/nutrition';
import { weightSeries } from '../domain/profile';
import { resolveProfile } from '../domain/summary';
import { trendDaysKnown, weightGoalPlan, weightTrendKgPerWeek, type WeightGoalPlan } from '../domain/weight-goal';
import { weightGoalMessage, type WeightGoalMessage } from './user/weight-goal-text';
import { weightGoalVisual, type WeightGoalVisual } from './health/weight-goal-visual';

/** El plan hacia el peso objetivo con los datos de ahora, o `null` si aún no ha completado sus datos (con valores genéricos no se puede decir nada). Leerlo suscribe a quien pinta. */
function weightGoalPlanNow(goal: HealthGoal, target: number): { plan: WeightGoalPlan; today: DayKey; firstKg: number | null } | null {
  const history = profileHistory.value;
  const today = dayKeyOf(nowMs.value);
  const { profile, generic } = resolveProfile(history, today);
  if (generic) return null;
  const targets = nutritionTargets(profile, today, goal, targetOptions());
  const weights = weightSeries(history).map((w) => ({ day: w.date, kg: w.weightKg }));
  return {
    today,
    firstKg: weights[0]?.kg ?? null,
    plan: weightGoalPlan({
      currentKg: profile.weightKg,
      targetKg: target,
      goal,
      maintenanceKcal: targets.maintenanceKcal,
      plannedKcal: targets.kcal,
      trendKgPerWeek: weightTrendKgPerWeek(weights, today),
      trendDays: trendDaysKnown(weights, today),
      eaten: recentIntake.value,
      heightCm: profile.heightCm,
    }),
  };
}

/**
 * Lo que se le dice a la persona sobre su peso objetivo ahora mismo (cuánto le falta, si con lo que come llegará y cuándo, si el objetivo de salud la lleva allí), o `null`
 * si aún no ha completado sus datos. Es el texto de «Objetivos y medición»; la pestaña Salud lo enseña dibujado (`weightGoalVisualNow`).
 */
export function weightGoalMessageNow(goal: HealthGoal, target: number): WeightGoalMessage | null {
  const now = weightGoalPlanNow(goal, target);
  return now === null ? null : weightGoalMessage(now.plan, goal, now.today);
}

/** Lo mismo, en cifras y dibujos, para el bloque de Salud (`null`: faltan los datos de la persona). */
export function weightGoalVisualNow(goal: HealthGoal, target: number): WeightGoalVisual | null {
  const now = weightGoalPlanNow(goal, target);
  return now === null ? null : weightGoalVisual(now.plan, goal, now.today, now.firstKg);
}
