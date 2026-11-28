import { describe, expect, it } from 'vitest';
import type { PhoneActivity, PhoneSpan } from './phone-activity';
import { estimateSleepFromPhone, type PhoneSleepInput } from './sleep-phone';
import type { SleepSessionRecord, StepBucket } from './types';

// TZ = Europe/Madrid (vitest.config.ts). Octubre de 2026, del 5 al 15: sin cambio de hora (es el 25).
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 3_600_000;
const MIN = 60_000;

/** Un móvil usado cada ~40 min de 08:00 a 23:30 y quieto de 23:30 a 07:30 (lo coge al despertar), de la noche del 5 al 6 a la del 13 al 14. */
function scenario(opts: { lastUse?: number; firstUse?: number; extraUses?: PhoneSpan[] } = {}): PhoneActivity {
  const uses: PhoneSpan[] = [];
  for (let day = 5; day <= 14; day++) {
    const lastUse = day === 14 ? at(14, 23, 30) : at(day, 23, 30) + (opts.lastUse ?? 0);
    for (let t = at(day, 7, 30) + (opts.firstUse ?? 0); t < lastUse - 5 * MIN; t += 40 * MIN) uses.push({ startMs: t, endMs: t + 2 * MIN });
    uses.push({ startMs: lastUse - 5 * MIN, endMs: lastUse });
  }
  uses.push(...(opts.extraUses ?? []));
  return { uses, coverage: [{ startMs: at(5, 0), endMs: at(15, 0) }] };
}

const input = (phone: PhoneActivity, extra: Partial<PhoneSleepInput> = {}): PhoneSleepInput => ({
  phone,
  buckets: [],
  counters: [],
  heart: [],
  workouts: [],
  logged: [],
  syncs: [],
  real: [],
  askedAtMs: at(15, 18),
  fromMs: at(5, 0),
  toMs: at(15, 0),
  ...extra,
});

const clock = (ms: number): number => new Date(ms).getHours() + new Date(ms).getMinutes() / 60;

