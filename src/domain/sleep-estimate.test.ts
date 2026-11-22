import { describe, expect, it } from 'vitest';
import { backtestEstimate, estimateSleep, MIN_ESTIMATED_SLEEP_MS, summarizeBacktest, type SleepEstimateInput } from './sleep-estimate';
import type { HeartSample, SleepSessionRecord, StepBucket } from './types';

// TZ = Europe/Madrid (vitest.config.ts). Octubre de 2026: del 5 al 14, sin cambio de hora (es el 25).
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 3_600_000;

interface Plan {
  /** Horas (de 0 a 23) en las que duerme, y desde qué día hasta cuál se genera. */
  asleep: (hour: number) => boolean;
  fromDay?: number;
  toDay?: number;
}

const NIGHT_SLEEPER: Plan['asleep'] = (hour) => hour >= 23 || hour < 7;
const DAY_SLEEPER: Plan['asleep'] = (hour) => hour >= 6 && hour < 16;

/** Diez días con el pulso cada hora (dormido ~55, despierto 70–85) y un tramo de pasos en cada hora despierta. Con `breathing`, cada lectura trae también la respiración (dormido 12–13, despierto 16–18). */
function scenario(plan: Plan, breathing = false): { heart: HeartSample[]; buckets: StepBucket[] } {
  const heart: HeartSample[] = [];
  const buckets: StepBucket[] = [];
  for (let day = plan.fromDay ?? 5; day <= (plan.toDay ?? 14); day++) {
    for (let hour = 0; hour < 24; hour++) {
      const sleeping = plan.asleep(hour);
      heart.push({ tsMs: at(day, hour), bpm: sleeping ? 53 + (hour % 4) : 70 + (hour % 5) * 3, source: 'ring-auto', ...(breathing ? { resp: sleeping ? 12 + (hour % 2) : 16 + (hour % 3) } : {}) });
      if (!sleeping) buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 120, ringDistanceM: 80, ringCalories: 5 });
    }
  }
  return { heart, buckets };
}

const input = (data: { heart: HeartSample[]; buckets: StepBucket[] }, extra: Partial<SleepEstimateInput> = {}): SleepEstimateInput => ({
  heart: data.heart,
  buckets: data.buckets,
  counters: [],
  workouts: [],
  real: [],
  // Se le pidió el sueño al anillo el día 15 por la tarde: todas las noches de los datos son anteriores.
  askedAtMs: at(15, 18),
  fromMs: at(5, 0),
  toMs: at(15, 0),
  ...extra,
});

