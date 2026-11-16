import { describe, expect, it } from 'vitest';
import { aggregate, buildDaySummaries, meanPerDay, resolveProfile, type RawRange } from './summary';
import type { ProfileEntry } from './profile';
import { rangeDays } from './dates';

const at = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
const key = (day: number): string => `2026-07-${String(day).padStart(2, '0')}`;
const NOW = at(20, 9);

const history: ProfileEntry[] = [
  { date: '2026-01-01', heightCm: 178, weightKg: 82, sex: 'male', birthDate: '1985-06-15' },
  { date: '2026-07-10', heightCm: 178, weightKg: 79, sex: 'male', birthDate: '1985-06-15' },
];

function raw(over: Partial<RawRange> = {}): RawRange {
  return { buckets: [], counters: [], heart: [], spo2: [], sleep: [], workouts: [], ...over };
}

describe('buildDaySummaries', () => {
  it('cada día usa el perfil vigente EN ESA FECHA: mismo paseo, distinto peso, distintas kcal', () => {
    const bucket = (day: number) => ({ startMs: at(day, 8), endMs: at(day, 8, 30), steps: 3000, ringDistanceM: 0, ringCalories: 0 });
    const out = buildDaySummaries([key(5), key(15)], raw({ buckets: [bucket(5), bucket(15)] }), history, NOW);
    expect(out[0]?.steps).toBe(3000);
    expect(out[1]?.steps).toBe(3000);
    expect(out[0]?.distanceM).toBe(out[1]?.distanceM); // misma altura → misma distancia
    expect(out[0]!.activeKcal! / out[1]!.activeKcal!).toBeCloseTo(82 / 79, 1);
  });

  it('un día sin datos queda en null, no en cero', () => {
    const [d] = buildDaySummaries([key(3)], raw(), history, NOW);
    expect(d).toMatchObject({ steps: null, distanceM: null, activeKcal: null, sleepAsleepSec: null, restingBpm: null, workoutCount: 0 });
  });

  it('reúne sueño, FC y SpO2 del día', () => {
    const sleep = [{ startMs: at(8, 23), endMs: at(9, 7), segments: [{ stage: 'light' as const, startMs: at(8, 23), durationSec: 8 * 3600 }] }];
    const heart = [0, 3, 6, 9, 12, 15].map((h, i) => ({ tsMs: at(9, h), bpm: 52 + i * 3, source: 'ring-auto' as const }));
    const spo2 = [{ tsMs: at(9, 2), percent: 96 }, { tsMs: at(9, 4), percent: 94 }];
    const [d] = buildDaySummaries([key(9)], raw({ sleep, heart, spo2 }), history, NOW);
    expect(d?.sleepAsleepSec).toBe(8 * 3600);
    expect(d?.sleepBedMin).toBe(23 * 60);
    expect(d?.sleepWakeMin).toBe(7 * 60);
    expect(d?.restingBpm).toBe(55);
    expect(d?.maxBpm).toBe(67);
    expect(d?.spo2Min).toBe(94);
  });

  it('sin historial de perfil usa valores genéricos y lo señala', () => {
    expect(resolveProfile([], '2026-07-10').generic).toBe(true);
    expect(resolveProfile(history, '2026-07-10').generic).toBe(false);
  });

  it('cuenta los entrenamientos del día', () => {
    const workouts = [{ id: 'a', sport: 'gym' as const, startMs: at(9, 18), endMs: at(9, 19), pausedMs: 0, source: 'manual' as const }];
    const [d] = buildDaySummaries([key(9)], raw({ workouts }), history, NOW);
    expect(d?.workoutCount).toBe(1);
    expect(d?.workoutMin).toBe(60);
  });
});

