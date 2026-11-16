import { describe, expect, it } from 'vitest';
import { summarizeActivity, type ActivityInputs } from './activity';
import type { ResolvedProfile } from './profile';
import type { StepBucket } from './types';
import type { WorkoutRecord } from './workout';

const profile: ResolvedProfile = {
  date: '2026-01-01',
  heightCm: 178,
  weightKg: 80,
  sex: 'male',
  birthDate: '1985-06-15',
  extrapolated: false,
};

const DAY = '2026-07-09';
const at = (h: number, m = 0): number => new Date(2026, 6, 9, h, m, 0).getTime();
const NOW = new Date(2026, 6, 10, 9, 0, 0).getTime(); // el día ya terminó
const min = 60_000;
/** Distancia de `steps` pasos con la zancada derivada de la altura del perfil de prueba (sin cadencia alta). */
const stepsMeters = (steps: number): number => steps * 1.78 * 0.415;

const input = (over: Partial<ActivityInputs> = {}): ActivityInputs => ({
  day: DAY,
  nowMs: NOW,
  profile,
  profileIsGeneric: false,
  buckets: [],
  counters: [],
  workouts: [],
  ...over,
});

const bucket = (startH: number, startM: number, minutes: number, steps: number): StepBucket => ({
  startMs: at(startH, startM),
  endMs: at(startH, startM) + minutes * min,
  steps,
  ringDistanceM: Math.round(steps * 0.74),
  ringCalories: Math.round(steps * 0.6),
});

describe('summarizeActivity: sin datos', () => {
  it('un día sin nada no inventa ceros: pasos, distancia y calorías son null', () => {
    const a = summarizeActivity(input());
    expect(a).toMatchObject({ hasData: false, steps: null, stepsSource: 'none', distanceM: null, activeKcal: null, basalKcal: null });
  });

  it('un entreno manual en un día sin anillo sí cuenta', () => {
    const w: WorkoutRecord = { id: 'a', sport: 'cycle', startMs: at(18), endMs: at(19), pausedMs: 0, source: 'manual', distanceM: 20_000, distanceSource: 'manual' };
    const a = summarizeActivity(input({ workouts: [w] }));
    expect(a.hasData).toBe(true);
    expect(a.steps).toBeNull();
    expect(a.distanceM).toBe(20_000);
    expect(a.activeKcal).toBeGreaterThan(400);
  });
});

describe('summarizeActivity: pasos', () => {
  it('solo contador: el máximo del día es el total y lo que sube entre lecturas cercanas se reparte entre ellas', () => {
    const a = summarizeActivity(
      input({
        counters: [
          { tsMs: at(0, 30), steps: 0 },
          { tsMs: at(9), steps: 0 },
          { tsMs: at(10), steps: 1200 },
          { tsMs: at(11), steps: 2400 },
          { tsMs: at(13), steps: 4100 },
          { tsMs: at(20), steps: 8000 },
        ],
      }),
    );
    expect(a.steps).toBe(8000);
    expect(a.stepsSource).toBe('counter');
    // 1200 pasos entre las 9 y las 10 → todos en la hora 9; 1700 entre las 11 y las 13 → mitad en cada hora.
    expect(a.hourlySteps).toBeNull(); // la lectura de las 13 a las 20 está demasiado separada: no se sabe cuándo se dieron
    // 8000 pasos × 0,7387 m
    expect(a.distanceM).toBeGreaterThan(5800);
    expect(a.distanceM).toBeLessThan(6000);
    expect(a.ringReportedDistanceM).toBeNull();
  });

  it('con lecturas del contador cercanas se dibujan las horas, repartiendo cada subida entre las lecturas', () => {
    const a = summarizeActivity(
      input({
        counters: [
          { tsMs: at(8), steps: 0 },
          { tsMs: at(9), steps: 1200 },
          { tsMs: at(11), steps: 2400 },
        ],
      }),
    );
    expect(a.hourlySteps?.[8]).toBe(1200);
    expect(a.hourlySteps?.[9]).toBe(600);
    expect(a.hourlySteps?.[10]).toBe(600);
    expect(a.hourlySteps?.reduce((x, y) => x + y, 0)).toBe(2400);
    expect(a.hourlySteps?.[13]).toBe(0);
  });

  it('una sola lectura del contador no basta para saber a qué hora se dieron los pasos', () => {
    const a = summarizeActivity(input({ counters: [{ tsMs: at(20), steps: 5000 }] }));
    expect(a.steps).toBe(5000);
    expect(a.hourlySteps).toBeNull();
  });

  it('solo tramos: suma de pasos, y la distancia del anillo queda aparte, solo informativa', () => {
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 15, 1500), bucket(13, 0, 20, 2000)] }));
    expect(a.steps).toBe(3500);
    expect(a.stepsSource).toBe('buckets');
    expect(a.ringReportedDistanceM).toBe(Math.round(1500 * 0.74) + Math.round(2000 * 0.74));
    expect(a.hourlySteps?.[8]).toBe(1500);
  });

  it('la distancia del anillo no se enseña si los tramos son solo una parte del día (otra app ya se llevó el resto del anillo)', () => {
    // Captura real: 12.628 pasos en el contador del día y un único tramo de 1.252 pasos / 846 m en el anillo.
    const a = summarizeActivity(input({ buckets: [{ ...bucket(23, 0, 30, 1252), ringDistanceM: 846 }], counters: [{ tsMs: at(23, 30), steps: 12_628 }] }));
    expect(a.steps).toBe(12_628);
    expect(a.stepsSource).toBe('counter');
    expect(a.ringReportedDistanceM).toBeNull();
  });

  it('si el contador supera a los tramos, manda el contador y el resto se estima como caminar', () => {
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 15, 1000)], counters: [{ tsMs: at(22), steps: 3000 }] }));
    expect(a.steps).toBe(3000);
    expect(a.walking.steps).toBe(3000);
    expect(a.notes.some((n) => n.includes('difieren'))).toBe(true);
  });

  it('un tramo que cruza la medianoche reparte sus pasos entre los dos días', () => {
    const crossing: StepBucket = { startMs: at(23, 30), endMs: at(23, 30) + 60 * min, steps: 600, ringDistanceM: 0, ringCalories: 0 };
    const today = summarizeActivity(input({ buckets: [crossing] }));
    const tomorrow = summarizeActivity(input({ day: '2026-07-10', buckets: [crossing] }));
    expect(today.steps).toBe(300);
    expect(tomorrow.steps).toBe(300);
  });

  it('la calidad de la estimación depende del perfil vigente: más peso → más calorías, misma distancia', () => {
    const data = { buckets: [bucket(8, 0, 20, 2000)] };
    const light = summarizeActivity(input({ ...data, profile: { ...profile, weightKg: 70 } }));
    const heavy = summarizeActivity(input({ ...data, profile: { ...profile, weightKg: 90 } }));
    expect(heavy.distanceM).toBe(light.distanceM);
    expect((heavy.activeKcal ?? 0) / (light.activeKcal ?? 1)).toBeCloseTo(90 / 70, 1);
  });

  it('la zancada fijada por el usuario cambia la distancia', () => {
    const data = { buckets: [bucket(8, 0, 20, 2000)] };
    const a = summarizeActivity(input({ ...data }));
    const b = summarizeActivity(input({ ...data, profile: { ...profile, strideCm: 85 } }));
    expect((b.distanceM ?? 0) / (a.distanceM ?? 1)).toBeCloseTo(85 / 73.87, 1);
    expect(b.stride.source).toBe('manual');
  });
});