describe('estimateSleep', () => {
  it('primero la forma normal: sin haberle pedido el sueño al anillo (nunca, o antes de que acabara la noche) no se estima nada', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    expect(estimateSleep(input(data, { askedAtMs: null }))).toEqual([]);
    // Se le pidió el día 9 a las 12: las noches que acabaron antes se estiman; las posteriores esperan a la siguiente sincronización.
    const asked = at(9, 12);
    const sessions = estimateSleep(input(data, { askedAtMs: asked }));
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions.every((s) => s.endMs <= asked)).toBe(true);
    expect(sessions.length).toBeLessThan(estimateSleep(input(data)).length);
  });

  it('si el anillo dio sesión esa noche, no se estima aunque se le haya pedido después', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const real: SleepSessionRecord = { startMs: at(7, 23, 10), endMs: at(8, 6, 40), segments: [] };
    const sessions = estimateSleep(input(data, { real: [real] }));
    expect(sessions.some((s) => s.startMs < real.endMs && s.endMs > real.startMs)).toBe(false);
    expect(sessions.length).toBeGreaterThanOrEqual(7); // el resto de noches siguen estimándose
  });

  it('estima cada noche de quien duerme de noche, con las horas a media hora de las reales', () => {
    const sessions = estimateSleep(input(scenario({ asleep: NIGHT_SLEEPER })));
    // Del 5 al 14 de octubre hay nueve noches completas: la del 4 al 5 empieza antes de los datos (cortada, no se estima) y la del
    // 14 al 15 acaba a las 07:00 del 15, justo en el último día con datos.
    expect(sessions).toHaveLength(9);
    for (const session of sessions) {
      expect(session.estimated).toBe(true);
      expect(session.segments).toEqual([]);
      const startHour = new Date(session.startMs).getHours() + new Date(session.startMs).getMinutes() / 60;
      const endHour = new Date(session.endMs).getHours() + new Date(session.endMs).getMinutes() / 60;
      expect(startHour).toBeGreaterThanOrEqual(22.25);
      expect(startHour).toBeLessThanOrEqual(23.5);
      expect(endHour).toBeGreaterThanOrEqual(6.25);
      expect(endHour).toBeLessThanOrEqual(7.25);
    }
  });

  it('también quien duerme de día (06:00–16:00): la franja del anillo no importa', () => {
    const sessions = estimateSleep(input(scenario({ asleep: DAY_SLEEPER })));
    expect(sessions.length).toBeGreaterThanOrEqual(8);
    const [first] = sessions;
    expect(new Date(first?.startMs ?? 0).getHours()).toBeGreaterThanOrEqual(5);
    expect(new Date(first?.startMs ?? 0).getHours()).toBeLessThanOrEqual(6);
    expect(new Date(first?.endMs ?? 0).getHours()).toBeGreaterThanOrEqual(15);
  });

  it('donde el anillo sí dio la noche, no se estima otra', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const real: SleepSessionRecord = { startMs: at(9, 23, 10), endMs: at(10, 7, 5), segments: [] };
    const sessions = estimateSleep(input(data, { real: [real] }));
    expect(sessions.some((s) => s.endMs > real.startMs - 90 * 60_000 && s.startMs < real.endMs + 90 * 60_000)).toBe(false);
    // Las demás noches siguen estimándose.
    expect(sessions.length).toBeGreaterThanOrEqual(7);
  });

  it('un rato quieto de tarde con el pulso de reposo no es una noche (menos de 3 h, y despierto alrededor)', () => {
    const data = scenario({ asleep: (hour) => hour >= 15 && hour < 18 });
    expect(estimateSleep(input(data))).toEqual([]);
  });

  it('con pocas lecturas de pulso no se opina', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER, fromDay: 13, toDay: 13 });
    expect(data.heart.length).toBeLessThan(30);
    expect(estimateSleep(input({ heart: data.heart.slice(0, 20), buckets: data.buckets }))).toEqual([]);
  });

  it('una noche que sigue en curso (la última lectura es de dormido) no se da por acabada', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const lastNight = at(14, 23);
    const cut = { heart: data.heart.filter((h) => h.tsMs <= at(15, 3)), buckets: data.buckets.filter((b) => b.startMs <= at(15, 3)) };
    const sessions = estimateSleep(input(cut, { toMs: at(16, 0) }));
    expect(sessions.some((s) => s.startMs >= lastNight - HOUR)).toBe(false);
  });

  it('un paseo de una hora o las idas al baño de madrugada no parten la noche; uno largo sí', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const bathroom: StepBucket = { startMs: at(10, 3, 10), endMs: at(10, 3, 14), steps: 12, ringDistanceM: 8, ringCalories: 0 };
    const hourWalk: StepBucket = { startMs: at(11, 3, 0), endMs: at(11, 4, 0), steps: 900, ringDistanceM: 600, ringCalories: 30 };
    const longWalk: StepBucket[] = [3, 4, 5].map((hour) => ({ startMs: at(12, hour, 0), endMs: at(12, hour, 59), steps: 900, ringDistanceM: 600, ringCalories: 30 }));
    const sessions = estimateSleep(input({ heart: data.heart, buckets: [...data.buckets, bathroom, hourWalk, ...longWalk] }));
    const covering = (day: number) => sessions.filter((s) => s.endMs > at(day, 0) && s.startMs < at(day, 8));
    for (const day of [10, 11]) {
      expect(covering(day)).toHaveLength(1);
      expect(covering(day)[0]?.endMs ?? 0).toBeGreaterThan(at(day, 6));
    }
    // De 3 a 6 caminando: lo que queda antes (hasta las 3) es una noche de 4 h y lo de después no llega a 3 h.
    const walked = covering(12);
    expect(walked).toHaveLength(1);
    expect(walked[0]?.endMs ?? Infinity).toBeLessThan(at(12, 3, 30));
  });

  it('un repunte aislado del pulso (una fase REM) no la parte', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const heart = data.heart.map((h) => (h.tsMs === at(10, 3) ? { ...h, bpm: 63 } : h));
    const sessions = estimateSleep(input({ heart, buckets: data.buckets }));
    const night = sessions.filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 8));
    expect(night).toHaveLength(1);
    expect(night[0]?.endMs ?? 0).toBeGreaterThan(at(10, 6));
  });

  it('un corte de la medida de unas horas dentro de la noche no la parte, y de día no inventa sueño', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const inNight = data.heart.filter((h) => !(h.tsMs >= at(10, 1) && h.tsMs <= at(10, 4)));
    const night = estimateSleep(input({ heart: inNight, buckets: data.buckets })).filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 8));
    expect(night).toHaveLength(1);
    // Anillo quitado de 9 a 17 (sin lecturas ni pasos): no es dormir.
    const off = (ms: number) => ms >= at(10, 9) && ms <= at(10, 17);
    const sessions = estimateSleep(input({ heart: data.heart.filter((h) => !off(h.tsMs)), buckets: data.buckets.filter((b) => !off(b.startMs)) }));
    expect(sessions.filter((s) => s.endMs > at(10, 8) && s.startMs < at(10, 22))).toHaveLength(0);
  });

  it('un entreno largo en mitad de la noche cuenta como despierto y la parte; uno corto o una medida a mano, no', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const covering = (sessions: SleepSessionRecord[], day: number) => sessions.filter((s) => s.endMs > at(day, 0) && s.startMs < at(day, 8));
    // De 1:00 a 4:30 despierto: quedan dos trozos de menos de 3 h.
    expect(covering(estimateSleep(input(data, { workouts: [{ startMs: at(10, 1), endMs: at(10, 4, 30) }] })), 10)).toHaveLength(0);
    // Una hora despierto de madrugada: sigue siendo la misma noche.
    expect(covering(estimateSleep(input(data, { workouts: [{ startMs: at(10, 2), endMs: at(10, 3) }] })), 10)).toHaveLength(1);
    const heart: HeartSample[] = [...data.heart, { tsMs: at(10, 2, 30), bpm: 56, source: 'ring-spot' }];
    expect(covering(estimateSleep(input({ heart, buckets: data.buckets })), 10)).toHaveLength(1);
  });

  it('el pulso de un entreno no cuenta como lectura automática', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const workoutOnly = data.heart.map((h) => ({ ...h, source: 'workout' as const }));
    expect(estimateSleep(input({ heart: workoutOnly, buckets: data.buckets }))).toEqual([]);
  });

  it('solo devuelve lo que toca el rango pedido', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const sessions = estimateSleep(input(data, { fromMs: at(9, 0), toMs: at(10, 0) }));
    expect(sessions.every((s) => s.endMs > at(9, 0) && s.startMs < at(10, 0))).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('con lecturas cada dos horas también la encuentra', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const heart = data.heart.filter((h) => new Date(h.tsMs).getHours() % 2 === 1 || new Date(h.tsMs).getHours() === 23);
    const sessions = estimateSleep(input({ heart, buckets: data.buckets }));
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    for (const s of sessions) expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(MIN_ESTIMATED_SLEEP_MS);
  });

  it('si el pulso no distingue dormida de despierta (siempre el mismo), no se opina', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const flat = data.heart.map((h, i) => ({ ...h, bpm: 62 + (i % 3) }));
    expect(estimateSleep(input({ heart: flat, buckets: [] }))).toEqual([]);
  });

  it('una noche cortada por el principio de los datos o que sigue en curso no se estima', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const sessions = estimateSleep(input(data));
    expect(sessions.some((s) => s.startMs < at(5, 12))).toBe(false);
    const cut = { heart: data.heart.filter((h) => h.tsMs <= at(15, 3)), buckets: data.buckets.filter((b) => b.startMs <= at(15, 3)) };
    expect(estimateSleep(input(cut, { toMs: at(16, 0) })).some((s) => s.endMs > at(15, 0))).toBe(false);
  });

  it('el cambio de hora de octubre (la noche del 24 al 25 dura una hora más) no la descoloca', () => {
    const heart: HeartSample[] = [];
    const buckets: StepBucket[] = [];
    for (let ms = at(18, 0); ms < at(31, 0); ms += HOUR) {
      const hour = new Date(ms).getHours();
      const sleeping = hour >= 23 || hour < 7;
      heart.push({ tsMs: ms, bpm: sleeping ? 53 + (hour % 4) : 70 + (hour % 5) * 3, source: 'ring-auto' });
      if (!sleeping) buckets.push({ startMs: ms + 5 * 60_000, endMs: ms + 35 * 60_000, steps: 120, ringDistanceM: 80, ringCalories: 5 });
    }
    const sessions = estimateSleep({ heart, buckets, counters: [], workouts: [], real: [], askedAtMs: at(31, 18), fromMs: at(18, 0), toMs: at(31, 0) });
    expect(sessions.length).toBeGreaterThanOrEqual(11);
    for (const s of sessions) {
      const startHour = new Date(s.startMs).getHours() + new Date(s.startMs).getMinutes() / 60;
      const endHour = new Date(s.endMs).getHours() + new Date(s.endMs).getMinutes() / 60;
      expect(startHour).toBeGreaterThanOrEqual(22.25);
      expect(startHour).toBeLessThanOrEqual(23.5);
      expect(endHour).toBeGreaterThanOrEqual(6.25);
      expect(endHour).toBeLessThanOrEqual(7.25);
    }
  });

  it('nunca da una noche de más de 14 h', () => {
    const data = scenario({ asleep: () => true });
    expect(estimateSleep(input({ heart: data.heart, buckets: [] }))).toEqual([]);
  });
});

