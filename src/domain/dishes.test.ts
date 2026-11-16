import { describe, expect, it } from 'vitest';
import {
  dishKcal,
  dishTotals,
  ingredientOf,
  ingredientsOfItems,
  isPhoto,
  MAX_DISH_NAME,
  MAX_INGREDIENT_G,
  mealDraftOfDish,
  mealOfDish,
  mealProblemOfDish,
  PHOTO_PREFIX,
  portionOf,
  recipeGrams,
  scaleIngredient,
  sortDishes,
  validateDish,
  withoutServings,
  type DishIngredient,
  type SavedDish,
} from './dishes';
import type { TextItem } from './food-text';
import { validateMealDraft } from './nutrition';

const lentils: DishIngredient[] = [
  { name: 'Lentejas', kcal: 600, proteinG: 40, carbsG: 100, fatG: 4, fiberG: 30, sugarsG: 6, saltG: 0.5, grams: 400 },
  { name: 'Chorizo', kcal: 300, proteinG: 15, carbsG: 2, fatG: 26, saltG: 2, grams: 100 },
  { name: 'Aceite', kcal: 270, fatG: 30, grams: 30 },
];

const dish = (overrides: Partial<SavedDish> = {}): SavedDish => ({ id: 'p1', name: 'Lentejas', createdMs: 1_700_000_000_000, updatedMs: 1_700_000_000_000, ingredients: lentils, ...overrides });

describe('dishTotals', () => {
  it('suma los ingredientes; los extras solo llevan lo de los que los traían', () => {
    const totals = dishTotals(lentils);
    expect(totals.kcal).toBe(1170);
    expect(totals.proteinG).toBe(55);
    expect(totals.fatG).toBe(60);
    expect(totals.fiberG).toBe(30); // el chorizo y el aceite no la traían: no suman cero, no aportan nada
    expect(totals.saltG).toBe(2.5);
    expect(totals.grams).toBe(530);
  });

  it('un nutriente que ningún ingrediente trae queda «sin dato»', () => {
    const totals = dishTotals([{ name: 'Café', kcal: 5 }]);
    expect(totals).toEqual({ kcal: 5 });
  });

  it('los gramos solo se saben si se sabe lo que pesan todos', () => {
    expect(dishTotals([...lentils, { name: 'Pan', kcal: 80 }]).grams).toBeUndefined();
    expect(dishTotals([]).grams).toBeUndefined();
  });
});

