import { mergedPartNames, splitMergedIngredient, type DishIngredient, type MergedPart, type SavedDish } from '../domain/dishes';
import { estimateMealFromText, foodTable } from './food-text';
import { productLookup, withOwnProducts } from './food-db';
import { svc } from './services';

// Los platos guardados antes de la ronda 46 llevan lo calculado con palabras o pesado en la báscula como UN ingrediente («Pollo (crudo) + Polvos ajo y limón + Aceite de oliva + …»), y al anotarlos
// solo se podían cambiar los gramos del total. Aquí se les vuelve a repartir en sus alimentos, cada uno con sus gramos (la matemática está en `domain/dishes.ts: splitMergedIngredient`); lo único
// que hace falta de la app es saber qué lleva cada alimento por 100 g, que sale de la tabla de alimentos, la base de productos y los productos de la persona, como al calcularlo con palabras.

const norm = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*·\s*/g, ' ')
    .replace(/\s*×\s*\d+(?:[.,]\d+)?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Lo que lleva por 100 g un alimento de un ingrediente juntado, buscado por su nombre, o `null` si no se reconoce IGUAL que cuando se juntó (no se adivina). Primero en la tabla de
 * alimentos por su nombre exacto («Pollo (crudo)», que escrito como texto se entendería otra cosa); y si no, como producto de la base o de los que enseñó la persona, que sí se encuentran
 * por las palabras de su nombre.
 */
async function partOf(name: string, lookup: Parameters<typeof estimateMealFromText>[1]): Promise<MergedPart | null> {
  const wanted = norm(name);
  const entry = foodTable().find((food) => !food.ignore && food.recipe === null && norm(food.name) === wanted);
  if (entry !== undefined) {
    return {
      name,
      per100: { kcal: entry.kcal, proteinG: entry.proteinG, carbsG: entry.carbsG, fatG: entry.fatG, fiberG: entry.fiberG, sugarsG: entry.sugarsG, saltG: entry.saltG },
      usualG: entry.serving > 0 ? entry.serving : 100,
    };
  }
  // Como texto: «Pollo (crudo)» se escribe «pollo crudo» (el paréntesis lo pone la app al cocinarlo de otra forma) y «Marca Producto · Marca» se busca por sus palabras.
  const spoken = name.replace(/\s*·\s*/g, ' ').replace(/\s*\(([^)]*)\)/g, ' $1');
  for (const text of new Set([spoken, name.replace(/\s*·\s*/g, ' ')])) {
    const result = estimateMealFromText(text, lookup);
    if (result.status !== 'ok' || result.analysis.items.length !== 1 || result.analysis.unknown.length > 0) continue;
    const item = result.analysis.items[0];
    if (item === undefined || item.kcalOnly === true || !(item.amount > 0) || norm(item.name) !== wanted) continue;
    const per = (value: number): number => (value / item.amount) * 100;
    return {
      name,
      per100: {
        kcal: per(item.kcal),
        proteinG: per(item.proteinG),
        carbsG: per(item.carbsG),
        fatG: per(item.fatG),
        ...(item.fiberG !== undefined ? { fiberG: per(item.fiberG) } : {}),
        ...(item.sugarsG !== undefined ? { sugarsG: per(item.sugarsG) } : {}),
        ...(item.saltG !== undefined ? { saltG: per(item.saltG) } : {}),
      },
      usualG: item.amount,
    };
  }
  return null;
}

/** ¿Algún ingrediente de este plato es de los juntados? */
export const hasMergedIngredient = (dish: Pick<SavedDish, 'ingredients'>): boolean => dish.ingredients.some((item) => mergedPartNames(item) !== null);

/**
 * Un alimento juntado de UNA comida anotada («Pollo (crudo) + Aceite de oliva + Arroz») repartido en sus alimentos, cada uno con sus gramos, o `null` si no lo parece o no cuadra. Es el mismo
 * reparto que el de los platos, para poder cambiar los gramos de lo ya anotado ingrediente a ingrediente. Nunca lanza.
 */
export async function splitMergedItem(item: DishIngredient): Promise<DishIngredient[] | null> {
  const names = mergedPartNames(item);
  if (names === null) return null;
  try {
    const own = await svc().store.listProducts().catch(() => []);
    const lookup = withOwnProducts(await productLookup(), own) ?? undefined;
    const parts = await Promise.all(names.map((name) => partOf(name, lookup)));
    return parts.every((part): part is MergedPart => part !== null) ? splitMergedIngredient(item, parts) : null;
  } catch {
    return null;
  }
}

/** El plato con sus ingredientes juntados repartidos, o `null` si no había ninguno o ninguno se pudo repartir. Nunca lanza. */
export async function splitDishIngredients(dish: SavedDish): Promise<SavedDish | null> {
  if (!hasMergedIngredient(dish)) return null;
  try {
    const own = await svc().store.listProducts().catch(() => []);
    const lookup = withOwnProducts(await productLookup(), own) ?? undefined;
    const ingredients: DishIngredient[] = [];
    let changed = false;
    for (const item of dish.ingredients) {
      const names = mergedPartNames(item);
      const parts = names === null ? null : await Promise.all(names.map((name) => partOf(name, lookup)));
      const split = parts !== null && parts.every((part): part is MergedPart => part !== null) ? splitMergedIngredient(item, parts) : null;
      if (split === null) ingredients.push(item);
      else {
        ingredients.push(...split);
        changed = true;
      }
    }
    return changed ? { ...dish, ingredients } : null;
  } catch {
    return null;
  }
}

/** Los platos que ya se intentó repartir en esta sesión (con su última modificación): un plato que no se pudo no se vuelve a intentar a cada lectura. */
const attempted = new Set<string>();

/**
 * Reparte los ingredientes juntados de los platos que haya y guarda el resultado. Devuelve los platos cambiados. Un fallo al guardar deja el plato como estaba (se vuelve a intentar al abrir
 * la app otra vez).
 */
export async function migrateMergedDishes(dishes: readonly SavedDish[]): Promise<SavedDish[]> {
  const changed: SavedDish[] = [];
  for (const dish of dishes) {
    const key = `${dish.id}:${dish.updatedMs}`;
    if (attempted.has(key) || !hasMergedIngredient(dish)) continue;
    attempted.add(key);
    const split = await splitDishIngredients(dish);
    if (split === null) continue;
    const next: SavedDish = { ...split, updatedMs: svc().now() };
    try {
      await svc().store.putDish(next);
      changed.push(next);
    } catch {
      /* se deja como estaba */
    }
  }
  return changed;
}

/** Solo para las pruebas: olvida lo ya intentado. */
export const forgetAttemptedSplits = (): void => attempted.clear();
