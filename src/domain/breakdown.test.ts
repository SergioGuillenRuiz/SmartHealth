import { describe, expect, it } from 'vitest';
import type { DayActivity } from './activity';
import { activityParts, WALKING_KEY } from './breakdown';
import type { SportId } from './sports';
import type { WorkoutEstimate } from './workout';

function workout(id: string, sport: SportId, o: Partial<WorkoutEstimate> = {}): WorkoutEstimate {
  return {
    id,
    sport,
    day: '2026-10-12',
    activeMs: 30 * 60_000,
    distanceM: null,
    distanceProvenance: null,
    avgSpeedKmh: null,
    kcal: 200,
    kcalMethod: 'met',
    kcalProvenance: 'estimated',
    steps: null,
    ascentM: null,
    idleMs: 0,
    avgBpm: null,
    maxBpm: null,
    minBpm: null,
    ...o,
  };
}

/** Solo los campos que lee el reparto; el resto del día no importa aquí. */
function day(o: { steps: number | null; walking: DayActivity['walking']; workouts: WorkoutEstimate[]; workoutSteps?: Record<string, number> }): DayActivity {
  return { steps: o.steps, walking: o.walking, workouts: o.workouts, workoutSteps: o.workoutSteps ?? {} } as unknown as DayActivity;
}

describe('activityParts', () => {
  it('separa andar de los entrenos y cada deporte con sus calorías y su distancia: la bici no inventa pasos y el yoga no tiene distancia', () => {
    const a = day({
      steps: 9000,
      walking: { steps: 6000, distanceM: 4200, kcal: 180 },
      workouts: [
        workout('r', 'run', { kcal: 320, distanceM: 4000, activeMs: 25 * 60_000 }),
        workout('c', 'cycle', { kcal: 540, distanceM: 18_000, activeMs: 60 * 60_000 }),
        workout('y', 'yoga', { kcal: 90 }),
      ],
      workoutSteps: { r: 3000 },
    });
    const parts = activityParts(a);
    expect(parts.map((p) => p.key)).toEqual([WALKING_KEY, 'run', 'cycle', 'yoga']);
    expect(parts.map((p) => p.name)).toEqual(['Andar', 'Correr', 'Ciclismo', 'Yoga']);
    expect(parts.map((p) => p.distanceM)).toEqual([4200, 4000, 18_000, null]);
    expect(parts.map((p) => p.kcal)).toEqual([180, 320, 540, 90]);

    // Lo que se ve repartido suma el total del día.
    expect(parts.reduce((s, p) => s + p.kcal, 0)).toBe(180 + 320 + 540 + 90);
  });

  it('junta las sesiones del mismo deporte en una sola parte', () => {
    const a = day({
      steps: 5000,
      walking: { steps: 0, distanceM: 0, kcal: 0 },
      workouts: [
        workout('a', 'run', { kcal: 300, distanceM: 4000, activeMs: 25 * 60_000 }),
        workout('b', 'run', { kcal: 150, distanceM: 2000, activeMs: 12 * 60_000 }),
      ],
      workoutSteps: { a: 3000, b: 2000 },
    });
    const parts = activityParts(a);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ key: 'run', kcal: 450, distanceM: 6000 });
  });

  it('«Andar» solo sale si hay algo que andar fuera de los entrenos: pasos, distancia o calorías', () => {
    // Todos los pasos del día son de la carrera: no queda nada de andar.
    const onlyRun = day({ steps: 3000, walking: { steps: 0, distanceM: 0, kcal: 0 }, workouts: [workout('r', 'run')], workoutSteps: { r: 3000 } });
    expect(activityParts(onlyRun).map((p) => p.key)).toEqual(['run']);
    // Sobran pasos tras los de la carrera: eso es andar, aunque no se le calcule distancia ni calorías.
    const spare = day({ steps: 5000, walking: { steps: 2000, distanceM: 0, kcal: 0 }, workouts: [workout('r', 'run')], workoutSteps: { r: 3000 } });
    expect(activityParts(spare).map((p) => p.key)).toEqual([WALKING_KEY, 'run']);
    expect(activityParts(spare)[0]?.distanceM).toBeNull();
  });

  it('«Andar» y «Caminar» (el deporte) salen juntos en una sola fila con las calorías y la distancia sumadas', () => {
    const a = day({
      steps: 18_000,
      walking: { steps: 8000, distanceM: 4130, kcal: 226 },
      workouts: [workout('w', 'walk', { kcal: 373, distanceM: 6900 }), workout('b', 'bicimad', { kcal: 72 })],
      workoutSteps: { w: 10_000 },
    });
    const parts = activityParts(a);
    expect(parts.map((p) => p.name)).toEqual(['Andar', 'BiciMAD']);
    expect(parts[0]).toMatchObject({ key: WALKING_KEY, kcal: 599, distanceM: 11_030 });
    expect(parts.reduce((s, p) => s + p.kcal, 0)).toBe(226 + 373 + 72);
    // Sin distancia de andar fuera, la del deporte manda; y sin andar fuera, el deporte se llama igual.
    const noFreeDistance = day({ steps: 10_000, walking: { steps: 0, distanceM: 0, kcal: 10 }, workouts: [workout('w', 'walk', { kcal: 100, distanceM: 2000 })], workoutSteps: { w: 10_000 } });
    expect(activityParts(noFreeDistance)).toHaveLength(1);
    expect(activityParts(noFreeDistance)[0]).toMatchObject({ name: 'Andar', kcal: 110, distanceM: 2000 });
    const onlySport = day({ steps: null, walking: { steps: 0, distanceM: 0, kcal: 0 }, workouts: [workout('w', 'walk', { kcal: 100 })] });
    expect(activityParts(onlySport).map((p) => p.name)).toEqual(['Andar']);
  });

  it('un día sin pasos del anillo pero con entrenos no inventa «Andar»', () => {
    const a = day({ steps: null, walking: { steps: 0, distanceM: 0, kcal: 0 }, workouts: [workout('y', 'yoga', { kcal: 90 })] });
    expect(activityParts(a).map((p) => p.key)).toEqual(['yoga']);
  });

  it('un día sin nada no tiene partes', () => {
    expect(activityParts(day({ steps: null, walking: { steps: 0, distanceM: 0, kcal: 0 }, workouts: [] }))).toEqual([]);
  });
});
