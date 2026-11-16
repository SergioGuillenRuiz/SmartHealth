import { roundTo } from './food-label';
import type { TextItem } from './food-text';
import { buildMeal, MAX_MEAL_KCAL, MAX_MEAL_NAME, MAX_MEAL_NUTRIENT_G, validateMealDraft, type MealDraft, type MealEntry } from './nutrition';

// Platos guardados: una preparación que se repite (unas lentejas, un bocadillo de siempre, un batido) con sus ingredientes, para anotarla de una vez sin escribirla de cero cada
// vez. Cada ingrediente es una comida suelta (a mano, de un código de barras o calculada con palabras) con su cantidad en gramos, y el plato es su suma. Al anotarlo se elige
// cuántos gramos se han comido de CADA ingrediente (los de la receta vienen puestos): lo demás se calcula por regla de tres. Todo son ESTIMACIONES, como el resto de la alimentación.

export const MAX_DISH_NAME = 80;
/** Cuántos ingredientes admite un plato: sobra para cualquier receta y acota lo que una copia estropeada puede traer. */
export const MAX_DISH_INGREDIENTS = 60;
/** Lo máximo que se puede anotar de un ingrediente de una vez (g o ml): sobra para cualquier plato y acota lo que una copia estropeada puede traer. */
export const MAX_INGREDIENT_G = 10_000;
/** La foto de un plato va dentro de él como una imagen JPEG en texto (`data:`): no pasa de esto (una foto de 480 px pesa 25–45 KB). */
export const MAX_DISH_PHOTO_CHARS = 200_000;
export const PHOTO_PREFIX = 'data:image/jpeg;base64,';

/** Un ingrediente: lo mismo que una comida anotada, sin hora ni origen. Ausente = «sin dato», no cero. */
export interface DishIngredient {
  name: string;
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  /** Cantidad en gramos (o mililitros) de la receta: sobre ella se calcula lo que sale al comer otra cantidad. Los ingredientes de antes de las cantidades pueden no tenerla (entonces no se escalan). */
  grams?: number;
  /** Código de barras, si salió de un producto. */
  barcode?: string;
}

export interface SavedDish {
  id: string;
  name: string;
  createdMs: number;
  updatedMs: number;
  /** Cuándo se anotó por última vez: ordena la barra (lo más reciente primero). */
  lastUsedMs?: number;
  ingredients: DishIngredient[];
  /** Foto para reconocerlo (`data:image/jpeg;base64,…`). */
  photo?: string;
}

/** Lo que suman los ingredientes. Los extras (fibra, azúcares, sal) solo llevan lo de los ingredientes que los traían; `grams` solo si se sabe lo que pesan todos. */
export interface DishTotals {
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  grams?: number;
}

const sumOf = (items: readonly DishIngredient[], key: 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarsG' | 'saltG'): number | undefined => {
  let any = false;
  let total = 0;
  for (const item of items) {
    const value = item[key];
    if (value === undefined) continue;
    any = true;
    total += value;
  }
  return any ? total : undefined;
};

/** La suma de los ingredientes del plato entero (sin redondear: se redondea al anotar). */
export function dishTotals(ingredients: readonly DishIngredient[]): DishTotals {
  const totals: DishTotals = { kcal: ingredients.reduce((sum, item) => sum + item.kcal, 0) };
  for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const) {
    const value = sumOf(ingredients, key);
    if (value !== undefined) totals[key] = value;
  }
  if (ingredients.length > 0 && ingredients.every((item) => item.grams !== undefined)) totals.grams = ingredients.reduce((sum, item) => sum + (item.grams ?? 0), 0);
  return totals;
}

/** Las calorías de la receta entera tal como está guardada. */
export const dishKcal = (dish: Pick<SavedDish, 'ingredients'>): number => Math.round(dishTotals(dish.ingredients).kcal);

/** Un ingrediente a partir de un borrador y lo que se sepa de su cantidad: redondeado como una comida y con nombre «Ingrediente» si no lo tiene. */
export function ingredientOf(draft: MealDraft, extra: { grams?: number; barcode?: string } = {}): DishIngredient {
  const meal = buildMeal({ ...draft, name: draft.name.trim() === '' ? 'Ingrediente' : draft.name }, { id: 'ingredient', tsMs: 0, source: 'manual', ...extra });
  return {
    name: meal.name,
    kcal: meal.kcal,
    ...(meal.proteinG !== undefined ? { proteinG: meal.proteinG } : {}),
    ...(meal.carbsG !== undefined ? { carbsG: meal.carbsG } : {}),
    ...(meal.fatG !== undefined ? { fatG: meal.fatG } : {}),
    ...(meal.fiberG !== undefined ? { fiberG: meal.fiberG } : {}),
    ...(meal.sugarsG !== undefined ? { sugarsG: meal.sugarsG } : {}),
    ...(meal.saltG !== undefined ? { saltG: meal.saltG } : {}),
    ...(meal.grams !== undefined ? { grams: meal.grams } : {}),
    ...(meal.barcode !== undefined ? { barcode: meal.barcode } : {}),
  };
}