describe('gramos de cada ingrediente al comer un plato', () => {
  it('las calorías del plato son la suma de la receta', () => {
    expect(dishKcal(dish())).toBe(1170);
  });

  it('con las cantidades de la receta sale la receta entera (y el nombre no lleva sufijo)', () => {
    const { draft, grams } = mealDraftOfDish(dish(), recipeGrams(dish()));
    expect(draft.name).toBe('Lentejas');
    expect(draft.kcal).toBe(1170);
    expect(draft.proteinG).toBe(55);
    expect(draft.saltG).toBe(2.5);
    expect(grams).toBe(530);
  });

  it('cada ingrediente se escala por separado: la mitad de lentejas, el chorizo igual y sin aceite', () => {
    const { draft, grams } = mealDraftOfDish(dish(), [200, 100, 0]);
    // lentejas 300 kcal + chorizo 300 kcal, el aceite no entra
    expect(draft.kcal).toBe(600);
    expect(draft.proteinG).toBe(35); // 20 + 15
    expect(draft.fatG).toBe(28); // 2 + 26
    expect(grams).toBe(300);
  });

  it('el ingrediente escalado conserva el reparto: regla de tres sobre todo', () => {
    const half = scaleIngredient(lentils[0] as DishIngredient, 200);
    expect(half).toMatchObject({ name: 'Lentejas', kcal: 300, proteinG: 20, carbsG: 50, fiberG: 15, grams: 200 });
    const triple = scaleIngredient(lentils[1] as DishIngredient, 300);
    expect(triple).toMatchObject({ kcal: 900, saltG: 6, grams: 300 });
  });

  it('un ingrediente de antes de las cantidades (sin gramos) entra tal cual y no se escala', () => {
    const old = dish({ ingredients: [{ name: 'Lentejas', kcal: 600, grams: 400 }, { name: 'Pan', kcal: 80 }] });
    expect(recipeGrams(old)).toEqual([400, null]);
    expect(portionOf(old, [200, null]).map((i) => i.kcal)).toEqual([300, 80]);
    expect(mealDraftOfDish(old, [200, null]).draft.kcal).toBe(380);
    expect(mealDraftOfDish(old, [200, null]).grams).toBeUndefined(); // no se sabe lo que pesa todo
  });

  it('lo que no tenía dato sigue sin dato al anotarlo', () => {
    const café = dish({ ingredients: [{ name: 'Café', kcal: 5, grams: 100 }] });
    const { draft } = mealDraftOfDish(café, [100]);
    expect(draft.proteinG).toBeNull();
    expect(draft.fiberG).toBeUndefined();
    const meal = mealOfDish(café, [100], { id: 'c1', tsMs: 1 });
    expect(meal).toMatchObject({ id: 'c1', source: 'dish', kcal: 5, grams: 100 });
    expect(meal.fiberG).toBeUndefined();
  });

  it('la comida lleva el id del plato con el que se anotó: su foto es la miniatura de la comida', () => {
    expect(mealOfDish(dish({ id: 'plato-7' }), recipeGrams(dish()), { id: 'c3', tsMs: 9 })).toMatchObject({ source: 'dish', dishId: 'plato-7' });
  });

  it('la comida anotada es una comida válida (entra en una copia de seguridad)', () => {
    const meal = mealOfDish(dish(), [200, 50, 10], { id: 'c2', tsMs: 5 });
    expect(meal.source).toBe('dish');
    expect(meal.kcal).toBe(Math.round(300 + 150 + 90));
    expect(validateMealDraft({ name: meal.name, kcal: meal.kcal, proteinG: meal.proteinG ?? null, carbsG: meal.carbsG ?? null, fatG: meal.fatG ?? null })).toEqual([]);
  });

  it('no deja anotar una cantidad vacía, negativa o pasada, ni todo a cero, ni cifras que no caben en una comida', () => {
    expect(mealProblemOfDish(dish(), recipeGrams(dish()))).toBeNull();
    expect(mealProblemOfDish(dish(), [null, 100, 30])).toMatch(/Indica los gramos de Lentejas/);
    expect(mealProblemOfDish(dish(), [400, -5, 30])).toMatch(/Indica los gramos de Chorizo/);
    expect(mealProblemOfDish(dish(), [400, 100, MAX_INGREDIENT_G + 1])).toMatch(/Aceite: como mucho/);
    expect(mealProblemOfDish(dish(), [0, 0, 0])).toMatch(/algún ingrediente/);
    const huge = dish({ ingredients: [{ name: 'Olla', kcal: 9_000, grams: 1000 }, { name: 'Más olla', kcal: 9_000, grams: 1000 }] });
    expect(mealProblemOfDish(huge, [1000, 1000])).toMatch(/más de 10\.000 kcal/);
    expect(mealProblemOfDish(huge, [500, 500])).toBeNull(); // la mitad sí cabe
  });
});

describe('platos de antes, con raciones', () => {
  it('se pasan a una ración: cada ingrediente entre las raciones, y el campo desaparece', () => {
    const old = withoutServings({ ...dish(), servings: 3 });
    expect(old).not.toHaveProperty('servings');
    expect(old.ingredients[0]).toEqual({ name: 'Lentejas', kcal: 200, proteinG: 13.33, carbsG: 33.33, fatG: 1.33, fiberG: 10, sugarsG: 2, saltG: 0.17, grams: 133.3 });
    expect(dishKcal(old)).toBe(390); // 1170 entre 3: lo que salía por ración
  });

  it('con una ración, o sin el campo, se queda igual', () => {
    expect(withoutServings({ ...dish(), servings: 1 })).toEqual(dish());
    expect(withoutServings(dish())).toEqual(dish());
  });
});

describe('ingredientOf', () => {
  it('redondea como una comida y pone nombre si no lo hay', () => {
    expect(ingredientOf({ name: '  ', kcal: 120.4, proteinG: 3.14, carbsG: 20, fatG: 2, saltG: 0.123 }, { grams: 80.04 })).toEqual({
      name: 'Ingrediente',
      kcal: 120,
      proteinG: 3.1,
      carbsG: 20,
      fatG: 2,
      saltG: 0.12,
      grams: 80,
    });
  });

  it('con solo las calorías no inventa nutrientes, y guarda el código de barras', () => {
    expect(ingredientOf({ name: 'Yogur', kcal: 61, proteinG: null, carbsG: null, fatG: null }, { barcode: '8410000000017' })).toEqual({ name: 'Yogur', kcal: 61, barcode: '8410000000017' });
  });
});

