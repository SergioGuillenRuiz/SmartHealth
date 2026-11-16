import { describe, expect, it } from 'vitest';
import { estimateSleepOffRing, OFFRING, type OffRingInput } from './sleep-offring';
import type { HeartSample, SleepSessionRecord, StepBucket } from './types';

const MIN = 60_000;
/** Hora local de un día de junio de 2026 (`day` 10 = 10-jun). */
const t = (day: number, h: number, m = 0): number => new Date(2026, 5, day, h, m, 0, 0).getTime();
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

const walk = (startMs: number, steps = 40): StepBucket => ({ startMs, endMs: startMs + 10 * MIN, steps, ringDistanceM: 0, ringCalories: 0 });
const night = (startMs: number, endMs: number): SleepSessionRecord => ({ startMs, endMs, segments: [] });

/** Una noche normal sin anillo: pasos hasta las 22:40 del 10, la app abierta y una comida anotada, y a las 08:05 del 11 la app otra vez. */
function base(change: Partial<OffRingInput> = {}): OffRingInput {
  return {
    buckets: [walk(t(10, 22, 30))],
    counters: [],
    heart: [],
    workouts: [],
    logged: [t(10, 20, 55), t(11, 8, 40)],
    syncs: [t(11, 8, 5)],
    real: [],
    askedAtMs: t(11, 8, 6),
    fromMs: t(11, 0),
    toMs: t(12, 0),
    ...change,
  };
}