describe('buildDaySummaries: comidas', () => {
  const meal = (id: string, day: number, h: number, kcal: number, extra: Record<string, number> = {}) => ({ id, tsMs: at(day, h), name: id, kcal, source: 'manual' as const, ...extra });

  it('suma lo anotado de cada día; un día sin comidas queda en null, no en cero', () => {
    const meals = [meal('a', 5, 9, 400, { proteinG: 20, carbsG: 50, fatG: 10 }), meal('b', 5, 14, 700, { proteinG: 40 }), meal('c', 6, 22, 300)];
    const out = buildDaySummaries([key(4), key(5), key(6)], raw({ meals }), history, NOW);
    expect(out[0]).toMatchObject({ intakeKcal: null, intakeProteinG: null, intakeCarbsG: null, intakeFatG: null });
    expect(out[1]).toMatchObject({ intakeKcal: 1100, intakeProteinG: 60, intakeCarbsG: 50, intakeFatG: 10 });
    expect(out[2]).toMatchObject({ intakeKcal: 300, intakeProteinG: 0 });
  });

  it('una comida a medianoche en punto es del día siguiente', () => {
    const out = buildDaySummaries([key(5), key(6)], raw({ meals: [meal('m', 6, 0, 250)] }), history, NOW);
    expect(out.map((d) => d.intakeKcal)).toEqual([null, 250]);
  });

  it('sin el apartado de comidas todo queda en null', () => {
    expect(buildDaySummaries([key(5)], raw(), history, NOW)[0]?.intakeKcal).toBeNull();
  });
});

describe('buildDaySummaries: entrenos que cruzan la medianoche', () => {
  it('la distancia de una carrera de 23:30 a 00:30 no se cuenta otra vez como paseo al día siguiente', () => {
    const run = { id: 'r', sport: 'run' as const, startMs: at(9, 23, 30), endMs: at(10, 0, 30), pausedMs: 0, source: 'live' as const, steps: 5000, distanceM: 8000, distanceSource: 'gps' as const };
    const buckets = [
      { startMs: at(9, 23, 30), endMs: at(10, 0, 0), steps: 2500, ringDistanceM: 0, ringCalories: 0 },
      { startMs: at(10, 0, 0), endMs: at(10, 0, 30), steps: 2500, ringDistanceM: 0, ringCalories: 0 },
    ];
    const [d9, d10] = buildDaySummaries([key(9), key(10)], raw({ buckets, workouts: [run] }), history, NOW);
    expect(d9?.distanceM).toBe(8000);
    expect(d10?.distanceM).toBe(0);
    expect((d9?.distanceM ?? 0) + (d10?.distanceM ?? 0)).toBe(8000); // antes salían 9 847 m (+23 %)
    expect(d10?.steps).toBe(2500); // los pasos medidos no se tocan
    expect(d10?.workoutCount).toBe(0); // el entreno cuenta en el día en que empezó
  });

  it('el entreno de la víspera también se tiene en cuenta cuando viene como «carryWorkouts» (primer día del rango)', () => {
    const run = { id: 'r', sport: 'run' as const, startMs: at(9, 23, 30), endMs: at(10, 0, 30), pausedMs: 0, source: 'live' as const, distanceM: 8000, distanceSource: 'gps' as const };
    const buckets = [{ startMs: at(10, 0, 0), endMs: at(10, 0, 30), steps: 2500, ringDistanceM: 0, ringCalories: 0 }];
    const [d10] = buildDaySummaries([key(10)], raw({ buckets, carryWorkouts: [run] }), history, NOW);
    expect(d10?.distanceM).toBe(0);
  });
});

describe('buildDaySummaries: comidas pasadas a otro día', () => {
  const meal = (id: string, day: number, h: number, kcal: number, credited?: number) => ({
    id,
    tsMs: at(day, h),
    name: id,
    kcal,
    source: 'manual' as const,
    ...(credited === undefined ? {} : { day: key(credited) }),
  });

  it('una cena de después de medianoche pasada al día anterior suma en ese día, no en el que se comió', () => {
    const meals = [meal('comida', 9, 14, 700), meal('cena', 10, 0, 800, 9), meal('desayuno', 10, 9, 300)];
    const [d9, d10] = buildDaySummaries([key(9), key(10)], raw({ meals }), history, NOW);
    expect(d9?.intakeKcal).toBe(1500);
    expect(d10?.intakeKcal).toBe(300);
  });

  it('pasada al día siguiente, al revés; y un día que se queda sin comidas es null, no cero', () => {
    const [d9, d10] = buildDaySummaries([key(9), key(10)], raw({ meals: [meal('tarde', 9, 23, 400, 10)] }), history, NOW);
    expect(d9?.intakeKcal).toBeNull();
    expect(d10?.intakeKcal).toBe(400);
  });
});