describe('summarizeActivity: entrenamientos sin duplicados ni omisiones', () => {
  it('una caminata registrada NO se cuenta dos veces', () => {
    // El anillo midió 3000 pasos, todos dentro de la ventana de la caminata.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18) + 40 * min, pausedMs: 0, source: 'live', steps: 3000 };
    const buckets = [bucket(18, 0, 40, 3000)];
    const withWorkout = summarizeActivity(input({ buckets, workouts: [walk] }));
    const withoutWorkout = summarizeActivity(input({ buckets }));
    expect(withWorkout.steps).toBe(3000);
    expect(withWorkout.walking.steps).toBe(0); // todo el tramo está cubierto por el entreno
    // La distancia total es la de los pasos, no el doble.
    expect(withWorkout.distanceM).toBeCloseTo(withoutWorkout.distanceM ?? 0, -2);
    expect(withWorkout.distanceM).toBeLessThan((withoutWorkout.distanceM ?? 0) * 1.1);
  });

  it('una sesión de bici suma su distancia y sus calorías y NO usa como "andar" los pasos que cuenta el anillo', () => {
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17), endMs: at(18), pausedMs: 0, source: 'live', steps: 450, distanceM: 24_000, distanceSource: 'gps' };
    const buckets = [bucket(8, 0, 20, 2000), bucket(17, 5, 50, 450)]; // 450 "pasos" por vibración en la bici
    const a = summarizeActivity(input({ buckets, workouts: [ride] }));
    expect(a.steps).toBe(2000); // los 450 "pasos" de la bici no se suman: solo lo que se anduvo
    expect(a.ignoredSteps).toBeGreaterThan(400);
    expect(a.walking.steps).toBe(2000);
    expect(a.workoutSteps).toEqual({}); // la bici no aporta pasos
    expect(a.distanceM).toBeCloseTo(a.walking.distanceM + 24_000, -1);
    expect(a.activeKcal).toBeCloseTo(a.walking.kcal + a.workouts[0]!.kcal, -1);
    expect(a.notes.some((n) => n.includes('No se suman'))).toBe(true);
  });

  it('los pasos del día son andar fuera de entrenos + los de los entrenos a pie, y la bici no suma', () => {
    // 2 000 andando por la mañana, 3 000 en un paseo registrado, 450 de vibración en una salida en bici.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18) + 40 * min, pausedMs: 0, source: 'live', steps: 3000 };
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17), endMs: at(17, 50), pausedMs: 0, source: 'live', steps: 450, distanceM: 20_000, distanceSource: 'gps' };
    const buckets = [bucket(8, 0, 30, 2000), bucket(17, 0, 50, 450), bucket(18, 0, 40, 3000)];
    const a = summarizeActivity(input({ buckets, workouts: [walk, ride] }));
    expect(a.steps).toBe(5000);
    expect(a.workoutSteps).toEqual({ w: 3000 });
    expect(a.walking.steps).toBe(2000);
    expect(a.steps).toBe(a.walking.steps + (a.workoutSteps['w'] ?? 0));
    // La distancia y la energía suman el andar y los dos entrenos (el paseo sustituye a sus propios pasos, sin contarlos dos veces).
    expect(a.distanceM).toBeCloseTo(a.walking.distanceM + a.workouts[0]!.distanceM! + 20_000, -1);
    expect(a.activeKcal).toBeCloseTo(a.walking.kcal + a.workouts[0]!.kcal + a.workouts[1]!.kcal, -1);
  });

  it('un deporte sin distancia (gimnasio) suma calorías pero ni kilómetros ni pasos', () => {
    const gym: WorkoutRecord = { id: 'g', sport: 'gym', startMs: at(19), endMs: at(20), pausedMs: 0, source: 'manual' };
    const buckets = [bucket(8, 0, 30, 2000), bucket(19, 0, 60, 300)];
    const without = summarizeActivity(input({ buckets }));
    const a = summarizeActivity(input({ buckets, workouts: [gym] }));
    expect(a.steps).toBe(2000);
    expect(a.distanceM).toBeCloseTo(a.walking.distanceM, -1);
    expect(a.activeKcal).toBeGreaterThan(without.activeKcal! - 1 + 100);
  });

  it('el gráfico por horas no dibuja los pasos de la bici y suma lo mismo que los pasos del día', () => {
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17), endMs: at(18), pausedMs: 0, source: 'live', steps: 450, distanceM: 20_000, distanceSource: 'gps' };
    const buckets = [bucket(8, 0, 30, 2000), bucket(17, 0, 60, 450)];
    const a = summarizeActivity(input({ buckets, workouts: [ride] }));
    expect(a.hourlySteps).not.toBeNull();
    expect(a.hourlySteps![17]).toBe(0);
    expect(a.hourlySteps!.reduce((x, y) => x + y, 0)).toBe(a.steps);
  });

  it('si el entreno sin andar trajo sus pasos y los tramos aún no los reflejan, se restan igualmente del contador', () => {
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17), endMs: at(18), pausedMs: 0, source: 'live', steps: 600, distanceM: 20_000, distanceSource: 'gps' };
    const counters = [{ tsMs: at(18, 5), steps: 3600 }];
    const a = summarizeActivity(input({ counters, workouts: [ride] }));
    expect(a.steps).toBe(3000);
    expect(a.ignoredSteps).toBe(600);
  });

  it('un paseo en directo sin sincronizar después se suma a lo que el anillo ya contaba: 4 000 + 5 200', () => {
    // Se sincronizó a las 17:30 (contador 4 000) y después se hizo un paseo en directo que contó 5 200 pasos: el contador
    // es anterior al paseo, así que no los incluye.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 5200 };
    const a = summarizeActivity(input({ counters: [{ tsMs: at(17, 30), steps: 4000 }], workouts: [walk] }));
    expect(a.steps).toBe(9200);
    expect(a.workoutSteps).toEqual({ w: 5200 });
    expect(a.walking.steps).toBe(4000); // lo de antes del paseo sigue siendo andar
    expect(a.walking.distanceM).toBeGreaterThan(2500);
  });

  it('lo mismo con tramos: lo andado por la mañana no desaparece al registrar un paseo posterior', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 5200, distanceM: 4000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ buckets: [bucket(9, 0, 60, 4000)], counters: [{ tsMs: at(17, 30), steps: 4000 }], workouts: [walk] }));
    expect(a.steps).toBe(9200);
    expect(a.walking.steps).toBe(4000);
    expect(a.distanceM).toBeGreaterThan(4000 + 2500); // el paseo con GPS más lo andado por la mañana
  });

  it('una bici en directo sin sincronizar después no resta sus pasos de un contador que no los incluye', () => {
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17), endMs: at(18), pausedMs: 0, source: 'live', steps: 600, distanceM: 20_000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ counters: [{ tsMs: at(16), steps: 3000 }], workouts: [ride] }));
    expect(a.steps).toBe(3000);
    expect(a.ignoredSteps).toBe(0);
  });

  it('si el entreno a pie trae más pasos de los que el total sincronizado recoge (sincronizado después), el total no queda por debajo de lo que suma', () => {
    // Datos que no cuadran: el contador (leído después del paseo) dice 4 000 y el paseo, medido en directo, 5 200.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 5200 };
    const a = summarizeActivity(input({ counters: [{ tsMs: at(19), steps: 4000 }], workouts: [walk] }));
    expect(a.steps).toBe(5200);
    expect(a.workoutSteps).toEqual({ w: 5200 });
  });

  it('las filas del día suman el total: lo que el anillo contó en la ventana de un paseo y el paseo no se atribuye es suyo', () => {
    // Paseo con GPS de 18:00 a 18:40 sin pausa; el enlace en directo se cayó y solo contó 3 000 de los 3 500 del anillo.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 40), pausedMs: 0, source: 'live', steps: 3000, distanceM: 2500, distanceSource: 'gps' };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 30, 2000), bucket(18, 0, 40, 3500)], workouts: [walk] }));
    expect(a.steps).toBe(5500);
    expect(a.workoutSteps).toEqual({ w: 3500 });
    expect(a.walking.steps).toBe(2000);
    expect(a.walking.steps + a.workoutSteps['w']!).toBe(a.steps);
  });

  it('un paseo con GPS y sin pasos propios se lleva los pasos del anillo de su ventana', () => {
    const run: WorkoutRecord = { id: 'm', sport: 'run', startMs: at(7), endMs: at(7) + 50 * min, pausedMs: 0, source: 'manual', distanceM: 8000, distanceSource: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(7, 0, 50, 3000), bucket(12, 0, 30, 1000)], workouts: [run] }));
    expect(a.workoutSteps).toEqual({ m: 3000 });
    expect(a.steps).toBe(4000);
    expect(a.walking.steps + 3000).toBe(a.steps);
  });

  it('un paseo que se solapa con una bici: cada paso es de uno solo y las filas suman el total', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(17), endMs: at(18), pausedMs: 0, source: 'live', distanceM: 4000, distanceSource: 'gps' };
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(17, 30), endMs: at(18, 30), pausedMs: 0, source: 'live', distanceM: 10_000, distanceSource: 'gps' };
    const buckets = [bucket(8, 0, 30, 2000), bucket(17, 0, 30, 3000), bucket(17, 30, 30, 3000), bucket(18, 0, 30, 400)];
    const a = summarizeActivity(input({ buckets, workouts: [walk, ride] }));
    const rows = a.walking.steps + Object.values(a.workoutSteps).reduce((x, y) => x + y, 0);
    expect(Math.abs(rows - (a.steps ?? 0))).toBeLessThanOrEqual(1);
    expect(a.overlappingWorkouts).toBe(true);
    // Los de 17:30–18:00 son del paseo (el que trae medidas y empezó antes); los de 18:00–18:30, de la bici y no se suman.
    expect(a.workoutSteps['w']).toBe(6000);
    expect(a.ignoredSteps).toBe(400);
    expect(a.steps).toBe(8000);
  });

  it('sin datos del anillo en el día, los pasos propios de un entreno a pie siguen siendo pasos del día', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 40), pausedMs: 0, source: 'live', steps: 3000 };
    const ride: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: at(10), endMs: at(11), pausedMs: 0, source: 'live', steps: 500, distanceM: 15_000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ workouts: [walk, ride] }));
    expect(a.steps).toBe(3000);
    expect(a.stepsSource).toBe('workouts');
    expect(a.workoutSteps).toEqual({ w: 3000 });
  });

  it('un entreno manual (sin pasos propios) sustituye a lo que el anillo midió en esa ventana', () => {
    const run: WorkoutRecord = { id: 'm', sport: 'run', startMs: at(7), endMs: at(7) + 50 * min, pausedMs: 0, source: 'manual', distanceM: 10_000, distanceSource: 'manual' };
    const buckets = [bucket(7, 0, 50, 8300)];
    const a = summarizeActivity(input({ buckets, workouts: [run] }));
    expect(a.walking.steps).toBe(0);
    expect(a.distanceM).toBe(10_000);
  });

  it('un entreno que solo cubre parte de un tramo descuenta solo esa parte', () => {
    const w: WorkoutRecord = { id: 'p', sport: 'cycle', startMs: at(10), endMs: at(10, 30), pausedMs: 0, source: 'manual', distanceM: 9000, distanceSource: 'manual' };
    const buckets = [bucket(10, 0, 60, 1200)]; // la mitad del tramo cae dentro del entreno
    const a = summarizeActivity(input({ buckets, workouts: [w] }));
    expect(a.walking.steps).toBe(600);
    expect(a.ignoredSteps).toBe(600);
  });

  it('dos entrenos solapados por error no descuentan dos veces la misma ventana', () => {
    const a: WorkoutRecord = { id: '1', sport: 'cycle', startMs: at(10), endMs: at(11), pausedMs: 0, source: 'manual', distanceM: 15_000, distanceSource: 'manual' };
    const b: WorkoutRecord = { ...a, id: '2', startMs: at(10, 30), endMs: at(11, 30) };
    const buckets = [bucket(10, 0, 90, 900)];
    const r = summarizeActivity(input({ buckets, workouts: [a, b] }));
    expect(r.walking.steps).toBe(0);
    expect(r.ignoredSteps).toBe(900); // los 900 se cuentan una vez, no 1 350
  });

  it('marca los entrenos que se pisan en el tiempo, también en un día sin datos del anillo', () => {
    const a: WorkoutRecord = { id: '1', sport: 'yoga', startMs: at(10), endMs: at(11), pausedMs: 0, source: 'manual' };
    const b: WorkoutRecord = { ...a, id: '2', startMs: at(10, 30), endMs: at(11, 30) };
    expect(summarizeActivity(input({ workouts: [a, b] })).overlappingWorkouts).toBe(true);
    expect(summarizeActivity(input({ buckets: [bucket(10, 0, 90, 900)], workouts: [a, b] })).overlappingWorkouts).toBe(true);
    // Uno a continuación de otro, o a un minuto de pisarse, no es un solape.
    const next: WorkoutRecord = { ...a, id: '3', startMs: at(11), endMs: at(12) };
    expect(summarizeActivity(input({ workouts: [a, next] })).overlappingWorkouts).toBe(false);
  });

  it('un ciclismo sin distancia avisa de que solo aporta calorías', () => {
    const w: WorkoutRecord = { id: 'n', sport: 'cycle', startMs: at(10), endMs: at(11), pausedMs: 0, source: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)], workouts: [w] }));
    expect(a.notes.some((n) => n.includes('sin distancia'))).toBe(true);
    expect(a.activeKcal).toBeGreaterThan(a.walking.kcal);
  });
});

