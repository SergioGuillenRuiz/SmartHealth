import { describe, expect, it } from 'vitest';
import { BREATH_SPEC, HEART_SPEC, blendLevels, evidenceOf, levelsFromLabels, twoLevels, type Level } from './sleep-model';

const around = (centre: number, spread: number, count: number): number[] => Array.from({ length: count }, (_, i) => centre + ((i % 5) - 2) * spread);

describe('twoLevels', () => {
  it('encuentra el nivel bajo y el alto de las lecturas quietas de la persona', () => {
    const level = twoLevels([...around(56, 1, 30), ...around(72, 1.5, 30)], HEART_SPEC);
    expect(level?.asleep).toBeCloseTo(56, 0);
    expect(level?.awake).toBeCloseTo(72, 0);
    expect(level?.trust).toBe(1);
  });

  it('con una sola nube de lecturas (pulso que no distingue) no hay modelo', () => {
    expect(twoLevels(around(62, 0.2, 60), HEART_SPEC)).toBeNull();
  });

  it('con pocas lecturas no hay modelo', () => {
    expect(twoLevels([55, 56, 70, 71], HEART_SPEC)).toBeNull();
  });

  it('la respiración tiene su propia escala: 13 contra 17 respiraciones por minuto sí se distinguen, y 15 contra 15,4 no', () => {
    const resp = twoLevels([...around(13, 0.5, 30), ...around(17, 0.5, 30)], BREATH_SPEC);
    expect(resp?.asleep).toBeCloseTo(13, 0);
    expect(resp?.awake).toBeCloseTo(17, 0);
    expect(twoLevels([...around(15, 0.2, 30), ...around(15.4, 0.2, 30)], BREATH_SPEC)).toBeNull();
  });
});

describe('levelsFromLabels', () => {
  it('toma las medias de lo etiquetado, no de lo que mezcla el k-means', () => {
    const level = levelsFromLabels(around(55, 1, 20), around(70, 1, 20), HEART_SPEC);
    expect(level?.asleep).toBeCloseTo(55, 0);
    expect(level?.awake).toBeCloseTo(70, 0);
  });

  it('sin lecturas bastantes de cada clase, o si no se distinguen, no hay modelo', () => {
    expect(levelsFromLabels(around(55, 1, 5), around(70, 1, 20), HEART_SPEC)).toBeNull();
    expect(levelsFromLabels(around(60, 1, 20), around(60.3, 1, 20), HEART_SPEC)).toBeNull();
  });
});

describe('evidenceOf', () => {
  const level: Level = { asleep: 56, awake: 72, sigma: 5, trust: 1 };

  it('un pulso de dormido da evidencia positiva, uno de despierto negativa y uno a medio camino casi nada', () => {
    expect(evidenceOf(level, 54, HEART_SPEC)).toBeGreaterThan(1);
    expect(evidenceOf(level, 74, HEART_SPEC)).toBeLessThan(-1);
    expect(Math.abs(evidenceOf(level, 64, HEART_SPEC))).toBeLessThan(0.2);
  });

  it('una lectura disparada (el sensor se mueve) no es «más despierta» que una de despierto normal', () => {
    expect(evidenceOf(level, 130, HEART_SPEC)).toBeCloseTo(evidenceOf(level, 74.5, HEART_SPEC), 5);
    expect(evidenceOf(level, 130, HEART_SPEC)).toBeGreaterThanOrEqual(-HEART_SPEC.clip);
  });

  it('un modelo de poca confianza pesa menos', () => {
    const weak = { ...level, trust: 0.3 };
    expect(Math.abs(evidenceOf(weak, 54, HEART_SPEC))).toBeLessThan(Math.abs(evidenceOf(level, 54, HEART_SPEC)));
  });
});

describe('blendLevels', () => {
  const a: Level = { asleep: 50, awake: 70, sigma: 4, trust: 1 };
  const b: Level = { asleep: 60, awake: 80, sigma: 6, trust: 0.5 };

  it('mezcla dos modelos con el peso dado, y si falta uno se queda con el otro', () => {
    expect(blendLevels(a, b, 0.5)).toEqual({ asleep: 55, awake: 75, sigma: 5, trust: 0.75 });
    expect(blendLevels(a, b, 1)).toEqual(a);
    expect(blendLevels(a, null, 0.2)).toEqual(a);
    expect(blendLevels(null, b, 0.2)).toEqual(b);
    expect(blendLevels(null, null, 0.5)).toBeNull();
  });
});
