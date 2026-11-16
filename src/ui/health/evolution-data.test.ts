import { describe, expect, it } from 'vitest';
import { periodTitle, pointX, xLabel } from './evolution-data';

const p = (start: string, end = start) => ({ start, end });

describe('xLabel: etiqueta corta del eje X', () => {
  it('por días: con pocos, el día de la semana y el número; con muchos, la fecha corta', () => {
    expect(xLabel(p('2026-10-14'), 'day', 7)).toMatch(/^mié\.? 14$|^mié 14$/);
    expect(xLabel(p('2026-10-14'), 'day', 30)).toBe('14 oct');
  });

  it('por semanas: la fecha corta del lunes', () => {
    expect(xLabel(p('2026-10-12', '2026-10-14'), 'week', 13)).toBe('12 oct');
  });

  it('por meses: el mes, y con más de doce meses también el año (si no, «oct» saldría dos veces)', () => {
    expect(xLabel(p('2026-10-01'), 'month', 12)).toBe('Oct');
    expect(xLabel(p('2025-10-01'), 'month', 13)).toBe('Oct 25');
    expect(xLabel(p('2026-10-01'), 'month', 13)).toBe('Oct 26');
  });
});

describe('periodTitle: cabecera de la lectura de un periodo', () => {
  it('día, semana y mes', () => {
    expect(periodTitle(p('2026-10-14'), 'day')).toMatch(/^Mié\.? 14 oct$|^Mié 14 oct$/);
    expect(periodTitle(p('2026-10-12', '2026-10-14'), 'week')).toBe('Semana del 12 oct al 14 oct');
    expect(periodTitle(p('2026-10-01'), 'month')).toMatch(/^Octubre de 2026$|^Octubre 2026$/);
  });
});

describe('pointX: posición de un periodo en el eje', () => {
  it('una semana que empieza antes del rango arranca en el primer día del rango', () => {
    const from = new Date(2026, 9, 14).getTime();
    expect(pointX(p('2026-10-12', '2026-10-18'), from)).toBe(from);
    expect(pointX(p('2026-10-19', '2026-10-25'), from)).toBe(new Date(2026, 9, 19).getTime());
  });
});
