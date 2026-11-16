import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { analyzeMealText, draftOfAnalysis, type TextAnalysis } from './food-text';
import type { MealDraft } from './nutrition';
import { analysisOfItem, appendAnalysis, hasAmount, isEditableAmount, itemOfDraft, MAX_EDIT_ITEMS, removeItem, removePart, setItemAmount, setPartAmount, withAmount } from './text-edit';

const table = parseFoodTables(FOOD_SOURCES);
const analyze = (text: string): TextAnalysis => analyzeMealText(text, table);

const kcalOf = (analysis: TextAnalysis): number => draftOfAnalysis(analysis).kcal ?? 0;

describe('cambiar los gramos de un alimento calculado', () => {
  it('las calorías y los nutrientes siguen la regla de tres', () => {
    const a = analyze('200 g de arroz cocido');
    const item = a.items[0]!;
    const half = setItemAmount(a, 0, item.amount / 2).items[0]!;
    expect(half.amount).toBe(item.amount / 2);
    expect(half.kcal).toBe(Math.round(item.kcal / 2));
    expect(half.carbsG).toBeCloseTo(item.carbsG / 2, 0);
    expect(half.assumed).toBe(false);
  });

  it('da lo mismo que escribirlo con esa cantidad', () => {
    const edited = setItemAmount(analyze('100 g de arroz cocido'), 0, 250);
    const written = analyze('250 g de arroz cocido');
    expect(kcalOf(edited)).toBeCloseTo(kcalOf(written), -1);
    expect(draftOfAnalysis(edited).proteinG ?? 0).toBeCloseTo(draftOfAnalysis(written).proteinG ?? 0, 0);
  });

  it('una ración supuesta deja de serlo al ponerle gramos', () => {
    const a = analyze('arroz cocido');
    expect(a.items[0]?.assumed).toBe(true);
    expect(setItemAmount(a, 0, 100).items[0]?.assumed).toBe(false);
  });

  it('una cantidad imposible (0, negativa, enorme o no numérica) deja todo como estaba', () => {
    const a = analyze('200 g de arroz cocido');
    for (const bad of [0, -5, 5001, Number.NaN, Number.POSITIVE_INFINITY]) expect(setItemAmount(a, 0, bad), String(bad)).toEqual(a);
    expect(isEditableAmount(1)).toBe(true);
    expect(isEditableAmount(5000)).toBe(true);
    expect(isEditableAmount(0.5)).toBe(false);
  });

  it('un índice que no existe no rompe nada', () => {
    const a = analyze('200 g de arroz cocido');
    expect(setItemAmount(a, 7, 100)).toEqual(a);
    expect(removeItem(a, 7)).toEqual(a);
  });

  it('lo dicho solo con sus calorías no tiene gramos que cambiar', () => {
    const a = analyze('zarandajo 400 kcal');
    const item = a.items[0]!;
    expect(item.kcalOnly).toBe(true);
    expect(hasAmount(item)).toBe(false);
    expect(withAmount(item, 100)).toBe(item);
  });
});

describe('platos compuestos: cambiar o quitar una pieza', () => {
  const kebab = (): TextAnalysis => analyze('un kebab de ternera con cebolla y salsa blanca');

  it('el plato lleva piezas y suma lo que ellas suman', () => {
    const item = kebab().items[0]!;
    expect(item.parts?.length).toBeGreaterThan(2);
    expect(item.kcal).toBe(Math.round(item.parts!.reduce((total, part) => total + part.kcal, 0)));
  });

  it('cambiar los gramos de una pieza cambia solo esa pieza y el total del plato', () => {
    const a = kebab();
    const item = a.items[0]!;
    const meatAt = item.parts!.findIndex((part) => /ternera|carne/i.test(part.name));
    expect(meatAt).toBeGreaterThanOrEqual(0);
    const meat = item.parts![meatAt]!;
    const edited = setPartAmount(a, 0, meatAt, meat.amount * 2).items[0]!;
    expect(edited.parts![meatAt]!.amount).toBe(round(meat.amount * 2));
    expect(edited.parts![meatAt]!.kcal).toBe(Math.round(meat.kcal * 2));
    for (const [i, part] of item.parts!.entries()) if (i !== meatAt) expect(edited.parts![i]).toEqual(part);
    expect(edited.kcal).toBe(Math.round(edited.parts!.reduce((total, part) => total + part.kcal, 0)));
    expect(edited.kcal).toBeGreaterThan(item.kcal);
    expect(edited.amount).toBeCloseTo(item.amount + meat.amount, 0);
  });

  it('cambiar los gramos del plato entero lo reparte entre todas sus piezas', () => {
    const a = kebab();
    const item = a.items[0]!;
    const doubled = setItemAmount(a, 0, item.amount * 2).items[0]!;
    expect(doubled.kcal).toBeGreaterThan(item.kcal * 1.9);
    expect(doubled.kcal).toBeLessThan(item.kcal * 2.1);
    expect(doubled.parts).toHaveLength(item.parts!.length);
    expect(doubled.parts![0]!.amount).toBeCloseTo(item.parts![0]!.amount * 2, 0);
  });

  it('quitar una pieza resta sus calorías del plato; quitar la última quita el plato', () => {
    const a = kebab();
    const item = a.items[0]!;
    const less = removePart(a, 0, 0).items[0]!;
    expect(less.parts).toHaveLength(item.parts!.length - 1);
    expect(less.kcal).toBe(Math.round(item.kcal - item.parts![0]!.kcal));
    let rest = a;
    for (let i = 0; i < item.parts!.length; i++) rest = removePart(rest, 0, 0);
    expect(rest.items).toHaveLength(0);
  });
});

