import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { dishTotals, ingredientOf, mergedPartNames, type DishIngredient, type SavedDish } from '../domain/dishes';
import { draftOfAnalysis } from '../domain/food-text';
import { forgetAttemptedSplits, hasMergedIngredient, migrateMergedDishes, splitDishIngredients } from './dish-split';
import { estimateMealFromText } from './food-text';
import { installServices } from './services';

const NOW = new Date(2026, 10, 11, 18, 0, 0).getTime();
let store: IdbStore;
let counter = 0;

beforeEach(async () => {
  store = await openIdbStore(`split-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 2 })), now: () => NOW, demo: false });
  forgetAttemptedSplits();
});

/** Lo que guardaba la versión anterior a la ronda 46: todo lo calculado como UN ingrediente (nombres con « + », gramos y cifras sumados). */
function oldMerged(text: string): { ingredient: DishIngredient; truth: Array<{ name: string; amount: number }> } {
  const result = estimateMealFromText(text);
  if (result.status !== 'ok') throw new Error(result.message);
  const items = result.analysis.items;
  const total = Math.round(items.reduce((sum, item) => sum + item.amount, 0));
  return { ingredient: ingredientOf(draftOfAnalysis(result.analysis), { grams: total }), truth: items.map((item) => ({ name: item.name, amount: item.amount })) };
}

const dishOf = (ingredients: DishIngredient[]): SavedDish => ({ id: 'd1', name: 'Pollo con arroz', createdMs: NOW - 1000, updatedMs: NOW - 1000, ingredients });

describe('platos de antes de la ronda 46: ingredientes juntados', () => {
  it('se reconoce un ingrediente juntado por su nombre', () => {
    expect(mergedPartNames({ name: 'Pollo (crudo) + Aceite de oliva + Arroz cocido' })).toEqual(['Pollo (crudo)', 'Aceite de oliva', 'Arroz cocido']);
    expect(mergedPartNames({ name: 'Huevos ×2 + Pan' })).toEqual(['Huevos', 'Pan']);
    expect(mergedPartNames({ name: 'Arroz cocido' })).toBeNull();
    expect(mergedPartNames({ name: 'Pollo + Arroz', barcode: '8412345678905' })).toBeNull(); // un producto con código no es una suma
  });

  it('se reparten los gramos de cada alimento y las calorías siguen sumando lo mismo', async () => {
    const { ingredient, truth } = oldMerged('150 g de pollo crudo, 10 g de aceite de oliva y 180 g de arroz basmati cocido');
    expect(ingredient.name).toBe('Pollo (crudo) + Aceite de oliva + Arroz cocido');
    const split = await splitDishIngredients(dishOf([ingredient]));
    expect(split).not.toBeNull();
    const parts = split!.ingredients;
    expect(parts.map((p) => p.name)).toEqual(['Pollo (crudo)', 'Aceite de oliva', 'Arroz cocido']);
    // Los gramos recuperados se parecen a los de verdad (hay más cifras guardadas que incógnitas).
    for (const [i, part] of parts.entries()) expect(Math.abs((part.grams ?? 0) - (truth[i]?.amount ?? 0))).toBeLessThanOrEqual(Math.max(6, (truth[i]?.amount ?? 0) * 0.1));
    // Y juntos pesan y valen lo que valía el ingrediente que se guardó.
    const total = dishTotals(parts);
    expect(Math.round(total.kcal)).toBe(ingredient.kcal);
    expect(Math.abs((total.grams ?? 0) - (ingredient.grams ?? 0))).toBeLessThanOrEqual(ingredient.grams! * 0.05);
    expect(Math.abs((total.proteinG ?? 0) - (ingredient.proteinG ?? 0))).toBeLessThan(2);
  });

  it('un nombre que no se reconoce igual que entonces deja el ingrediente como estaba', async () => {
    const { ingredient } = oldMerged('150 g de pollo crudo, 10 g de aceite de oliva y 180 g de arroz basmati cocido');
    const odd: DishIngredient = { ...ingredient, name: 'Pollo (crudo) + Cosa rarísima del súper + Arroz cocido' };
    expect(await splitDishIngredients(dishOf([odd]))).toBeNull();
    // Y un plato sin nada juntado ni se toca.
    expect(hasMergedIngredient(dishOf([{ name: 'Arroz cocido', kcal: 234, grams: 180 }]))).toBe(false);
    expect(await splitDishIngredients(dishOf([{ name: 'Arroz cocido', kcal: 234, grams: 180 }]))).toBeNull();
  });

  it('si las cifras guardadas no cuadran con esos alimentos no se inventa un reparto', async () => {
    const { ingredient } = oldMerged('150 g de pollo crudo, 10 g de aceite de oliva y 180 g de arroz basmati cocido');
    // Un ingrediente que dice ser eso pero con la mitad de calorías: no sale ningún reparto fiable.
    const wrong: DishIngredient = { ...ingredient, kcal: Math.round(ingredient.kcal / 2) };
    expect(await splitDishIngredients(dishOf([wrong]))).toBeNull();
  });

  it('el resto de ingredientes del plato se queda igual y el reparto va en su sitio', async () => {
    const { ingredient } = oldMerged('150 g de pollo crudo, 10 g de aceite de oliva y 180 g de arroz basmati cocido');
    const salad: DishIngredient = { name: 'Ensalada', kcal: 40, proteinG: 2, carbsG: 6, fatG: 1, grams: 200 };
    const split = await splitDishIngredients(dishOf([salad, ingredient]));
    expect(split!.ingredients[0]).toEqual(salad);
    expect(split!.ingredients.length).toBe(4);
  });

  it('migrar guarda el plato repartido, una sola vez, y no vuelve a intentar uno que no se pudo', async () => {
    const { ingredient } = oldMerged('150 g de pollo crudo, 10 g de aceite de oliva y 180 g de arroz basmati cocido');
    const good = dishOf([ingredient]);
    const bad: SavedDish = { ...dishOf([{ ...ingredient, name: 'Pollo (crudo) + Cosa rarísima + Arroz cocido' }]), id: 'd2' };
    await store.putDish(good);
    await store.putDish(bad);
    const changed = await migrateMergedDishes([good, bad]);
    expect(changed.map((d) => d.id)).toEqual(['d1']);
    expect((await store.listDishes()).find((d) => d.id === 'd1')!.ingredients.length).toBe(3);
    expect((await store.listDishes()).find((d) => d.id === 'd2')!.ingredients.length).toBe(1);
    // Con el plato ya repartido, nada que hacer; con el que no se pudo, no se insiste en esta sesión.
    expect(await migrateMergedDishes(await store.listDishes())).toEqual([]);
  });
});