describe('sueño sin anillo: la noche es el hueco de actividad', () => {
  it('estima desde poco después de la última marca hasta poco antes de la primera de la mañana', () => {
    const [estimate, ...rest] = estimateSleepOffRing(base());
    expect(rest).toEqual([]);
    expect(estimate?.estimated).toBe(true);
    expect(estimate?.segments).toEqual([]);
    // Último paso a las 22:40 (tramo de 10 min) + 30 min; primera marca a las 08:05 − 15 min.
    expect(clock(estimate!.startMs)).toBe('23:10');
    expect(clock(estimate!.endMs)).toBe('07:50');
  });

  it('no estima si la noche ya la dio el anillo, ni una muy cercana a la suya', () => {
    expect(estimateSleepOffRing(base({ real: [night(t(10, 23, 20), t(11, 7, 30))] }))).toEqual([]);
    expect(estimateSleepOffRing(base({ real: [night(t(10, 15), t(10, 16, 0))] })).length).toBe(1); // lejos (una siesta de la tarde): no la tapa
  });

  it('no estima si el anillo ESTABA puesto de noche: eso es de la otra estimación (hay pulso en el hueco)', () => {
    const heart: HeartSample[] = [t(11, 1), t(11, 2), t(11, 3)].map((tsMs) => ({ tsMs, bpm: 55, source: 'ring-auto' }));
    expect(estimateSleepOffRing(base({ heart }))).toEqual([]);
    // Dos lecturas pegadas a los bordes (al quitárselo o ponérselo) no cuentan.
    const edges: HeartSample[] = [t(10, 22, 50), t(11, 7, 55)].map((tsMs) => ({ tsMs, bpm: 70, source: 'ring-auto' }));
    expect(estimateSleepOffRing(base({ heart: edges })).length).toBe(1);
  });

  it('un entreno de noche es un despertar largo: no hay noche; una medida a mano suelta, con horas de silencio a cada lado, es un despertar dentro de la misma noche', () => {
    expect(estimateSleepOffRing(base({ workouts: [{ startMs: t(11, 3, 0), endMs: t(11, 4, 30) }] }))).toEqual([]);
    const [night] = estimateSleepOffRing(base({ heart: [{ tsMs: t(11, 3, 50), bpm: 80, source: 'ring-spot' }] }));
    expect(clock(night!.startMs)).toBe('23:10');
    expect(clock(night!.endMs)).toBe('07:50');
  });

  it('marcas en plena madrugada que dejan un lado sin horas de silencio es una persona despierta: no hay noche', () => {
    // Marcas a las 03:45 y a las 04:20: de ahí a las 08:05 solo hay 3 h 45 min y antes se acaba a las 03:45 (menos de 5 h).
    expect(estimateSleepOffRing(base({ logged: [t(10, 20, 55), t(11, 3, 45), t(11, 8, 40)], syncs: [t(11, 4, 20)] }))).toEqual([]);
  });

  it('los pasos sueltos de una noche con el anillo en la mano (menos de 5) no son marcas', () => {
    const estimates = estimateSleepOffRing(base({ buckets: [walk(t(10, 22, 30)), walk(t(11, 2, 0), 3)] }));
    expect(estimates.length).toBe(1);
  });

  it('un hueco demasiado corto o demasiado largo no es una noche', () => {
    expect(estimateSleepOffRing(base({ syncs: [t(11, 3, 30) + 40 * MIN], logged: [], buckets: [walk(t(10, 23, 50))] }))).toEqual([]); // < 5 h
    expect(estimateSleepOffRing(base({ buckets: [walk(t(10, 8, 0))], logged: [], syncs: [t(11, 8, 5)] }))).toEqual([]); // la última marca del día anterior, a las 08:10: 24 h de hueco
  });

  it('una noche larga (hasta las 15:00) y quien duerme de día (de 06:00 a 16:00) también salen: el hueco no tiene que contener las 04:00', () => {
    const [long] = estimateSleepOffRing(base({ syncs: [t(11, 15, 5)], logged: [t(10, 20, 55)], askedAtMs: t(11, 15, 6) }));
    expect(clock(long!.endMs)).toBe('14:50');
    const [day] = estimateSleepOffRing({ ...base({ buckets: [walk(t(11, 5, 10))], logged: [t(10, 20, 55), t(10, 23, 30), t(11, 2, 15)], syncs: [t(11, 16, 5)], askedAtMs: t(11, 16, 6) }) });
    // La última marca es de madrugada: se acostó justo después (no hay suelo de las 22:00 que aplicar).
    expect(clock(day!.startMs)).toBe('05:50');
    expect(clock(day!.endMs)).toBe('15:50');
  });

  it('un hueco quieto de la mañana o de la tarde (sin pasar por la madrugada) no es una noche', () => {
    expect(estimateSleepOffRing({ ...base({ buckets: [walk(t(11, 8, 0))], logged: [], syncs: [t(11, 15, 0)], askedAtMs: t(11, 16, 0) }) })).toEqual([]);
  });

  it('solo cuando al anillo ya se le pidió el sueño después de esa noche', () => {
    expect(estimateSleepOffRing(base({ askedAtMs: null }))).toEqual([]);
    expect(estimateSleepOffRing(base({ askedAtMs: t(10, 23, 0) }))).toEqual([]);
    expect(estimateSleepOffRing(base({ askedAtMs: t(11, 8, 6) })).length).toBe(1);
  });

  it('solo devuelve las noches que se solapan con lo pedido', () => {
    expect(estimateSleepOffRing(base({ fromMs: t(12, 0), toMs: t(13, 0) }))).toEqual([]);
    expect(estimateSleepOffRing(base({ fromMs: t(10, 0), toMs: t(11, 0) })).length).toBe(1); // acaba el 11 pero empieza el 10
  });

  it('sin mirar cuánto dura: una tarde quieta (última marca a las 20:55) no hace empezar la noche antes de las 22:00, y acaba poco antes de la primera marca de la mañana', () => {
    const [estimate] = estimateSleepOffRing(base({ buckets: [], logged: [t(10, 20, 55)], syncs: [t(11, 8, 5)] }));
    expect(clock(estimate!.startMs)).toBe('22:00');
    expect(estimate!.endMs).toBe(t(11, 8, 5) - OFFRING.lead.sync);
  });

  it('una noche enorme (de las 22:30 a las 13:50, más de 15 h) sale entera: la duración no descarta nada', () => {
    const [estimate] = estimateSleepOffRing(base({ buckets: [walk(t(10, 21, 50))], logged: [], syncs: [t(11, 14, 5)], askedAtMs: t(11, 14, 6) }));
    expect(clock(estimate!.startMs)).toBe('22:30');
    expect(clock(estimate!.endMs)).toBe('13:50');
  });

  it('no calcula de más: sin marcas no hay nada, y un mes entero se recorre bien', () => {
    expect(estimateSleepOffRing(base({ buckets: [], logged: [], syncs: [] }))).toEqual([]);
    const buckets: StepBucket[] = [];
    const syncs: number[] = [];
    for (let d = 1; d <= 28; d++) {
      buckets.push(walk(t(d, 22, 30)), walk(t(d, 9, 0)));
      syncs.push(t(d, 8, 5));
    }
    const month = estimateSleepOffRing({ ...base(), buckets, syncs, logged: [], fromMs: t(2, 0), toMs: t(28, 0), askedAtMs: t(28, 12) });
    expect(month.length).toBeGreaterThanOrEqual(25);
    for (const m of month) expect(m.endMs - m.startMs).toBeGreaterThanOrEqual(OFFRING.minSleepMs);
  });
});
