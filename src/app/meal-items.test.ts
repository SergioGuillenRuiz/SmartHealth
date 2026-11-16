import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { draftOfAnalysis } from '../domain/food-text';
import { ingredientOf, type SavedDish } from '../domain/dishes';
import { buildMeal, type MealEntry } from '../domain/nutrition';
import { estimateMealFromText } from './food-text';
import { loadMealItems, saveMealAmounts } from './meal-items';
import { installServices } from './services';
import { savedDishes } from './state';

const NOW = new Date(2026, 10, 11, 18, 0, 0).getTime();
let store: IdbStore;
let counter = 0;

beforeEach(async () => {
  store = await openIdbStore(`meal-items-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 2 })), now: () => NOW, demo: false });
  savedDishes.value = [];
});

/** Una comida como la guardaba la versión de antes de la ronda 49: lo calculado con palabras como un solo bloque, sin desglose. */
function oldTextMeal(text: string): MealEntry {
  const result = estimateMealFromText(text);
  if (result.status !== 'ok') throw new Error(result.message);
  const total = Math.round(result.analysis.items.reduce((sum, item) => sum + item.amount, 0));
  return buildMeal(draftOfAnalysis(result.analysis), { id: 'old', tsMs: NOW - 3600_000, source: 'text', grams: total });
}

describe('lo que lleva una comida ya anotada (para cambiar sus gramos)', () => {
  it('una comida con desglose guardado lo devuelve tal cual', async () => {
    const meal = buildMeal({ name: 'Arroz + Pollo', kcal: 500, proteinG: 50, carbsG: 56, fatG: 6 }, { id: 'n', tsMs: NOW, source: 'text', grams: 350, items: [{ name: 'Arroz', kcal: 260, grams: 200 }, { name: 'Pollo', kcal: 240, grams: 150 }] });
    expect(await loadMealItems(meal)).toEqual(meal.items);
  });

  it('una comida de antes contada con palabras («A + B») se reparte en sus alimentos con sus gramos, y las calorías cuadran con las guardadas', async () => {
    const meal = oldTextMeal('200 g de arroz blanco cocido y 150 g de pollo a la plancha');
    const items = await loadMealItems(meal);
    expect(items).not.toBeNull();
    expect((items ?? []).length).toBeGreaterThanOrEqual(2);
    expect((items ?? []).every((item) => item.grams !== undefined && item.grams > 0)).toBe(true);
    expect(Math.round((items ?? []).reduce((sum, item) => sum + item.kcal, 0))).toBe(meal.kcal);
  });

  it('un producto escaneado de antes (con su cantidad) es un solo alimento; una comida a mano con solo calorías, nada', async () => {
    const scanned: MealEntry = { id: 's', tsMs: NOW, name: 'Yogur natural', kcal: 120, proteinG: 8, carbsG: 14, fatG: 3, source: 'barcode', barcode: '8480000123456', grams: 250 };
    expect(await loadMealItems(scanned)).toEqual([{ name: 'Yogur natural', kcal: 120, proteinG: 8, carbsG: 14, fatG: 3, grams: 250, barcode: '8480000123456' }]);
    expect(await loadMealItems({ id: 'm', tsMs: NOW, name: 'Tarta', kcal: 350, source: 'manual' })).toBeNull();
  });

  it('una comida de un plato guardado lleva los ingredientes de su receta, ajustados a lo que se anotó', async () => {
    const dish: SavedDish = {
      id: 'd1',
      name: 'Pollo con arroz',
      createdMs: NOW - 5000,
      updatedMs: NOW - 5000,
      ingredients: [ingredientOf({ name: 'Arroz', kcal: 260, proteinG: 5, carbsG: 56, fatG: 1 }, { grams: 200 }), ingredientOf({ name: 'Pollo', kcal: 240, proteinG: 45, carbsG: 0, fatG: 5 }, { grams: 150 })],
    };
    savedDishes.value = [dish];
    // Se comió la mitad de la receta.
    const meal: MealEntry = { id: 'dm', tsMs: NOW, name: 'Pollo con arroz', kcal: 250, source: 'dish', dishId: 'd1', grams: 175 };
    const items = await loadMealItems(meal);
    expect(items?.map((item) => item.name)).toEqual(['Arroz', 'Pollo']);
    expect(items?.map((item) => item.grams)).toEqual([100, 75]);
    expect(Math.round((items ?? []).reduce((sum, item) => sum + item.kcal, 0))).toBe(250);
  });

  it('guardar los gramos nuevos deja la comida rehecha en el almacén (misma hora y origen) y la de antes se reemplaza', async () => {
    const meal = oldTextMeal('200 g de arroz blanco cocido y 150 g de pollo a la plancha');
    await store.putMeal(meal);
    const before = (await loadMealItems(meal)) ?? [];
    const doubled = before.map((item, i) => (i === 0 ? { ...item, grams: (item.grams ?? 0) * 2, kcal: item.kcal * 2 } : item));
    const saved = await saveMealAmounts(meal, before, doubled);
    expect(saved).toMatchObject({ id: 'old', tsMs: meal.tsMs, source: 'text' });
    expect(saved?.kcal).toBeGreaterThan(meal.kcal);
    const stored = (await store.listMeals(NOW - 86_400_000, NOW)).filter((m) => m.id === 'old');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kcal).toBe(saved?.kcal);
    expect(stored[0]?.items?.length).toBe(before.length);
  });
});