describe('estimateSleep: la respiración', () => {
  const flatHeart = (data: { heart: HeartSample[]; buckets: StepBucket[] }): HeartSample[] => data.heart.map((h, i) => ({ ...h, bpm: 62 + (i % 3) }));

  it('si el pulso no distingue dormida de despierta pero la respiración sí, se estima igual', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER }, true);
    expect(estimateSleep(input({ heart: flatHeart(data).map((h) => ({ ...h, resp: undefined })), buckets: [] }))).toEqual([]);
    const sessions = estimateSleep(input({ heart: flatHeart(data), buckets: [] }));
    expect(sessions.length).toBeGreaterThanOrEqual(7);
    for (const session of sessions) {
      const startHour = new Date(session.startMs).getHours() + new Date(session.startMs).getMinutes() / 60;
      const endHour = new Date(session.endMs).getHours() + new Date(session.endMs).getMinutes() / 60;
      expect(startHour).toBeGreaterThanOrEqual(21.5);
      expect(startHour).toBeLessThanOrEqual(23.75);
      expect(endHour).toBeGreaterThanOrEqual(6);
      expect(endHour).toBeLessThanOrEqual(7.5);
    }
  });

  it('una lectura de pulso disparada en mitad de la noche (el sensor se mueve) no la parte si la respiración sigue siendo de dormido, ni se convierte en «el nivel de despierto»', () => {
    // Con ratos despierto y quieto (sin pasos en una de cada tres horas): la persona tiene sus dos niveles de verdad y una sola lectura de 118 no los cambia.
    const data = scenario({ asleep: NIGHT_SLEEPER }, true);
    const buckets = data.buckets.filter((b) => new Date(b.startMs).getHours() % 3 !== 0);
    const heart = data.heart.map((h) => (h.tsMs === at(10, 3) ? { ...h, bpm: 118 } : h));
    const night = estimateSleep(input({ heart, buckets })).filter((s) => s.endMs > at(10, 0) && s.startMs < at(10, 8));
    expect(night).toHaveLength(1);
    expect(night[0]?.endMs ?? 0).toBeGreaterThan(at(10, 6));
    expect(estimateSleep(input({ heart, buckets })).length).toBeGreaterThanOrEqual(8);
  });
});