describe('summarizeActivity: lo que el anillo ve pero el entreno no explica', () => {

  it('un paseo en vivo cuyos pasos solo están en el contador no se cuenta dos veces (sin tramos del anillo)', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 4000 };
    const counters = [{ tsMs: at(22), steps: 9000 }];
    const withW = summarizeActivity(input({ counters, workouts: [walk] }));
    const without = summarizeActivity(input({ counters }));
    expect(withW.steps).toBe(9000);
    // 9000 pasos en total: el paseo (4000) y el resto (5000), no 13 000.
    expect(withW.walking.steps).toBe(5000);
    expect(withW.distanceM).toBeCloseTo(stepsMeters(9000), -2);
    expect(withW.distanceM ?? 0).toBeLessThan((without.distanceM ?? 0) * 1.05);
  });

  it('con GPS en un paseo cuyos pasos solo están en el contador, no suma pasos × zancada ADEMÁS del GPS', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 4000, distanceM: 3000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ counters: [{ tsMs: at(22), steps: 9000 }], workouts: [walk] }));
    expect(a.walking.steps).toBe(5000);
    expect(a.distanceM).toBeCloseTo(stepsMeters(5000) + 3000, -2);
  });

  it('el tramo del anillo aún sin cerrar (solo está en el contador) no se cuenta dos veces con el entreno', () => {
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(18, 30), pausedMs: 0, source: 'live', steps: 3000 };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 60, 4000)], counters: [{ tsMs: at(18, 31), steps: 7000 }], workouts: [walk] }));
    expect(a.steps).toBe(7000);
    expect(a.walking.steps).toBe(4000);
    expect(a.distanceM).toBeCloseTo(stepsMeters(7000), -2);
  });

  it('los pasos que el anillo contó durante una pausa del entreno son caminar, no desaparecen', () => {
    // 18:00-19:00 con 20 min de pausa: el anillo contó 3000 pasos en la hora y el entreno se atribuye 2000.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(19), pausedMs: 20 * min, source: 'live', steps: 2000 };
    const a = summarizeActivity(input({ buckets: [bucket(18, 0, 60, 3000)], workouts: [walk] }));
    expect(a.steps).toBe(3000);
    expect(a.walking.steps).toBe(1000);
    expect(a.distanceM).toBeCloseTo(stepsMeters(3000), -2);
  });

  it('un paseo manual SIN distancia ni pasos usa los pasos que el anillo contó en esa ventana (antes se perdían)', () => {
    const walk: WorkoutRecord = { id: 'm', sport: 'walk', startMs: at(18), endMs: at(18, 40), pausedMs: 0, source: 'manual' };
    const buckets = [bucket(18, 0, 40, 3000)];
    const withW = summarizeActivity(input({ buckets, workouts: [walk] }));
    const without = summarizeActivity(input({ buckets }));
    expect(withW.workouts[0]?.distanceM).toBeCloseTo(stepsMeters(3000), -2);
    expect(withW.workouts[0]?.distanceProvenance).toBe('estimated');
    expect(withW.distanceM).toBeCloseTo(without.distanceM ?? 0, -2); // ni más ni menos que sin el entreno
    expect(withW.walking.steps).toBe(0);
  });

  it('un senderismo de 2 h sin GPS ni pasos propios toma los pasos del anillo de esas dos horas', () => {
    const hike: WorkoutRecord = { id: 'h', sport: 'hike', startMs: at(9), endMs: at(11), pausedMs: 0, source: 'live' };
    const a = summarizeActivity(input({ buckets: [bucket(9, 0, 60, 3500), bucket(10, 0, 60, 3500)], workouts: [hike] }));
    expect(a.distanceM).toBeCloseTo(stepsMeters(7000), -2);
    expect(a.distanceM).toBeGreaterThan(5000);
  });

  it('un entreno a pie sin distancia ni pasos y SIN datos del anillo en su ventana no inventa distancia', () => {
    const walk: WorkoutRecord = { id: 'm', sport: 'walk', startMs: at(18), endMs: at(18, 40), pausedMs: 0, source: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)], workouts: [walk] }));
    expect(a.workouts[0]?.distanceM).toBeNull();
    expect(a.walking.steps).toBe(2000);
  });
});

