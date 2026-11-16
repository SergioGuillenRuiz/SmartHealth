// La comida que se repite, y las recetas más sanas para ella con su valoración: lo que usa la hoja de detalles de una comida para ofrecer ideas (ver `domain/recipes.ts`).

import { addDays } from '../domain/dates';
import { mealDay } from '../domain/day-credit';
import { mealFit, type Criterion, type FitLevel } from '../domain/meal-fit';
import { REPEAT_WINDOW_DAYS, REPEATS_FOR_SUGGESTIONS, repeatsAround, sameMeal } from '../domain/meal-repeat';
import { nutritionTargets, type HealthGoal, type MealEntry, type NutritionTargets } from '../domain/nutrition';
import { familyOf, needsOf, rankRecipes, scaleRecipe, weakPoints, type ScaledRecipe } from '../domain/recipe-suggest';
import type { Recipe, RecipeFamily } from '../domain/recipes';
import { resolveProfile } from '../domain/summary';
import { draftOfAnalysis, estimateMealFromText } from './food-text';
import { targetOptions } from './personal';
import { svc } from './services';
import { profileHistory, settings } from './state';

/** Las metas del día al que cuenta una comida, con el perfil de ese día (lo mismo que enseña la tarjeta y la hoja de detalles). */
export function targetsForDay(day: string, goal: HealthGoal): NutritionTargets {
  return nutritionTargets(resolveProfile(profileHistory.value, day).profile, day, goal, targetOptions());
}

/**
 * Cuántas veces se ha repetido ESTA comida (la misma, no otras parecidas) estando poco adecuada, en la mejor semana que incluye su día: se miran los 6 días antes y después de
 * ella y cuentan las veces que se anotó la misma comida y salió «poco adecuada» con el objetivo de salud de ahora.
 */
export async function repeatsOf(meal: MealEntry): Promise<number> {
  const goal = settings.peek().healthGoal;
  const day = mealDay(meal);
  const found = await svc().store.listMealsByDay(addDays(day, -(REPEAT_WINDOW_DAYS - 1)), addDays(day, REPEAT_WINDOW_DAYS - 1));
  const all = found.some((candidate) => candidate.id === meal.id) ? found : [...found, meal];
  const days = [];
  for (const candidate of all) {
    if (candidate.id !== meal.id && !sameMeal(meal, candidate)) continue;
    const candidateDay = mealDay(candidate);
    if (mealFit(candidate, goal, targetsForDay(candidateDay, goal)).level === 'poor') days.push(candidateDay);
  }
  return repeatsAround(day, days);
}

/** ¿Toca ofrecer ideas con esta comida? Solo si está poco adecuada, es la misma que se ha repetido varias veces esa semana y la función está activada. */
export function shouldSuggest(level: FitLevel, repeats: number, enabled: boolean): boolean {
  return enabled && level === 'poor' && repeats >= REPEATS_FOR_SUGGESTIONS;
}

export interface RecipeResult {
  scaled: ScaledRecipe;
  kcal: number;
  proteinG: number;
  level: FitLevel;
  headline: string;
}

/** Calcula lo que lleva una receta con las cantidades de la persona (con la tabla de alimentos de la app) y cómo la valoraría para su objetivo; `null` si no se pudo calcular. */
export function evaluateRecipe(recipe: Recipe, goal: HealthGoal, targets: NutritionTargets): RecipeResult | null {
  const scaled = scaleRecipe(recipe, goal);
  const result = estimateMealFromText(scaled.text);
  if (result.status !== 'ok' || result.analysis.unknown.length > 0) return null;
  const draft = draftOfAnalysis(result.analysis);
  const kcal = Math.round(draft.kcal ?? 0);
  const proteinG = Math.round(draft.proteinG ?? 0);
  const fit = mealFit(
    {
      name: recipe.title,
      kcal,
      ...(draft.proteinG !== null ? { proteinG: draft.proteinG } : {}),
      ...(draft.carbsG !== null ? { carbsG: draft.carbsG } : {}),
      ...(draft.fatG !== null ? { fatG: draft.fatG } : {}),
      ...(draft.fiberG != null ? { fiberG: draft.fiberG } : {}),
      ...(draft.sugarsG != null ? { sugarsG: draft.sugarsG } : {}),
      ...(draft.saltG != null ? { saltG: draft.saltG } : {}),
    },
    goal,
    targets,
  );
  return { scaled, kcal, proteinG, level: fit.level, headline: fit.headline };
}

export interface MealAdvice {
  family: RecipeFamily;
  /** Lo que más pesa en la valoración de esta comida. */
  weak: Criterion[];
  results: RecipeResult[];
}

/** Todo lo que se le enseña a la persona de una comida que se repite: de qué tipo de plato es, qué le falla y las recetas más sanas de ese tipo ajustadas a su objetivo. */
export function adviceFor(meal: MealEntry, goal: HealthGoal): MealAdvice {
  const day = mealDay(meal);
  const targets = targetsForDay(day, goal);
  const fit = mealFit(meal, goal, targets);
  const family = familyOf(meal.name, meal);
  // El identificador de la comida es la «semilla»: cada vez que la misma comida se repite sale una selección distinta entre las que encajan igual de bien.
  const recipes = rankRecipes(family, meal.name, needsOf(meal, fit), 3, meal.id);
  const results = recipes.map((recipe) => evaluateRecipe(recipe, goal, targets)).filter((result): result is RecipeResult => result !== null);
  return { family, weak: weakPoints(fit), results };
}