describe('quitar y añadir alimentos', () => {
  it('quitar uno deja los demás y recalcula el total', () => {
    const a = analyze('dos huevos fritos y 200 g de arroz cocido');
    expect(a.items.length).toBeGreaterThanOrEqual(2);
    const without = removeItem(a, 0);
    expect(without.items).toHaveLength(a.items.length - 1);
    expect(kcalOf(without)).toBeLessThan(kcalOf(a));
  });

  it('añadir lo que calcula otro texto suma sus alimentos, lo no reconocido y lo supuesto', () => {
    const a = analyze('200 g de arroz cocido');
    const merged = appendAnalysis(a, analyze('arroz cocido y zarandajo'))!;
    expect(merged.items.length).toBeGreaterThan(a.items.length);
    expect(merged.unknown).toContain('zarandajo');
    expect(merged.assumptions).not.toBe('');
    expect(kcalOf(merged)).toBeGreaterThan(kcalOf(a));
  });

  it('no deja pasar del máximo de alimentos', () => {
    const full: TextAnalysis = { items: Array.from({ length: MAX_EDIT_ITEMS }, () => analyze('un yogur').items[0]!), unknown: [], assumptions: '' };
    expect(appendAnalysis(full, analyze('un yogur'))).toBeNull();
  });
});

const round = (n: number): number => Math.round(n * 10) / 10;

describe('un alimento a partir de cifras que ya se tienen (producto escaneado o anotado a mano)', () => {
  const draft = (change: Partial<MealDraft> = {}): MealDraft => ({ name: 'Yogur natural', kcal: 76, proteinG: 4.4, carbsG: 5.9, fatG: 4, fiberG: 0, sugarsG: 5.9, saltG: 0.15, ...change });

  it('lleva sus cifras, su cantidad en gramos y no es una ración supuesta', () => {
    const item = itemOfDraft(draft(), 125);
    expect(item).toMatchObject({ name: 'Yogur natural', amount: 125, unit: 'g', kcal: 76, proteinG: 4.4, carbsG: 5.9, fatG: 4, saltG: 0.15, assumed: false });
    expect(hasAmount(item)).toBe(true);
  });

  it('sin calorías las saca de los nutrientes, y sin nombre se llama «Ingrediente»', () => {
    const item = itemOfDraft(draft({ name: '  ', kcal: null, proteinG: 10, carbsG: 20, fatG: 5 }), 100);
    expect(item.name).toBe('Ingrediente');
    expect(item.kcal).toBe(165); // 4·10 + 4·20 + 9·5
  });

  it('un nutriente que no se sabe queda sin dato, no a cero', () => {
    const item = itemOfDraft(draft({ fiberG: null, sugarsG: null, saltG: null }), 100);
    expect('fiberG' in item).toBe(false);
    expect('sugarsG' in item).toBe(false);
    expect('saltG' in item).toBe(false);
  });

  it('se suma a lo ya calculado y su cantidad se puede corregir después con la regla de tres', () => {
    const plate = appendAnalysis(analyze('250 g de pechuga de pollo'), analysisOfItem(itemOfDraft(draft(), 100)))!;
    expect(plate.items.map((i) => i.name)).toEqual(['Pechuga de pollo', 'Yogur natural']);
    expect(plate.unknown).toEqual([]);
    const doubled = setItemAmount(plate, 1, 200);
    expect(doubled.items[1]).toMatchObject({ amount: 200, kcal: 152, proteinG: 8.8 });
    expect(kcalOf(doubled)).toBe(kcalOf(plate) + 76);
  });
});