describe('summarizeActivity: reparto de los pasos entre entrenos', () => {

  it('una carrera con GPS no suma como paseo los pasos que el anillo contó y el entreno no se atribuye', () => {
    // GPS de 9 km, pero el enlace en directo solo recogió 300 pasos mientras el anillo contó 9000 en esa hora.
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(8), endMs: at(9), pausedMs: 0, source: 'live', steps: 300, distanceM: 9000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 60, 9000)], workouts: [run] }));
    expect(a.steps).toBe(9000);
    expect(a.walking.steps).toBe(0);
    expect(a.distanceM).toBe(9000);
  });

  it('con GPS solo la pausa puede haber sido caminar aparte, no toda la diferencia', () => {
    // 18:00–19:00 con 12 min de pausa (20 %): el anillo contó 3000 pasos; el entreno, 2000, y trae GPS de 1,6 km.
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(19), pausedMs: 12 * min, source: 'live', steps: 2000, distanceM: 1600, distanceSource: 'gps' };
    const a = summarizeActivity(input({ buckets: [bucket(18, 0, 60, 3000)], workouts: [walk] }));
    expect(a.walking.steps).toBe(600); // 3000 × 20 %, no los 1000 de diferencia
    expect(a.distanceM).toBeCloseTo(1600 + stepsMeters(600), -1);
  });

  it('un paseo en vivo y el mismo añadido a mano no cuentan dos veces la distancia', () => {
    const live: WorkoutRecord = { id: 'live', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'live', steps: 4000 };
    const manual: WorkoutRecord = { id: 'manual', sport: 'walk', startMs: at(18), endMs: at(18, 50), pausedMs: 0, source: 'manual' };
    const buckets = [bucket(18, 0, 50, 4000)];
    const a = summarizeActivity(input({ buckets, workouts: [live, manual] }));
    const only = summarizeActivity(input({ buckets, workouts: [live] }));
    expect(a.distanceM).toBe(only.distanceM);
    expect(a.workouts.find((w) => w.id === 'manual')?.distanceM).toBeNull(); // sus pasos ya son del otro
    expect(a.notes.some((n) => n.includes('se solapan'))).toBe(true);
  });

  it('dos paseos manuales solapados reparten los pasos del anillo: cada uno se cuenta una vez', () => {
    const first: WorkoutRecord = { id: '1', sport: 'walk', startMs: at(18), endMs: at(19), pausedMs: 0, source: 'manual' };
    const second: WorkoutRecord = { id: '2', sport: 'walk', startMs: at(18, 30), endMs: at(19, 30), pausedMs: 0, source: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(18, 0, 90, 9000)], workouts: [first, second] }));
    expect(a.walking.steps).toBe(0);
    expect(a.distanceM).toBe(Math.round(stepsMeters(6000)) + Math.round(stepsMeters(3000))); // 9000 pasos, no 13 500
  });

  it('el aviso de solape también salta cuando uno corto queda dentro de otro y un tercero pisa al largo', () => {
    const long: WorkoutRecord = { id: 'l', sport: 'gym', startMs: at(10), endMs: at(12), pausedMs: 0, source: 'manual' };
    const inside: WorkoutRecord = { id: 'i', sport: 'gym', startMs: at(10, 10), endMs: at(10, 20), pausedMs: 0, source: 'manual' };
    const third: WorkoutRecord = { id: 't', sport: 'gym', startMs: at(11), endMs: at(11, 30), pausedMs: 0, source: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)], workouts: [long, inside, third] }));
    expect(a.notes.some((n) => n.includes('se solapan'))).toBe(true);
    const apart = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)], workouts: [long, { ...third, startMs: at(13), endMs: at(13, 30) }] }));
    expect(apart.notes.some((n) => n.includes('se solapan'))).toBe(false);
  });

  it('un tramo grueso que desborda la ventana del paseo no hace sumar más pasos de los que el anillo contó', () => {
    // El tramo 17:00–19:00 trae 4000 pasos; el paseo de 18:00 a 19:00 se atribuye 3000 (más de los 2000 «proporcionales»).
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(18), endMs: at(19), pausedMs: 0, source: 'live', steps: 3000 };
    const a = summarizeActivity(input({ buckets: [bucket(17, 0, 120, 4000)], workouts: [walk] }));
    expect(a.steps).toBe(4000);
    expect(a.walking.steps + (a.workouts[0]?.steps ?? 0)).toBe(4000);
    expect(a.distanceM).toBeCloseTo(stepsMeters(4000), 0);
  });

  it('la cadencia de un paseo manual se mide sobre el tiempo activo, no sobre la hora entera con parada', () => {
    // Carrera de 1 h con 30 min de parada y 5400 pasos del anillo: 180 pasos/min en movimiento (zancada alargada ×1,4).
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(18), endMs: at(19), pausedMs: 30 * min, source: 'manual' };
    const a = summarizeActivity(input({ buckets: [bucket(18, 0, 60, 5400)], workouts: [run] }));
    expect(a.workouts[0]?.distanceM).toBeCloseTo(stepsMeters(5400) * 1.4, -1);
    expect(a.workouts[0]?.avgSpeedKmh).toBeGreaterThan(10);
  });
});

