import { describe, expect, it } from 'vitest';
import { clockOf, correctedNight, parseClock } from './sleep-correction';

const t = (day: number, h: number, m = 0): number => new Date(2026, 5, day, h, m, 0, 0).getTime();

describe('corregir una noche a mano', () => {
  it('lee «HH:MM» y rechaza lo que no es una hora', () => {
    expect(parseClock('07:30')).toBe(450);
    expect(parseClock('7:05')).toBe(425);
    for (const bad of ['', '24:00', '12:60', 'abc', '7']) expect(parseClock(bad)).toBeNull();
    expect(clockOf(t(5, 9, 4))).toBe('09:04');
  });

  it('se acostó la tarde-noche anterior y se levantó ese día', () => {
    expect(correctedNight(t(11, 12), '23:30', '08:15')).toEqual({ startMs: t(10, 23, 30), endMs: t(11, 8, 15) });
    expect(correctedNight(t(11, 20), '22:00', '14:00')).toEqual({ startMs: t(10, 22), endMs: t(11, 14) }); // una noche de 16 h
  });

  it('si se acostó más temprano que se levantó, es del mismo día (acostarse de madrugada o dormir de día)', () => {
    expect(correctedNight(t(11, 15), '02:00', '12:00')).toEqual({ startMs: t(11, 2), endMs: t(11, 12) });
    expect(correctedNight(t(11, 15), '06:00', '16:00')).toEqual({ startMs: t(11, 6), endMs: t(11, 16) });
  });

  it('descarta una noche de menos de 30 minutos o de más de 20 horas, y las horas mal escritas', () => {
    expect(correctedNight(t(11, 12), '08:00', '08:10')).toBeNull();
    expect(correctedNight(t(11, 12), '08:00', '08:00')).toBeNull(); // 24 h
    expect(correctedNight(t(11, 12), '10:00', '07:00')).toBeNull(); // 21 h
    expect(correctedNight(t(11, 12), 'x', '08:00')).toBeNull();
  });
});
