import { describe, expect, it } from 'vitest';
import { estimateMealFromText } from '../app/food-text';
import { PREP_OPTIONS, withPrep } from './food-prep';

const kcal = (text: string): number => {
  const r = estimateMealFromText(text);
  if (r.status !== 'ok') throw new Error(r.message);
  return r.analysis.items.reduce((sum, item) => sum + item.kcal, 0);
};
const names = (text: string): string => {
  const r = estimateMealFromText(text);
  return r.status === 'ok' ? r.analysis.items.map((i) => i.name).join(' + ') : r.message;
};

describe('cómo está lo que se pesa', () => {
  it('añade la preparación detrás de lo escrito, o lo deja como está', () => {
    expect(withPrep('  arroz ', null)).toBe('arroz');
    expect(withPrep('arroz', 'crudo')).toBe('arroz en crudo');
    expect(withPrep('pechuga de pollo', 'plancha')).toBe('pechuga de pollo a la plancha');
    expect(PREP_OPTIONS.map((o) => o.id)).toEqual(['crudo', 'cocido', 'plancha', 'horno', 'frito']);
  });

  it('crudo cambia de verdad las calorías por gramo de lo que se pesa en crudo: arroz, pasta, legumbres, cereales y carnes', () => {
    // Lo cocido es lo que se come; el mismo peso en crudo lleva muchísimas más calorías (el arroz y la pasta, ~2,5 veces) o menos (la carne, por el agua).
    for (const food of ['arroz', 'pasta', 'lentejas', 'garbanzos', 'alubias', 'quinoa', 'cuscús']) {
      expect(kcal(`100 g de ${withPrep(food, 'crudo')}`), food).toBeGreaterThan(kcal(`100 g de ${withPrep(food, 'cocido')}`) * 2);
    }
    for (const food of ['pechuga de pollo', 'ternera', 'salmón', 'gambas']) {
      expect(kcal(`100 g de ${withPrep(food, 'crudo')}`), food).toBeLessThan(kcal(`100 g de ${withPrep(food, 'cocido')}`));
    }
  });

  it('plancha, horno y frito suman el aceite, de menos a más, en lo que cambia al cocinarlo', () => {
    for (const food of ['pechuga de pollo', 'ternera', 'salmón', 'brócoli']) {
      const base = kcal(`100 g de ${withPrep(food, 'cocido')}`);
      const plancha = kcal(`100 g de ${withPrep(food, 'plancha')}`);
      const horno = kcal(`100 g de ${withPrep(food, 'horno')}`);
      const frito = kcal(`100 g de ${withPrep(food, 'frito')}`);
      expect(plancha, food).toBeGreaterThan(base);
      expect(horno, food).toBeGreaterThanOrEqual(plancha);
      expect(frito, food).toBeGreaterThan(horno);
    }
  });

  it('en lo que no cambia con la preparación (una manzana) no inventa nada ni rompe el cálculo', () => {
    for (const option of PREP_OPTIONS) {
      expect(kcal(`150 g de ${withPrep('manzana', option.id)}`), option.id).toBe(kcal('150 g de manzana'));
    }
  });

  it('el nombre calculado dice cómo se contó («Pasta cruda», «Pechuga de pollo (frito)»), para que la persona lo vea antes de añadir', () => {
    expect(names('100 g de pasta en crudo')).toBe('Pasta cruda');
    expect(names('100 g de lentejas en crudo')).toBe('Lentejas crudas');
    expect(names('100 g de pechuga de pollo frito')).toBe('Pechuga de pollo (frito)');
    expect(names('100 g de pechuga de pollo en crudo')).toBe('Pechuga de pollo (crudo)');
  });
});
