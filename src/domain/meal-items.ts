import { isScalable, mealDraftOfDish, scaleIngredient } from './dishes';
import { buildMeal, MAX_MEAL_NAME, validateMealDraft, type MealEntry, type MealItem } from './nutrition';
import { roundTo } from './food-label';
import { isEditableAmount, MAX_EDIT_AMOUNT, MIN_EDIT_AMOUNT } from './text-edit';

// Cambiar los gramos de lo YA anotado, alimento a alimento. Una comida guarda lo que lleva (`MealEntry.items`: cada alimento con sus gramos y sus cifras para esos gramos) y aquí se
// cambia la cantidad de uno con la regla de tres —lo mismo que al comer un plato guardado— y se rehace la comida sumando lo que queda. Las comidas anotadas antes de que se guardara
// el desglose se reconstruyen al abrirlas (`app/meal-items.ts`).

export { MAX_EDIT_AMOUNT, MIN_EDIT_AMOUNT };

/** El alimento con sus cifras redondeadas como se guardan (las calorías enteras, los gramos con una décima, la sal con dos decimales). */
function tidy(item: MealItem): MealItem {
  const out: MealItem = { name: item.name, kcal: Math.round(item.kcal) };
  for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG'] as const) {
    const value = item[key];
    if (value !== undefined) out[key] = roundTo(value, 1);
  }
  if (item.saltG !== undefined) out.saltG = roundTo(item.saltG, 2);
  if (item.grams !== undefined) out.grams = roundTo(item.grams, 1);
  if (item.barcode !== undefined) out.barcode = item.barcode;
  return out;
}

/**
 * Lo que lleva una comida, si se sabe: lo que se guardó con ella o, en una comida de antes que solo recuerda su cantidad total, ella entera como un único alimento (sus gramos y sus cifras).
 * `null` si no hay forma de saber cuánto pesa (una comida anotada a mano con solo las calorías): no hay gramos que cambiar.
 */
export function itemsOfMeal(meal: MealEntry): MealItem[] | null {
  if (meal.items !== undefined && meal.items.length > 0) return meal.items.map((item) => ({ ...item }));
  if (meal.grams === undefined || !(meal.grams > 0)) return null;
  const whole: MealItem = { name: meal.name, kcal: meal.kcal, grams: meal.grams };
  for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const) {
    const value = meal[key];
    if (value !== undefined) whole[key] = value;
  }
  if (meal.barcode !== undefined) whole.barcode = meal.barcode;
  return [whole];
}

/** ¿Hay algún alimento al que se le puedan cambiar los gramos? */
export const canEditAmounts = (items: readonly MealItem[] | null): items is readonly MealItem[] => items !== null && items.some((item) => isScalable(item));

/** La lista con otra cantidad para el alimento `index` (regla de tres). Si la cantidad no es válida, o ese alimento no tiene gramos de los que partir, queda igual. */
export function setItemGrams(items: readonly MealItem[], index: number, grams: number): MealItem[] {
  const item = items[index];
  if (item === undefined || !isScalable(item) || !isEditableAmount(grams)) return [...items];
  return items.map((entry, i) => (i === index ? tidy(scaleIngredient(entry, grams)) : entry));
}

/** La lista sin el alimento `index`. */
export const removeItemAt = (items: readonly MealItem[], index: number): MealItem[] => items.filter((_, i) => i !== index);

/** El nombre que se pone a una comida cuya lista de alimentos se calculó (su nombre es los de sus alimentos unidos con « + »). */
const joinedNames = (items: readonly MealItem[]): string => items.map((item) => item.name).join(' + ').slice(0, MAX_MEAL_NAME);

/**
 * La comida rehecha con esta lista de alimentos: mismo id, hora, día y origen; calorías, nutrientes y gramos, la suma de lo que lleva. Si su nombre era el de sus alimentos unidos, se
 * rehace con los que quedan. `{ problem }` si no se puede (sin alimentos, o con cifras que no caben en una comida).
 */
export function mealWithItems(meal: MealEntry, before: readonly MealItem[], after: readonly MealItem[]): MealEntry | { problem: string } {
  if (after.length === 0) return { problem: 'Deja al menos un alimento (o borra la comida).' };
  const { draft, grams } = mealDraftOfDish({ name: meal.name, ingredients: after.map(tidy) }, after.map((item) => item.grams ?? null));
  const renamed = meal.name === joinedNames(before) && joinedNames(after) !== '' ? joinedNames(after) : meal.name;
  const problems = validateMealDraft({ ...draft, name: renamed });
  if (problems.length > 0) return { problem: 'Con esas cantidades salen cifras demasiado grandes para una comida: baja alguna.' };
  const rebuilt = buildMeal(
    { ...draft, name: renamed },
    {
      id: meal.id,
      tsMs: meal.tsMs,
      source: meal.source,
      ...(meal.barcode !== undefined ? { barcode: meal.barcode } : {}),
      ...(meal.dishId !== undefined ? { dishId: meal.dishId } : {}),
      ...(grams !== undefined ? { grams } : {}),
      items: after.map(tidy),
    },
  );
  return meal.day !== undefined ? { ...rebuilt, day: meal.day } : rebuilt;
}
