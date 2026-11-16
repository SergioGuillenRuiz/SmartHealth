import { describe, expect, it } from 'vitest';
import { periodRange, reachesToday, shiftPeriod } from './periods';

describe('periodRange', () => {
  it('un día es solo ese día', () => {
    expect(periodRange('day', '2026-10-13')).toEqual({ from: '2026-10-13', to: '2026-10-13' });
  });

  it('una semana va de lunes a domingo, esté el día donde esté', () => {
    // 13 oct 2026 es martes
    expect(periodRange('week', '2026-10-13')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(periodRange('week', '2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // lunes
    expect(periodRange('week', '2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // domingo
  });

  it('una semana puede cruzar de mes y de año', () => {
    expect(periodRange('week', '2026-12-31')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('un mes va del 1 a su último día, también en febrero y en bisiesto', () => {
    expect(periodRange('month', '2026-10-13')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('month', '2026-04-30')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('«todos» no acota nada', () => {
    expect(periodRange('all', '2026-10-13')).toBeNull();
  });
});

describe('shiftPeriod', () => {
  it('mueve un día, una semana o un mes entero', () => {
    expect(shiftPeriod('day', '2026-10-13', -1)).toBe('2026-10-12');
    expect(shiftPeriod('week', '2026-10-13', -1)).toBe('2026-10-06');
    expect(shiftPeriod('week', '2026-10-13', 1)).toBe('2026-10-20');
  });

  it('un mes más desde el 31 no se pasa de largo en un mes corto', () => {
    expect(shiftPeriod('month', '2026-03-31', -1)).toBe('2026-02-01');
    expect(shiftPeriod('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftPeriod('month', '2026-12-15', 1)).toBe('2027-01-01');
    expect(shiftPeriod('month', '2026-01-15', -1)).toBe('2025-12-01');
  });
});

describe('reachesToday', () => {
  it('el periodo en curso no tiene siguiente', () => {
    expect(reachesToday('day', '2026-10-13', '2026-10-13')).toBe(true);
    expect(reachesToday('day', '2026-10-12', '2026-10-13')).toBe(false);
    expect(reachesToday('week', '2026-10-12', '2026-10-13')).toBe(true); // la semana de hoy
    expect(reachesToday('week', '2026-10-05', '2026-10-13')).toBe(false);
    expect(reachesToday('month', '2026-10-01', '2026-10-13')).toBe(true);
    expect(reachesToday('month', '2026-09-30', '2026-10-13')).toBe(false);
    expect(reachesToday('all', '2026-10-13', '2026-10-13')).toBe(true);
  });
});