describe('summarizeActivity: entrenos que cruzan la medianoche', () => {
  it('los pasos de después de las 00:00 que pertenecen al entreno no se vuelven a contar como paseo al día siguiente', () => {
    // Carrera 23:30 → 00:30 con GPS de 8 km; el anillo contó 2500 pasos a cada lado de la medianoche.
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(23, 30), endMs: at(23, 30) + 60 * min, pausedMs: 0, source: 'live', steps: 5000, distanceM: 8000, distanceSource: 'gps' };
    const buckets = [bucket(23, 30, 30, 2500), { startMs: at(24, 0), endMs: at(24, 30), steps: 2500, ringDistanceM: 0, ringCalories: 0 }];
    const startDay = summarizeActivity(input({ buckets, workouts: [run] }));
    const nextDay = summarizeActivity(input({ day: '2026-07-10', buckets, workouts: [], carryOverWorkouts: [run] }));
    expect(startDay.distanceM).toBe(8000);
    expect(nextDay.walking.steps).toBe(0);
    expect(nextDay.distanceM).toBe(0); // su distancia (y calorías) está en el día en que empezó
    expect(nextDay.steps).toBe(2500); // los pasos del anillo siguen mostrándose tal cual
    expect(nextDay.workouts).toEqual([]); // el entreno es del día en que empezó
    expect(nextDay.notes.some((n) => n.includes('entrenamiento que empezó ayer'))).toBe(true);
  });

  it('los pasos propios de un entreno que cruza la medianoche se reparten entre los dos días', () => {
    // Carrera 23:30–00:30 (GPS 8 km, 5000 pasos propios). El contador del primer día llegó a 3200: 2500 de la carrera y
    // 700 de antes que ningún tramo recoge. Esos 700 son un paseo y no deben desaparecer por restarles los 5000 enteros.
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(23, 30), endMs: at(23, 30) + 60 * min, pausedMs: 0, source: 'live', steps: 5000, distanceM: 8000, distanceSource: 'gps' };
    const a = summarizeActivity(input({ buckets: [bucket(23, 30, 30, 2500)], counters: [{ tsMs: at(23, 59), steps: 3200 }], workouts: [run] }));
    expect(a.steps).toBe(3200);
    expect(a.walking.steps).toBe(700);
  });

  it('un senderismo manual sin pasos ni distancia que cruza la medianoche no deja sin contar los pasos de después', () => {
    const hike: WorkoutRecord = { id: 'h', sport: 'hike', startMs: at(23), endMs: at(23) + 3 * 60 * min, pausedMs: 0, source: 'manual' };
    const after = { startMs: at(24, 0), endMs: at(26, 0), steps: 7200, ringDistanceM: 0, ringCalories: 0 };
    const buckets = [bucket(23, 0, 60, 3600), after];
    const startDay = summarizeActivity(input({ buckets, workouts: [hike] }));
    const nextDay = summarizeActivity(input({ day: '2026-07-10', buckets, carryOverWorkouts: [hike] }));
    // Su distancia sale de los pasos hasta las 00:00, medidos sobre la hora (no sobre las tres) en que se dieron.
    expect(startDay.workouts[0]?.distanceM).toBeCloseTo(stepsMeters(3600), -1);
    expect(startDay.workouts[0]?.avgSpeedKmh).toBeCloseTo((stepsMeters(3600) / 1000) / 1, 0);
    expect(startDay.notes.some((n) => n.includes('cruza la medianoche'))).toBe(true);
    // Los de después no los explica nadie: son paseo del día siguiente.
    expect(nextDay.walking.steps).toBe(7200);
  });

  it('sin el aviso del entreno de la víspera, esos pasos sí se estiman como paseo (el caso que se corrige)', () => {
    const buckets = [{ startMs: at(24, 0), endMs: at(24, 30), steps: 2500, ringDistanceM: 0, ringCalories: 0 }];
    const nextDay = summarizeActivity(input({ day: '2026-07-10', buckets }));
    expect(nextDay.walking.steps).toBe(2500);
  });
});

