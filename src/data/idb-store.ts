import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SavedRing } from '../ble/transport';
import { sanitizeSavedScale, type SavedScale } from '../domain/scale';
import { cleanSocialProfile, isSocialProfile, isUntouched, type SocialProfile } from '../domain/social-profile';
import { addDays, dayKeyOf, endOfDayMs, startOfDayMs, DAY_MS, type DayKey } from '../domain/dates';
import { mealDay, MAX_DAY_SHIFT } from '../domain/day-credit';
import { maxOf, minOf } from '../domain/extent';
import { backtestEstimate, BASELINE_DAYS, estimateSleep, summarizeBacktest, type BacktestSummary } from '../domain/sleep-estimate';
import { estimateSleepOffRing, OFFRING } from '../domain/sleep-offring';
import { sortProfile, type ProfileEntry } from '../domain/profile';
import { sanitizeJointMetrics } from '../domain/joint-metrics';
import { sanitizeNutritionPanel } from '../domain/nutrition-panel';
import { isTargetWeight } from '../domain/weight-goal';
import { sortDishes, withoutServings, type SavedDish } from '../domain/dishes';
import { productKey, type UserProduct } from '../domain/user-products';
import type { WaterEntry } from '../domain/hydration';
import type { MealEntry } from '../domain/nutrition';
import type { IngestRows } from '../domain/sanitize';
import type { RawRange } from '../domain/summary';
import type { CounterSample, HeartSample, SleepSessionRecord, Spo2Sample, StepBucket } from '../domain/types';
import type { WorkoutDraft, WorkoutRecord } from '../domain/workout';
import { DEFAULT_SETTINGS, type BackupFile, type IngestResult, type LatestData, type RowCounts, type Settings, type Store, type StoreStats, type SyncRecord } from './types';
import { parseBackup, requireCompleteBackup } from './backup';

interface Schema extends DBSchema {
  buckets: { key: number; value: StepBucket };
  counters: { key: number; value: CounterSample };
  heart: { key: number; value: HeartSample };
  spo2: { key: number; value: Spo2Sample };
  sleep: { key: number; value: SleepSessionRecord };
  workouts: { key: string; value: WorkoutRecord; indexes: { byStart: number } };
  profile: { key: string; value: ProfileEntry };
  syncs: { key: number; value: SyncRecord };
  kv: { key: string; value: unknown };
}

/**
 * La versión de la base de datos NO cambia con la alimentación (sigue en 1): las comidas viven en el almacén `kv`, un grupo por día
 * (`meals:2026-10-16` → la lista de ese día). Así la app base y la que lleva la dieta abren la
 * MISMA base sin migrar nada: una versión más baja que la guardada haría fallar el arranque (`VersionError`), y con esto se puede
 * pasar de una a otra en los dos sentidos sin perder ni estropear nada (la base simplemente no ve las comidas).
 */
const DB_VERSION = 1;
/** Solo las últimas sincronizaciones conservan la traza BLE completa (puede pesar cientos de KB). */
const SYNC_LOGS_KEPT = 5;
const SYNC_RECORDS_KEPT = 60;

const ROW_STORES = ['buckets', 'counters', 'heart', 'spo2', 'sleep'] as const;
type StoreName = (typeof ROW_STORES)[number];
const ALL_STORES = ['buckets', 'counters', 'heart', 'spo2', 'sleep', 'workouts', 'profile', 'syncs', 'kv'] as const;
/** Donde una versión anterior guardaba la clave de una IA externa: la app ya no usa ninguna y la borra al abrir la base. */
const LEGACY_AI_KEY = 'aiKey';
/** Las comidas de un día, en `kv`: la clave lleva el día (`meals:AAAA-MM-DD`) y el valor es la lista de ese día. */
const MEALS_PREFIX = 'meals:';
const mealsKey = (day: DayKey): string => `${MEALS_PREFIX}${day}`;
/** El rango de claves de todas las comidas (`;` es el carácter que sigue a `:`). */
const ALL_MEALS = IDBKeyRange.bound(MEALS_PREFIX, 'meals;', false, true);

/** Las tomas de agua de un día, igual que las comidas: `water:AAAA-MM-DD` en `kv`. */
const WATER_PREFIX = 'water:';
const waterKey = (day: DayKey): string => `${WATER_PREFIX}${day}`;
const ALL_WATER = IDBKeyRange.bound(WATER_PREFIX, 'water;', false, true);

/** Los platos guardados, uno por clave en `kv` (`dish:<id>`): con su foto un plato pesa decenas de KB y así guardar o usar uno no reescribe los demás. */
const DISH_PREFIX = 'dish:';
const dishKey = (id: string): string => `${DISH_PREFIX}${id}`;
const ALL_DISHES = IDBKeyRange.bound(DISH_PREFIX, 'dish;', false, true);
/** Los productos que la persona enseña, uno por clave en `kv` (`product:<código sin ceros delante>`): buscar uno al escanear no lee los demás. */
const PRODUCT_PREFIX = 'product:';
const productStoreKey = (barcode: string): string => `${PRODUCT_PREFIX}${productKey(barcode)}`;
const ALL_PRODUCTS = IDBKeyRange.bound(PRODUCT_PREFIX, 'product;', false, true);
const isUserProduct = (value: unknown): value is UserProduct =>
  typeof value === 'object' && value !== null && typeof (value as UserProduct).barcode === 'string' && typeof (value as UserProduct).per100g === 'object' && (value as UserProduct).per100g !== null;
