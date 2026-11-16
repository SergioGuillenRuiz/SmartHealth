import { describe, expect, it } from 'vitest';
import { canEditAmounts, itemsOfMeal, mealWithItems, removeItemAt, setItemGrams } from './meal-items';
import { buildMeal, type MealEntry, type MealItem } from './nutrition';

const rice: MealItem = { name: 'Arroz blanco (cocido)', kcal: 260, proteinG: 5.4, carbsG: 56, fatG: 0.6, fiberG: 0.8, sugarsG: 0.1, saltG: 0.02, grams: 200 };
const chicken: MealItem = { name: 'Pollo (plancha)', kcal: 240, proteinG: 45, carbsG: 0, fatG: 5.4, saltG: 0.3, grams: 150 };
const sauce: MealItem = { name: 'Salsa de tomate', kcal: 40 }; // sin gramos: calorías dichas, no se puede escalar

const meal = (over: Partial<MealEntry> = {}): MealEntry => ({
  ...buildMeal({ name: 'Arroz blanco (cocido) + Pollo (plancha)', kcal: 500, proteinG: 50.4, carbsG: 56, fatG: 6, fiberG: 0.8, sugarsG: 0.1, saltG: 0.32 }, { id: 'm1', tsMs: Date.UTC(2026, 10, 11, 12), source: 'text', grams: 350, items: [rice, chicken] }),
  ...over,
});

describe('cambiar los gramos de lo ya anotado', () => {
  it('una comida guarda sus alimentos con sus gramos y se leen tal cual', () => {
    const m = meal();
    expect(m.items).toHaveLength(2);
    expect(itemsOfMeal(m)).toEqual([rice, chicken]);
    // Es una copia: tocar lo leído no cambia la comida.
    (itemsOfMeal(m) as MealItem[])[0]!.grams = 1;
    expect(m.items?.[0]?.grams).toBe(200);
  });

  it('una comida de antes (sin desglose) con su cantidad total se lee como un único alimento; sin cantidad no hay nada que cambiar', () => {
    const old: MealEntry = { id: 'o', tsMs: 1, name: 'Yogur', kcal: 120, proteinG: 8, carbsG: 14, fatG: 3, source: 'barcode', barcode: '8480000123456', grams: 250 };
    expect(itemsOfMeal(old)).toEqual([{ name: 'Yogur', kcal: 120, proteinG: 8, carbsG: 14, fatG: 3, grams: 250, barcode: '8480000123456' }]);
    expect(itemsOfMeal({ id: 'a', tsMs: 1, name: 'Tarta', kcal: 350, source: 'manual' })).toBeNull();
    expect(canEditAmounts(null)).toBe(false);
    expect(canEditAmounts([sauce])).toBe(false);
    expect(canEditAmounts([sauce, rice])).toBe(true);
  });

  it('cambiar los gramos de un alimento lo escala con la regla de tres y deja los demás como están', () => {
    const next = setItemGrams([rice, chicken], 1, 300);
    expect(next[1]).toMatchObject({ grams: 300, kcal: 480, proteinG: 90, fatG: 10.8 });
    expect(next[0]).toBe(rice);
    // Sin gramos de partida, fuera de rango o un índice que no existe: queda igual.
    expect(setItemGrams([sauce, rice], 0, 100)[0]).toBe(sauce);
    expect(setItemGrams([rice], 0, 0)[0]).toBe(rice);
    expect(setItemGrams([rice], 0, 9999)[0]).toBe(rice);
    expect(setItemGrams([rice], 5, 100)).toEqual([rice]);
  });

  it('la comida se rehace sumando lo que lleva: calorías, nutrientes y gramos; mismo id, hora y origen', () => {
    const m = meal({ day: '2026-11-10' });
    const edited = setItemGrams(itemsOfMeal(m) as MealItem[], 1, 300);
    const result = mealWithItems(m, itemsOfMeal(m) as MealItem[], edited);
    if ('problem' in result) throw new Error(result.problem);
    expect(result).toMatchObject({ id: 'm1', tsMs: m.tsMs, source: 'text', day: '2026-11-10', kcal: 260 + 480, proteinG: 5.4 + 90, grams: 500 });
    expect(result.items).toHaveLength(2);
    expect(result.items?.[1]?.grams).toBe(300);
  });

  it('quitar un alimento lo saca de la suma y, si el nombre era el de los alimentos unidos, se rehace con los que quedan', () => {
    const m = meal();
    const rest = removeItemAt(itemsOfMeal(m) as MealItem[], 1);
    const result = mealWithItems(m, itemsOfMeal(m) as MealItem[], rest);
    if ('problem' in result) throw new Error(result.problem);
    expect(result.name).toBe('Arroz blanco (cocido)');
    expect(result.kcal).toBe(260);
    // Si la persona le puso su propio nombre, se respeta.
    const named = meal({ name: 'Mi comida del lunes' });
    const kept = mealWithItems(named, itemsOfMeal(named) as MealItem[], rest);
    if ('problem' in kept) throw new Error(kept.problem);
    expect(kept.name).toBe('Mi comida del lunes');
  });

  it('no se deja una comida sin alimentos ni con cifras que no caben', () => {
    const m = meal();
    expect(mealWithItems(m, itemsOfMeal(m) as MealItem[], [])).toEqual({ problem: expect.stringMatching(/al menos un alimento/) });
    const huge: MealItem[] = [{ name: 'Aceite', kcal: 9000, fatG: 1000, grams: 1000 }, { name: 'Más aceite', kcal: 5000, fatG: 600, grams: 600 }];
    expect(mealWithItems(m, itemsOfMeal(m) as MealItem[], huge)).toEqual({ problem: expect.stringMatching(/demasiado grandes/) });
  });

  it('un alimento sin gramos (calorías dichas) sigue sumando sus calorías tal cual', () => {
    const m = buildMeal({ name: 'Arroz + Salsa de tomate', kcal: 300, proteinG: 5.4, carbsG: 56, fatG: 0.6 }, { id: 'm2', tsMs: 1, source: 'text', items: [rice, sauce] });
    const edited = setItemGrams(itemsOfMeal(m) as MealItem[], 0, 100);
    const result = mealWithItems(m, itemsOfMeal(m) as MealItem[], edited);
    if ('problem' in result) throw new Error(result.problem);
    expect(result.kcal).toBe(130 + 40);
  });
});