/** Lo que falla en un plato a punto de guardarse (vacío si está bien). */
export function validateDish(input: { name: string; ingredients: readonly DishIngredient[] }): string[] {
  const problems: string[] = [];
  if (input.name.trim() === '') problems.push('Ponle un nombre al plato.');
  else if (input.name.trim().length > MAX_DISH_NAME) problems.push(`El nombre admite como mucho ${MAX_DISH_NAME} letras.`);
  if (input.ingredients.length === 0) problems.push('Añade al menos un ingrediente.');
  if (input.ingredients.length > MAX_DISH_INGREDIENTS) problems.push(`Un plato admite como mucho ${MAX_DISH_INGREDIENTS} ingredientes.`);
  return problems;
}

/** Si el ingrediente se puede escalar: sabe cuántos gramos lleva la receta. */
export const isScalable = (item: Pick<DishIngredient, 'grams'>): boolean => item.grams !== undefined && item.grams > 0;

/** `item` con la cantidad `grams` en vez de la de la receta: todo en proporción (regla de tres). Uno sin cantidad en la receta se queda como está. */
export function scaleIngredient(item: DishIngredient, grams: number): DishIngredient {
  if (!isScalable(item)) return item;
  const factor = grams / (item.grams as number);
  const scaled: DishIngredient = { name: item.name, kcal: item.kcal * factor, grams };
  for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const) {
    const value = item[key];
    if (value !== undefined) scaled[key] = value * factor;
  }
  if (item.barcode !== undefined) scaled.barcode = item.barcode;
  return scaled;
}

/**
 * Los ingredientes de lo que se ha comido: cada uno con los gramos de `grams` (en el mismo orden que los del plato; `null` = sin cantidad válida) o, si el ingrediente no
 * tiene cantidad en la receta, tal cual. Un ingrediente con 0 g no entra (hoy no lo he puesto).
 */
export function portionOf(dish: Pick<SavedDish, 'ingredients'>, grams: ReadonlyArray<number | null>): DishIngredient[] {
  return dish.ingredients.flatMap((item, i) => {
    if (!isScalable(item)) return [item];
    const amount = grams[i] ?? item.grams ?? 0;
    return amount > 0 ? [scaleIngredient(item, amount)] : [];
  });
}

/** Las cantidades de la receta, para empezar a anotar: lo que dice cada ingrediente (`null` si no tiene). */
export const recipeGrams = (dish: Pick<SavedDish, 'ingredients'>): Array<number | null> => dish.ingredients.map((item) => (isScalable(item) ? (item.grams as number) : null));

/** El borrador de la comida que sale de comer esas cantidades del plato. */
export function mealDraftOfDish(dish: Pick<SavedDish, 'name' | 'ingredients'>, grams: ReadonlyArray<number | null>): { draft: MealDraft; grams?: number } {
  const totals = dishTotals(portionOf(dish, grams));
  const round = (value: number | undefined): number | null | undefined => (value === undefined ? undefined : roundTo(value, 2));
  return {
    draft: {
      name: dish.name.slice(0, MAX_MEAL_NAME),
      kcal: Math.round(totals.kcal),
      proteinG: round(totals.proteinG) ?? null,
      carbsG: round(totals.carbsG) ?? null,
      fatG: round(totals.fatG) ?? null,
      fiberG: round(totals.fiberG),
      sugarsG: round(totals.sugarsG),
      saltG: round(totals.saltG),
    },
    ...(totals.grams !== undefined && totals.grams > 0 && totals.grams <= 100_000 ? { grams: roundTo(totals.grams, 1) } : {}),
  };
}

/**
 * Lo calculado con palabras o pesado en la báscula (varios alimentos: «200 g de arroz y 150 g de pollo»), como ingredientes SUELTOS de un plato: cada alimento con sus gramos, para poder
 * cambiarlos uno a uno al comer el plato. Hasta la ronda 46 todo se juntaba en UN ingrediente con la suma de los gramos y solo se podía cambiar el total. Un plato compuesto de la tabla
 * («kebab de ternera con cebolla»: `parts`) se reparte en sus piezas. Lo que solo trae calorías dichas (`kcalOnly`) no sabe cuánto pesa: entra sin gramos (fijo, no se escala).
 */
