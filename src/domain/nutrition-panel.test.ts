import { describe, expect, it } from 'vitest';
import { intakeOf, type MealEntry, type NutritionTargets } from './nutrition';
import { DEFAULT_NUTRITION_PANEL, FIBER_GOAL_G, MAX_PANEL_INDICATORS, PANEL_INDICATORS, panelTarget, panelValue, sanitizeNutritionPanel } from './nutrition-panel';

const targets: NutritionTargets = { maintenanceKcal: 2200, kcal: 2000, proteinG: 120, carbsG: 220, fatG: 65, saltG: 5 };
const meal = (over: Partial<MealEntry>): MealEntry => ({ id: 'm', tsMs: 0, name: 'x', kcal: 500, source: 'manual', ...over }) as MealEntry;

describe('indicadores del panel de nutrición', () => {
  it('por omisión, los cuatro de siempre en su orden; el catálogo tiene siete y cada uno es único', () => {
    expect(DEFAULT_NUTRITION_PANEL).toEqual(['protein', 'carbs', 'fat', 'salt']);
    expect(PANEL_INDICATORS.map((i) => i.id)).toEqual(['protein', 'carbs', 'fat', 'salt', 'fiber', 'sugars', 'water']);
    expect(PANEL_INDICATORS.length).toBeLessThanOrEqual(MAX_PANEL_INDICATORS);
  });

  it('limpia lo guardado: lo desconocido y lo repetido se va, el orden se respeta, una lista vacía vale y lo que no es lista vuelve al valor de serie', () => {
    expect(sanitizeNutritionPanel(['water', 'x', 'water', 'fiber', 7])).toEqual(['water', 'fiber']);
    expect(sanitizeNutritionPanel([])).toEqual([]);
    for (const bad of [undefined, null, 'protein', 3, {}]) expect(sanitizeNutritionPanel(bad)).toEqual([...DEFAULT_NUTRITION_PANEL]);
    expect(sanitizeNutritionPanel(Array.from({ length: 30 }, () => 'protein'))).toEqual(['protein']);
  });

  it('las metas: las de la persona, la fibra fija, los azúcares el 10 % de las calorías y el agua la del día', () => {
    expect(panelTarget('protein', targets, 2500)).toBe(120);
    expect(panelTarget('salt', targets, 2500)).toBe(5);
    expect(panelTarget('fiber', targets, 2500)).toBe(FIBER_GOAL_G);
    expect(panelTarget('sugars', targets, 2500)).toBe(50); // 2000 × 10 % ÷ 4 kcal/g
    expect(panelTarget('water', targets, 2500)).toBe(2500);
  });

  it('los valores salen de lo comido (cero si no hay nada anotado) y del agua bebida', () => {
    const intake = intakeOf([meal({ proteinG: 30, carbsG: 40, fatG: 10, fiberG: 6, sugarsG: 12, saltG: 1.4 }), meal({ proteinG: 20, fiberG: 4 })]);
    expect(panelValue('protein', intake, 900)).toBe(50);
    expect(panelValue('fiber', intake, 900)).toBe(10);
    expect(panelValue('sugars', intake, 900)).toBe(12);
    expect(panelValue('salt', intake, 900)).toBe(1.4);
    expect(panelValue('water', intake, 900)).toBe(900);
    expect(panelValue('fiber', null, 0)).toBe(0);
  });
});
