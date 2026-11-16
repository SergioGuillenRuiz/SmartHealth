import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { KCAL_PER_KG } from '../domain/adaptive-intake';
import { addDays, atHourMs, type DayKey } from '../domain/dates';
import type { ProfileEntry } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import { computeAdaptive, computeHr } from './personal';

const TODAY: DayKey = '2026-10-19';
const NOW = atHourMs(TODAY, 12);
const ago = (n: number): DayKey => addDays(TODAY, -n);
const entry = (date: DayKey, weightKg: number): ProfileEntry => ({ date, heightCm: 182, weightKg, sex: 'male', birthDate: '1999-05-20' });
/** Un peso anotado cada día de hace `days` días a hoy, en línea recta entre `from` y `to`. */
const dailyHistory = (days: number, from: number, to: number): ProfileEntry[] => Array.from({ length: days + 1 }, (_, i) => entry(ago(days - i), from + ((to - from) * i) / days));

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`personal-${++counter}`);
});

describe('computeAdaptive: calorías de mantenimiento a partir de lo anotado y del peso', () => {
  it('con seis semanas de comidas y dos pesos, sale el gasto medido ', async () => {
    for (let n = 42; n >= 1; n--) {
      await store.putMeal({ id: `a${n}`, tsMs: atHourMs(ago(n), 14), name: 'Comida', kcal: 1200, source: 'manual' });
      await store.putMeal({ id: `b${n}`, tsMs: atHourMs(ago(n), 21), name: 'Cena', kcal: 800, source: 'manual' });
    }
    const history = dailyHistory(42, 80, 78);
    const result = await computeAdaptive(store, history, TODAY);
    expect(result?.source).toBe('adaptive');
    expect(result?.loggedDays).toBe(42);
    expect(result?.kcal).toBe(Math.round(2000 + (2 * KCAL_PER_KG) / 42));
  });

  it('la comida de hoy no cuenta, y con poco anotado se queda en la fórmula', async () => {
    await store.putMeal({ id: 't', tsMs: atHourMs(TODAY, 9), name: 'Desayuno', kcal: 500, source: 'manual' });
    const result = await computeAdaptive(store, [entry(ago(42), 80), entry(TODAY, 78)], TODAY);
    expect(result?.source).toBe('formula');
    expect(result?.loggedDays).toBe(0);
  });

  it('la cena de después de medianoche pasada al día anterior cuenta en ese día (no deja un día corto y otro largo)', async () => {
    for (let n = 42; n >= 1; n--) {
      await store.putMeal({ id: `a${n}`, tsMs: atHourMs(ago(n), 14), name: 'Comida', kcal: 1200, source: 'manual' });
      // La cena es de la 01:00 del día siguiente, pasada a su día.
      await store.putMeal({ id: `b${n}`, tsMs: atHourMs(ago(n - 1), 1), day: ago(n), name: 'Cena', kcal: 800, source: 'manual' });
    }
    const result = await computeAdaptive(store, dailyHistory(42, 80, 78), TODAY);
    expect(result?.source).toBe('adaptive');
    expect(result?.loggedDays).toBe(42);
    expect(result?.kcal).toBe(Math.round(2000 + (2 * KCAL_PER_KG) / 42));
  });

  it('sin perfil (el genérico) no hay nada que medir', async () => {
    expect(await computeAdaptive(store, [], TODAY)).toBeNull();
  });
});

describe('computeHr: pulso máximo personal', () => {
  const run = (id: string, daysAgo: number, peak: number): WorkoutRecord => {
    const startMs = atHourMs(ago(daysAgo), 18);
    const hr: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => [startMs + i * 60_000, i === 59 ? peak : i === 58 ? peak - 2 : 150 + (i % 10)]);
    return { id, sport: 'run', startMs, endMs: startMs + 60 * 60_000, pausedMs: 0, source: 'live', hr };
  };

  it('con tres carreras de picos 198, 197 y 193 (el segundo valor de cada una), el máximo es el segundo pico más alto: 195 (la fórmula daba 189)', async () => {
    for (const [i, peak] of [198, 197, 193].entries()) await store.putWorkout(run(`r${i}`, 5 + i * 3, peak));
    const hr = await computeHr(store, [entry(ago(60), 78)], TODAY, NOW);
    expect(hr).toEqual({ hrMax: 195, maxSource: 'observed' });
  });

  it('sin entrenos con pulso, queda la fórmula por edad', async () => {
    const hr = await computeHr(store, [entry(ago(60), 78)], TODAY, NOW);
    expect(hr).toEqual({ hrMax: 189, maxSource: 'age' });
  });

  it('sin perfil no hay pulsos personales', async () => {
    expect(await computeHr(store, [], TODAY, NOW)).toBeNull();
  });
});