export function ingredientsOfItems(items: readonly TextItem[]): DishIngredient[] {
  const out: DishIngredient[] = [];
  const round = (value: number | undefined): number | undefined => (value === undefined ? undefined : roundTo(value, 2));
  const visit = (item: TextItem): void => {
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) visit(part);
      return;
    }
    const ingredient: DishIngredient = { name: item.name.trim() === '' ? 'Ingrediente' : item.name.slice(0, MAX_MEAL_NAME), kcal: Math.round(item.kcal) };
    for (const [key, value] of [
      ['proteinG', item.proteinG],
      ['carbsG', item.carbsG],
      ['fatG', item.fatG],
      ['fiberG', item.fiberG],
      ['sugarsG', item.sugarsG],
      ['saltG', item.saltG],
    ] as const) {
      const rounded = round(value);
      if (rounded !== undefined) ingredient[key] = rounded;
    }
    if (item.kcalOnly !== true && item.amount > 0) ingredient.grams = Math.min(MAX_INGREDIENT_G, roundTo(item.amount, 1));
    out.push(ingredient);
  };
  for (const item of items) visit(item);
  return out;
}

/** Lo que impide anotar esas cantidades (una vacía o pasada de rango, nada que comer, cifras que no caben en una comida), o `null` si se puede. */
export function mealProblemOfDish(dish: Pick<SavedDish, 'name' | 'ingredients'>, grams: ReadonlyArray<number | null>): string | null {
  for (let i = 0; i < dish.ingredients.length; i++) {
    const item = dish.ingredients[i] as DishIngredient;
    if (!isScalable(item)) continue;
    const amount = grams[i];
    if (amount === null || amount === undefined || !Number.isFinite(amount) || amount < 0) return `Indica los gramos de ${item.name}.`;
    if (amount > MAX_INGREDIENT_G) return `${item.name}: como mucho ${MAX_INGREDIENT_G.toLocaleString('es-ES')} g.`;
  }
  const eaten = portionOf(dish, grams);
  if (eaten.length === 0) return 'Pon algún ingrediente: con todo a 0 g no hay nada que anotar.';
  const { draft } = mealDraftOfDish(dish, grams);
  if (validateMealDraft(draft).length > 0) {
    return `Con esas cantidades salen más de ${MAX_MEAL_KCAL.toLocaleString('es-ES')} kcal o ${MAX_MEAL_NUTRIENT_G.toLocaleString('es-ES')} g de un nutriente: baja alguna.`;
  }
  return null;
}

/** La comida que se anota al comer esas cantidades del plato. */
export function mealOfDish(dish: Pick<SavedDish, 'id' | 'name' | 'ingredients'>, grams: ReadonlyArray<number | null>, extra: { id: string; tsMs: number }): MealEntry {
  const { draft, grams: total } = mealDraftOfDish(dish, grams);
  // Con el id del plato: su foto (si la tiene) es la miniatura de la comida en la lista del día.
  return buildMeal(draft, { id: extra.id, tsMs: extra.tsMs, source: 'dish', dishId: dish.id, ...(total !== undefined ? { grams: total } : {}), items: portionOf(dish, grams) });
}

/**
 * Un plato como lo guardaba la versión con raciones (`servings`): los ingredientes sumaban para `servings` raciones. Se pasa a una ración (cada ingrediente entre las raciones) y se
 * descarta el campo, para que al anotarlo salgan las cantidades de una ración, como antes. Un plato sin `servings`, o de una sola ración, se queda igual.
 */
export function withoutServings<T extends SavedDish & { servings?: number }>(dish: T): SavedDish {
  const { servings, ...rest } = dish;
  if (servings === undefined || !(servings > 1)) return rest;
  const div = (value: number | undefined, decimals: number): number | undefined => (value === undefined ? undefined : roundTo(value / servings, decimals));
  return {
    ...rest,
    ingredients: rest.ingredients.map((item): DishIngredient => {
      const out: DishIngredient = { name: item.name, kcal: Math.round(item.kcal / servings) };
      for (const key of ['proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const) {
        const value = div(item[key], 2);
        if (value !== undefined) out[key] = value;
      }
      const grams = div(item.grams, 1);
      if (grams !== undefined && grams > 0) out.grams = grams;
      if (item.barcode !== undefined) out.barcode = item.barcode;
      return out;
    }),
  };
}

/** La foto de un plato si es una imagen que la app admite (JPEG en texto y de un tamaño razonable): lo demás se ignora. */
export const isPhoto = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PHOTO_PREFIX) && value.length <= MAX_DISH_PHOTO_CHARS && /^[A-Za-z0-9+/=]+$/.test(value.slice(PHOTO_PREFIX.length));

