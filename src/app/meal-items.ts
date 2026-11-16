import { isScalable, scaleIngredient, type DishIngredient } from '../domain/dishes';
import { itemsOfMeal, mealWithItems } from '../domain/meal-items';
import type { MealEntry, MealItem } from '../domain/nutrition';
import { saveMeal } from './actions';
import { splitMergedItem } from './dish-split';
import { savedDishes, showToast } from './state';

// Lo que lleva una comida YA anotada, para poder cambiar los gramos de cada alimento. Las comidas anotadas desde la ronda 49 guardan su desglose; las de antes se reconstruyen aquí al abrirlas
// (sin tocar nada hasta que la persona guarde un cambio): un plato guardado, por su receta; lo calculado con palabras o pesado, repartiendo el nombre «A + B + C» en sus alimentos como
// se hizo con los platos de antes (`app/dish-split.ts`); y todo lo demás, como un único alimento con su cantidad total.

/** La receta del plato con el que se anotó la comida, ajustada a las calorías que se anotaron (lo que se comió en total puede no ser la receta entera). */
function itemsOfDishMeal(meal: MealEntry): MealItem[] | null {
  if (meal.dishId === undefined) return null;
  const dish = savedDishes.value.find((candidate) => candidate.id === meal.dishId);
  if (dish === undefined) return null;
  const recipeKcal = dish.ingredients.reduce((sum, item) => sum + item.kcal, 0);
  if (!(recipeKcal > 0) || !(meal.kcal > 0)) return null;
  const factor = meal.kcal / recipeKcal;
  if (!(factor > 0.05 && factor < 20)) return null;
  return dish.ingredients.map((item): MealItem => (isScalable(item) ? scaleIngredient(item, Math.max(1, Math.round((item.grams as number) * factor * 10) / 10)) : { ...item }));
}

/** Los alimentos de una comida con sus gramos, o `null` si no hay forma de saber cuánto pesa (una comida a mano con solo las calorías). Nunca lanza. */
export async function loadMealItems(meal: MealEntry): Promise<MealItem[] | null> {
  if (meal.items !== undefined && meal.items.length > 0) return itemsOfMeal(meal);
  const fromDish = itemsOfDishMeal(meal);
  if (fromDish !== null) return fromDish;
  const merged: DishIngredient = { name: meal.name, kcal: meal.kcal, ...(meal.grams !== undefined ? { grams: meal.grams } : {}) };
  for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const) {
    const value = meal[key];
    if (value !== undefined) merged[key] = value;
  }
  const split = meal.barcode === undefined ? await splitMergedItem(merged) : null;
  if (split !== null && split.length > 1) return split;
  return itemsOfMeal(meal);
}

/** Guarda la comida con otros gramos. Devuelve la comida guardada, o `null` si no se pudo (y lo dice). */
export async function saveMealAmounts(meal: MealEntry, before: readonly MealItem[], after: readonly MealItem[]): Promise<MealEntry | null> {
  const next = mealWithItems(meal, before, after);
  if ('problem' in next) {
    showToast(next.problem, 'error');
    return null;
  }
  try {
    await saveMeal(next);
  } catch (error) {
    showToast(`No se pudo guardar el cambio${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
    return null;
  }
  showToast(`Cantidades cambiadas: ${Math.round(next.kcal).toLocaleString('es-ES')} kcal`);
  return next;
}
