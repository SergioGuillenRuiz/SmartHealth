import { describe, expect, it } from 'vitest';
import {
  addDays,
  atHourMs,
  dayKeyOf,
  dayOfMs,
  daysBetween,
  dayWindow,
  elapsedFractionOfDay,
  endOfDayMs,
  isValidDayKey,
  rangeDays,
  startOfDayMs,
  startOfMonth,
  startOfWeek,
  weekdayOf,
} from './dates';

describe('dates', () => {
  it('dayKeyOf usa el día local', () => {
    expect(dayKeyOf(new Date(2026, 6, 10, 23, 59, 59).getTime())).toBe('2026-07-10');
    expect(dayKeyOf(new Date(2026, 6, 11, 0, 0, 0).getTime())).toBe('2026-07-11');
  });

  it('addDays cruza meses, años y bisiestos', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('addDays no se desplaza con el cambio de hora (Madrid)', () => {
    // 2026-03-29 tiene 23 h; 2026-10-25 tiene 25 h.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect((endOfDayMs('2026-03-29') - startOfDayMs('2026-03-29')) / 3_600_000).toBe(23);
    expect((endOfDayMs('2026-10-25') - startOfDayMs('2026-10-25')) / 3_600_000).toBe(25);
  });

  it('daysBetween y rangeDays', () => {
    expect(daysBetween('2026-07-01', '2026-07-10')).toBe(9);
    expect(daysBetween('2026-07-10', '2026-07-01')).toBe(-9);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(rangeDays('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('semana en lunes y mes', () => {
    expect(weekdayOf('2026-07-06')).toBe(0); // lunes
    expect(weekdayOf('2026-07-12')).toBe(6); // domingo
    expect(startOfWeek('2026-07-10')).toBe('2026-07-06');
    expect(startOfMonth('2026-07-10')).toBe('2026-07-01');
  });

  it('valida claves de día', () => {
    expect(isValidDayKey('2026-02-29')).toBe(false);
    expect(isValidDayKey('2028-02-29')).toBe(true);
    expect(isValidDayKey('2026-7-1')).toBe(false);
    expect(isValidDayKey('hola')).toBe(false);
  });

  it('fracción transcurrida del día', () => {
    const noon = new Date(2026, 6, 10, 12, 0, 0).getTime();
    expect(elapsedFractionOfDay('2026-07-10', noon)).toBeCloseTo(0.5, 5);
    expect(elapsedFractionOfDay('2026-07-10', noon - 10 * 86_400_000)).toBe(0);
    expect(elapsedFractionOfDay('2026-07-10', noon + 5 * 86_400_000)).toBe(1);
  });
});

describe('atHourMs: horas de pared, también los días de 23 y 25 h', () => {
  it('un día normal: a las 6 son las 6', () => {
    expect(new Date(atHourMs('2026-07-10', 6)).getHours()).toBe(6);
  });

  it('el día del cambio a la hora de verano (23 h) y a la de invierno (25 h) «las 6» siguen siendo las 6, no las 7 ni las 5', () => {
    for (const day of ['2026-03-29', '2026-10-25']) {
      for (const hour of [0, 6, 12, 18]) {
        const d = new Date(atHourMs(day, hour));
        expect([d.getHours(), d.getMinutes()], `${day} ${hour}`).toEqual([hour, 0]);
      }
    }
    // Lo que se hacía antes —sumar horas al inicio del día— se equivocaba una hora:
    expect(new Date(startOfDayMs('2026-03-29') + 6 * 3_600_000).getHours()).toBe(7);
    expect(new Date(startOfDayMs('2026-10-25') + 6 * 3_600_000).getHours()).toBe(5);
  });
});

describe('días que no empiezan a medianoche (el del Resumen)', () => {
  const at = (day: string, hour: number, minute = 0): number => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();

  it('dayOfMs: lo de antes de la hora de inicio aún es del día anterior', () => {
    expect(dayOfMs(at('2026-10-20', 2, 30), 8)).toBe('2026-10-19');
    expect(dayOfMs(at('2026-10-20', 7, 59), 8)).toBe('2026-10-19');
    expect(dayOfMs(at('2026-10-20', 8, 0), 8)).toBe('2026-10-20');
    expect(dayOfMs(at('2026-10-20', 23, 59), 8)).toBe('2026-10-20');
    // Cruza el mes y el año.
    expect(dayOfMs(at('2027-01-01', 0, 20), 8)).toBe('2026-12-31');
    expect(dayOfMs(at('2026-03-01', 3, 0), 8)).toBe('2026-02-28');
  });

  it('con 0 es el día de calendario', () => {
    for (const hour of [0, 1, 12, 23]) expect(dayOfMs(at('2026-10-20', hour), 0)).toBe('2026-10-20');
    expect(dayWindow('2026-10-20')).toEqual({ day: '2026-10-20', startMs: startOfDayMs('2026-10-20'), endMs: endOfDayMs('2026-10-20') });
  });

  it('dayWindow: de la hora de inicio a esa misma hora del día siguiente, y las ventanas se encadenan', () => {
    const w = dayWindow('2026-10-20', 8);
    expect(w.startMs).toBe(at('2026-10-20', 8));
    expect(w.endMs).toBe(at('2026-10-21', 8));
    expect(dayWindow('2026-10-21', 8).startMs).toBe(w.endMs);
    // Todo instante cae en la ventana del día que dice dayOfMs.
    for (const ms of [w.startMs, w.startMs + 1, w.endMs - 1, at('2026-10-21', 1)]) {
      const day = dayOfMs(ms, 8);
      const window = dayWindow(day, 8);
      expect(ms >= window.startMs && ms < window.endMs, String(ms)).toBe(true);
    }
  });

  it('el cambio de hora no mueve el límite: las 08:00 siguen siendo las 08:00 en días de 23 y 25 h', () => {
    for (const day of ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25']) {
      const w = dayWindow(day, 8);
      expect([new Date(w.startMs).getHours(), new Date(w.endMs).getHours()], day).toEqual([8, 8]);
      expect(dayOfMs(w.startMs, 8), day).toBe(day);
      expect(dayOfMs(w.startMs - 1, 8), day).toBe(addDays(day, -1));
      expect(dayOfMs(w.endMs - 1, 8), day).toBe(day);
    }
    expect((dayWindow('2026-03-29', 8).endMs - dayWindow('2026-03-29', 8).startMs) / 3_600_000).toBe(24);
    // El día que acaba en el cambio de hora dura 23 h (o 25), no 24.
    expect((dayWindow('2026-03-28', 8).endMs - dayWindow('2026-03-28', 8).startMs) / 3_600_000).toBe(23);
    expect((dayWindow('2026-10-24', 8).endMs - dayWindow('2026-10-24', 8).startMs) / 3_600_000).toBe(25);
  });

  it('elapsedFractionOfDay con hora de inicio: a las 20:00 ha pasado la mitad del día que empezó a las 08:00', () => {
    expect(elapsedFractionOfDay('2026-07-10', at('2026-07-10', 20), 8)).toBeCloseTo(0.5, 5);
    expect(elapsedFractionOfDay('2026-07-10', at('2026-07-11', 2), 8)).toBeCloseTo(0.75, 5);
    expect(elapsedFractionOfDay('2026-07-10', at('2026-07-10', 6), 8)).toBe(0);
    expect(elapsedFractionOfDay('2026-07-10', at('2026-07-11', 9), 8)).toBe(1);
  });
});