/** Los platos de la barra: el último que se anotó primero y, entre los que nunca se anotaron, el más reciente. */
export const sortDishes = (dishes: readonly SavedDish[]): SavedDish[] =>
  [...dishes].sort((a, b) => (b.lastUsedMs ?? b.createdMs) - (a.lastUsedMs ?? a.createdMs) || a.name.localeCompare(b.name, 'es'));

// ───────────────────────── platos de antes de la ronda 46: ingredientes juntados ─────────────────────────
//
// Hasta la ronda 46 lo calculado con palabras o pesado en la báscula entraba en un plato como UN ingrediente: «Pollo (crudo) + Polvos ajo y limón + Aceite de oliva + Sabroz Arroz Basmati» con la
// suma de los gramos (352 g) y las calorías y nutrientes de todos juntos. La app no guardó cuánto pesaba cada uno, pero sí QUÉ eran (el nombre) y lo que sumaban: con lo que lleva cada alimento
// por 100 g se pueden volver a repartir los gramos de manera que sumen justo lo guardado. Es una reconstrucción, y se hace solo cuando cuadra: si algún nombre no se reconoce igual que entonces
// o las cifras no salen, el ingrediente se deja como estaba.

/** Un alimento del que se sabe lo que lleva por 100 g y cuánto suele pesar una ración (para repartir bien lo que casi no pesa, como las especias). */
export interface MergedPart {
  /** Como se llama en el ingrediente juntado (sin «×2»). */
  name: string;
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG?: number; sugarsG?: number; saltG?: number };
  /** Una ración habitual, en gramos: solo desempata cuando las cifras no bastan para saber cuánto pesa algo. */
  usualG: number;
}

const SPLIT_SEPARATOR = ' + ';
const MAX_MERGED_PARTS = 8;
/** Lo que se puede desviar lo reconstruido de lo guardado para fiarse de ello (relativo, con un mínimo absoluto). */
const MERGE_TOLERANCE = 0.08;

/** Los nombres de los alimentos de un ingrediente juntado (sin la marca «×2»), o `null` si no lo parece. */
export function mergedPartNames(item: Pick<DishIngredient, 'name' | 'barcode'>): string[] | null {
  if (item.barcode !== undefined || !item.name.includes(SPLIT_SEPARATOR)) return null;
  const names = item.name.split(SPLIT_SEPARATOR).map((part) => part.replace(/\s*×\s*\d+(?:[.,]\d+)?\s*$/, '').trim());
  return names.length >= 2 && names.length <= MAX_MERGED_PARTS && names.every((name) => name !== '') ? names : null;
}

/**
 * Reparte un ingrediente juntado en sus alimentos, cada uno con sus gramos. `parts` son esos alimentos EN EL MISMO ORDEN que los nombres. Busca los gramos (no negativos) que mejor explican
 * las calorías, las proteínas, los hidratos, las grasas y el peso total que se guardaron, tirando un poco hacia una ración habitual de cada uno cuando las cifras no bastan; y reescala el
 * resultado para que las calorías sumen EXACTAMENTE las guardadas. `null` si no cuadra (más de un 8 % de desviación): entonces no se toca nada.
 */
