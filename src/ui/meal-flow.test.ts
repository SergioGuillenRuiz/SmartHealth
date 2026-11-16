import { beforeEach, describe, expect, it } from 'vitest';
import type { TextAnalysis, TextItem } from '../domain/food-text';
import { MAX_EDIT_ITEMS } from '../domain/text-edit';
import { addToScalePlate, clearScalePlate, fromScale, leaveScaleFor, resetMealFlow, returnToScale, scaleBaseline, scalePlate, step } from './meal-flow';

const item = (name: string, kcal = 100): TextItem => ({ name, amount: 100, unit: 'g', kcal, proteinG: 1, carbsG: 1, fatG: 1, assumed: false });
const analysis = (...names: string[]): TextAnalysis => ({ items: names.map((n) => item(n)), assumptions: '', unknown: [] });

// El plato que se pesa y las excursiones a otras formas de añadir (el código de barras, «a mano») desde el propio paso de pesar. El fallo que se vigila: lo escaneado desde el pesaje
// se anotaba en el diario y cerraba la hoja, porque el plato vivía en el componente del paso y se perdía al salir de él.
describe('el plato que se pesa en la báscula', () => {
  beforeEach(() => resetMealFlow());

  it('empieza vacío y cada cosa añadida se suma al mismo plato, subiendo la versión', () => {
    expect(scalePlate.value).toBeNull();
    expect(addToScalePlate(analysis('Arroz'))).toBe(true);
    expect(scalePlate.value?.version).toBe(1);
    expect(addToScalePlate(analysis('Pollo'))).toBe(true);
    expect(scalePlate.value?.analysis.items.map((i) => i.name)).toEqual(['Arroz', 'Pollo']);
    expect(scalePlate.value?.version).toBe(2);
  });

  it('no admite más alimentos que el máximo y lo dice (devuelve false sin tocar el plato)', () => {
    expect(addToScalePlate(analysis(...Array.from({ length: MAX_EDIT_ITEMS }, (_, i) => `A${i}`)))).toBe(true);
    const before = scalePlate.value;
    expect(addToScalePlate(analysis('Uno más'))).toBe(false);
    expect(scalePlate.value).toBe(before);
  });

  it('salir a escanear no pierde el plato ni lo ya pesado, y al volver se sigue en el pesaje', () => {
    step.value = 'scale';
    addToScalePlate(analysis('Arroz'));
    scaleBaseline.value = 150;

    leaveScaleFor('barcode');
    expect(step.value).toBe('barcode');
    expect(fromScale.value).toBe(true);
    expect(scalePlate.value?.analysis.items).toHaveLength(1);
    expect(scaleBaseline.value).toBe(150);

    // El producto escaneado se suma al mismo plato…
    addToScalePlate(analysis('Yogur'));
    // …y se vuelve a pesar, sin anotar nada.
    returnToScale();
    expect(step.value).toBe('scale');
    expect(fromScale.value).toBe(false);
    expect(scalePlate.value?.analysis.items.map((i) => i.name)).toEqual(['Arroz', 'Yogur']);
    expect(scaleBaseline.value).toBe(150);
  });

  it('desde el pesaje también se puede salir a anotar a mano, con el mismo viaje de vuelta', () => {
    step.value = 'scale';
    leaveScaleFor('manual');
    expect(step.value).toBe('manual');
    expect(fromScale.value).toBe(true);
    returnToScale();
    expect(step.value).toBe('scale');
    expect(fromScale.value).toBe(false);
  });

  it('un plato nuevo empieza de cero, y cerrar la hoja lo borra todo', () => {
    addToScalePlate(analysis('Arroz'));
    scaleBaseline.value = 80;
    leaveScaleFor('barcode');
    clearScalePlate();
    expect(scalePlate.value).toBeNull();
    expect(scaleBaseline.value).toBe(0);
    expect(fromScale.value).toBe(false);

    addToScalePlate(analysis('Pollo'));
    scaleBaseline.value = 5;
    leaveScaleFor('barcode');
    resetMealFlow();
    expect(step.value).toBe('menu');
    expect(scalePlate.value).toBeNull();
    expect(scaleBaseline.value).toBe(0);
    expect(fromScale.value).toBe(false);
  });
});