describe('estimateSleepFromPhone', () => {
  it('la noche es el rato largo sin usar el móvil, con un rato para dormirse tras el último uso y otro despierta tras el primero', () => {
    const sessions = estimateSleepFromPhone(input(scenario()));
    expect(sessions.length).toBeGreaterThanOrEqual(7);
    for (const session of sessions) {
      expect(session.estimated).toBe(true);
      expect(session.segments).toEqual([]);
      // Último uso a las 23:30 (+15 min para dormirse) y primero a las 07:30 (−8 min).
      expect(clock(session.startMs)).toBeGreaterThanOrEqual(23.6);
      expect(clock(session.startMs)).toBeLessThanOrEqual(24.1);
      expect(clock(session.endMs)).toBeGreaterThanOrEqual(7.2);
      expect(clock(session.endMs)).toBeLessThanOrEqual(7.5);
    }
  });

  it('mirar el móvil dos minutos de madrugada no parte la noche, pero estar un buen rato despierta con él sí la acorta', () => {
    const night = (list: SleepSessionRecord[]) => list.filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 9));
    expect(night(estimateSleepFromPhone(input(scenario({ extraUses: [{ startMs: at(10, 3, 10), endMs: at(10, 3, 12) }] }))))).toHaveLength(1);
    const long = night(estimateSleepFromPhone(input(scenario({ extraUses: [{ startMs: at(10, 2, 0), endMs: at(10, 5, 0) }] }))));
    // De 00:00 a 02:00 y de 05:00 a 07:30: ni una ni otra dura tres horas… y el de 02:00 a 05:00 despierto no es sueño.
    expect(long.every((s) => s.endMs <= at(10, 2, 30) || s.startMs >= at(10, 4, 45))).toBe(true);
  });

  it('con el móvil encendido hasta la 01:20 la noche empieza después, y no antes de la última vez que lo usó', () => {
    const phone = scenario({ extraUses: [{ startMs: at(9, 23, 40), endMs: at(10, 1, 20) }] });
    const sessions = estimateSleepFromPhone(input(phone));
    const night = sessions.find((s) => s.endMs > at(10, 0) && s.startMs < at(10, 9));
    expect(night).toBeDefined();
    expect(night!.startMs).toBeGreaterThanOrEqual(at(10, 1, 20));
    expect(night!.startMs).toBeLessThanOrEqual(at(10, 1, 50));
  });

  it('sin registro del móvil (apagado, sin permiso) no se opina: un móvil apagado no duerme, y una noche no atraviesa un tramo sin registro', () => {
    const phone = scenario();
    const withHole: PhoneActivity = {
      uses: phone.uses,
      coverage: [
        { startMs: at(5, 0), endMs: at(10, 1, 0) },
        { startMs: at(10, 7, 45), endMs: at(15, 0) },
      ],
    };
    const covering = estimateSleepFromPhone(input(withHole)).filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 9));
    expect(covering).toEqual([]);
    expect(estimateSleepFromPhone(input({ uses: phone.uses, coverage: [] }))).toEqual([]);
  });

  it('un rato quieto de mediodía no es una noche', () => {
    const phone = scenario();
    const withoutNoon: PhoneActivity = { uses: phone.uses.filter((u) => !(u.startMs >= at(10, 11, 0) && u.startMs < at(10, 16, 0))), coverage: phone.coverage };
    const sessions = estimateSleepFromPhone(input(withoutNoon));
    expect(sessions.some((s) => s.startMs >= at(10, 9) && s.startMs < at(10, 20))).toBe(false);
  });

  it('los pasos del anillo de madrugada (despierta) y lo anotado cuentan como actividad', () => {
    // Tres horas seguidas andando (02:00–05:00): despierta. Tres paseos de media hora con ratos quietos entre medias serían idas al baño y no partirían la noche.
    const walking = (h: number, m: number): StepBucket => ({ startMs: at(10, h, m), endMs: at(10, h, m) + 30 * MIN, steps: 600, ringDistanceM: 400, ringCalories: 20 });
    const withSteps = estimateSleepFromPhone(input(scenario(), { buckets: [walking(2, 0), walking(2, 30), walking(3, 0), walking(3, 30), walking(4, 0), walking(4, 30)] }));
    expect(withSteps.filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 9)).every((s) => s.endMs - s.startMs < 6 * HOUR)).toBe(true);
    const logged = estimateSleepFromPhone(input(scenario(), { logged: Array.from({ length: 16 }, (_, i) => at(10, 1) + i * 12 * MIN) }));
    expect(logged.filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 9)).every((s) => s.endMs - s.startMs < 6 * HOUR)).toBe(true);
  });

  it('no espera a sincronizar el anillo: el móvil sabe cuándo acabó la noche; pero donde hay una noche conocida no se estima', () => {
    const phone = scenario();
    expect(estimateSleepFromPhone(input(phone, { askedAtMs: null })).length).toBeGreaterThanOrEqual(7);
    expect(estimateSleepFromPhone(input(phone, { askedAtMs: at(9, 12) })).length).toBeGreaterThanOrEqual(7);
    const known: SleepSessionRecord = { startMs: at(8, 23, 40), endMs: at(9, 7, 20), segments: [] };
    expect(estimateSleepFromPhone(input(phone, { real: [known] })).some((s) => s.startMs < known.endMs + 90 * MIN && s.endMs > known.startMs - 90 * MIN)).toBe(false);
  });

  it('la noche sale aunque se abra la app a los pocos minutos de despertar (la lectura acaba en la misma franja que el primer uso)', () => {
    // La noche del 13 al 14: se despierta a las 07:30 y la lectura llega a las 07:34. Antes se daba por «cortada» y no salía hasta una lectura posterior.
    const full = scenario();
    const phone: PhoneActivity = { uses: full.uses.filter((u) => u.startMs < at(14, 7, 34)), coverage: [{ startMs: at(5, 0), endMs: at(14, 7, 34) }] };
    const sessions = estimateSleepFromPhone(input(phone, { fromMs: at(13, 12), toMs: at(14, 12) }));
    const night = sessions.find((s) => s.endMs > at(14, 6) && s.startMs < at(14, 9));
    expect(night).toBeDefined();
    expect(night!.endMs).toBeGreaterThanOrEqual(at(14, 7, 10));
    expect(night!.endMs).toBeLessThanOrEqual(at(14, 7, 31));
  });

  it('pero una noche que sigue en curso (sin ningún uso en la última franja) sigue sin darse', () => {
    const full = scenario();
    const phone: PhoneActivity = { uses: full.uses.filter((u) => u.startMs < at(14, 7, 0)), coverage: [{ startMs: at(5, 0), endMs: at(14, 7, 34) }] };
    const sessions = estimateSleepFromPhone(input(phone, { fromMs: at(13, 12), toMs: at(14, 12) }));
    expect(sessions.some((s) => s.endMs > at(14, 6) && s.startMs < at(14, 9))).toBe(false);
  });

  it('solo devuelve lo que toca el rango pedido', () => {
    const sessions = estimateSleepFromPhone(input(scenario(), { fromMs: at(9, 0), toMs: at(10, 0) }));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((s) => s.endMs > at(9, 0) && s.startMs < at(10, 0))).toBe(true);
  });

  it('con tres o más noches conocidas (corregidas a mano) corrige el sesgo: si siempre se duerme media hora más tarde de lo que dice el último uso, las estimaciones se retrasan', () => {
    // Quien deja el móvil a las 23:30 y se duerme a las 00:20 (el último uso + 15 min da 23:45): las noches corregidas dicen 00:20.
    const known = [5, 6, 7].map((day) => ({ startMs: at(day, 23, 30) + 50 * MIN, endMs: at(day + 1, 7, 20), segments: [] }) satisfies SleepSessionRecord);
    const plain = estimateSleepFromPhone(input(scenario()));
    const learned = estimateSleepFromPhone(input(scenario(), { real: known }));
    const day = (list: SleepSessionRecord[]) => list.find((s) => s.startMs > at(10, 20) && s.startMs < at(11, 3));
    expect(day(learned)!.startMs).toBeGreaterThan(day(plain)!.startMs);
    expect(day(learned)!.startMs - day(plain)!.startMs).toBeLessThanOrEqual(60 * MIN);
  });
});