describe('aggregate', () => {
  const days = rangeDays('2026-06-29', '2026-07-12');
  const summaries = buildDaySummaries(
    days,
    raw({
      counters: days.map((_, i) => ({ tsMs: new Date(2026, 5, 29 + i, 21).getTime(), steps: 5000 + i * 100 })),
    }),
    history,
    NOW,
  );

  it('por semanas (lunes) con la media por día con datos', () => {
    const weeks = aggregate(summaries, 'week');
    expect(weeks.map((w) => w.start)).toEqual(['2026-06-29', '2026-07-06']);
    expect(weeks[0]?.steps).toBe(5300);
    expect(weeks[1]?.steps).toBe(6000);
  });

  it('por meses', () => {
    const months = aggregate(summaries, 'month');
    expect(months.map((m) => m.start)).toEqual(['2026-06-01', '2026-07-01']);
    expect(months[0]?.daysWithData).toBe(2);
  });

  it('las noches con sueño de una semana no son los días con algún dato: pasos los 7 días y sueño solo 2 noches = 2 noches', () => {
    const days = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'];
    const sleepSession = (day: number) => ({ startMs: at(day - 1, 23), endMs: at(day, 7), segments: [{ stage: 'light' as const, startMs: at(day - 1, 23), durationSec: 8 * 3600 }] });
    const summaries = buildDaySummaries(
      days,
      raw({ counters: days.map((_, i) => ({ tsMs: at(6 + i, 21), steps: 6000 + i * 100 })), sleep: [sleepSession(7), sleepSession(9)] }),
      history,
      new Date(2026, 6, 20).getTime(),
    );
    const week = aggregate(summaries, 'week')[0];
    expect(week?.daysWithData).toBe(7);
    expect(week?.sleepNights).toBe(2);
  });

  it('el pulso de un periodo da los extremos de sus días (no medias de extremos) y cuántos días tienen lecturas', () => {
    const days = ['2026-07-06', '2026-07-07', '2026-07-08'];
    const beat = (day: number, hour: number, bpm: number) => ({ tsMs: at(day, hour), bpm, source: 'ring-auto' as const });
    const summaries = buildDaySummaries(days, raw({ heart: [beat(6, 3, 52), beat(6, 12, 90), beat(7, 3, 48), beat(7, 18, 130)] }), history, new Date(2026, 6, 20).getTime());
    const week = aggregate(summaries, 'week')[0];
    expect(week).toMatchObject({ minBpm: 48, maxBpm: 130, heartDays: 2 });
    expect(aggregate(summaries, 'day').map((p) => [p.minBpm, p.maxBpm])).toEqual([[52, 90], [48, 130], [null, null]]);
  });

  it('el día en curso (parcial) no entra en las medias de pasos, distancia y calorías de su semana o mes', () => {
    const week = ['2026-07-06', '2026-07-07', '2026-07-08'];
    const partial = buildDaySummaries(
      week,
      raw({ counters: [{ tsMs: at(6, 21), steps: 9000 }, { tsMs: at(7, 21), steps: 7000 }, { tsMs: at(8, 9), steps: 300 }] }),
      history,
      NOW,
    );
    // Sin indicarlo, el miércoles a medias (300 pasos) cuenta como un día entero.
    expect(aggregate(partial, 'week')[0]?.steps).toBe(5433);
    const point = aggregate(partial, 'week', { partialDay: '2026-07-08' })[0];
    expect(point?.steps).toBe(8000);
    expect(point?.distanceM).toBeGreaterThan(5000); // tampoco entra en distancia ni en calorías
    expect(point?.activityDays).toBe(2);
    expect(point?.daysWithData).toBe(3); // pero sí cuenta como día con datos
  });

  it('si el único día de la semana es el parcial, la semana no tiene media de pasos (no se inventa con unos cientos de pasos)', () => {
    const monday = buildDaySummaries(['2026-07-06'], raw({ counters: [{ tsMs: at(6, 9), steps: 300 }] }), history, NOW);
    const point = aggregate(monday, 'week', { partialDay: '2026-07-06' })[0];
    expect(point?.steps).toBeNull();
    expect(point?.activityDays).toBe(0);
  });

  it('por días la barra del día en curso se queda como está (a medias, pero es la de ese día)', () => {
    const partial = buildDaySummaries(['2026-07-08'], raw({ counters: [{ tsMs: at(8, 9), steps: 300 }] }), history, NOW);
    expect(aggregate(partial, 'day', { partialDay: '2026-07-08' })[0]?.steps).toBe(300);
  });

  it('los días sin datos no bajan la media', () => {
    const sparse = buildDaySummaries(
      ['2026-07-06', '2026-07-07', '2026-07-08'],
      raw({ counters: [{ tsMs: at(6, 21), steps: 9000 }] }),
      history,
      NOW,
    );
    expect(aggregate(sparse, 'week')[0]?.steps).toBe(9000);
  });
});