const isDish = (value: unknown): value is SavedDish => typeof value === 'object' && value !== null && typeof (value as SavedDish).id === 'string' && Array.isArray((value as SavedDish).ingredients);

const byTime = (a: { tsMs: number; id: string }, b: { tsMs: number; id: string }): number => a.tsMs - b.tsMs || a.id.localeCompare(b.id);
const asWater = (value: unknown): WaterEntry[] => (Array.isArray(value) ? (value as WaterEntry[]) : []);

/** Lo que hay guardado como comidas de un día, aunque el valor sea raro (algo que no es una lista se ignora). */
const asMeals = (value: unknown): MealEntry[] => (Array.isArray(value) ? (value as MealEntry[]) : []);

export async function openIdbStore(name = 'smartring'): Promise<IdbStore> {
  const db = await openDB<Schema>(name, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('buckets', { keyPath: 'startMs' });
      database.createObjectStore('counters', { keyPath: 'tsMs' });
      database.createObjectStore('heart', { keyPath: 'tsMs' });
      database.createObjectStore('spo2', { keyPath: 'tsMs' });
      database.createObjectStore('sleep', { keyPath: 'startMs' });
      const workouts = database.createObjectStore('workouts', { keyPath: 'id' });
      workouts.createIndex('byStart', 'startMs');
      database.createObjectStore('profile', { keyPath: 'date' });
      database.createObjectStore('syncs', { keyPath: 'tsMs' });
      database.createObjectStore('kv');
    },
  });
  // Una clave de IA guardada por una versión anterior es un secreto sin ningún uso: se borra (si falla, no impide abrir la app).
  await db.delete('kv', LEGACY_AI_KEY).catch(() => undefined);
  return new IdbStore(db);
}

const emptyCounts = (): RowCounts => ({ buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 });

/**
 * Ejecuta `work` dentro de una transacción y la confirma; si algo falla, la DESHACE. Hace falta porque IndexedDB solo
 * aborta sola ante un error asíncrono de una petición: una excepción síncrona (un valor que no se puede clonar, por
 * ejemplo) deja la transacción viva, y al terminar se confirmaría lo escrito hasta ese punto.
 */
/** Cuántos registros se piden a la vez al importar una copia. */
const IMPORT_BATCH = 2_000;
/** Cuántos registros se piden a la vez al guardar lo que lee el anillo. */
const INGEST_BATCH = 2_000;