export function splitMergedIngredient(item: DishIngredient, parts: readonly MergedPart[]): DishIngredient[] | null {
  const names = mergedPartNames(item);
  if (names === null || parts.length !== names.length || item.kcal <= 0) return null;
  if (parts.some((part) => !(part.per100.kcal >= 0) || !(part.usualG > 0))) return null;

  // Una ecuación por cada cifra guardada: Σ gramos_i × (lo que lleva i por gramo) = lo guardado, con peso relativo (un 5 % de error pesa igual en las calorías que en las grasas).
  interface Equation {
    perGram: number[];
    target: number;
    weight: number;
  }
  const equations: Equation[] = [];
  const add = (target: number | undefined, pick: (part: MergedPart) => number, minimum: number, weight = 1): void => {
    if (target === undefined) return;
    equations.push({ perGram: parts.map((part) => pick(part) / 100), target, weight: weight / Math.max(target, minimum) });
  };
  add(item.kcal, (p) => p.per100.kcal, 50);
  add(item.proteinG, (p) => p.per100.proteinG, 5);
  add(item.carbsG, (p) => p.per100.carbsG, 5);
  add(item.fatG, (p) => p.per100.fatG, 5);
  // El peso total es lo más fiable que se guardó (lo dijo la persona o lo marcó la báscula): pesa el doble.
  if (item.grams !== undefined && item.grams > 0) equations.push({ perGram: parts.map(() => 1), target: item.grams, weight: 2 / item.grams });
  if (equations.length < 3) return null;

  // Mínimos cuadrados con g ≥ 0 por descenso de coordenadas, con un tirón suave hacia la ración habitual de cada alimento (desempata lo que casi no pesa).
  const n = parts.length;
  const pull = 0.02;
  const gram: number[] = parts.map((part) => part.usualG);
  for (let round = 0; round < 400; round++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let numerator = 0;
      let denominator = 0;
      for (const eq of equations) {
        const a = eq.perGram[i] as number;
        let rest = 0;
        for (let j = 0; j < n; j++) if (j !== i) rest += (eq.perGram[j] as number) * (gram[j] as number);
        numerator += eq.weight * eq.weight * a * (eq.target - rest);
        denominator += eq.weight * eq.weight * a * a;
      }
      const usual = (parts[i] as MergedPart).usualG;
      numerator += (pull * usual) / (usual * usual);
      denominator += pull / (usual * usual);
      const next = Math.max(0, denominator > 0 ? numerator / denominator : 0);
      moved = Math.max(moved, Math.abs(next - (gram[i] as number)));
      gram[i] = next;
    }
    if (moved < 1e-6) break;
  }

  // ¿Cuadra? Cada cifra guardada, dentro de la tolerancia (o de unas décimas si es pequeña).
  for (const eq of equations) {
    const got = eq.perGram.reduce((sum, a, i) => sum + a * (gram[i] as number), 0);
    const slack = Math.max(MERGE_TOLERANCE * eq.target, eq.target === item.kcal ? 5 : 1.5);
    if (Math.abs(got - eq.target) > slack) return null;
  }
  const total = parts.reduce((sum, part, i) => sum + (part.per100.kcal / 100) * (gram[i] as number), 0);
  if (!(total > 0)) return null;
  // Lo que pesa cada uno sale en gramos con un decimal; las calorías (y lo demás) se reescalan para que sumen lo guardado.
  const factor = item.kcal / total;
  const kept = parts.map((_, i) => i).filter((i) => Math.min(MAX_INGREDIENT_G, (gram[i] as number) * factor) >= 0.5); // un alimento que sale sin peso no estaba (o no se reconoce igual): fuera de la cuenta
  // Las calorías de cada uno son enteras y SUMAN las guardadas (el redondeo se reparte por el mayor resto).
  const exact = new Map(kept.map((i) => [i, ((parts[i] as MergedPart).per100.kcal / 100) * Math.min(MAX_INGREDIENT_G, (gram[i] as number) * factor)]));
  const whole = new Map([...exact].map(([i, value]) => [i, Math.floor(value)]));
  let missing = Math.round(item.kcal) - [...whole.values()].reduce((sum, value) => sum + value, 0);
  for (const [i] of [...exact].sort((a, b) => (b[1] - Math.floor(b[1])) - (a[1] - Math.floor(a[1])))) {
    if (missing <= 0) break;
    whole.set(i, (whole.get(i) as number) + 1);
    missing--;
  }
  const out: DishIngredient[] = [];
  for (const i of kept) {
    const part = parts[i] as MergedPart;
    const g = Math.min(MAX_INGREDIENT_G, (gram[i] as number) * factor);
    const scale = (value: number): number => roundTo((value / 100) * g, 2);
    const ingredient: DishIngredient = {
      name: (names[i] as string).slice(0, MAX_MEAL_NAME),
      kcal: whole.get(i) as number,
      proteinG: scale(part.per100.proteinG),
      carbsG: scale(part.per100.carbsG),
      fatG: scale(part.per100.fatG),
      grams: roundTo(g, 1),
    };
    for (const key of ['fiberG', 'sugarsG', 'saltG'] as const) {
      const per100 = part.per100[key];
      if (per100 !== undefined) ingredient[key] = scale(per100);
    }
    out.push(ingredient);
  }
  return out.length >= 2 ? out : null;
}
