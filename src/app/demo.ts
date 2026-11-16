import { emptyHistory } from '../ble/records';
import { parseSupportFunction, withBaseline } from '../ble/support';
import { buildDemoDataset, mulberry32, R99_SUPPORT_BITMAP, type DemoSchedule, type SimDataset } from '../ble/sim/dataset';
import type { SimBehavior } from '../ble/sim/ring';
import type { Store } from '../data/types';
import { addDays, dayKeyOf, HOUR_MS, MINUTE_MS, startOfDayMs } from '../domain/dates';
import type { WaterEntry } from '../domain/hydration';
import { buildMeal, type MealDraft, type MealEntry, type MealSource } from '../domain/nutrition';
import type { ProfileEntry } from '../domain/profile';
import { sanitizeHistory } from '../domain/sanitize';
import type { SportId } from '../domain/sports';
import type { WorkoutRecord } from '../domain/workout';

/** Qué anillo simula la demostración: el R99 real o variantes que NO ofrecen pulso / pasos (para probar la adaptación). */
export type DemoRing = 'r99' | 'sin-pulso' | 'sin-nada';

export const parseDemoRing = (value: string | null): DemoRing => (value === 'sin-pulso' || value === 'sin-nada' ? value : 'r99');

/** Tipos de historial que cada variante rechaza con 0xFC, y la medida de pulso en directo, que rechaza con estado 1. */
export function demoRingBehavior(variant: DemoRing): SimBehavior {
  // Como el anillo real, cierra solo cada medida de pulso (`04 0e`); aquí tras unas lecturas, no a los ~35 s.
  const base: SimBehavior = { hrVerdict: 'success', hrSamples: [0, 71, 72, 73, 72, 73, 74, 73], hrIntervalMs: 60 };
  if (variant === 'sin-pulso') return { ...base, unsupportedHistory: ['heart'], refuseModes: [0] };
  if (variant === 'sin-nada') return { ...base, unsupportedHistory: ['heart', 'sport'], refuseModes: [0] };
  return base;
}

/** Funciones que ofrece cada variante tras sincronizar: las del R99 menos lo que rechaza. */
export function demoRingCapabilities(variant: DemoRing): string[] {
  const capabilities = withBaseline(parseSupportFunction(R99_SUPPORT_BITMAP));
  if (variant !== 'r99') capabilities.delete('heartRate');
  if (variant === 'sin-nada') capabilities.delete('steps');
  return [...capabilities].sort();
}

/** Dataset del anillo simulado en modo demostración (los últimos 7 días, como un anillo real). */
export const demoRingDataset = (nowMs: number, schedule: DemoSchedule = 'noche'): SimDataset => buildDemoDataset({ nowMs, days: 7, seed: 99, schedule });

/**
 * Siembra el almacén con ~4 meses de historia verosímil: pasos, sueño, pulso, peso en descenso y
 * entrenamientos variados. Es determinista, y solo se usa en modo demostración y en las pruebas e2e.
 */