async function atomically<T>(tx: { abort(): void; done: Promise<void> }, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    await tx.done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* ya había terminado */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/**
 * Una medida puntual hecha desde la app (`ring-spot`) la guarda también el propio anillo en su historial y la devuelve en
 * la siguiente sincronización con su sello (al minuto): si hay una lectura del anillo (`ring-auto`) a menos de este
 * margen, es la misma medida vista desde el anillo y manda su copia (la nuestra se retira para no contarla dos veces).
 */
const SPOT_MATCH_MS = 90_000;
/** Lo que se lee de sueño por detrás del rango: un sueño partido en la medianoche son dos sesiones, y `groupSleep` las junta (16 h es su tope). */
const SLEEP_BLOCK_MARGIN_MS = 16 * 3_600_000;

interface SleepStore {
  getAll(range?: IDBKeyRange): Promise<SleepSessionRecord[]>;
  put(value: SleepSessionRecord): Promise<unknown>;
  delete(key: number): Promise<unknown>;
  getKey(key: number): Promise<IDBValidKey | undefined>;
}

/** Longitud de la parte de [startMs, endMs] cubierta por los intervalos (ya fusionados y ordenados). */
function coveredMs(startMs: number, endMs: number, merged: ReadonlyArray<readonly [number, number]>): number {
  let covered = 0;
  for (const [s, e] of merged) covered += Math.max(0, Math.min(endMs, e) - Math.max(startMs, s));
  return covered;
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * Guarda las sesiones de sueño de un lote. El anillo reenvía TODO lo que tiene y puede afinar los límites de una noche
 * entre dos sincronizaciones (o partirla en dos): una sesión guardada que el lote vuelve a describir —cubierto al menos
 * un 50 % de su duración— se sustituye para no contar la noche dos veces. Una guardada que el lote solo roza (un minuto
 * de solape, o una siesta dentro de una noche) se conserva. Las sesiones de un mismo lote nunca se sustituyen entre sí:
 * son la visión actual del anillo.
 */
async function putSleepBatch(store: SleepStore, sessions: readonly SleepSessionRecord[]): Promise<{ added: number; updated: number }> {
  if (sessions.length === 0) return { added: 0, updated: 0 };
  const spans = mergeSpans(sessions.map((x) => [x.startMs, x.endMs] as [number, number]));
  const from = minOf(sessions.map((x) => x.startMs)) - DAY_MS;
  const to = maxOf(sessions.map((x) => x.endMs));
  const superseded: SleepSessionRecord[] = [];
  for (const old of await store.getAll(IDBKeyRange.bound(from, to))) {
    const duration = old.endMs - old.startMs;
    if (duration > 0 && coveredMs(old.startMs, old.endMs, spans) >= duration * 0.5) superseded.push(old);
  }
  const replacedKeys = new Set(superseded.map((x) => x.startMs));
  for (const old of superseded) await store.delete(old.startMs);
  let added = 0;
  let updated = 0;
  for (const session of sessions) {
    const existed = replacedKeys.has(session.startMs) || (await store.getKey(session.startMs)) !== undefined;
    const replacedSomething = superseded.some((old) => old.startMs < session.endMs && old.endMs > session.startMs);
    await store.put(session);
    if (existed || replacedSomething) updated++;
    else added++;
  }
  return { added, updated };
}

export class IdbStore implements Store {
  constructor(private readonly db: IDBPDatabase<Schema>) {}

  close(): void {
    this.db.close();
  }

  // ───────────────────────────── datos del anillo ─────────────────────────────

  async ingest(rows: IngestRows): Promise<IngestResult> {
    const added = emptyCounts();
    const updated = emptyCounts();
    const tx = this.db.transaction([...ROW_STORES], 'readwrite');
    return atomically(tx, async () => {
      const upsert = async <K extends Exclude<StoreName, 'sleep'>>(name: K, items: ReadonlyArray<Schema[K]['value']>, key: (item: Schema[K]['value']) => number): Promise<void> => {
        const store = tx.objectStore(name);
        // Las peticiones se hacen de golpe, por tandas (IndexedDB las ejecuta en orden dentro de la transacción): esperar cada una por separado costaba dos viajes de ida y vuelta por registro,
        // y una historia de cuatro meses (~15 000 registros) tardaba más de 20 s en un móvil. Un registro repetido dentro de la misma llamada cuenta como actualizado, igual que antes.
        const seen = new Set<number>();
        for (let from = 0; from < items.length; from += INGEST_BATCH) {
          const chunk = items.slice(from, from + INGEST_BATCH);
          const existing = await Promise.all(chunk.map((item) => store.getKey(key(item))));
          await Promise.all(chunk.map((item) => store.put(item as never)));
          chunk.forEach((item, i) => {
            const k = key(item);
            (existing[i] !== undefined || seen.has(k) ? updated : added)[name]++;
            seen.add(k);
          });
        }
      };
      await upsert('buckets', rows.buckets, (b) => b.startMs);
      await upsert('counters', rows.counters, (c) => c.tsMs);
      await upsert('heart', rows.heart, (h) => h.tsMs);
      await upsert('spo2', rows.spo2, (s) => s.tsMs);

      // Medidas puntuales de la app que el anillo ya ha devuelto en su historial: queda la copia del anillo.
      const fromRing = rows.heart.filter((h) => h.source === 'ring-auto');
      if (fromRing.length > 0) {
        const heartStore = tx.objectStore('heart');
        const lo = minOf(fromRing.map((h) => h.tsMs)) - SPOT_MATCH_MS;
        const hi = maxOf(fromRing.map((h) => h.tsMs)) + SPOT_MATCH_MS;
        for (const stored of await heartStore.getAll(IDBKeyRange.bound(lo, hi))) {
          if (stored.source === 'ring-spot' && fromRing.some((h) => Math.abs(h.tsMs - stored.tsMs) <= SPOT_MATCH_MS)) {
            await heartStore.delete(stored.tsMs);
          }
        }
      }

      const sleep = await putSleepBatch(tx.objectStore('sleep'), rows.sleep);
      added.sleep += sleep.added;
      updated.sleep += sleep.updated;
      return { added, updated };
    });
  }

  async loadRange(from: DayKey, to: DayKey): Promise<RawRange> {
    return this.loadWindow(startOfDayMs(from), endOfDayMs(to));
  }

  async loadWindow(start: number, end: number): Promise<RawRange> {
    // Margen de un día por delante: tramos y sesiones de sueño que empiezan el día anterior y acaban dentro.
    const lo = start - DAY_MS;
    const bound = (a: number, b: number): IDBKeyRange => IDBKeyRange.bound(a, b, false, true);
    // Para estimar el sueño que el anillo no guardó hace falta ver unos días a cada lado: calibran el pulso de la persona y su hábito.
    const around = bound(start - BASELINE_DAYS * DAY_MS, end + BASELINE_DAYS * DAY_MS);
    const [buckets, counters, heart, spo2, sleep, workouts, earlier, near] = await Promise.all([
      this.db.getAll('buckets', bound(lo, end)),
      this.db.getAll('counters', bound(start, end)),
      this.db.getAll('heart', bound(start, end)),
      this.db.getAll('spo2', bound(start, end)),
      // Una noche que el anillo parte en la medianoche son dos sesiones: la hoja del primer día necesita también las del siguiente.
      this.db.getAll('sleep', bound(lo, end + SLEEP_BLOCK_MARGIN_MS)),
      this.db.getAllFromIndex('workouts', 'byStart', bound(start, end)),
      this.db.getAllFromIndex('workouts', 'byStart', bound(lo, start)),
      Promise.all([
        this.db.getAll('heart', around),
        this.db.getAll('buckets', around),
        this.db.getAll('counters', around),
        this.db.getAllFromIndex('workouts', 'byStart', around),
        this.db.getAll('sleep', around),
      ]),
    ]);
    // Los que empezaron antes del rango y siguen dentro (cruzan la medianoche): no son del rango, pero sus pasos sí.
    const carryWorkouts = earlier.filter((w) => w.endMs > start);
    // Lo que la persona hizo con la app dice cuándo estaba despierta: una comida o un vaso de agua anotados y las veces que la app estuvo abierta sincronizando.
    const habitFrom = start - OFFRING.habitDays * DAY_MS;
    const habitTo = end + OFFRING.habitDays * DAY_MS;
    const [asked, marks, realNights] = await Promise.all([
      this.lastSleepAskMs(),
      this.appActivity(start - BASELINE_DAYS * DAY_MS, end + BASELINE_DAYS * DAY_MS),
      this.db.getAll('sleep', bound(habitFrom, habitTo)),
    ]);
    const { logged: loggedTimes, syncs: syncTimes } = marks;
    // Las noches que el anillo no dio se estiman con el pulso, la respiración y los pasos (nunca se guardan: ver `sleep-estimate.ts`).
    const [heartAround, bucketsAround, countersAround, workoutsAround, sleepAround] = near;
    const estimated = estimateSleep({
      heart: heartAround,
      buckets: bucketsAround,
      counters: countersAround,
      workouts: workoutsAround,
      real: sleepAround,
      askedAtMs: asked,
      fromMs: start,
      toMs: end,
      awakeMarks: [...loggedTimes, ...syncTimes],
    });
    // Y las noches SIN anillo (no hay pulso ni pasos que mirar), con los huecos de actividad: lo anotado, la app abierta y los pasos de antes y después. Solo donde ni el anillo ni la otra estimación dieron nada.
    const offRing = estimateSleepOffRing({
      buckets: bucketsAround,
      counters: countersAround,
      heart: heartAround,
      workouts: workoutsAround,
      logged: loggedTimes,
      syncs: syncTimes,
      real: realNights,
      askedAtMs: asked,
      fromMs: start,
      toMs: end,
    }).filter((night) => !estimated.some((e) => e.startMs < night.endMs + OFFRING.nearRealMs && e.endMs > night.startMs - OFFRING.nearRealMs));
    const allEstimated = offRing.length > 0 ? [...estimated, ...offRing] : estimated;
    return {
      buckets,
      counters,
      heart,
      spo2,
      sleep: allEstimated.length > 0 ? [...sleep, ...allEstimated] : sleep,
      workouts,
      carryWorkouts,
      meals: await this.mealsOfWindow(start, end),
      water: await this.listWater(start, end),
    };
  }

  /** Las horas en que la persona hizo algo con la app (anotó una comida o agua, o la app estuvo abierta sincronizando) entre `from` y `to`: estaba despierta. */
  private async appActivity(from: number, to: number): Promise<{ logged: number[]; syncs: number[] }> {
    const [meals, water, syncKeys] = await Promise.all([
      this.listMeals(from, to),
      this.listWater(from, to),
      // Solo las horas (la clave de cada registro): sus trazas pesan mucho y aquí no hacen falta.
      this.db.getAllKeys('syncs'),
    ]);
    return {
      // Una comida pasada a otro día conserva la hora a la que se anotó, que no es la de ese día: no dice cuándo estaba despierta la persona.
      logged: [...meals.filter((m) => m.day === undefined || m.day === dayKeyOf(m.tsMs)).map((m) => m.tsMs), ...water.map((w) => w.tsMs)],
      syncs: syncKeys.filter((ts): ts is number => typeof ts === 'number').filter((ts) => ts >= from && ts < to),
    };
  }

  async sleepAccuracy(nowMs: number, days = 60): Promise<BacktestSummary | null> {
    const start = nowMs - days * DAY_MS;
    const around = IDBKeyRange.bound(start - BASELINE_DAYS * DAY_MS, nowMs, false, true);
    const [heart, buckets, counters, workouts, sleep, marks] = await Promise.all([
      this.db.getAll('heart', around),
      this.db.getAll('buckets', around),
      this.db.getAll('counters', around),
      this.db.getAllFromIndex('workouts', 'byStart', around),
      this.db.getAll('sleep', around),
      this.appActivity(start - BASELINE_DAYS * DAY_MS, nowMs),
    ]);
    return summarizeBacktest(
      backtestEstimate({ heart, buckets, counters, workouts, real: sleep, askedAtMs: nowMs, fromMs: start, toMs: nowMs, awakeMarks: [...marks.logged, ...marks.syncs] }),
    );
  }

  async stats(): Promise<StoreStats> {
    const counts: Record<string, number> = {};
    for (const name of ['buckets', 'counters', 'heart', 'spo2', 'sleep', 'workouts', 'profile', 'syncs'] as const) {
      counts[name] = await this.db.count(name);
    }
    counts.meals = (await this.allMeals()).length;
    counts.water = (await this.allWater()).length;
    counts.dishes = (await this.listDishes()).length;
    counts.products = (await this.listProducts()).length;
    const firsts: number[] = [];
    for (const name of ['buckets', 'counters', 'heart', 'spo2', 'sleep'] as const) {
      const [first] = await this.db.getAllKeys(name, undefined, 1);
      if (typeof first === 'number') firsts.push(first);
    }
    return { counts, firstDataMs: firsts.length ? Math.min(...firsts) : null };
  }

  async latestData(): Promise<LatestData> {
    const [heartMs, spo2Ms, bucket, counterMs, sleep] = await Promise.all([
      this.lastKeyOf('heart'),
      this.lastKeyOf('spo2'),
      this.db.transaction('buckets').store.openCursor(null, 'prev'),
      this.lastKeyOf('counters'),
      this.db.transaction('sleep').store.openCursor(null, 'prev'),
    ]);
    // Una franja de actividad cuenta hasta donde acaba, no desde donde empieza.
    const activity = [bucket?.value.endMs ?? null, counterMs].filter((t): t is number => t !== null);
    return { heartMs, spo2Ms, activityMs: activity.length ? Math.max(...activity) : null, sleepEndMs: sleep?.value.endMs ?? null };
  }

  /** La clave más alta (la más reciente) de un almacén indexado por hora. */
  private async lastKeyOf(name: 'buckets' | 'counters' | 'heart' | 'spo2' | 'sleep'): Promise<number | null> {
    const cursor = await this.db.transaction(name).store.openCursor(null, 'prev');
    return cursor && typeof cursor.key === 'number' ? cursor.key : null;
  }

  // ───────────────────────────── perfil ─────────────────────────────

  async getProfileHistory(): Promise<ProfileEntry[]> {
    return sortProfile(await this.db.getAll('profile'));
  }

  async putProfileEntry(entry: ProfileEntry): Promise<void> {
    await this.db.put('profile', entry);
  }

  async putMany(rows: { profile?: readonly ProfileEntry[]; workouts?: readonly WorkoutRecord[]; meals?: readonly MealEntry[]; water?: readonly WaterEntry[] }): Promise<void> {
    const tx = this.db.transaction(['profile', 'workouts', 'kv'], 'readwrite');
    await atomically(tx, async () => {
      // Las escrituras se piden de golpe: IndexedDB las ejecuta en orden dentro de la transacción (esperar cada una costaba un viaje de ida y vuelta por registro).
      await Promise.all((rows.profile ?? []).map((entry) => tx.objectStore('profile').put(entry)));
      await Promise.all(
        (rows.workouts ?? []).map((workout) => {
          const { day: _legacy, ...clean } = workout as WorkoutRecord & { day?: unknown };
          return tx.objectStore('workouts').put(clean);
        }),
      );
      // Comidas y agua van agrupadas por día (una clave por día): se juntan con lo que ya hubiera en ese día, como `putMeal` y `putWater`.
      const kv = tx.objectStore('kv');
      const mealDays = new Map<string, MealEntry[]>();
      for (const meal of rows.meals ?? []) mealDays.set(mealsKey(dayKeyOf(meal.tsMs)), [...(mealDays.get(mealsKey(dayKeyOf(meal.tsMs))) ?? []), meal]);
      await Promise.all(
        [...mealDays].map(async ([key, incoming]) => {
          const ids = new Set(incoming.map((m) => m.id));
          await kv.put([...asMeals(await kv.get(key)).filter((m) => !ids.has(m.id)), ...incoming].sort(byTime), key);
        }),
      );
      const waterDays = new Map<string, WaterEntry[]>();
      for (const entry of rows.water ?? []) waterDays.set(waterKey(dayKeyOf(entry.tsMs)), [...(waterDays.get(waterKey(dayKeyOf(entry.tsMs))) ?? []), entry]);
      await Promise.all(
        [...waterDays].map(async ([key, incoming]) => {
          const ids = new Set(incoming.map((w) => w.id));
          await kv.put([...asWater(await kv.get(key)).filter((w) => !ids.has(w.id)), ...incoming].sort(byTime), key);
        }),
      );
    });
  }

  // ───────────────────────────── entrenamientos ─────────────────────────────

  async getWorkoutDraft(): Promise<WorkoutDraft | null> {
    return ((await this.db.get('kv', 'workoutDraft')) as WorkoutDraft | undefined) ?? null;
  }

  async setWorkoutDraft(record: WorkoutDraft | null): Promise<void> {
    if (record) await this.db.put('kv', record, 'workoutDraft');
    else await this.db.delete('kv', 'workoutDraft');
  }

  async putWorkout(workout: WorkoutRecord): Promise<void> {
    // Un entreno ya no se pasa de día: el `day` que dejó guardado una versión anterior no cuenta (cuenta el día en que ocurrió) y no se arrastra.
    const { day: _legacy, ...clean } = workout as WorkoutRecord & { day?: unknown };
    await this.db.put('workouts', clean);
  }

  async deleteWorkout(id: string): Promise<void> {
    await this.db.delete('workouts', id);
  }

  async getWorkout(id: string): Promise<WorkoutRecord | null> {
    return (await this.db.get('workouts', id)) ?? null;
  }

  async listWorkouts(fromMs: number, toMs: number): Promise<WorkoutRecord[]> {
    return this.db.getAllFromIndex('workouts', 'byStart', IDBKeyRange.bound(fromMs, toMs, false, true));
  }

  async recentWorkouts(limit: number): Promise<WorkoutRecord[]> {
    const out: WorkoutRecord[] = [];
    let cursor = await this.db.transaction('workouts').store.index('byStart').openCursor(null, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  // ───────────────────────────── comidas ─────────────────────────────

  /** Todas las comidas guardadas (de cualquier día), sin ordenar. */
  private async allMeals(): Promise<MealEntry[]> {
    return (await this.db.getAll('kv', ALL_MEALS)).flatMap(asMeals);
  }

  /** Las comidas de un intervalo: las que cuentan para sus días (las movidas, para el día al que se pasaron) y, de las demás, las que caen dentro. */
  private async mealsOfWindow(startMs: number, endMs: number): Promise<MealEntry[]> {
    const from = dayKeyOf(startMs);
    const to = dayKeyOf(endMs - 1);
    const found = await this.listMeals(startOfDayMs(addDays(from, -MAX_DAY_SHIFT)), endOfDayMs(addDays(to, MAX_DAY_SHIFT)));
    return found.filter((m) => (m.day === undefined ? m.tsMs >= startMs && m.tsMs < endMs : m.day >= from && m.day <= to));
  }

  async listMealsByDay(fromDay: DayKey, toDay: DayKey): Promise<MealEntry[]> {
    const found = await this.listMeals(startOfDayMs(addDays(fromDay, -MAX_DAY_SHIFT)), endOfDayMs(addDays(toDay, MAX_DAY_SHIFT)));
    return found.filter((m) => {
      const day = mealDay(m);
      return day >= fromDay && day <= toDay;
    });
  }

  async putMeal(meal: MealEntry): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const key = mealsKey(dayKeyOf(meal.tsMs));
    const day = asMeals(await tx.store.get(key)).filter((m) => m.id !== meal.id);
    await tx.store.put([...day, meal].sort(byTime), key);
    await tx.done;
  }

  async deleteMeal(meal: Pick<MealEntry, 'id' | 'tsMs'>): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    // El grupo lo decidió la zona horaria de cuando se anotó, que puede no ser la de ahora (un viaje): se mira también el día anterior y el siguiente.
    const day = dayKeyOf(meal.tsMs);
    for (const key of [mealsKey(addDays(day, -1)), mealsKey(day), mealsKey(addDays(day, 1))]) {
      const all = asMeals(await tx.store.get(key));
      const rest = all.filter((m) => m.id !== meal.id);
      if (rest.length === all.length) continue;
      if (rest.length > 0) await tx.store.put(rest, key);
      else await tx.store.delete(key);
    }
    await tx.done;
  }

  async listMeals(fromMs: number, toMs: number): Promise<MealEntry[]> {
    // Con un día de margen por cada lado: el grupo de un día lo decidió la zona horaria de cuando se anotó.
    const range = IDBKeyRange.bound(mealsKey(addDays(dayKeyOf(fromMs), -1)), mealsKey(addDays(dayKeyOf(toMs), 1)));
    return (await this.db.getAll('kv', range))
      .flatMap(asMeals)
      .filter((m) => m.tsMs >= fromMs && m.tsMs < toMs)
      .sort(byTime);
  }

  // ───────────────────────────── agua ─────────────────────────────

  private async allWater(): Promise<WaterEntry[]> {
    return (await this.db.getAll('kv', ALL_WATER)).flatMap(asWater);
  }

  async putWater(entry: WaterEntry): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const key = waterKey(dayKeyOf(entry.tsMs));
    const day = asWater(await tx.store.get(key)).filter((w) => w.id !== entry.id);
    await tx.store.put([...day, entry].sort(byTime), key);
    await tx.done;
  }

  async deleteWater(entry: Pick<WaterEntry, 'id' | 'tsMs'>): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    // Como con las comidas: el grupo lo decidió la zona horaria de cuando se anotó, que puede no ser la de ahora.
    const day = dayKeyOf(entry.tsMs);
    for (const key of [waterKey(addDays(day, -1)), waterKey(day), waterKey(addDays(day, 1))]) {
      const all = asWater(await tx.store.get(key));
      const rest = all.filter((w) => w.id !== entry.id);
      if (rest.length === all.length) continue;
      if (rest.length > 0) await tx.store.put(rest, key);
      else await tx.store.delete(key);
    }
    await tx.done;
  }

  async listWater(fromMs: number, toMs: number): Promise<WaterEntry[]> {
    const range = IDBKeyRange.bound(waterKey(addDays(dayKeyOf(fromMs), -1)), waterKey(addDays(dayKeyOf(toMs), 1)));
    return (await this.db.getAll('kv', range))
      .flatMap(asWater)
      .filter((w) => w.tsMs >= fromMs && w.tsMs < toMs)
      .sort(byTime);
  }

  // ───────────────────────────── ajustes y anillo ─────────────────────────────

  async getSettings(): Promise<Settings> {
    // `dayStartHour` era el ajuste «Inicio del día» (ya no existe: los días empiezan a las 00:00): lo que se guardó con él no se arrastra.
    const { dayStartHour: _legacy, ...stored } = ((await this.db.get('kv', 'settings')) ?? {}) as Partial<Settings> & { dayStartHour?: number };
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    // Un peso objetivo que no es un peso (un valor raro guardado a mano o por una versión futura) se trata como «sin peso objetivo»: nada de «NaN kg» en el menú ni escalas rotas.
    // Los datos del gráfico se limpian al leerlos: uno que ya no existe (una versión futura) no rompe el gráfico.
    // Qué dispositivos tiene: lo que no sea un sí o un no vuelve al valor de serie (tiene los dos).
    const clean = {
      ...settings,
      jointMetrics: sanitizeJointMetrics(settings.jointMetrics),
      nutritionPanel: sanitizeNutritionPanel(settings.nutritionPanel),
      hasRing: typeof settings.hasRing === 'boolean' ? settings.hasRing : DEFAULT_SETTINGS.hasRing,
      hasScale: typeof settings.hasScale === 'boolean' ? settings.hasScale : DEFAULT_SETTINGS.hasScale,
    };
    return isTargetWeight(clean.targetWeightKg) ? clean : { ...clean, targetWeightKg: null };
  }

  async setSettings(partial: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings()), ...partial };
    await this.db.put('kv', next, 'settings');
    return next;
  }

  async getSocial(): Promise<SocialProfile | null> {
    const found: unknown = await this.db.get('kv', 'social');
    return isSocialProfile(found) ? cleanSocialProfile(found) : null;
  }

  async setSocial(profile: SocialProfile): Promise<void> {
    if (!isSocialProfile(profile)) throw new Error('El perfil no es válido.');
    await this.db.put('kv', cleanSocialProfile(profile), 'social');
  }

  async getRing(): Promise<SavedRing | null> {
    return ((await this.db.get('kv', 'ring')) as SavedRing | undefined) ?? null;
  }

  async setRing(ring: SavedRing | null): Promise<void> {
    if (ring) await this.db.put('kv', ring, 'ring');
    else await this.db.delete('kv', 'ring');
  }

  async getScale(): Promise<SavedScale | null> {
    return sanitizeSavedScale(await this.db.get('kv', 'scale'));
  }

  async setScale(scale: SavedScale | null): Promise<void> {
    const clean = scale ? sanitizeSavedScale(scale) : null;
    if (clean) await this.db.put('kv', clean, 'scale');
    else await this.db.delete('kv', 'scale');
  }

  // ───────────────────────────── sincronizaciones ─────────────────────────────

  async addSync(record: SyncRecord): Promise<void> {
    const tx = this.db.transaction('syncs', 'readwrite');
    await tx.store.put(record);
    // Solo las últimas conservan la traza; las demás se aligeran. Y se limita el total.
    const all = await tx.store.getAll();
    all.sort((a, b) => b.tsMs - a.tsMs);
    for (const [index, sync] of all.entries()) {
      if (index >= SYNC_RECORDS_KEPT) {
        await tx.store.delete(sync.tsMs);
      } else if (index >= SYNC_LOGS_KEPT && sync.log !== undefined) {
        const { log: _log, ...light } = sync;
        await tx.store.put(light);
      }
    }
    await tx.done;
  }

  async listSyncs(limit: number): Promise<SyncRecord[]> {
    const all = await this.db.getAll('syncs');
    return all.sort((a, b) => b.tsMs - a.tsMs).slice(0, limit);
  }

  /**
   * Cuándo se le pidió al anillo, por última vez, su historial de sueño (cualquiera que fuera el resultado: lo que importa es que se
   * intentó la forma normal). `null`: nunca. Se recorre de la más reciente hacia atrás y se para en la primera que lo pidió.
   */
  private async lastSleepAskMs(): Promise<number | null> {
    let cursor = await this.db.transaction('syncs').store.openCursor(null, 'prev');
    while (cursor) {
      if (cursor.value.outcomes.some((o) => o.type === 'sleep')) return cursor.value.tsMs;
      cursor = await cursor.continue();
    }
    return null;
  }

  async lastSuccessfulSync(): Promise<SyncRecord | null> {
    const all = await this.listSyncs(SYNC_RECORDS_KEPT);
    return all.find((s) => s.error === undefined && !s.interrupted) ?? null;
  }

  // ───────────────────────────── platos guardados ─────────────────────────────

  async putDish(dish: SavedDish): Promise<void> {
    await this.db.put('kv', dish, dishKey(dish.id));
  }

  async deleteDish(id: string): Promise<void> {
    await this.db.delete('kv', dishKey(id));
  }

  async listDishes(): Promise<SavedDish[]> {
    // Los platos guardados con raciones (la versión anterior) se leen como una ración: ver `withoutServings`.
    return sortDishes((await this.db.getAll('kv', ALL_DISHES)).filter(isDish).map(withoutServings));
  }

  // ───────────────────────────── mis productos ─────────────────────────────

  async putProduct(product: UserProduct): Promise<void> {
    await this.db.put('kv', product, productStoreKey(product.barcode));
  }

  async deleteProduct(barcode: string): Promise<void> {
    await this.db.delete('kv', productStoreKey(barcode));
  }

  async getProduct(barcode: string): Promise<UserProduct | null> {
    if (!/^\d{8,14}$/.test(barcode)) return null;
    const found: unknown = await this.db.get('kv', productStoreKey(barcode));
    return isUserProduct(found) ? found : null;
  }

  async listProducts(): Promise<UserProduct[]> {
    return (await this.db.getAll('kv', ALL_PRODUCTS)).filter(isUserProduct).sort((a, b) => b.updatedMs - a.updatedMs || a.name.localeCompare(b.name));
  }

  // ───────────────────────────── copia de seguridad ─────────────────────────────

  async exportAll(): Promise<BackupFile> {
    const syncs = (await this.db.getAll('syncs')).map(({ log: _log, ...rest }) => rest);
    const social = await this.getSocial();
    return {
      format: 'smartring-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        profile: await this.getProfileHistory(),
        settings: await this.getSettings(),
        workouts: await this.db.getAll('workouts'),
        meals: (await this.allMeals()).sort(byTime),
        water: (await this.allWater()).sort(byTime),
        dishes: await this.listDishes(),
        products: await this.listProducts(),
        ...(social !== null ? { social } : {}),
        buckets: await this.db.getAll('buckets'),
        counters: await this.db.getAll('counters'),
        heart: await this.db.getAll('heart'),
        spo2: await this.db.getAll('spo2'),
        sleep: await this.db.getAll('sleep'),
        syncs,
      },
    };
  }

  /**
   * Importa una copia. Se valida ENTERA antes de tocar nada y todo se escribe en UNA transacción: si algo falla a mitad
   * (cuota, cierre de la app), no queda un almacén vacío ni a medias — o se importa todo o no cambia nada.
   * - `replace` vacía los datos y deja los de la copia (no toca el anillo vinculado: no forma parte de la copia).
   * - `merge` añade lo de la copia a lo que hay; los ajustes actuales no se tocan.
   */
  async importAll(file: unknown, mode: 'merge' | 'replace'): Promise<{ imported: Record<string, number> }> {
    const parsed = parseBackup(file);
    if (mode === 'replace') requireCompleteBackup(parsed);
    const imported: Record<string, number> = {};
    const tx = this.db.transaction([...ALL_STORES], 'readwrite');
    await atomically(tx, async () => {
      if (mode === 'replace') {
        // El anillo vinculado no forma parte de la copia: reemplazar los datos no lo quita.
        const ring = await tx.objectStore('kv').get('ring');
        // Lo que es de ESTE móvil y no de la copia sobrevive a reemplazar: la identidad social (si la copia no trae otra).
        const social = await tx.objectStore('kv').get('social');
        for (const name of ALL_STORES) await tx.objectStore(name).clear();
        if (ring !== undefined) await tx.objectStore('kv').put(ring, 'ring');
        if (social !== undefined) await tx.objectStore('kv').put(social, 'social');
      }
      const put = async (name: 'workouts' | 'profile' | 'syncs' | 'buckets' | 'counters' | 'heart' | 'spo2', items: readonly unknown[]): Promise<void> => {
        const store = tx.objectStore(name);
        // Las escrituras se piden de golpe (en tandas, para no crear cientos de miles de promesas a la vez): IndexedDB las ejecuta en orden dentro de la transacción. Esperar cada una por separado
        // costaba un viaje de ida y vuelta por registro: una copia de tres años (70 000 registros) tardaba 10 s y ahora unos 2.
        for (let from = 0; from < items.length; from += IMPORT_BATCH) await Promise.all(items.slice(from, from + IMPORT_BATCH).map((item) => store.put(item as never)));
        imported[name] = items.length;
      };
      await put('profile', parsed.profile);
      await put('workouts', parsed.workouts);
      // Las comidas de la copia se juntan por día con las que ya hubiera (al combinar): la de la copia manda si es la misma.
      const kv = tx.objectStore('kv');
      const days = new Map<string, MealEntry[]>();
      for (const meal of parsed.meals) days.set(mealsKey(dayKeyOf(meal.tsMs)), [...(days.get(mealsKey(dayKeyOf(meal.tsMs))) ?? []), meal]);
      await Promise.all(
        [...days].map(async ([key, incoming]) => {
          const ids = new Set(incoming.map((m) => m.id));
          const kept = asMeals(await kv.get(key)).filter((m) => !ids.has(m.id));
          await kv.put([...kept, ...incoming].sort(byTime), key);
        }),
      );
      imported.meals = parsed.meals.length;
      const waterDays = new Map<string, WaterEntry[]>();
      for (const entry of parsed.water) waterDays.set(waterKey(dayKeyOf(entry.tsMs)), [...(waterDays.get(waterKey(dayKeyOf(entry.tsMs))) ?? []), entry]);
      await Promise.all(
        [...waterDays].map(async ([key, incoming]) => {
          const ids = new Set(incoming.map((w) => w.id));
          const kept = asWater(await kv.get(key)).filter((w) => !ids.has(w.id));
          await kv.put([...kept, ...incoming].sort(byTime), key);
        }),
      );
      imported.water = parsed.water.length;
      for (const dish of parsed.dishes) await kv.put(dish, dishKey(dish.id));
      imported.dishes = parsed.dishes.length;
      for (const product of parsed.products) await kv.put(product, productStoreKey(product.barcode));
      imported.products = parsed.products.length;
      // La identidad social: la de la copia manda al reemplazar; al combinar solo si aquí no hay una en uso (un perfil recién creado se cambia por el de la copia sin perder nada).
      if (parsed.social !== null) {
        const local: unknown = await kv.get('social');
        if (mode === 'replace' || !isSocialProfile(local) || isUntouched(local)) {
          await kv.put(parsed.social, 'social');
          imported.social = 1;
        }
      }
      await put('buckets', parsed.buckets);
      await put('counters', parsed.counters);
      await put('heart', parsed.heart);
      await put('spo2', parsed.spo2);
      await put('syncs', parsed.syncs);
      const sleep = await putSleepBatch(tx.objectStore('sleep'), parsed.sleep);
      imported.sleep = sleep.added + sleep.updated;
      if (mode === 'replace' && parsed.hasSettings) await tx.objectStore('kv').put({ ...DEFAULT_SETTINGS, ...parsed.settings }, 'settings');
    });
    return { imported };
  }

  async wipe(): Promise<void> {
    const tx = this.db.transaction([...ALL_STORES], 'readwrite');
    for (const name of ALL_STORES) await tx.objectStore(name).clear();
    await tx.done;
  }
}