describe('summarizeActivity: datos que no lo son', () => {
  it('un contador a 0 no es «0 pasos»: el día no tiene datos (no cuenta como un día de cero en las medias)', () => {
    const a = summarizeActivity(input({ counters: [{ tsMs: at(7), steps: 0 }, { tsMs: at(22), steps: 0 }] }));
    expect(a).toMatchObject({ hasData: false, steps: null, distanceM: null, activeKcal: null });
  });

  it('un contador a 0 al empezar el día no estorba cuando luego hay pasos', () => {
    const a = summarizeActivity(input({ counters: [{ tsMs: at(7), steps: 0 }, { tsMs: at(22), steps: 4200 }] }));
    expect(a.steps).toBe(4200);
  });

  it('un día anterior a la primera entrada del perfil avisa de que usa esos primeros datos', () => {
    const a = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)], profile: { ...profile, extrapolated: true } }));
    expect(a.profileExtrapolated).toBe(true);
    expect(a.notes.some((n) => n.includes('anterior a tu primer dato'))).toBe(true);
    const b = summarizeActivity(input({ buckets: [bucket(8, 0, 20, 2000)] }));
    expect(b.profileExtrapolated).toBe(false);
    expect(b.notes.some((n) => n.includes('anterior a tu primer dato'))).toBe(false);
  });
});

