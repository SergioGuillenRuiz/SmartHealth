import { describe, expect, it } from 'vitest';
import { changeOf } from './joint-marks';

describe('changeOf', () => {
  it('es la diferencia entre el último y el primer valor presentes', () => {
    expect(changeOf([80.2, null, 79.8, 79.4])).toBeCloseTo(-0.8, 10);
    expect(changeOf([null, 52, 55, null])).toBe(3);
  });

  it('con menos de dos valores no hay cambio que contar', () => {
    expect(changeOf([null, 60, null])).toBeNull();
    expect(changeOf([])).toBeNull();
  });
});