describe('aggregate: calorías comidas', () => {
  const days = (values: Array<number | null>) =>
    buildDaySummaries(
      values.map((_, i) => key(6 + i)),
      raw({ meals: values.flatMap((kcal, i) => (kcal === null ? [] : [{ id: `m${i}`, tsMs: at(6 + i, 13), name: 'x', kcal, source: 'manual' as const }])) }),
      history,
      NOW,
    );

  it('la media es por día CON comidas: un día sin anotar no cuenta como cero', () => {
    const [week] = aggregate(days([2000, null, 2200]), 'week');
    expect(week).toMatchObject({ intakeKcal: 2100, intakeDays: 2 });
  });

  it('sin ningún día anotado no hay media', () => {
    expect(aggregate(days([null, null]), 'week')[0]).toMatchObject({ intakeKcal: null, intakeDays: 0 });
  });

  it('el día en curso, a medias, no entra en la media de la semana pero por días se ve tal cual', () => {
    const summaries = days([2000, 2200, 300]); // el último (8 jul) es «hoy»
    expect(aggregate(summaries, 'week', { partialDay: key(8) })[0]).toMatchObject({ intakeKcal: 2100, intakeDays: 2 });
    expect(aggregate(summaries, 'day', { partialDay: key(8) }).map((p) => p.intakeKcal)).toEqual([2000, 2200, 300]);
  });
});

describe('meanPerDay: media por día con datos', () => {
  const days = rangeDays('2026-07-06', '2026-07-12');
  // Seis días a 8000 pasos; el último (hoy, a medias) lleva 800.
  const summaries = buildDaySummaries(
    days,
    raw({ counters: days.map((_, i) => ({ tsMs: new Date(2026, 6, 6 + i, 21).getTime(), steps: i === 6 ? 800 : 8000 })) }),
    history,
    NOW,
  );

  it('los días sin dato no cuentan como cero', () => {
    const sparse = buildDaySummaries(['2026-07-06', '2026-07-07', '2026-07-08'], raw({ counters: [{ tsMs: at(6, 21), steps: 9000 }] }), history, NOW);
    expect(meanPerDay(sparse, (d) => d.steps)).toBe(9000);
    expect(meanPerDay(sparse, (d) => d.sleepAsleepSec)).toBeNull();
  });

  it('se puede dejar fuera el día en curso, que aún no ha terminado', () => {
    expect(meanPerDay(summaries, (d) => d.steps)).toBeCloseTo((6 * 8000 + 800) / 7, 5);
    expect(meanPerDay(summaries, (d) => d.steps, { skipDay: '2026-07-12' })).toBe(8000);
  });

  it('pesa cada DÍA por igual: no es la media de las medias de las semanas', () => {
    // Una semana de 1 día a 2000 y otra de 7 días a 8000: la media por día no es (2000 + 8000) / 2.
    const all = rangeDays('2026-06-28', '2026-07-12');
    const s = buildDaySummaries(all, raw({ counters: all.map((_, i) => ({ tsMs: new Date(2026, 5, 28 + i, 21).getTime(), steps: i === 0 ? 2000 : 8000 })) }), history, NOW);
    const weeks = aggregate(s, 'week');
    const meanOfMeans = (weeks.reduce((a, w) => a + (w.steps ?? 0), 0)) / weeks.length;
    const perDay = meanPerDay(s, (d) => d.steps) ?? 0;
    expect(perDay).toBeCloseTo((2000 + 14 * 8000) / 15, 5);
    expect(meanOfMeans).toBeLessThan(perDay); // el 28 de junio, solo, pesaba como una semana entera
  });
});

