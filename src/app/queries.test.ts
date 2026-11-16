import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SimulatedTransport } from '../ble/sim/ring';
import { buildDemoDataset } from '../ble/sim/dataset';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import type { IngestRows } from '../domain/sanitize';
import type { ProfileEntry } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import { estimateStoredWorkouts, estimateWithin, loadDayBundle, loadHistory, loadWorkoutDay } from './queries';
import { installServices } from './services';

const at = (h: number, m = 0): number => new Date(2026, 6, 9, h, m, 0).getTime();
const NOW = new Date(2026, 6, 10, 9, 0, 0).getTime();
const DAY = '2026-07-09';
const history: ProfileEntry[] = [{ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' }];

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`q-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 1 })), now: () => NOW, demo: false });
});

const ringRows = (): IngestRows => ({
  buckets: [{ startMs: at(18), endMs: at(18, 40), steps: 3000, ringDistanceM: 2200, ringCalories: 1800 }],
  counters: [],
  heart: [],
  spo2: [],
  sleep: [],
  dropped: {},
});

// Un paseo manual no trae distancia: la saca de los pasos que el anillo contó en esa ventana. Esa cifra debe ser LA MISMA
// en el resumen del día, en la lista de Deportes y en el detalle (antes solo la sacaba el resumen).
describe('estimaciones de entrenos: mismas cifras en todas las pantallas', () => {
  const walk: WorkoutRecord = { id: 'm', sport: 'walk', startMs: at(18), endMs: at(18, 40), pausedMs: 0, source: 'manual' };

  it('el resumen, la lista y el detalle coinciden', async () => {
    await store.ingest(ringRows());
    await store.putWorkout(walk);

    const inSummary = (await loadDayBundle(DAY, NOW, history)).activity.workouts[0];
    const inList = (await estimateStoredWorkouts([walk], history)).get('m');
    const inDetail = estimateWithin(walk, await loadWorkoutDay(DAY), history);

    expect(inSummary?.distanceM).toBeGreaterThan(2000); // sale de los 3000 pasos del anillo
    expect(inList).toEqual(inSummary);
    expect(inDetail).toEqual(inSummary);
  });

  it('una versión corregida y sin guardar sustituye a la guardada con el mismo id', async () => {
    await store.ingest(ringRows());
    await store.putWorkout(walk);
    const corrected: WorkoutRecord = { ...walk, distanceM: 3500, distanceSource: 'manual' };
    const estimate = estimateWithin(corrected, await loadWorkoutDay(DAY), history);
    expect(estimate?.distanceM).toBe(3500);
    expect(estimate?.distanceProvenance).toBe('manual');
  });

  it('uno nuevo y sin guardar que repite a otro guardado no se lleva otra vez los mismos pasos', async () => {
    await store.ingest(ringRows());
    await store.putWorkout(walk);
    const twin: WorkoutRecord = { ...walk, id: 'twin', source: 'live' }; // el mismo paseo grabado en vivo, sin pasos propios
    const estimate = estimateWithin(twin, await loadWorkoutDay(DAY), history);
    expect(estimate?.distanceM).toBeNull(); // los pasos ya son del guardado (a igualdad, el que ya estaba)
    expect(estimate?.kcal).toBeGreaterThan(0); // pero sus calorías se calculan por duración
  });

  it('con el contexto de otro día no estima (todavía no se ha leído el suyo)', async () => {
    const other = await loadWorkoutDay('2026-07-08');
    expect(estimateWithin(walk, other, history)).toBeNull();
  });
});

describe('historial de entrenos por periodo', () => {
  // Hoy es el viernes 10 de julio de 2026 (NOW). Entrenos: hoy, ayer, el lunes de esa semana, el mes pasado.
  const mk = (id: string, day: [number, number, number], h = 18): WorkoutRecord => ({
    id,
    sport: 'yoga',
    startMs: new Date(day[0], day[1], day[2], h).getTime(),
    endMs: new Date(day[0], day[1], day[2], h, 30).getTime(),
    pausedMs: 0,
    source: 'manual',
  });
  const ids = async (period: 'day' | 'week' | 'month' | 'all', anchor: string, limit = 50): Promise<string[]> =>
    (await loadHistory(period, anchor, history, limit)).items.map((i) => i.record.id);

  beforeEach(async () => {
    for (const w of [mk('hoy', [2026, 6, 10]), mk('ayer', [2026, 6, 9]), mk('lunes', [2026, 6, 6]), mk('domingo', [2026, 6, 5]), mk('junio', [2026, 5, 20])]) await store.putWorkout(w);
  });

  it('el día trae solo los de ese día', async () => {
    expect(await ids('day', '2026-07-10')).toEqual(['hoy']);
    expect(await ids('day', '2026-07-08')).toEqual([]);
  });

  it('la semana va de lunes a domingo y viene de más reciente a más antigua', async () => {
    expect(await ids('week', '2026-07-10')).toEqual(['hoy', 'ayer', 'lunes']);
    expect(await ids('week', '2026-07-05')).toEqual(['domingo']); // el domingo es de la semana anterior
  });

  it('el mes trae los de todo el mes, también los anteriores a hoy', async () => {
    expect(await ids('month', '2026-07-10')).toEqual(['hoy', 'ayer', 'lunes', 'domingo']);
    expect(await ids('month', '2026-06-15')).toEqual(['junio']);
  });

  it('«todos» pagina: trae un número, avisa de si quedan más y el siguiente tramo los incluye', async () => {
    const first = await loadHistory('all', '2026-07-10', history, 2);
    expect(first.items.map((i) => i.record.id)).toEqual(['hoy', 'ayer']);
    expect(first.more).toBe(true);
    const all = await loadHistory('all', '2026-07-10', history, 5);
    expect(all.items).toHaveLength(5);
    expect(all.more).toBe(false);
  });

  it('cada entreno lleva sus cifras (calorías) como en el resumen', async () => {
    const [item] = (await loadHistory('day', '2026-07-10', history, 10)).items;
    expect(item?.estimate.kcal).toBeGreaterThan(0);
    expect(item?.estimate.sport).toBe('yoga');
  });
});

describe('loadDayBundle: comidas', () => {
  it('trae las comidas del día, de la más antigua a la más reciente, y no las de otros días', async () => {
    await store.putMeal({ id: 'b', tsMs: at(14), name: 'Comida', kcal: 700, source: 'manual' });
    await store.putMeal({ id: 'a', tsMs: at(9), name: 'Desayuno', kcal: 350, source: 'barcode', barcode: '8410000000016', grams: 125 });
    await store.putMeal({ id: 'ayer', tsMs: at(14) - 86_400_000, name: 'Otra', kcal: 500, source: 'ai' });
    expect((await loadDayBundle(DAY, NOW, history)).meals.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('un día sin comidas anotadas trae una lista vacía', async () => {
    expect((await loadDayBundle(DAY, NOW, history)).meals).toEqual([]);
  });
});

describe('loadDayBundle: el día que empieza a las 08:00', () => {
  const t = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
  const START = 8;

  it('lo de madrugada es del día que empezó antes: pasos, comidas, pulso y sueño', async () => {
    await store.ingest({
      buckets: [
        { startMs: t(9, 2), endMs: t(9, 2, 30), steps: 900, ringDistanceM: 600, ringCalories: 40 }, // 02:00 del 9: del día 8
        { startMs: t(9, 10), endMs: t(9, 10, 30), steps: 2000, ringDistanceM: 1400, ringCalories: 90 },
        { startMs: t(10, 2), endMs: t(10, 2, 30), steps: 700, ringDistanceM: 500, ringCalories: 30 }, // 02:00 del 10: del día 9
      ],
      counters: [],
      heart: [
        { tsMs: t(9, 3), bpm: 58, source: 'ring-auto' },
        { tsMs: t(10, 1), bpm: 64, source: 'ring-auto' },
      ],
      spo2: [],
      sleep: [{ startMs: t(9, 8, 15), endMs: t(9, 18, 17), segments: [{ stage: 'light', startMs: t(9, 8, 15), durationSec: 36_120 }] }],
      dropped: {},
    });
    await store.putMeal({ id: 'cena', tsMs: t(10, 2), name: 'Zanahorias', kcal: 60, source: 'manual' });
    await store.putMeal({ id: 'antes', tsMs: t(9, 2), name: 'Otra cosa', kcal: 100, source: 'manual' });

    const day9 = await loadDayBundle(DAY, t(10, 9), history, START);
    expect(day9.activity.steps).toBe(2700);
    expect(day9.meals.map((m) => m.id)).toEqual(['cena']);
    expect(day9.heart?.samples.map((s) => s.bpm)).toEqual([64]);
    expect(day9.sleep?.night?.startMs).toBe(t(9, 8, 15));

    const day8 = await loadDayBundle('2026-07-08', t(10, 9), history, START);
    expect(day8.activity.steps).toBe(900);
    expect(day8.meals.map((m) => m.id)).toEqual(['antes']);
    expect(day8.heart?.samples.map((s) => s.bpm)).toEqual([58]);
    expect(day8.sleep).toBeNull();
  });

  it('una comida pasada de día cuenta en el día al que se pasó', async () => {
    const t = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
    await store.putMeal({ id: 'cena', tsMs: t(10, 0, 40), day: '2026-07-09', name: 'Cena tardía', kcal: 600, source: 'manual' });
    await store.putMeal({ id: 'comida', tsMs: t(9, 14), name: 'Comida', kcal: 700, source: 'manual' });
    const now = t(10, 12);
    const day9 = await loadDayBundle('2026-07-09', now, history);
    const day10 = await loadDayBundle('2026-07-10', now, history);
    expect(day9.meals.map((m) => m.id)).toEqual(['comida', 'cena']);
    expect(day10.meals).toEqual([]);
  });

  it('el entreno de madrugada cuenta en el día anterior, también en la lista de Deportes', async () => {
    const late: WorkoutRecord = { id: 'late', sport: 'walk', startMs: t(10, 2), endMs: t(10, 2, 40), pausedMs: 0, source: 'manual' };
    await store.ingest({
      buckets: [{ startMs: t(10, 2), endMs: t(10, 2, 40), steps: 3000, ringDistanceM: 2200, ringCalories: 1800 }],
      counters: [],
      heart: [],
      spo2: [],
      sleep: [],
      dropped: {},
    });
    await store.putWorkout(late);
    const day9 = await loadDayBundle(DAY, t(10, 9), history, START);
    expect(day9.activity.workouts.map((w) => w.id)).toEqual(['late']);
    const inSummary = day9.activity.workouts[0];
    // La lista y el detalle estiman en el mismo día que el resumen: mismas cifras.
    expect((await estimateStoredWorkouts([late], history, START)).get('late')).toEqual(inSummary);
    expect(estimateWithin(late, await loadWorkoutDay(DAY, START), history, START)).toEqual(inSummary);
    // Con días de calendario sería del 10, no del 9.
    expect(estimateWithin(late, await loadWorkoutDay(DAY, START), history)).toBeNull();
  });
});