describe('estimateSleep: lo que la persona hizo con la app', () => {
  it('algo anotado a las 2 de la madrugada (despierta) parte la noche si va seguido de más rato despierto, y una marca suelta de otro momento no cambia nada', () => {
    const data = scenario({ asleep: NIGHT_SLEEPER });
    const covering = (sessions: SleepSessionRecord[], day: number) => sessions.filter((s) => s.endMs > at(day, 0) && s.startMs < at(day, 8));
    const plain = covering(estimateSleep(input(data)), 10);
    expect(plain).toHaveLength(1);
    // Un vaso de agua a las 15:00 (despierta de todos modos): igual.
    expect(covering(estimateSleep(input(data, { awakeMarks: [at(10, 15)] })), 10)).toEqual(plain);
    // Marcas cada pocos minutos de 01:00 a 04:30 (estuvo despierta con el móvil): ya no es una noche de 8 h.
    const marks = Array.from({ length: 22 }, (_, i) => at(10, 1) + i * 10 * 60_000);
    const split = covering(estimateSleep(input(data, { awakeMarks: marks })), 10);
    expect(split.every((s) => s.endMs - s.startMs < 6 * HOUR)).toBe(true);
  });
});

describe('estimateSleep: aprende de las noches que el anillo sí guardó', () => {
  // Quien se acuesta a las 23:00 pero el anillo da su sueño desde las 23:50 y hasta las 06:40: la estimación sola dice 23:00–07:00.
  const data = scenario({ asleep: NIGHT_SLEEPER });
  const ring = (day: number): SleepSessionRecord => ({ startMs: at(day, 23, 50), endMs: at(day + 1, 6, 40), segments: [] });

  it('con tres o más noches conocidas, las demás se corrigen en la dirección del desvío (sin pasarse)', () => {
    const base = estimateSleep(input(data, { real: [] }));
    const known = [ring(5), ring(6), ring(7)];
    const learned = estimateSleep(input(data, { real: known }));
    const noKnown = (day: number) => (list: SleepSessionRecord[]) => list.find((s) => s.startMs > at(day, 20) && s.startMs < at(day + 1, 3));
    const day = 10;
    const before = noKnown(day)(base);
    const after = noKnown(day)(learned);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // Antes ≈ 23:00 y 07:00 (la hora real de dormir); la guía del anillo (23:50 → 06:40) mueve el inicio más tarde y el final más pronto.
    expect(after!.startMs).toBeGreaterThan(before!.startMs);
    expect(after!.endMs).toBeLessThan(before!.endMs);
    // Atenuado (3 pares de 3 + 3 = la mitad) y acotado a una hora.
    expect(after!.startMs - before!.startMs).toBeLessThanOrEqual(60 * 60_000);
    expect(before!.endMs - after!.endMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it('con menos de tres noches conocidas no se toca nada', () => {
    const base = estimateSleep(input(data, { real: [] }));
    const two = estimateSleep(input(data, { real: [ring(5), ring(6)] }));
    const day10 = (list: SleepSessionRecord[]) => list.find((s) => s.startMs > at(10, 20) && s.startMs < at(11, 3));
    expect(day10(two)).toEqual(day10(base));
  });
});

describe('backtestEstimate', () => {
  const data = scenario({ asleep: NIGHT_SLEEPER });

  it('compara cada noche conocida con lo que se habría estimado sin saberla', () => {
    const known: SleepSessionRecord[] = [7, 8, 9].map((day) => ({ startMs: at(day, 23, 0), endMs: at(day + 1, 7, 0), segments: [] }));
    const pairs = backtestEstimate(input(data, { real: known }));
    expect(pairs).toHaveLength(3);
    const summary = summarizeBacktest(pairs);
    expect(summary?.nights).toBe(3);
    // Los datos son perfectos y las noches conocidas, exactas: el error es del orden de lo que da la propia medida (una lectura por hora).
    expect(summary?.startMin).toBeLessThanOrEqual(35);
    expect(summary?.endMin).toBeLessThanOrEqual(35);
    expect(summary?.durationMin).toBeLessThanOrEqual(60);
  });

  it('sin noches conocidas, o con una que no se parece a nada de lo estimado, no hay con qué comparar', () => {
    expect(summarizeBacktest(backtestEstimate(input(data, { real: [] })))).toBeNull();
    const far: SleepSessionRecord = { startMs: at(8, 12), endMs: at(8, 17), segments: [] }; // una tarde quieta
    expect(backtestEstimate(input(data, { real: [far] }))).toEqual([]);
  });
});
