import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtDayShortYear, fmtDayTitle, fmtPeriod, NBSP, plural } from './format';

const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m, 0).getTime(); // octubre de 2026

describe('plural', () => {
  it('singular con 1 y plural con el resto, incluido 0', () => {
    expect(plural(1, 'lectura nueva', 'lecturas nuevas')).toBe('1 lectura nueva');
    expect(plural(0, 'lectura nueva', 'lecturas nuevas')).toBe('0 lecturas nuevas');
    expect(plural(2, 'noche', 'noches')).toBe('2 noches');
    expect(plural(1234, 'lectura', 'lecturas')).toBe('1234 lecturas'); // en español los números de 4 cifras no llevan separador
    expect(plural(12345, 'lectura', 'lecturas')).toBe('12.345 lecturas');
  });
});

describe('fmtAgo', () => {
  it('minutos y horas del mismo día', () => {
    expect(fmtAgo(at(12, 10, 0), at(12, 10, 0))).toBe('ahora mismo');
    expect(fmtAgo(at(12, 9, 40), at(12, 10, 0))).toBe('hace 20 min');
    expect(fmtAgo(at(12, 7, 0), at(12, 10, 0))).toBe('hace 3 h');
  });

  it('cruzando la medianoche con menos de 24 h sigue siendo «hace X h», no «ayer»', () => {
    expect(fmtAgo(at(11, 23, 30), at(12, 1, 0))).toBe('hace 1 h');
  });

  it('«ayer» es el día anterior del calendario', () => {
    expect(fmtAgo(at(11, 8, 0), at(12, 9, 0))).toBe('ayer a las 08:00'); // 25 h, pero ayer
  });

  it('del sábado a las 23:30 al lunes a las 00:30 (25 h) NO es ayer: son dos días', () => {
    // 10 de octubre de 2026 es sábado, el 12 lunes.
    expect(fmtAgo(at(10, 23, 30), at(12, 0, 30))).toBe('hace 2 días');
  });

  it('varios días', () => {
    expect(fmtAgo(at(7, 12, 0), at(12, 12, 0))).toBe('hace 5 días');
  });
});

describe('fmtDayTitle y NBSP', () => {
  it('hoy y ayer', () => {
    expect(fmtDayTitle('2026-10-12', '2026-10-12')).toBe('Hoy');
    expect(fmtDayTitle('2026-10-11', '2026-10-12')).toBe('Ayer');
  });

  it('el espacio duro no es un espacio normal (no se parte la línea entre 78 y %)', () => {
    expect(`78${NBSP}%`).not.toBe('78 %');
    expect(`78${NBSP}%`.charCodeAt(2)).toBe(0xa0);
  });
});

describe('fmtPeriod', () => {
  const today = '2026-10-13'; // martes
  it('el día: hoy, ayer o el nombre del día', () => {
    expect(fmtPeriod('day', '2026-10-13', today)).toEqual({ title: 'Hoy', subtitle: 'mar 13 oct' });
    expect(fmtPeriod('day', '2026-10-12', today).title).toBe('Ayer');
    expect(fmtPeriod('day', '2026-10-10', today)).toEqual({ title: 'Sábado', subtitle: 'sáb 10 oct' });
  });

  it('la semana: la de hoy se llama «Esta semana» y las demás dicen sus fechas', () => {
    expect(fmtPeriod('week', '2026-10-14', today)).toEqual({ title: 'Esta semana', subtitle: '12 oct – 18 oct' });
    expect(fmtPeriod('week', '2026-10-06', today)).toEqual({ title: 'Semana', subtitle: '5 oct – 11 oct' });
  });

  it('el mes: el de hoy se llama «Este mes» y los demás, su nombre', () => {
    expect(fmtPeriod('month', '2026-10-01', today)).toEqual({ title: 'Este mes', subtitle: 'octubre de 2026' });
    expect(fmtPeriod('month', '2026-09-15', today)).toEqual({ title: 'Septiembre', subtitle: 'septiembre de 2026' });
  });
});

describe('fmtDayShortYear', () => {
  it('lleva el año solo cuando no es el actual', () => {
    expect(fmtDayShortYear('2026-10-11', '2026-10-13')).toBe('11 oct');
    expect(fmtDayShortYear('2025-10-11', '2026-10-13')).toBe('11 oct 2025');
  });

  it('los rótulos de periodo también lo llevan en un año pasado', () => {
    expect(fmtPeriod('day', '2025-12-31', '2026-10-13').subtitle).toBe('mié 31 dic 2025');
    expect(fmtPeriod('week', '2025-12-31', '2026-10-13').subtitle).toBe('29 dic 2025 – 4 ene 2026');
  });
});