describe('buildDaySummaries y aggregate: agua', () => {
  const sip = (id: string, day: number, h: number, ml: number) => ({ id, tsMs: at(day, h), ml });

  it('suma el agua de cada día (la de su hora); un día sin tomas queda en null, no en cero', () => {
    const water = [sip('a', 5, 9, 250), sip('b', 5, 21, 500), sip('c', 6, 8, 1000)];
    const out = buildDaySummaries([key(4), key(5), key(6)], raw({ water }), history, NOW);
    expect(out.map((d) => d.waterMl)).toEqual([null, 750, 1000]);
  });

  it('la meta de cada día es la de su perfil (35 ml/kg, 80 % en bebidas) y sube con los entrenos: una carrera de una hora, más de un litro', () => {
    const noExercise = buildDaySummaries([key(12)], raw(), history, NOW)[0]!;
    expect(noExercise.waterGoalMl).toBe(2200); // 79 kg: 35 ml/kg × 79 × 0,8 = 2212 → 2200
    const hour = [{ id: 'r', sport: 'run' as const, startMs: at(12, 18), endMs: at(12, 19), pausedMs: 0, source: 'manual' as const, distanceM: 10_000 }];
    const run = buildDaySummaries([key(12)], raw({ workouts: hour }), history, NOW)[0]!;
    expect(run.waterGoalMl - noExercise.waterGoalMl).toBeGreaterThan(800);
    expect(run.waterGoalMl % 50).toBe(0);
  });

  it('los pasos solos suben algo la meta y más pasos, más meta', () => {
    const bucket = (day: number, steps: number) => ({ startMs: at(day, 8), endMs: at(day, 10), steps, ringDistanceM: 0, ringCalories: 0 });
    const few = buildDaySummaries([key(12)], raw({ buckets: [bucket(12, 2000)] }), history, NOW)[0]!;
    const many = buildDaySummaries([key(12)], raw({ buckets: [bucket(12, 20_000)] }), history, NOW)[0]!;
    expect(many.waterGoalMl).toBeGreaterThan(few.waterGoalMl);
  });

  it('en semanas y meses, la media por día con agua anotada y la meta media de esos días (el día en curso, a medias, no cuenta)', () => {
    const water = [sip('a', 6, 9, 2000), sip('b', 7, 9, 1000), sip('c', 8, 9, 300)];
    const days = buildDaySummaries([key(6), key(7), key(8), key(9)], raw({ water }), history, at(8, 12));
    const [week] = aggregate(days, 'week', { partialDay: key(8) });
    expect(week).toMatchObject({ waterMl: 1500, waterDays: 2 });
    expect(week?.waterGoalMl).toBe(2300); // 82 kg esos días (el peso cambia el 10)
    // Por días no cambia nada: el día en curso sale con lo que lleva.
    expect(aggregate(days, 'day').map((p) => p.waterMl)).toEqual([2000, 1000, 300, null]);
  });
});
