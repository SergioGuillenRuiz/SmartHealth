import { describe, expect, it } from 'vitest';
import { inWayOrder, WAY_ORDER } from './add-ways';
import { PREP_OPTIONS } from '../domain/food-prep';
import { hasIcon } from './icons';

describe('el orden de las formas de anotar comida', () => {
  it('siempre es báscula, lectura (código o foto), palabras y, la última, a mano', () => {
    expect(WAY_ORDER).toEqual(['scale', 'scan', 'words', 'manual']);
  });

  it('ordena cualquier subconjunto sin cambiar el orden relativo', () => {
    const options = [{ way: 'manual' as const }, { way: 'words' as const }, { way: 'scan' as const }];
    expect(inWayOrder(options).map((o) => o.way)).toEqual(['scan', 'words', 'manual']);
    expect(inWayOrder([{ way: 'manual' as const }, { way: 'scale' as const }]).map((o) => o.way)).toEqual(['scale', 'manual']);
    expect(inWayOrder([])).toEqual([]);
  });
});

describe('las formas de cocinar', () => {
  it('cada una tiene su icono, y no se repite ninguno', () => {
    const icons = PREP_OPTIONS.map((o) => o.icon);
    for (const icon of icons) expect(hasIcon(icon), icon).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
