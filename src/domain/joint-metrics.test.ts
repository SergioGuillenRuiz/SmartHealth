import { describe, expect, it } from 'vitest';
import { DEFAULT_JOINT_METRICS, isJointMetricId, JOINT_GROUPS, JOINT_METRICS, jointMetricOf, jointValues, RETIRED_JOINT_METRICS, sanitizeJointMetrics } from './joint-metrics';
import type { DaySummary } from './summary';

const day = (d: string, over: Partial<DaySummary> = {}): DaySummary => ({
  day: d, steps: null, distanceM: null, activeKcal: null, workoutCount: 0, workoutMin: 0, sleepAsleepSec: null, sleepInBedSec: null, sleepBedMin: null, sleepWakeMin: null,
  restingBpm: null, avgBpm: null, minBpm: null, maxBpm: null, spo2Avg: null, spo2Min: null, intakeKcal: null, intakeProteinG: null, intakeCarbsG: null, intakeFatG: null,
  intakeFiberG: null, intakeSugarsG: null, intakeSaltG: null, waterMl: null, waterGoalMl: 2200, ...over,
});

describe('el catálogo de datos del gráfico', () => {
  it('cada dato tiene identificador propio, grupo conocido y los textos que pinta la banda', () => {
    expect(new Set(JOINT_METRICS.map((m) => m.id)).size).toBe(JOINT_METRICS.length);
    for (const metric of JOINT_METRICS) {
      expect(JOINT_GROUPS).toContain(metric.group);
      expect(metric.title.length).toBeGreaterThan(2);
      expect(metric.reading.length).toBeGreaterThan(2);
      expect(metric.empty.length).toBeGreaterThan(2);
      expect(metric.plotH).toBeGreaterThanOrEqual(150);
      expect(metric.color).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it('todo dato menos el peso sabe sacar su valor de un día', () => {
    for (const metric of JOINT_METRICS) expect(typeof metric.pick === 'function').toBe(metric.id !== 'weight');
  });

  it('por omisión se ven los cuatro de siempre, en su orden', () => {
    expect(DEFAULT_JOINT_METRICS).toEqual(['steps', 'intake', 'water', 'weight']);
    expect(jointMetricOf('steps').title).toBe('Pasos al día');
    expect(jointMetricOf('intake').title).toBe('Calorías al día');
    expect(jointMetricOf('water').title).toBe('Agua al día');
    expect(jointMetricOf('weight').title).toBe('Peso (kg)');
  });

  it('ofrece actividad, comida con sus nutrientes, agua y peso; el sueño, el pulso y el oxígeno tienen su propio gráfico y no se pueden añadir', () => {
    const ids = JOINT_METRICS.map((m) => m.id) as string[];
    for (const id of ['steps', 'distance', 'activeKcal', 'workoutMin', 'intake', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'salt', 'water', 'weight']) expect(ids).toContain(id);
    expect(ids).toHaveLength(13);
    for (const retired of RETIRED_JOINT_METRICS) expect(ids).not.toContain(retired);
    expect(RETIRED_JOINT_METRICS.size).toBe(7);
  });
});

describe('sanitizeJointMetrics', () => {
  it('deja la lista como está, en su orden, sin límite de tamaño', () => {
    const all = JOINT_METRICS.map((m) => m.id).reverse();
    expect(sanitizeJointMetrics(all)).toEqual(all);
  });

  it('quita lo que no existe, lo repetido y lo que el gráfico ya no ofrece (sueño, pulso, oxígeno), y conserva el resto en orden', () => {
    expect(sanitizeJointMetrics(['weight', 'nada', 'steps', 'weight', 7, null, 'sleep', 'maxBpm', 'spo2Min', 'salt'])).toEqual(['weight', 'steps', 'salt']);
  });

  it('una lista vacía es válida (no ver ningún dato); lo que no es una lista vuelve a lo de siempre', () => {
    expect(sanitizeJointMetrics([])).toEqual([]);
    expect(sanitizeJointMetrics(undefined)).toEqual([...DEFAULT_JOINT_METRICS]);
    expect(sanitizeJointMetrics('steps')).toEqual([...DEFAULT_JOINT_METRICS]);
  });

  it('isJointMetricId distingue los identificadores válidos', () => {
    expect(isJointMetricId('salt')).toBe(true);
    expect(isJointMetricId('Salt')).toBe(false);
    expect(isJointMetricId(3)).toBe(false);
  });
});

describe('jointValues: el valor de cada periodo', () => {
  const steps = jointMetricOf('steps');
  const summaries = [
    day('2026-10-26', { steps: 6000 }), // lunes
    day('2026-10-27', { steps: 8000 }),
    day('2026-10-28', { steps: null }), // sin datos: no cuenta como cero
    day('2026-10-29', { steps: 1000 }), // hoy, a medias
  ];

  it('por días: el valor de cada día, null si no lo tuvo', () => {
    expect(jointValues(summaries, 'day', '2026-10-29', summaries.map((d) => d.day), steps)).toEqual([6000, 8000, null, 1000]);
  });

  it('en semanas: la media por día con dato y sin el día en curso', () => {
    expect(jointValues(summaries, 'week', '2026-10-29', ['2026-10-26'], steps)).toEqual([7000]);
  });

  it('un periodo sin ningún dato es null, también para el peso (que no sale de aquí)', () => {
    expect(jointValues([], 'week', '2026-10-29', ['2026-10-26'], steps)).toEqual([null]);
    expect(jointValues(summaries, 'day', '2026-10-29', ['2026-10-26'], jointMetricOf('weight'))).toEqual([null]);
  });

  it('convierte a las unidades del dato: km y gramos con su redondeo', () => {
    const rows = [day('2026-10-26', { distanceM: 5230, intakeSaltG: 5.34, intakeFiberG: 24.4 })];
    expect(jointValues(rows, 'day', '2026-10-30', ['2026-10-26'], jointMetricOf('distance'))).toEqual([5.2]);
    expect(jointValues(rows, 'day', '2026-10-30', ['2026-10-26'], jointMetricOf('salt'))).toEqual([5.3]);
    expect(jointValues(rows, 'day', '2026-10-30', ['2026-10-26'], jointMetricOf('fiber'))).toEqual([24]);
  });

  it('los minutos de entreno solo cuentan en los días con datos de actividad (un día sin sincronizar no es un cero)', () => {
    const rows = [day('2026-10-26', { steps: 100, workoutMin: 0 }), day('2026-10-27', { steps: null, workoutMin: 0 })];
    expect(jointValues(rows, 'day', '2026-10-30', rows.map((d) => d.day), jointMetricOf('workoutMin'))).toEqual([0, null]);
  });
});