describe('summarizeActivity: metabolismo basal', () => {
  it('un día completo usa el basal entero; el día en curso, la fracción transcurrida', () => {
    const data = { buckets: [bucket(8, 0, 20, 2000)] };
    const finished = summarizeActivity(input(data));
    expect(finished.basalKcal).toBeGreaterThan(1700);
    expect(finished.basalKcal).toBeLessThan(1900);
    const noon = summarizeActivity(input({ ...data, nowMs: at(12) }));
    expect(noon.basalKcal).toBeCloseTo((finished.basalKcal ?? 0) / 2, -1);
    expect(finished.totalKcal).toBeCloseTo((finished.basalKcal ?? 0) + (finished.activeKcal ?? 0), -1);
  });
});

describe('summarizeActivity: un día con una cantidad enorme de lecturas (una copia hostil o estropeada)', () => {
  it('no lanza RangeError por pasar cientos de miles de elementos a Math.max', () => {
    const counters = Array.from({ length: 300_000 }, (_, i) => ({ tsMs: at(0) + i * 100, steps: 1 + (i % 9000) }));
    const buckets = Array.from({ length: 200_000 }, (_, i) => ({ startMs: at(0) + i * 100, endMs: at(0) + i * 100 + 50, steps: 1, ringDistanceM: 0, ringCalories: 0 }));
    const a = summarizeActivity(input({ counters, buckets }));
    expect(a.hasData).toBe(true);
  });
});

describe('summarizeActivity: la bici recién terminada y los huecos del contador', () => {
  const ride: WorkoutRecord = { id: 'r', sport: 'bicimad', startMs: at(18), endMs: at(18, 20), pausedMs: 0, source: 'live', distanceM: 5000, distanceSource: 'gps' };

  it('justo tras una bici cuyo tramo del historial sigue abierto, sus «pasos» de manillar no se cuentan como andar (con el contador al minuto, ~exacto)', () => {
    // 6 000 pasos andando por la mañana (tramos ya cerrados) y 1 200 «pasos» de la muñeca pedaleando de 18:00 a 18:20, que aún no
    // están en ningún tramo (el último se cierra más tarde): solo los ve el contador.
    const buckets = [bucket(8, 0, 30, 3000), bucket(12, 0, 30, 3000)];
    const counters = [
      { tsMs: at(12, 40), steps: 6000 },
      { tsMs: at(17, 59), steps: 6000 },
      { tsMs: at(18, 21), steps: 7200 },
    ];
    const a = summarizeActivity(input({ buckets, counters, workouts: [ride] }));
    expect(a.steps).toBeGreaterThan(6000);
    expect(a.steps).toBeLessThan(6250); // antes salían 7 200: los 1 200 de la bici como andar
    expect(a.ignoredSteps).toBeGreaterThan(1000);
    expect(a.distanceM).toBeLessThan(5000 + stepsMeters(6250) + 1);
  });

  it('sin la bici registrada nada cambia: los pasos del contador son andar', () => {
    const buckets = [bucket(8, 0, 30, 3000), bucket(12, 0, 30, 3000)];
    const counters = [
      { tsMs: at(17, 59), steps: 6000 },
      { tsMs: at(18, 21), steps: 7200 },
    ];
    expect(summarizeActivity(input({ buckets, counters })).steps).toBe(7200);
  });

  it('un día solo con contador y una lectura a más de 3 h de la anterior (la primera a las 9:00) no pierde las franjas de la bici que sí se ven', () => {
    const counters = [
      { tsMs: at(9, 0), steps: 3000 }, // desde medianoche: no se sabe a qué hora se dieron
      { tsMs: at(14, 0), steps: 4200 },
      { tsMs: at(17, 59), steps: 4500 },
      { tsMs: at(18, 21), steps: 5700 }, // 1 200 de manillar de 18:00 a 18:20
    ];
    const a = summarizeActivity(input({ counters, workouts: [ride] }));
    expect(a.hourlySteps).toBeNull(); // el detalle por horas no se da (hay subidas sin hora)
    expect(a.steps).toBeGreaterThan(4500);
    expect(a.steps).toBeLessThan(4750); // antes la bici se contaba entera como andar: 5 700
  });
});