export async function seedDemo(store: Store, nowMs: number, ringVariant: DemoRing = 'r99', schedule: DemoSchedule = 'noche'): Promise<void> {
  const today = dayKeyOf(nowMs);
  const rand = mulberry32(1234);

  await store.wipe();

  // Perfil: el peso baja con el tiempo y la altura es constante. Una entrada cada ~12 días.
  const profile: ProfileEntry[] = [];
  for (let back = 140; back >= 0; back -= 12) {
    const progress = 1 - back / 140;
    const weight = 84.6 - progress * 4.9 + (rand() - 0.5) * 0.9;
    profile.push({
      date: addDays(today, -back),
      heightCm: 178,
      weightKg: Math.round(weight * 10) / 10,
      sex: 'male',
      birthDate: '1985-06-15',
    });
  }

  // Historia larga del anillo: se pasa por el mismo saneado que usa la sincronización real.
  const dataset = buildDemoDataset({ nowMs, days: 120, seed: 42, schedule });
  const records = emptyHistory();
  records.sport = dataset.sport;
  records.sleep = dataset.sleep;
  records.heart = dataset.heart;
  records.all = dataset.all;
  records.spo2 = dataset.spo2;
  await store.ingest(sanitizeHistory(records, nowMs, dataset.live));

  // Entrenamientos.
  const sports: Array<{ sport: SportId; weight: number }> = [
    { sport: 'walk', weight: 3 },
    { sport: 'run', weight: 3 },
    { sport: 'cycle', weight: 3 },
    { sport: 'gym', weight: 3 },
    { sport: 'padel', weight: 1 },
    { sport: 'yoga', weight: 1 },
  ];
  const pick = (): SportId => {
    const total = sports.reduce((a, s) => a + s.weight, 0);
    let r = rand() * total;
    for (const s of sports) {
      r -= s.weight;
      if (r <= 0) return s.sport;
    }
    return 'walk';
  };
  // Todo lo que se siembra se junta y se guarda de una vez (`putMany`): una transacción por registro tardaba decenas de segundos en un móvil.
  const workouts: WorkoutRecord[] = [];
  const meals: MealEntry[] = [];
  const water: WaterEntry[] = [];
  for (let back = 100; back >= 1; back -= 2 + Math.floor(rand() * 3)) {
    const sport = pick();
    const day = addDays(today, -back);
    const [y, m, d] = day.split('-').map(Number);
    // De tarde (17–19 h); quien hace turno de noche entrena de madrugada (00–02 h), que es del día que empezó antes.
    const hour = (schedule === 'dia' ? 0 : 17) + Math.floor(rand() * 3);
    const startMs = new Date(y ?? 2026, (m ?? 1) - 1, d ?? 1, hour, Math.floor(rand() * 4) * 15).getTime();
    const minutes = sport === 'cycle' ? 50 + rand() * 70 : sport === 'gym' ? 45 + rand() * 30 : 30 + rand() * 40;
    const workout: WorkoutRecord = { id: `demo-${back}`, sport, startMs, endMs: startMs + minutes * MINUTE_MS, pausedMs: 0, source: back % 5 === 0 ? 'manual' : 'live' };
    if (sport === 'cycle') {
      workout.distanceM = Math.round((minutes / 60) * (19 + rand() * 6) * 1000);
      workout.distanceSource = back % 5 === 0 ? 'manual' : 'gps';
    }
    if (sport === 'run' || sport === 'walk') workout.steps = Math.round(minutes * (sport === 'run' ? 160 : 105));
    if (workout.source === 'live') {
      const base = sport === 'run' ? 150 : sport === 'cycle' ? 135 : sport === 'gym' ? 118 : sport === 'yoga' ? 80 : 105;
      workout.hr = [];
      for (let t = 0; t < minutes * 60; t += 5) {
        workout.hr.push([startMs + t * 1000, Math.round(base + Math.sin(t / 240) * 8 + (rand() - 0.5) * 6)]);
      }
    }
    workouts.push(workout);
  }

  // Comidas: casi cada día de los últimos tres meses (alguno sin anotar), con calorías alrededor de lo que pide perder peso.
  await store.setSettings({ healthGoal: 'lose' });
  type Dish = { at: [number, number]; name: string; kcal: number; protein: number; carbs: number; fat: number; fiber: number; sugars: number; salt: number; source: MealSource };
  const dayMenu: Dish[] = [
    { at: [8, 30], name: 'Tostadas con tomate y café con leche', kcal: 360, protein: 12, carbs: 48, fat: 13, fiber: 4, sugars: 9, salt: 1.6, source: 'manual' },
    { at: [11, 15], name: 'Yogur natural y fruta', kcal: 190, protein: 9, carbs: 28, fat: 4, fiber: 2, sugars: 20, salt: 0.2, source: 'barcode' },
    { at: [14, 20], name: 'Arroz con pollo y ensalada', kcal: 680, protein: 42, carbs: 82, fat: 17, fiber: 5, sugars: 6, salt: 2.2, source: 'text' },
    { at: [17, 30], name: 'Fruta y frutos secos', kcal: 240, protein: 6, carbs: 24, fat: 14, fiber: 5, sugars: 18, salt: 0.1, source: 'manual' },
    { at: [21, 15], name: 'Merluza con verduras y patata', kcal: 520, protein: 38, carbs: 46, fat: 20, fiber: 6, sugars: 7, salt: 1.7, source: 'text' },
  ];
  // Quien hace turno de noche come al levantarse (~18:30) y de madrugada: la hora pasa de 24 y cae en el día de calendario siguiente.
  const nightMenu: Dish[] = [
    { at: [19, 30], name: 'Tostadas con tomate y café con leche', kcal: 360, protein: 12, carbs: 48, fat: 13, fiber: 4, sugars: 9, salt: 1.6, source: 'manual' },
    { at: [22, 15], name: 'Yogur natural y fruta', kcal: 190, protein: 9, carbs: 28, fat: 4, fiber: 2, sugars: 20, salt: 0.2, source: 'barcode' },
    { at: [25, 20], name: 'Arroz con pollo y ensalada', kcal: 680, protein: 42, carbs: 82, fat: 17, fiber: 5, sugars: 6, salt: 2.2, source: 'text' },
    { at: [26, 10], name: 'Zanahorias', kcal: 40, protein: 0.9, carbs: 9.6, fat: 0.2, fiber: 2.8, sugars: 4.7, salt: 0.1, source: 'manual' },
    { at: [30, 15], name: 'Merluza con verduras y patata', kcal: 520, protein: 38, carbs: 46, fat: 20, fiber: 6, sugars: 7, salt: 1.7, source: 'text' },
  ];
  const menu = schedule === 'dia' ? nightMenu : dayMenu;
  const skippable = schedule === 'dia' ? 1 : 3; // el yogur o la merienda: un día de cada siete no se anota
  for (let back = 90; back >= 0; back--) {
    if (back > 0 && back % 9 === 4) continue; // un día sin anotar
    const day = addDays(today, -back);
    const dayStart = startOfDayMs(day);
    // Unos días se come algo más y otros algo menos; hoy solo lo que ya ha pasado (el resto del día aún no se ha comido).
    const wobble = 0.85 + rand() * 0.3;
    for (const [i, dish] of menu.entries()) {
      if (back % 7 === 0 && i === skippable) continue;
      const tsMs = dayStart + dish.at[0] * HOUR_MS + dish.at[1] * MINUTE_MS;
      if (tsMs > nowMs - MINUTE_MS) continue;
      const draft: MealDraft = {
        name: dish.name,
        kcal: Math.round(dish.kcal * wobble),
        proteinG: Math.round(dish.protein * wobble * 10) / 10,
        carbsG: Math.round(dish.carbs * wobble * 10) / 10,
        fatG: Math.round(dish.fat * wobble * 10) / 10,
        fiberG: Math.round(dish.fiber * wobble * 10) / 10,
        sugarsG: Math.round(dish.sugars * wobble * 10) / 10,
        saltG: Math.round(dish.salt * wobble * 100) / 100,
      };
      meals.push(buildMeal(draft, { id: `demo-meal-${back}-${i}`, tsMs, source: dish.source }));
    }
  }

  // Agua: las dos últimas semanas (menos hoy, que empieza sin nada anotado), con días que llegan a la meta y otros que se quedan cortos.
  const sips: Array<[number, number, number]> = [
    [8, 0, 250],
    [10, 30, 300],
    [13, 0, 500],
    [15, 30, 250],
    [17, 45, 330],
    [20, 0, 250],
    [22, 0, 200],
  ];
  const shift = schedule === 'dia' ? 11 : 0; // quien duerme de día bebe a otras horas
  for (let back = 14; back >= 1; back--) {
    const dayStart = startOfDayMs(addDays(today, -back));
    const scale = 0.7 + ((back * 37) % 10) / 20; // entre el 70 % y el 115 % de lo normal
    for (const [i, [hour, minute, ml]] of sips.entries()) {
      if (back % 5 === 0 && i === sips.length - 1) continue;
      const tsMs = dayStart + (hour + shift) * HOUR_MS + minute * MINUTE_MS;
      if (tsMs >= startOfDayMs(today)) continue; // hoy empieza sin nada anotado
      water.push({ id: `demo-water-${back}-${i}`, tsMs, ml: Math.round((ml * scale) / 10) * 10 });
    }
  }

  await store.putMany({ profile, workouts, meals, water });

  // Un anillo ya vinculado y una sincronización reciente.
  await store.setRing({ id: 'sim-r99-0001', name: dataset.deviceName });
  await store.addSync({
    tsMs: nowMs - 2 * HOUR_MS,
    ringName: dataset.deviceName,
    firmware: '2.32',
    batteryPercent: dataset.batteryPercent,
    durationMs: 11_400,
    interrupted: false,
    outcomes: [],
    added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 },
    dropped: {},
    liveSteps: dataset.live.steps,
    capabilities: demoRingCapabilities(ringVariant),
  });
}
