import { describe, expect, it } from 'vitest';
import { rangeDays } from './dates';
import { autoGranularity, buildJointSlots, rangeForPreset } from './evolution';
import type { ProfileEntry } from './profile';
import type { DaySummary } from './summary';

describe('rangeForPreset', () => {
  it('termina hoy e incluye hoy', () => {
    expect(rangeForPreset('7', '2026-07-10', null)).toEqual({ from: '2026-07-04', to: '2026-07-10' });
    expect(rangeForPreset('30', '2026-07-10', null)).toEqual({ from: '2026-06-11', to: '2026-07-10' });
    expect(rangeForPreset('365', '2026-07-10', null)).toEqual({ from: '2025-07-11', to: '2026-07-10' });
  });

  it('"todo" empieza en el primer día con datos, o 30 días atrás si no hay', () => {
    expect(rangeForPreset('all', '2026-07-10', '2026-03-02')).toEqual({ from: '2026-03-02', to: '2026-07-10' });
    expect(rangeForPreset('all', '2026-07-10', null).from).toBe('2026-06-11');
    expect(rangeForPreset('all', '2026-07-10', '2026-07-10').from).toBe('2026-06-11');
  });
});

describe('autoGranularity', () => {
  it('siempre por días, también con 90 días, un año o todo (las semanas y los meses acumulados no dicen nada útil)', () => {
    for (const days of [1, 7, 30, 45, 46, 90, 200, 365, 1200]) expect(autoGranularity(days)).toBe('day');
  });
});