describe('summarizeActivity: el día del Resumen empieza a las 08:00', () => {
  // El día 9 va del 9 a las 08:00 al 10 a las 08:00.
  const START = 8;
  const dayOf = (over: Partial<ActivityInputs> = {}): ActivityInputs => input({ dayStartHour: START, nowMs: new Date(2026, 6, 10, 12, 0, 0).getTime(), ...over });

  it('lo de madrugada se suma al día que empezó antes, no al que acaba de empezar a las 00:00', () => {
    // 1000 pasos a las 02:00 del 9, 3000 a las 10:00 del 9 y 500 a las 02:00 del 10.
    const buckets = [bucket(2, 0, 30, 1000), bucket(10, 0, 30, 3000), bucket(26, 0, 30, 500)];
    expect(summarizeActivity(dayOf({ buckets })).steps).toBe(3500);
    expect(summarizeActivity(dayOf({ day: '2026-07-08', buckets })).steps).toBe(1000);
    expect(summarizeActivity(dayOf({ day: '2026-07-10', buckets })).steps).toBeNull();
  });

  it('un entreno de madrugada cuenta en el día anterior', () => {
    // Una carrera a las 02:00 del 10: del día 9, que empezó a las 08:00.
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(26, 0), endMs: at(27, 0), pausedMs: 0, source: 'manual', distanceM: 8000, distanceSource: 'manual' };
    const day9 = summarizeActivity(dayOf({ workouts: [run] }));
    expect(day9.workouts).toHaveLength(1);
    expect(day9.distanceM).toBe(8000);
    expect(summarizeActivity(dayOf({ day: '2026-07-10', workouts: [] })).distanceM).toBeNull();
  });

  it('el contador del anillo se reinicia a medianoche: el total del día suma lo de antes y lo de después', () => {
    const a = summarizeActivity(
      dayOf({
        counters: [
          { tsMs: at(9), steps: 600 }, // lo que llevaba cuando empezó el día (se descuenta)
          { tsMs: at(12), steps: 2600 },
          { tsMs: at(23, 50), steps: 7600 },
          { tsMs: at(25, 0), steps: 150 }, // 01:00 del 10: el contador volvió a 0 a medianoche
          { tsMs: at(27, 0), steps: 400 },
        ],
      }),
    );
    expect(a.steps).toBe(7400); // (7600 − 600) + 400
    expect(a.stepsSource).toBe('counter');
  });

  it('sin lecturas antes de medianoche, el contador solo aporta lo de después de ella', () => {
    const a = summarizeActivity(dayOf({ counters: [{ tsMs: at(25, 0), steps: 150 }, { tsMs: at(27, 0), steps: 900 }] }));
    expect(a.steps).toBe(900);
  });

  it('con los tramos completos mandan ellos; el contador solo añade lo que aún no han recogido', () => {
    // Tramos de 10 a 20 h (6000) y de 01:00 a 01:30 del 10 (800): 6800. El contador (7600 − 600) + 400 = 7400 es mayor por el tramo abierto.
    const buckets = [bucket(10, 0, 600, 6000), bucket(25, 0, 30, 800)];
    const counters = [
      { tsMs: at(9), steps: 600 },
      { tsMs: at(23, 50), steps: 7600 },
      { tsMs: at(27, 0), steps: 400 },
    ];
    expect(summarizeActivity(dayOf({ buckets, counters })).steps).toBe(7400);
    // Si el contador va por detrás de los tramos, no los pisa.
    expect(summarizeActivity(dayOf({ buckets, counters: [{ tsMs: at(9), steps: 600 }, { tsMs: at(12), steps: 1600 }] })).steps).toBe(6800);
  });

  it('un día sin el contador partido (a medianoche) sigue igual que siempre', () => {
    const counters = [
      { tsMs: at(9), steps: 0 },
      { tsMs: at(10), steps: 1200 },
      { tsMs: at(20), steps: 8000 },
    ];
    expect(summarizeActivity(input({ counters })).steps).toBe(8000);
  });

  it('el metabolismo basal corre desde las 08:00: a las 20:00 ha pasado la mitad del día', () => {
    const buckets = [bucket(10, 0, 30, 2000)];
    const noon8 = at(20, 0);
    const logical = summarizeActivity(dayOf({ buckets, nowMs: noon8 }));
    const calendar = summarizeActivity(input({ buckets, nowMs: noon8 }));
    // 20/24 del día de calendario frente a 12/24 del que empezó a las 08:00.
    expect((logical.basalKcal ?? 0) / (calendar.basalKcal ?? 1)).toBeCloseTo(12 / 20, 2);
  });

  it('un paseo manual que cruza las 08:00: los pasos de antes son suyos y los de después son paseo del día siguiente', () => {
    // 07:30–08:30 sin distancia ni pasos propios: lo de antes de las 08:00 es del día 8 (que acaba el 9 a las 08:00).
    const walk: WorkoutRecord = { id: 'w', sport: 'walk', startMs: at(7, 30), endMs: at(8, 30), pausedMs: 0, source: 'manual' };
    const buckets = [bucket(7, 30, 60, 4000)];
    const before = summarizeActivity(dayOf({ day: '2026-07-08', buckets, workouts: [walk] }));
    expect(before.notes.some((n) => n.includes('cruza el cambio de día (las 08:00)'))).toBe(true);
    expect(before.steps).toBe(2000); // solo la mitad de los pasos del tramo cae en ese día
    const after = summarizeActivity(dayOf({ day: '2026-07-09', buckets, carryOverWorkouts: [walk] }));
    expect(after.walking.steps).toBe(2000);
  });

  it('una carrera con GPS que cruza las 08:00 no vuelve a contar como paseo, al día siguiente, los pasos que dio después', () => {
    const run: WorkoutRecord = { id: 'r', sport: 'run', startMs: at(7, 30), endMs: at(8, 30), pausedMs: 0, source: 'live', steps: 5000, distanceM: 8000, distanceSource: 'gps' };
    const buckets = [bucket(7, 30, 60, 5000)];
    const after = summarizeActivity(dayOf({ day: '2026-07-09', buckets, carryOverWorkouts: [run] }));
    expect(after.walking.steps).toBe(0);
    expect(after.distanceM).toBe(0); // su distancia y sus calorías están en el día en que empezó
    expect(after.steps).toBe(2500);
    expect(after.notes.some((n) => n.includes('empezó ayer antes de las 08:00'))).toBe(true);
  });
});
