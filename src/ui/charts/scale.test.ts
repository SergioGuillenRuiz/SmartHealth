import { describe, expect, it } from 'vitest';
import { compact, linear, niceScale, pickLabelIndexes, rangeScale } from './scale';

describe('niceScale', () => {
  it('redondea a marcas limpias e incluye el cero en barras', () => {
    const s = niceScale(0, 11_870, 4, true);
    expect(s.min).toBe(0);
    expect(s.max).toBe(15_000);
    expect(s.ticks).toEqual([0, 5000, 10_000, 15_000]);
  });

  it('en líneas no fuerza el cero', () => {
    const s = niceScale(76.4, 84.9, 4, false);
    expect(s.min).toBeLessThanOrEqual(76.4);
    expect(s.max).toBeGreaterThanOrEqual(84.9);
    expect(s.min).toBeGreaterThan(60);
    expect(s.ticks.every((t) => Number.isFinite(t))).toBe(true);
  });

  it('datos planos: abre margen en lugar de dividir por cero', () => {
    const s = niceScale(70, 70, 4);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it('entradas no finitas devuelven una escala segura', () => {
    expect(niceScale(Number.NaN, 5).ticks.length).toBeGreaterThan(1);
  });
});

describe('compact', () => {
  it('compacta desde 1000', () => {
    expect(compact(0)).toBe('0');
    expect(compact(950)).toBe('950');
    expect(compact(1000)).toBe('1K');
    expect(compact(2500)).toBe('2,5K');
    expect(compact(12_400)).toBe('12K');
  });
});

describe('helpers', () => {
  it('linear mapea el dominio al rango', () => {
    const f = linear(0, 10, 100, 200);
    expect(f(0)).toBe(100);
    expect(f(5)).toBe(150);
    expect(f(10)).toBe(200);
  });

  it('pickLabelIndexes no pisa etiquetas y conserva el primero', () => {
    expect(pickLabelIndexes(7, 300, 40)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const many = pickLabelIndexes(60, 300, 40);
    expect(many[0]).toBe(0);
    expect(many.length).toBeLessThanOrEqual(7);
    expect(pickLabelIndexes(0, 300, 40)).toEqual([]);
  });
});

describe('rangeScale: la escala de la banda de peso, con el peso objetivo como referencia', () => {
  it('sin datos no hay escala', () => {
    expect(rangeScale([])).toBeNull();
    expect(rangeScale([], 70)).toBeNull();
  });

  it('se ajusta a lo dibujado con un margen, y sin referencia no la abarca', () => {
    const s = rangeScale([80, 84]);
    expect(s).toMatchObject({ lo: 80, hi: 84, referenceShown: false });
    expect(s?.min).toBeCloseTo(80 - 4 * 0.14, 6);
    expect(s?.max).toBeCloseTo(84 + 4 * 0.14, 6);
  });

  it('una referencia cercana (a menos de 3 unidades o del doble del recorrido) se abarca: la línea cae dentro de la escala', () => {
    const below = rangeScale([80, 84], 75); // 5 de distancia, el doble del recorrido son 8
    expect(below?.referenceShown).toBe(true);
    expect(below?.min).toBeLessThan(75);
    expect(below?.max).toBeGreaterThan(84);
    expect(rangeScale([80, 84], 88)?.referenceShown).toBe(true);
    expect(rangeScale([80, 84], 82)?.referenceShown).toBe(true); // dentro de lo dibujado
    expect(rangeScale([80, 80], 77)?.referenceShown).toBe(true); // peso plano: hasta 3 unidades
  });

  it('una referencia lejana no estira la escala (aplastaría la curva) y se dice que no se abarcó', () => {
    const far = rangeScale([80, 80.4], 70);
    expect(far?.referenceShown).toBe(false);
    expect(far?.min).toBeGreaterThan(79);
    expect(far?.max).toBeLessThan(81);
    expect(rangeScale([80, 80], 76.9)?.referenceShown).toBe(false); // 3,1 > 3
  });

  it('siempre una escala finita con min < max y los datos dentro, con valores iguales o referencias raras', () => {
    for (const [values, reference] of [
      [[70], undefined],
      [[70, 70], 70],
      [[70, 70.01], 300],
      [[25], 25],
      [[300, 25], 150],
      [[80], -5],
    ] as Array<[number[], number | undefined]>) {
      const s = rangeScale(values, reference);
      expect(s, JSON.stringify([values, reference])).not.toBeNull();
      expect(Number.isFinite(s!.min) && Number.isFinite(s!.max)).toBe(true);
      expect(s!.min).toBeLessThan(s!.max);
      expect(s!.min).toBeLessThanOrEqual(Math.min(...values));
      expect(s!.max).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });
});