describe('buildJointSlots: actividad, comida y peso alineados en el tiempo', () => {
  const day = (d: string, over: Partial<DaySummary> = {}): DaySummary => ({
    day: d,
    steps: null,
    distanceM: null,
    activeKcal: null,
    workoutCount: 0,
    workoutMin: 0,
    sleepAsleepSec: null,
    sleepInBedSec: null,
    sleepBedMin: null,
    sleepWakeMin: null,
    restingBpm: null,
    avgBpm: null,
    minBpm: null,
    maxBpm: null,
    spo2Avg: null,
    spo2Min: null,
    intakeKcal: null,
    intakeProteinG: null,
    intakeCarbsG: null,
    intakeFatG: null,
    intakeFiberG: null,
    intakeSugarsG: null,
    intakeSaltG: null,
    waterMl: null,
    waterGoalMl: 2200,
    ...over,
  });
  const entry = (date: string, weightKg: number, over: Partial<ProfileEntry> = {}): ProfileEntry => ({ date, heightCm: 178, weightKg, sex: 'male', birthDate: '1985-06-15', ...over });
  const days = (from: string, to: string, over: (d: string, i: number) => Partial<DaySummary> = () => ({})): DaySummary[] => rangeDays(from, to).map((d, i) => day(d, over(d, i)));

  it('por días hay un punto por día con sus pasos y sus calorías comidas; el peso arrastra el último conocido desde la primera pesada', () => {
    const history = [entry('2026-07-03', 80), entry('2026-07-06', 79.4)];
    const summaries = days('2026-07-01', '2026-07-07', (_, i) => ({ steps: 1000 * (i + 1), intakeKcal: i === 2 ? null : 2000 + i * 10 }));
    const slots = buildJointSlots(summaries, 'day', history, { from: '2026-07-01', to: '2026-07-07' }, '2026-07-07');
    expect(slots).toHaveLength(7);
    expect(slots.map((s) => s.start)).toEqual(rangeDays('2026-07-01', '2026-07-07'));
    expect(slots.map((s) => s.steps)).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    expect(slots.map((s) => s.intakeKcal)).toEqual([2000, 2010, null, 2030, 2040, 2050, 2060]);
    expect(slots.map((s) => s.weightKg)).toEqual([null, null, 80, 80, 80, 79.4, 79.4]);
    expect(slots.map((s) => s.weighed)).toEqual([false, false, true, false, false, true, false]);
  });

  it('con una sola pesada el gráfico no queda vacío: su peso sigue igual hasta hoy (nadie se pesa para decir que no ha cambiado)', () => {
    const slots = buildJointSlots(days('2026-07-01', '2026-07-10'), 'day', [entry('2026-07-04', 80)], { from: '2026-07-01', to: '2026-07-10' }, '2026-07-10');
    expect(slots.map((s) => s.weightKg)).toEqual([null, null, null, 80, 80, 80, 80, 80, 80, 80]);
    expect(slots.filter((s) => s.weighed)).toHaveLength(1);
    // Y un rango posterior a la pesada, sin ninguna dentro, sale entero con ese peso.
    const later = buildJointSlots(days('2026-07-08', '2026-07-10'), 'day', [entry('2026-07-04', 80)], { from: '2026-07-08', to: '2026-07-10' }, '2026-07-10');
    expect(later.map((s) => s.weightKg)).toEqual([80, 80, 80]);
    expect(later.some((s) => s.weighed)).toBe(false);
  });

  it('el peso que ya regía al empezar el rango sale en el primer día (el de la última pesada anterior)', () => {
    const history = [entry('2026-06-20', 81), entry('2026-07-04', 80)];
    const slots = buildJointSlots(days('2026-07-01', '2026-07-05'), 'day', history, { from: '2026-07-01', to: '2026-07-05' }, '2026-07-05');
    expect(slots.map((s) => s.weightKg)).toEqual([81, 81, 81, 80, 80]);
  });

  it('antes de la primera pesada no se inventa un peso', () => {
    const history = [entry('2026-07-04', 80)];
    const slots = buildJointSlots(days('2026-07-01', '2026-07-05'), 'day', history, { from: '2026-07-01', to: '2026-07-05' }, '2026-07-05');
    expect(slots.map((s) => s.weightKg)).toEqual([null, null, null, 80, 80]);
    const noHistory = buildJointSlots(days('2026-07-01', '2026-07-03'), 'day', [], { from: '2026-07-01', to: '2026-07-03' }, '2026-07-03');
    expect(noHistory).toHaveLength(3);
    expect(noHistory.every((s) => s.weightKg === null)).toBe(true);
  });

  it('una entrada que solo fija la zancada no es una pesada', () => {
    const history = [entry('2026-06-20', 81), entry('2026-07-03', 81, { strideOnly: true, strideCm: 77 })];
    const slots = buildJointSlots(days('2026-07-01', '2026-07-05'), 'day', history, { from: '2026-07-01', to: '2026-07-05' }, '2026-07-05');
    expect(slots.map((s) => s.weightKg)).toEqual([81, 81, 81, 81, 81]);
  });

  it('por semanas: la última pesada de la semana gana y los pasos son la media por día', () => {
    // 22 jun (lunes) a 12 jul (domingo): tres semanas completas.
    const history = [entry('2026-06-24', 81), entry('2026-06-26', 80.6), entry('2026-07-08', 79)];
    const summaries = days('2026-06-22', '2026-07-12', (_, i) => ({ steps: i < 7 ? 6000 : i < 14 ? 8000 : 10_000, intakeKcal: i === 3 ? null : 2100 }));
    const slots = buildJointSlots(summaries, 'week', history, { from: '2026-06-22', to: '2026-07-12' }, '2026-07-12');
    expect(slots.map((s) => s.start)).toEqual(['2026-06-22', '2026-06-29', '2026-07-06']);
    expect(slots.map((s) => s.weightKg)).toEqual([80.6, 80.6, 79]);
    expect(slots.map((s) => s.steps)).toEqual([6000, 8000, 10_000]);
    expect(slots.map((s) => s.intakeKcal)).toEqual([2100, 2100, 2100]); // la media es por día CON comidas: un día sin anotar no cuenta como cero
    expect(slots.map((s) => s.intakeDays)).toEqual([6, 7, 6]);
    expect(slots.map((s) => s.activityDays)).toEqual([7, 7, 6]); // la última semana acaba hoy, que aún no ha terminado y no cuenta
  });

  it('el día en curso (a medias) no hunde la media de pasos de su semana, pero por días se ve tal cual', () => {
    const summaries = days('2026-07-06', '2026-07-08', (d) => ({ steps: d === '2026-07-08' ? 300 : 8000 }));
    const range = { from: '2026-07-06', to: '2026-07-08' };
    const [week] = buildJointSlots(summaries, 'week', [], range, '2026-07-08');
    expect(week?.steps).toBe(8000);
    expect(week?.activityDays).toBe(2); // el día en curso, aparte, no cuenta
    expect(buildJointSlots(summaries, 'day', [], range, '2026-07-08').map((s) => s.steps)).toEqual([8000, 8000, 300]);
  });

  it('la comida del día en curso (a medias) no hunde la media de calorías de su semana, pero por días se ve tal cual', () => {
    const summaries = days('2026-07-06', '2026-07-08', (d) => ({ intakeKcal: d === '2026-07-08' ? 250 : 2200 }));
    const range = { from: '2026-07-06', to: '2026-07-08' };
    const [week] = buildJointSlots(summaries, 'week', [], range, '2026-07-08');
    expect(week?.intakeKcal).toBe(2200);
    expect(week?.intakeDays).toBe(2);
    expect(buildJointSlots(summaries, 'day', [], range, '2026-07-08').map((s) => s.intakeKcal)).toEqual([2200, 2200, 250]);
  });

  it('por meses: una pesada en el mes se une a su mes aunque el rango no lo abarque entero', () => {
    const history = [entry('2026-05-15', 82), entry('2026-07-02', 79)];
    const summaries = days('2026-05-10', '2026-07-10', () => ({ steps: 7000 }));
    const slots = buildJointSlots(summaries, 'month', history, { from: '2026-05-10', to: '2026-07-10' }, '2026-07-10');
    expect(slots.map((s) => s.start)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(slots.map((s) => s.weightKg)).toEqual([82, 82, 79]);
  });
});

describe('buildJointSlots: agua', () => {
  const day = (d: string, over: Partial<DaySummary> = {}): DaySummary => ({
    day: d, steps: null, distanceM: null, activeKcal: null, workoutCount: 0, workoutMin: 0, sleepAsleepSec: null, sleepInBedSec: null, sleepBedMin: null, sleepWakeMin: null,
    restingBpm: null, avgBpm: null, minBpm: null, maxBpm: null, spo2Avg: null, spo2Min: null, intakeKcal: null, intakeProteinG: null, intakeCarbsG: null, intakeFatG: null,
    intakeFiberG: null, intakeSugarsG: null, intakeSaltG: null, waterMl: null, waterGoalMl: 2200, ...over,
  });

  it('por días: el agua de cada día (null si no se anotó) y su meta, que sube los días de ejercicio', () => {
    const summaries = [day('2026-07-01', { waterMl: 1800 }), day('2026-07-02'), day('2026-07-03', { waterMl: 2600, waterGoalMl: 3100 })];
    const slots = buildJointSlots(summaries, 'day', [], { from: '2026-07-01', to: '2026-07-03' }, '2026-07-03');
    expect(slots.map((s) => s.waterMl)).toEqual([1800, null, 2600]);
    expect(slots.map((s) => s.waterGoalMl)).toEqual([2200, 2200, 3100]);
    expect(slots.map((s) => s.waterDays)).toEqual([1, 0, 1]);
  });
});