describe('validateDish', () => {
  it('pide nombre y al menos un ingrediente', () => {
    expect(validateDish({ name: '', ingredients: lentils })).toEqual(['Ponle un nombre al plato.']);
    expect(validateDish({ name: 'x', ingredients: [] })).toEqual(['Añade al menos un ingrediente.']);
    expect(validateDish({ name: 'x'.repeat(MAX_DISH_NAME + 1), ingredients: lentils })[0]).toMatch(/como mucho/);
    expect(validateDish({ name: 'Lentejas', ingredients: lentils })).toEqual([]);
  });
});

describe('isPhoto y sortDishes', () => {
  it('solo admite como foto un JPEG en texto de tamaño razonable', () => {
    expect(isPhoto(`${PHOTO_PREFIX}/9j/4AAQSkZJRg==`)).toBe(true);
    expect(isPhoto('data:image/png;base64,AAAA')).toBe(false);
    expect(isPhoto('https://x.test/a.jpg')).toBe(false);
    expect(isPhoto(`${PHOTO_PREFIX}"><script>`)).toBe(false);
    expect(isPhoto(`${PHOTO_PREFIX}${'A'.repeat(200_000)}`)).toBe(false);
    expect(isPhoto(42)).toBe(false);
  });

  it('la barra pone primero el último plato anotado y, si nunca se anotó, el más reciente', () => {
    const a = dish({ id: 'a', name: 'A', createdMs: 1000 });
    const b = dish({ id: 'b', name: 'B', createdMs: 2000 });
    const c = dish({ id: 'c', name: 'C', createdMs: 500, lastUsedMs: 5000 });
    expect(sortDishes([a, b, c]).map((d) => d.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('ingredientsOfItems: lo calculado, ingrediente a ingrediente (ronda 46)', () => {
  const item = (overrides: Partial<TextItem> = {}): TextItem => ({ name: 'Arroz blanco cocido', amount: 200, unit: 'g', kcal: 260.4, proteinG: 5.123, carbsG: 56, fatG: 0.6, assumed: false, ...overrides });

  it('cada alimento es su propio ingrediente, con sus gramos y sus nutrientes redondeados', () => {
    const out = ingredientsOfItems([item(), item({ name: 'Pechuga de pollo', amount: 150.04, kcal: 247.5, proteinG: 46.5, carbsG: 0, fatG: 5.4, fiberG: 0, saltG: 0.2 })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Arroz blanco cocido', kcal: 260, proteinG: 5.12, carbsG: 56, fatG: 0.6, grams: 200 });
    expect(out[1]).toMatchObject({ name: 'Pechuga de pollo', kcal: 248, grams: 150, fiberG: 0, saltG: 0.2 });
  });

  it('un plato compuesto de la tabla se reparte en sus piezas (cada una con sus gramos)', () => {
    const kebab = item({
      name: 'Kebab de ternera',
      amount: 300,
      kcal: 700,
      parts: [item({ name: 'Pan de kebab', amount: 120, kcal: 320 }), item({ name: 'Ternera', amount: 100, kcal: 250 }), item({ name: 'Cebolla', amount: 80, kcal: 30 })],
    });
    const out = ingredientsOfItems([kebab]);
    expect(out.map((i) => [i.name, i.grams])).toEqual([
      ['Pan de kebab', 120],
      ['Ternera', 100],
      ['Cebolla', 80],
    ]);
  });

  it('lo que solo trae calorías dichas no sabe cuánto pesa: entra sin gramos (fijo, no se escala)', () => {
    const [only] = ingredientsOfItems([item({ name: 'Tteokbokki', amount: 0, kcal: 400, kcalOnly: true })]);
    expect(only).toMatchObject({ name: 'Tteokbokki', kcal: 400 });
    expect(only).not.toHaveProperty('grams');
  });

  it('al comer el plato cada ingrediente se escala solo: cambiar los gramos del arroz no toca el pollo', () => {
    const made = ingredientsOfItems([item(), item({ name: 'Pechuga de pollo', amount: 150, kcal: 250, proteinG: 46 })]);
    const saved = dish({ ingredients: made });
    expect(recipeGrams(saved)).toEqual([200, 150]);
    expect(mealOfDish(saved, [100, 150], { id: 'c', tsMs: 0 }).kcal).toBe(Math.round(260.4 / 2 + 250));
  });

  it('un nombre vacío no rompe nada y un peso fuera de rango se acota', () => {
    const [a] = ingredientsOfItems([item({ name: '  ', amount: 99_999 })]);
    expect(a?.name).toBe('Ingrediente');
    expect(a?.grams).toBe(MAX_INGREDIENT_G);
  });
});
