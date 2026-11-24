import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedDish } from '../domain/dishes';
import type { UserProduct } from '../domain/user-products';
import { newSocialProfile, type SocialProfile } from '../domain/social-profile';
import type { MealEntry } from '../domain/nutrition';
import type { IngestRows } from '../domain/sanitize';
import type { ProfileEntry } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import { openIdbStore, type IdbStore } from './idb-store';
import { BackupError } from './backup';
import type { SyncRecord } from './types';

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`test-${++counter}`);
});

const at = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
const key = (day: number): string => `2026-07-${String(day).padStart(2, '0')}`;

const emptyRows = (): IngestRows => ({ buckets: [], counters: [], heart: [], spo2: [], sleep: [], dropped: {} });

describe('ingest', () => {
  const rows = (): IngestRows => ({
    ...emptyRows(),
    buckets: [{ startMs: at(9, 8), endMs: at(9, 8, 15), steps: 1200, ringDistanceM: 900, ringCalories: 700 }],
    counters: [{ tsMs: at(9, 20), steps: 7000 }],
    heart: [{ tsMs: at(9, 3), bpm: 55, source: 'ring-auto' }, { tsMs: at(9, 12), bpm: 74, source: 'ring-auto' }],
    spo2: [{ tsMs: at(9, 3), percent: 96 }],
    sleep: [{ startMs: at(8, 23), endMs: at(9, 7), segments: [{ stage: 'light', startMs: at(8, 23), durationSec: 8 * 3600 }] }],
  });

  it('es idempotente: sincronizar dos veces lo mismo no duplica nada', async () => {
    const first = await store.ingest(rows());
    expect(first.added).toEqual({ buckets: 1, counters: 1, heart: 2, spo2: 1, sleep: 1 });
    const second = await store.ingest(rows());
    expect(second.added).toEqual({ buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 });
    expect(second.updated).toEqual({ buckets: 1, counters: 1, heart: 2, spo2: 1, sleep: 1 });
    const stats = await store.stats();
    expect(stats.counts).toMatchObject({ buckets: 1, counters: 1, heart: 2, spo2: 1, sleep: 1 });
  });

  it('una noche que llega con otro inicio sustituye a la anterior en vez de duplicarse', async () => {
    await store.ingest(rows());
    const refined = rows();
    refined.sleep = [{ startMs: at(8, 23, 4), endMs: at(9, 7, 2), segments: [{ stage: 'light', startMs: at(8, 23, 4), durationSec: 7.9 * 3600 }] }];
    const result = await store.ingest(refined);
    expect(result.updated.sleep).toBe(1);
    const range = await store.loadRange(key(9), key(9));
    expect(range.sleep).toHaveLength(1);
    expect(range.sleep[0]?.startMs).toBe(at(8, 23, 4));
  });

  it('el sueño de después de medianoche viene con el día anterior: una noche partida en la medianoche se ve entera desde su primera parte', async () => {
    const next = emptyRows();
    next.sleep = [
      { startMs: at(8, 22, 0), endMs: at(8, 23, 50), segments: [] },
      { startMs: at(9, 0, 30), endMs: at(9, 7, 0), segments: [] },
    ];
    await store.ingest(next);
    const range = await store.loadRange(key(8), key(8));
    expect(range.sleep.map((x) => x.startMs).sort()).toEqual([at(8, 22, 0), at(9, 0, 30)]);
  });

  it('noches distintas, sin solape, conviven', async () => {
    await store.ingest(rows());
    const next = emptyRows();
    next.sleep = [{ startMs: at(9, 23), endMs: at(10, 7), segments: [{ stage: 'light', startMs: at(9, 23), durationSec: 8 * 3600 }] }];
    await store.ingest(next);
    expect((await store.loadRange(key(8), key(10))).sleep).toHaveLength(2);
  });
});

describe('ingest: sueño (qué sustituye a qué)', () => {
  const night = (startMs: number, endMs: number) => ({ startMs, endMs, segments: [{ stage: 'light' as const, startMs, durationSec: (endMs - startMs) / 1000 }] });
  const sleepOf = async (): Promise<Array<[number, number]>> => (await store.loadRange(key(8), key(10))).sleep.map((x) => [x.startMs, x.endMs] as [number, number]);

  it('dos sesiones del MISMO lote que se rozan un minuto se conservan las dos (no se sustituyen entre sí)', async () => {
    await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 3) + 60_000), night(at(9, 3), at(9, 7))] });
    expect(await sleepOf()).toEqual([
      [at(8, 23), at(9, 3) + 60_000],
      [at(9, 3), at(9, 7)],
    ]);
  });

  it('una sesión corta al final de una noche guardada no se la lleva por delante', async () => {
    await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 7))] });
    await store.ingest({ ...emptyRows(), sleep: [night(at(9, 6, 55), at(9, 7, 40))] }); // 5 min de solape con 8 h
    expect(await sleepOf()).toHaveLength(2);
  });

  it('una noche parcial se completa: la sesión que crece con el mismo inicio sustituye a la anterior', async () => {
    await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 3))] });
    const result = await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 7))] });
    expect(await sleepOf()).toEqual([[at(8, 23), at(9, 7)]]);
    expect(result.updated.sleep).toBe(1);
  });

  it('si el anillo parte una noche guardada en dos sesiones, las dos nuevas sustituyen a la vieja (no se cuenta tres veces)', async () => {
    await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 7))] });
    const result = await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 3)), night(at(9, 4), at(9, 7))] });
    expect(await sleepOf()).toEqual([
      [at(8, 23), at(9, 3)],
      [at(9, 4), at(9, 7)],
    ]);
    expect(result.added.sleep + result.updated.sleep).toBe(2);
  });

  it('un lote que solo describe una hora dentro de una noche guardada NO la borra', async () => {
    await store.ingest({ ...emptyRows(), sleep: [night(at(8, 23), at(9, 7))] });
    await store.ingest({ ...emptyRows(), sleep: [night(at(9, 2), at(9, 3))] });
    expect((await sleepOf()).some(([a, b]) => a === at(8, 23) && b === at(9, 7))).toBe(true);
  });
});

describe('ingest: medidas puntuales de la app y su copia en el historial del anillo', () => {
  it('la lectura del anillo a menos de 90 s sustituye a la medida puntual de la app (no quedan dos filas)', async () => {
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 0) + 35_000, bpm: 74, source: 'ring-spot' }] });
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 0), bpm: 74, source: 'ring-auto' }] });
    const rows = (await store.loadRange(key(9), key(9))).heart;
    expect(rows).toEqual([{ tsMs: at(9, 10, 0), bpm: 74, source: 'ring-auto' }]);
  });

  it('una lectura automática lejana no toca la medida puntual', async () => {
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 0), bpm: 74, source: 'ring-spot' }] });
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 5), bpm: 70, source: 'ring-auto' }] });
    expect((await store.loadRange(key(9), key(9))).heart).toHaveLength(2);
  });

  it('las lecturas durante un entreno no se confunden con medidas puntuales', async () => {
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 0), bpm: 120, source: 'workout' }] });
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 10, 0, ) + 30_000, bpm: 70, source: 'ring-auto' }] });
    expect((await store.loadRange(key(9), key(9))).heart).toHaveLength(2);
  });
});

describe('loadRange', () => {
  it('devuelve solo el rango pedido, con margen para tramos y sueño que cruzan la medianoche', async () => {
    await store.ingest({
      ...emptyRows(),
      heart: [
        { tsMs: at(8, 23), bpm: 60, source: 'ring-auto' },
        { tsMs: at(9, 10), bpm: 70, source: 'ring-auto' },
        { tsMs: at(10, 0), bpm: 65, source: 'ring-auto' },
      ],
      buckets: [
        { startMs: at(8, 23, 30), endMs: at(9, 0, 30), steps: 600, ringDistanceM: 0, ringCalories: 0 },
        { startMs: at(9, 12), endMs: at(9, 13), steps: 800, ringDistanceM: 0, ringCalories: 0 },
      ],
    });
    const range = await store.loadRange(key(9), key(9));
    expect(range.heart.map((h) => h.bpm)).toEqual([70]);
    expect(range.buckets).toHaveLength(2); // incluye el que empezó la víspera
  });
});

describe('loadRange: sueño que el anillo no guardó', () => {
  // Diez días con el pulso cada hora (dormido de 23:00 a 07:00) y pasos en cada hora despierta, pero ninguna noche del anillo.
  const tenDays = (): IngestRows => {
    const rows = emptyRows();
    for (let day = 1; day <= 10; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const asleep = hour >= 23 || hour < 7;
        rows.heart.push({ tsMs: at(day, hour), bpm: asleep ? 54 + (hour % 3) : 72 + (hour % 5) * 3, source: 'ring-auto' });
        if (!asleep) rows.buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 150, ringDistanceM: 100, ringCalories: 6 });
      }
    }
    return rows;
  };

  /** Una sincronización que pidió el historial de sueño al anillo (y volvió con las manos vacías, como el R99 fuera de su franja nocturna). */
  const asked = (tsMs: number, status = 'empty'): Promise<void> =>
    store.addSync({
      tsMs,
      ringName: 'R99',
      firmware: null,
      batteryPercent: null,
      durationMs: 1,
      interrupted: false,
      outcomes: [{ type: 'sleep', status, bytes: 0, ms: 5 }],
      added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 },
      dropped: {},
      liveSteps: null,
    });

  it('la noche aparece estimada (y marcada) en el día en que despierta, sin guardarse', async () => {
    await store.ingest(tenDays());
    await asked(at(10, 12));
    const range = await store.loadRange(key(8), key(8));
    const estimated = range.sleep.filter((s) => s.estimated === true);
    expect(estimated.length).toBeGreaterThanOrEqual(1);
    const night = estimated.find((s) => s.endMs > at(8, 0) && s.endMs < at(8, 12));
    expect(night).toBeDefined();
    expect(night?.segments).toEqual([]);
    // No se guardó: el almacén de sueño sigue vacío, y una copia de seguridad no la lleva.
    expect(await store.stats().then((s) => s.counts.sleep)).toBe(0);
    expect((await store.exportAll()).data.sleep).toEqual([]);
  });

  it('si el anillo sí dio esa noche, manda la suya y no se añade otra', async () => {
    const rows = tenDays();
    rows.sleep.push({ startMs: at(7, 23, 5), endMs: at(8, 7, 0), segments: [{ stage: 'light', startMs: at(7, 23, 5), durationSec: 7 * 3600 }] });
    await store.ingest(rows);
    await asked(at(10, 12));
    const range = await store.loadRange(key(8), key(8));
    expect(range.sleep.filter((s) => s.endMs > at(8, 0) && s.endMs < at(8, 12))).toHaveLength(1);
    expect(range.sleep.some((s) => s.estimated === true && s.endMs > at(8, 0) && s.endMs < at(8, 12))).toBe(false);
  });
});

describe('loadRange: el sueño estimado va después de pedírselo al anillo', () => {
  const tenDays = (): IngestRows => {
    const rows = emptyRows();
    for (let day = 1; day <= 10; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const asleep = hour >= 23 || hour < 7;
        rows.heart.push({ tsMs: at(day, hour), bpm: asleep ? 54 + (hour % 3) : 72 + (hour % 5) * 3, source: 'ring-auto' });
        if (!asleep) rows.buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 150, ringDistanceM: 100, ringCalories: 6 });
      }
    }
    return rows;
  };
  const sync = (tsMs: number, outcomes: Array<{ type: string; status: string }>, extra: { error?: string; interrupted?: boolean } = {}) =>
    store.addSync({
      tsMs,
      ringName: 'R99',
      firmware: null,
      batteryPercent: null,
      durationMs: 1,
      interrupted: extra.interrupted ?? false,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      outcomes: outcomes.map((o) => ({ ...o, bytes: 0, ms: 5 })),
      added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 },
      dropped: {},
      liveSteps: null,
    });
  const estimatedOn = async (day: number): Promise<boolean> => (await store.loadRange(key(day), key(day))).sleep.some((s) => s.estimated === true && s.endMs > at(day, 0) && s.endMs < at(day, 12));

  it('sin ninguna sincronización no se estima nada: el anillo aún no ha tenido ocasión de dar la noche', async () => {
    await store.ingest(tenDays());
    expect(await estimatedOn(8)).toBe(false);
  });

  it('una sincronización que no pidió el sueño (la ligera, o un fallo antes de llegar) no cuenta', async () => {
    await store.ingest(tenDays());
    await sync(at(8, 12), [{ type: 'sport', status: 'ok' }, { type: 'heart', status: 'ok' }]);
    await sync(at(9, 12), [], { error: 'sin conexión' });
    expect(await estimatedOn(8)).toBe(false);
  });

  it('la noche se estima en cuanto una sincronización posterior a ella pidió el sueño y volvió vacía (o con fallo)', async () => {
    await store.ingest(tenDays());
    await sync(at(8, 6), [{ type: 'sleep', status: 'empty' }]); // antes de despertar: no vale para esa noche
    expect(await estimatedOn(8)).toBe(false);
    await sync(at(8, 9), [{ type: 'sleep', status: 'empty' }]);
    expect(await estimatedOn(8)).toBe(true);
  });

  it('si el sueño se pidió pero el anillo no contestó (tiempo agotado), también vale: la forma normal no funcionó', async () => {
    await store.ingest(tenDays());
    await sync(at(8, 9), [{ type: 'sleep', status: 'timeout' }]);
    expect(await estimatedOn(8)).toBe(true);
  });
});

describe('loadRange: las noches SIN anillo se estiman con los huecos de actividad', () => {
  /** Diez días con el anillo puesto solo de día: pulso y pasos de 09:00 a 22:30, y nada de noche (lo deja en la mesa). */
  const ringOnlyByDay = (): IngestRows => {
    const rows = emptyRows();
    for (let day = 1; day <= 10; day++) {
      for (let hour = 9; hour <= 22; hour++) {
        rows.heart.push({ tsMs: at(day, hour), bpm: 70 + (hour % 4) * 3, source: 'ring-auto' });
        rows.buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 150, ringDistanceM: 100, ringCalories: 6 });
      }
    }
    return rows;
  };
  const sync = (tsMs: number, outcomes: Array<{ type: string; status: string }>) =>
    store.addSync({ tsMs, ringName: 'R99', firmware: null, batteryPercent: null, durationMs: 1, interrupted: false, outcomes: outcomes.map((o) => ({ ...o, bytes: 0, ms: 5 })), added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 }, dropped: {}, liveSteps: null });
  const nightOf = async (day: number) => (await store.loadRange(key(day), key(day))).sleep.filter((n) => n.estimated === true && n.endMs > at(day, 0) && n.endMs < at(day, 12));

  it('el anillo no estuvo de noche: la noche sale entre la última actividad de la tarde y la primera de la mañana, marcada como estimada y sin guardarse', async () => {
    await store.ingest(ringOnlyByDay());
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'empty' }]);
    const [night, ...rest] = await nightOf(8);
    expect(rest).toEqual([]);
    expect(night?.segments).toEqual([]);
    // Lo último de la tarde del 7 acaba a las 22:35 y lo primero de la mañana del 8 es la sincronización de las 09:10 (el primer tramo de pasos es de las 09:05).
    expect(night!.startMs).toBeGreaterThanOrEqual(at(7, 23, 0));
    expect(night!.startMs).toBeLessThanOrEqual(at(8, 1, 0));
    expect(night!.endMs).toBeGreaterThan(at(8, 8, 30));
    expect(night!.endMs).toBeLessThanOrEqual(at(8, 9, 5));
    // No se guardó nada: en el almacén de sueño sigue sin haber ninguna sesión.
    expect((await store.stats()).counts.sleep).toBe(0);
  });

  it('hasta que al anillo no se le pide el sueño no se estima (puede que aún lo dé)', async () => {
    await store.ingest(ringOnlyByDay());
    expect(await nightOf(8)).toEqual([]);
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'empty' }]);
    expect((await nightOf(8)).length).toBe(1);
  });

  it('una noche que el anillo SÍ dio manda: no se estima otra encima', async () => {
    await store.ingest({ ...ringOnlyByDay(), sleep: [{ startMs: at(7, 23, 30), endMs: at(8, 7, 30), segments: [{ stage: 'light', startMs: at(7, 23, 30), durationSec: 8 * 3600 }] }] });
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'ok' }]);
    expect(await nightOf(8)).toEqual([]);
  });

  it('con el anillo puesto de noche no salen dos estimaciones: la del pulso y los pasos manda', async () => {
    const rows = emptyRows();
    for (let day = 1; day <= 10; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const asleep = hour >= 23 || hour < 7;
        rows.heart.push({ tsMs: at(day, hour), bpm: asleep ? 54 + (hour % 3) : 72 + (hour % 5) * 3, source: 'ring-auto' });
        if (!asleep) rows.buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 150, ringDistanceM: 100, ringCalories: 6 });
      }
    }
    await store.ingest(rows);
    await sync(at(8, 9), [{ type: 'sleep', status: 'empty' }]);
    expect((await nightOf(8)).length).toBe(1);
  });

  it('una comida pasada a otro día no cuenta como actividad a la hora a la que se anotó', async () => {
    await store.ingest(ringOnlyByDay());
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'empty' }]);
    // Anotada a las 02:00 pero para el día anterior: no dice que la persona estuviera despierta a esa hora.
    await store.putMeal({ id: 'late', tsMs: at(8, 2, 0), name: 'Cena olvidada', kcal: 500, source: 'manual', day: key(7) });
    expect((await nightOf(8)).length).toBe(1);
    // Una anotada de verdad a las 03:50 es un despertar dentro de la noche: sigue siendo una sola noche (no se parte en dos).
    await store.putMeal({ id: 'awake', tsMs: at(8, 3, 50), name: 'Vaso de leche', kcal: 100, source: 'manual' });
    expect((await nightOf(8)).length).toBe(1);
    // Con otra a las 06:30 la noche queda partida en tres trozos cortos (menos de las horas de silencio que hacen falta): no hay noche que estimar.
    await store.putMeal({ id: 'early', tsMs: at(8, 6, 30), name: 'Café', kcal: 5, source: 'manual' });
    expect(await nightOf(8)).toEqual([]);
  });
});

describe('loadRange: las noches SIN anillo de noche se estiman con el uso del móvil (de punta a punta, con el almacén)', () => {
  /** El anillo solo de día (pulso y pasos de 09:00 a 22:30). */
  const ringOnlyByDay = (): IngestRows => {
    const rows = emptyRows();
    for (let day = 1; day <= 10; day++) {
      for (let hour = 9; hour <= 22; hour++) {
        rows.heart.push({ tsMs: at(day, hour), bpm: 70 + (hour % 4) * 3, source: 'ring-auto' });
        rows.buckets.push({ startMs: at(day, hour, 5), endMs: at(day, hour, 35), steps: 150, ringDistanceM: 100, ringCalories: 6 });
      }
    }
    return rows;
  };
  /** Un móvil usado cada ~40 min de 07:30 a 23:30, quieto de noche; lo leído, del día 1 a las 23:59 del 10. */
  const phoneLife = async (opts: { dense?: boolean; coverageTo?: number } = {}): Promise<void> => {
    const uses: Array<{ startMs: number; endMs: number }> = [];
    for (let day = 1; day <= 10; day++) {
      for (let t = at(day, 7, 30); t < at(day, 23, 30); t += 40 * 60_000) uses.push({ startMs: t, endMs: t + 2 * 60_000 });
      if (opts.dense) uses.push({ startMs: at(day, 0, 20), endMs: at(day, 6, 40) }); // tuvo el móvil en uso casi toda la noche
    }
    await store.addPhoneActivity({ uses, coverage: [{ startMs: at(1, 0), endMs: opts.coverageTo ?? at(10, 23, 59) }] });
  };
  const nightOf = async (day: number) => (await store.loadRange(key(day), key(day))).sleep.filter((n) => n.estimated === true && n.endMs > at(day, 0) && n.endMs < at(day, 12));
  const sync = (tsMs: number, outcomes: Array<{ type: string; status: string }>) =>
    store.addSync({ tsMs, ringName: 'R99', firmware: null, batteryPercent: null, durationMs: 1, interrupted: false, outcomes: outcomes.map((o) => ({ ...o, bytes: 0, ms: 5 })), added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 }, dropped: {}, liveSteps: null });

  it('sale la noche entre el último uso y el primero aunque el anillo no se haya sincronizado nunca', async () => {
    await store.ingest(ringOnlyByDay());
    await phoneLife();
    const [night, ...rest] = await nightOf(8);
    expect(rest).toEqual([]);
    expect(night).toBeDefined();
    expect(night!.segments).toEqual([]);
    // Último uso del día 7: 22:50–22:52 (+15 min para dormirse); primero del 8: 07:30 (−8 min).
    expect(night!.startMs).toBeGreaterThanOrEqual(at(7, 23, 0));
    expect(night!.startMs).toBeLessThanOrEqual(at(8, 0, 10));
    expect(night!.endMs).toBeGreaterThanOrEqual(at(8, 7, 10));
    expect(night!.endMs).toBeLessThanOrEqual(at(8, 7, 31));
  });

  it('con una sincronización posterior que no trae el sueño pasa lo mismo, y no se guarda nada', async () => {
    await store.ingest(ringOnlyByDay());
    await phoneLife();
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'empty' }]);
    expect((await nightOf(8)).length).toBe(1);
    expect((await store.stats()).counts.sleep).toBe(0);
  });

  it('la noche que acaba de terminar sale ya (la lectura llega a los pocos minutos del primer uso)', async () => {
    await store.ingest(ringOnlyByDay());
    await phoneLife({ coverageTo: at(8, 7, 34) });
    expect((await nightOf(8)).length).toBe(1);
  });

  it('una noche que el anillo SÍ dio manda sobre la del móvil', async () => {
    await store.ingest({ ...ringOnlyByDay(), sleep: [{ startMs: at(7, 23, 30), endMs: at(8, 7, 30), segments: [{ stage: 'light', startMs: at(7, 23, 30), durationSec: 8 * 3600 }] }] });
    await phoneLife();
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'ok' }]);
    expect(await nightOf(8)).toEqual([]);
  });

  it('si el móvil estuvo en uso casi toda la noche, no se inventa una noche con los huecos del anillo', async () => {
    await store.ingest(ringOnlyByDay());
    await sync(at(8, 9, 10), [{ type: 'sleep', status: 'empty' }]);
    await phoneLife({ dense: true });
    expect(await nightOf(8)).toEqual([]);
  });
});

describe('loadRange: entrenos que cruzan la medianoche', () => {
  it('un entreno que empezó el día anterior y sigue dentro del rango sale aparte, sin contarse como del rango', async () => {
    await store.putWorkout({ id: 'late', sport: 'run', startMs: at(9, 23, 30), endMs: at(10, 0, 30), pausedMs: 0, source: 'manual', distanceM: 8000, distanceSource: 'manual' });
    await store.putWorkout({ id: 'done', sport: 'run', startMs: at(9, 18), endMs: at(9, 19), pausedMs: 0, source: 'manual' });
    const range = await store.loadRange(key(10), key(10));
    expect(range.workouts).toEqual([]);
    expect(range.carryWorkouts?.map((w) => w.id)).toEqual(['late']); // 'done' terminó antes de medianoche
  });
});

describe('loadWindow: un intervalo cualquiera (no solo un día de calendario)', () => {
  it('trae lo que cae entre las 08:00 de un día y las 08:00 del siguiente, y aparte lo que empezó antes y sigue dentro', async () => {
    await store.ingest({
      ...emptyRows(),
      buckets: [
        { startMs: at(9, 2), endMs: at(9, 2, 30), steps: 100, ringDistanceM: 70, ringCalories: 5 }, // de antes
        { startMs: at(9, 12), endMs: at(9, 12, 30), steps: 200, ringDistanceM: 140, ringCalories: 10 },
        { startMs: at(10, 3), endMs: at(10, 3, 30), steps: 300, ringDistanceM: 210, ringCalories: 15 },
      ],
      counters: [
        { tsMs: at(9, 6), steps: 50 },
        { tsMs: at(9, 20), steps: 5000 },
        { tsMs: at(10, 4), steps: 400 },
        { tsMs: at(10, 9), steps: 900 },
      ],
      heart: [{ tsMs: at(9, 7), bpm: 60, source: 'ring-auto' }, { tsMs: at(10, 7), bpm: 62, source: 'ring-auto' }],
    });
    await store.putWorkout({ id: 'cruza', sport: 'run', startMs: at(9, 7, 30), endMs: at(9, 8, 30), pausedMs: 0, source: 'manual' });
    await store.putWorkout({ id: 'dentro', sport: 'run', startMs: at(10, 2), endMs: at(10, 3), pausedMs: 0, source: 'manual' });
    await store.putMeal({ id: 'm1', tsMs: at(10, 2), name: 'Zanahorias', kcal: 60, source: 'manual' });
    await store.putMeal({ id: 'm0', tsMs: at(9, 2), name: 'Antes', kcal: 90, source: 'manual' });

    const window = await store.loadWindow(at(9, 8), at(10, 8));
    expect(window.counters.map((c) => c.steps)).toEqual([5000, 400]);
    expect(window.heart.map((h) => h.bpm)).toEqual([62]);
    expect(window.workouts.map((w) => w.id)).toEqual(['dentro']);
    expect(window.carryWorkouts?.map((w) => w.id)).toEqual(['cruza']);
    expect(window.meals?.map((m) => m.id)).toEqual(['m1']);
    // Los tramos traen un día de margen por detrás: el resumen los recorta él.
    expect(window.buckets.map((b) => b.steps)).toEqual(expect.arrayContaining([200, 300]));
    // loadRange sigue siendo lo mismo que un día de calendario.
    const day = await store.loadRange(key(9), key(9));
    const same = await store.loadWindow(at(9, 0), at(10, 0));
    expect(day).toEqual(same);
  });
});

describe('perfil, entrenamientos y ajustes', () => {
  const entry = (date: string, weightKg: number): ProfileEntry => ({ date, heightCm: 178, weightKg, sex: 'male', birthDate: '1985-06-15' });

  it('el historial de perfil se devuelve ordenado y se puede corregir una fecha pasada', async () => {
    await store.putProfileEntry(entry('2026-06-10', 77));
    await store.putProfileEntry(entry('2026-01-01', 82));
    await store.putProfileEntry(entry('2026-06-10', 78)); // corrección
    expect((await store.getProfileHistory()).map((e) => [e.date, e.weightKg])).toEqual([['2026-01-01', 82], ['2026-06-10', 78]]);
  });

  const workout = (id: string, startMs: number): WorkoutRecord => ({ id, sport: 'gym', startMs, endMs: startMs + 3_600_000, pausedMs: 0, source: 'manual' });

  it('entrenamientos: alta, lectura, rango, recientes y baja', async () => {
    await store.putWorkout(workout('a', at(5, 18)));
    await store.putWorkout(workout('b', at(7, 18)));
    await store.putWorkout(workout('c', at(9, 18)));
    expect((await store.listWorkouts(at(6, 0), at(10, 0))).map((w) => w.id)).toEqual(['b', 'c']);
    expect((await store.recentWorkouts(2)).map((w) => w.id)).toEqual(['c', 'b']);
    expect((await store.getWorkout('a'))?.sport).toBe('gym');
    await store.deleteWorkout('a');
    expect(await store.getWorkout('a')).toBeNull();
  });

  it('ajustes: valores por defecto y actualización parcial', async () => {
    expect(await store.getSettings()).toMatchObject({ stepGoal: 8000, heartIntervalMin: 60, lastBackupMs: null });
    await store.setSettings({ stepGoal: 10_000 });
    expect(await store.getSettings()).toMatchObject({ stepGoal: 10_000, sleepGoalH: 8 });
  });

  it('anillo vinculado: guardar y olvidar', async () => {
    expect(await store.getRing()).toBeNull();
    await store.setRing({ id: 'abc', name: 'R99 F265' });
    expect(await store.getRing()).toEqual({ id: 'abc', name: 'R99 F265' });
    await store.setRing(null);
    expect(await store.getRing()).toBeNull();
  });
});

describe('sincronizaciones', () => {
  const sync = (tsMs: number, over: Partial<SyncRecord> = {}): SyncRecord => ({
    tsMs,
    ringName: 'R99 F265',
    firmware: '2.32',
    batteryPercent: 80,
    durationMs: 9000,
    interrupted: false,
    outcomes: [],
    added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 },
    dropped: {},
    liveSteps: null,
    log: 'traza',
    ...over,
  });

  it('solo las últimas conservan la traza y se limita el total', async () => {
    for (let i = 0; i < 70; i++) await store.addSync(sync(1000 + i));
    const all = await store.listSyncs(100);
    expect(all).toHaveLength(60);
    expect(all.filter((s) => s.log !== undefined)).toHaveLength(5);
    expect(all[0]?.tsMs).toBe(1069);
  });

  it('la última sincronización correcta ignora fallos e interrupciones', async () => {
    await store.addSync(sync(1000));
    await store.addSync(sync(2000, { error: 'fallo' }));
    await store.addSync(sync(3000, { interrupted: true }));
    expect((await store.lastSuccessfulSync())?.tsMs).toBe(1000);
  });
});

describe('copia de seguridad', () => {
  async function seed(): Promise<void> {
    await store.putProfileEntry({ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' });
    await store.putWorkout({ id: 'w', sport: 'run', startMs: at(9, 7), endMs: at(9, 8), pausedMs: 0, source: 'manual', distanceM: 8000, distanceSource: 'manual' });
    await store.setSettings({ stepGoal: 9000 });
    await store.ingest({
      ...emptyRows(),
      heart: [{ tsMs: at(9, 12), bpm: 70, source: 'ring-auto' }],
      sleep: [{ startMs: at(8, 23), endMs: at(9, 7), segments: [{ stage: 'deep', startMs: at(8, 23), durationSec: 3600 }] }],
    });
  }

  it('exportar → borrar → importar restituye todo', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.wipe();
    expect((await store.stats()).counts).toMatchObject({ heart: 0, workouts: 0, profile: 0 });
    const { imported } = await store.importAll(backup, 'replace');
    expect(imported).toMatchObject({ heart: 1, sleep: 1, workouts: 1, profile: 1 });
    expect((await store.getSettings()).stepGoal).toBe(9000);
    expect((await store.getWorkout('w'))?.distanceM).toBe(8000);
  });

  it('un archivo inválido se rechaza SIN borrar nada, ni siquiera en modo reemplazar', async () => {
    await seed();
    await expect(store.importAll({ format: 'otra-cosa' }, 'replace')).rejects.toBeInstanceOf(BackupError);
    await expect(store.importAll({ format: 'smartring-backup', version: 1, data: { heart: [{ tsMs: 'x' }] } }, 'replace')).rejects.toBeInstanceOf(BackupError);
    expect((await store.stats()).counts.heart).toBe(1);
    expect(await store.getProfileHistory()).toHaveLength(1);
  });

  it('fusionar añade sin borrar lo existente', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 18), bpm: 80, source: 'ring-auto' }] });
    await store.importAll(backup, 'merge');
    expect((await store.stats()).counts.heart).toBe(2);
  });

  it('«reemplazar» es atómico: si la escritura falla a mitad (p. ej. sin cuota), los datos anteriores siguen intactos', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    backup.data.profile = [{ date: '2026-02-01', heightCm: 170, weightKg: 60, sex: 'female', birthDate: '1990-01-01' }];
    // La copia es válida, pero a la segunda escritura el almacén se queda sin espacio: ocurre DESPUÉS de haberlo vaciado todo.
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (++writes === 2) throw new DOMException('Sin espacio', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try {
      await expect(store.importAll(backup, 'replace')).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toBeGreaterThanOrEqual(2); // la escritura falló de verdad, a mitad
    expect((await store.stats()).counts).toMatchObject({ heart: 1, workouts: 1, profile: 1, sleep: 1 });
    expect((await store.getProfileHistory())[0]?.weightKg).toBe(80); // el perfil de la copia NO llegó a entrar
    expect((await store.getSettings()).stepGoal).toBe(9000);
  });

  it('«reemplazar» no olvida el anillo vinculado (no forma parte de la copia)', async () => {
    await seed();
    await store.setRing({ id: 'r1', name: 'R99 F265' });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.importAll(backup, 'replace');
    expect(await store.getRing()).toEqual({ id: 'r1', name: 'R99 F265' });
  });

  it('«reemplazar» con una copia incompleta (data: {}) se rechaza y no vacía nada', async () => {
    await seed();
    await expect(store.importAll({ format: 'smartring-backup', version: 1, data: {} }, 'replace')).rejects.toThrow(/incompleta/);
    const noSleep = JSON.parse(JSON.stringify(await store.exportAll()));
    delete noSleep.data.sleep;
    await expect(store.importAll(noSleep, 'replace')).rejects.toThrow(/falta: sueño/);
    expect((await store.stats()).counts).toMatchObject({ heart: 1, workouts: 1, profile: 1, sleep: 1 });
    // Combinar una copia así sí se admite: solo añade lo que trae.
    await expect(store.importAll({ format: 'smartring-backup', version: 1, data: {} }, 'merge')).resolves.toBeTruthy();
    expect((await store.stats()).counts.heart).toBe(1);
  });

  it('«combinar» no toca los ajustes actuales ni crea una noche duplicada con otros límites', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.setSettings({ stepGoal: 12_000, sleepGoalH: 7, heartIntervalMin: 120 });
    // La misma noche con límites afinados que ya hay guardada.
    await store.ingest({ ...emptyRows(), sleep: [{ startMs: at(8, 23, 4), endMs: at(9, 7, 2), segments: [{ stage: 'deep', startMs: at(8, 23, 4), durationSec: 3600 }] }] });
    await store.importAll(backup, 'merge');
    expect(await store.getSettings()).toMatchObject({ stepGoal: 12_000, sleepGoalH: 7, heartIntervalMin: 120 });
    expect((await store.loadRange(key(9), key(9))).sleep).toHaveLength(1);
  });

  it('una copia sin apartado de ajustes, al reemplazar, deja los ajustes de fábrica', async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    delete backup.data.settings;
    await store.importAll(backup, 'replace');
    // Sin ajustes en la copia, tras vaciar quedan los de fábrica (no los que había).
    expect((await store.getSettings()).stepGoal).toBe(8000);
  });

  it('las trazas BLE no viajan en la copia', async () => {
    await store.addSync({ tsMs: 5, ringName: 'x', firmware: null, batteryPercent: null, durationMs: 1, interrupted: false, outcomes: [], added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 }, dropped: {}, liveSteps: null, log: 'secreto' });
    const backup = await store.exportAll();
    expect(JSON.stringify(backup)).not.toContain('secreto');
  });
});

describe('stats', () => {
  it('el primer dato de cualquier tipo, y cuántos hay de cada uno', async () => {
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(3, 8), bpm: 60, source: 'ring-auto' }, { tsMs: at(9, 8), bpm: 62, source: 'ring-auto' }], counters: [{ tsMs: at(12, 8), steps: 10 }] });
    const stats = await store.stats();
    expect(stats.firstDataMs).toBe(at(3, 8));
    expect(stats.counts).toMatchObject({ heart: 2, counters: 1 });
  });
});

describe('latestData', () => {
  it('sin nada guardado no hay ninguna fecha', async () => {
    expect(await store.latestData()).toEqual({ heartMs: null, spo2Ms: null, activityMs: null, sleepEndMs: null });
  });

  it('lo más reciente de cada tipo: pulso, oxígeno, actividad (franja o contador) y final de la última noche', async () => {
    await store.ingest({
      ...emptyRows(),
      heart: [{ tsMs: at(9, 3), bpm: 55, source: 'ring-auto' }, { tsMs: at(9, 12), bpm: 74, source: 'ring-auto' }],
      spo2: [{ tsMs: at(9, 4), percent: 96 }],
      buckets: [{ startMs: at(9, 8), endMs: at(9, 8, 15), steps: 1200, ringDistanceM: 900, ringCalories: 700 }],
      counters: [{ tsMs: at(9, 20), steps: 7000 }],
      sleep: [
        { startMs: at(8, 23), endMs: at(9, 7), segments: [{ stage: 'light', startMs: at(8, 23), durationSec: 8 * 3600 }] },
        { startMs: at(9, 14), endMs: at(9, 14, 40), segments: [{ stage: 'nap', startMs: at(9, 14), durationSec: 40 * 60 }] },
      ],
    });
    expect(await store.latestData()).toEqual({ heartMs: at(9, 12), spo2Ms: at(9, 4), activityMs: at(9, 20), sleepEndMs: at(9, 14, 40) });
  });

  it('un tipo sin datos queda en null aunque haya de los demás', async () => {
    await store.ingest({ ...emptyRows(), heart: [{ tsMs: at(9, 12), bpm: 74, source: 'ring-spot' }] });
    expect(await store.latestData()).toEqual({ heartMs: at(9, 12), spo2Ms: null, activityMs: null, sleepEndMs: null });
  });
});

describe('comidas', () => {
  const meal = (id: string, tsMs: number, kcal = 500, patch: Partial<MealEntry> = {}): MealEntry => ({ id, tsMs, name: `Comida ${id}`, kcal, source: 'manual', ...patch });

  it('alta, lectura por rango (de la más antigua a la más reciente) y baja', async () => {
    await store.putMeal(meal('b', at(9, 14)));
    await store.putMeal(meal('a', at(9, 9), 300, { proteinG: 12, carbsG: 40, fatG: 8 }));
    await store.putMeal(meal('c', at(10, 9)));
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['a', 'b']);
    // Corregir una comida (misma id) la sustituye, no la duplica.
    await store.putMeal(meal('a', at(9, 9), 350));
    const day = await store.listMeals(at(9, 0), at(10, 0));
    expect(day.map((m) => m.id)).toEqual(['a', 'b']);
    expect(day.find((m) => m.id === 'a')?.kcal).toBe(350);
    await store.deleteMeal({ id: 'b', tsMs: at(9, 14) });
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['a']);
    await store.deleteMeal({ id: 'a', tsMs: at(9, 9) });
    expect(await store.listMeals(at(9, 0), at(10, 0))).toEqual([]);
    await store.deleteMeal({ id: 'no-existe', tsMs: at(9, 9) }); // borrar lo que no hay no falla
  });

  it('borrar una comida funciona aunque la zona horaria sea otra que cuando se anotó (viaje): se mira también el día anterior y el siguiente', async () => {
    // Una cena a las 23:30 se agrupó en el día 9. Tras un viaje, «su día» según la zona de ahora sería el 10 (aquí, el mismo instante visto a las 00:30 del 10).
    const dinner = meal('cena', at(9, 23, 30));
    await store.putMeal(dinner);
    await store.deleteMeal({ id: 'cena', tsMs: at(10, 0, 30) }); // la hora de la comida vista desde otro día
    expect(await store.listMeals(at(9, 0), at(11, 0))).toEqual([]);
  });

  it('el rango es exclusivo por arriba: una comida a medianoche en punto es del día siguiente', async () => {
    await store.putMeal(meal('midnight', at(10, 0)));
    expect(await store.listMeals(at(9, 0), at(10, 0))).toEqual([]);
    expect((await store.listMeals(at(10, 0), at(11, 0))).map((m) => m.id)).toEqual(['midnight']);
  });

  it('lee un rango largo con muchas comidas de varios días, ordenadas', async () => {
    for (let d = 1; d <= 20; d++) {
      await store.putMeal(meal(`n${d}`, at(d, 21)));
      await store.putMeal(meal(`d${d}`, at(d, 9)));
    }
    const all = await store.listMeals(at(1, 0), at(21, 0));
    expect(all).toHaveLength(40);
    expect(all.map((m) => m.tsMs)).toEqual([...all.map((m) => m.tsMs)].sort((a, b) => a - b));
    expect((await store.listMeals(at(5, 0), at(7, 0))).map((m) => m.id)).toEqual(['d5', 'n5', 'd6', 'n6']);
  });

  it('loadRange trae las comidas del rango, y stats las cuenta', async () => {
    await store.putMeal(meal('a', at(9, 9)));
    await store.putMeal(meal('b', at(12, 9)));
    expect((await store.loadRange(key(9), key(9))).meals?.map((m) => m.id)).toEqual(['a']);
    expect((await store.stats()).counts.meals).toBe(2);
  });

  it('viajan en la copia de seguridad y se restituyen', async () => {
    await store.putMeal(meal('a', at(9, 9), 420, { proteinG: 30, barcode: '8410000000016', grams: 125, source: 'barcode' }));
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(backup.data.meals).toHaveLength(1);
    await store.wipe();
    expect(await store.listMeals(at(9, 0), at(10, 0))).toEqual([]);
    const { imported } = await store.importAll(backup, 'replace');
    expect(imported.meals).toBe(1);
    expect((await store.listMeals(at(9, 0), at(10, 0)))[0]).toMatchObject({ id: 'a', kcal: 420, proteinG: 30, barcode: '8410000000016', grams: 125, source: 'barcode' });
  });

  it('«combinar» suma las comidas de la copia a las que hay (la de la copia manda si es la misma) y «reemplazar» deja solo las de la copia', async () => {
    await store.putMeal(meal('a', at(9, 9), 420));
    await store.putMeal(meal('b', at(9, 14), 600));
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.putMeal(meal('a', at(9, 9), 111)); // cambia después de la copia
    await store.putMeal(meal('c', at(9, 20), 300)); // y se añade otra
    await store.importAll(backup, 'merge');
    const merged = await store.listMeals(at(9, 0), at(10, 0));
    expect(merged.map((m) => [m.id, m.kcal])).toEqual([['a', 420], ['b', 600], ['c', 300]]);
    await store.importAll(backup, 'replace');
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('el objetivo de salud es un ajuste más: se guarda y viaja en la copia', async () => {
    expect((await store.getSettings()).healthGoal).toBe('maintain');
    await store.setSettings({ healthGoal: 'muscle' });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.wipe();
    await store.importAll(backup, 'replace');
    expect((await store.getSettings()).healthGoal).toBe('muscle');
  });

  it('el peso objetivo complementa al objetivo de salud: empieza sin él, se guarda, viaja en la copia y se puede quitar', async () => {
    expect((await store.getSettings()).targetWeightKg).toBeNull();
    await store.setSettings({ healthGoal: 'lose', targetWeightKg: 74.5 });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.wipe();
    expect((await store.getSettings()).targetWeightKg).toBeNull();
    await store.importAll(backup, 'replace');
    expect(await store.getSettings()).toMatchObject({ healthGoal: 'lose', targetWeightKg: 74.5 });
    await store.setSettings({ targetWeightKg: null });
    expect((await store.getSettings()).targetWeightKg).toBeNull();
    expect((await store.getSettings()).healthGoal).toBe('lose'); // quitar el peso no toca el objetivo de salud
  });

  it('los datos del gráfico de Salud: empiezan con los cuatro de siempre, se guardan en el orden elegido, viajan en la copia y lo desconocido se limpia al leer', async () => {
    expect((await store.getSettings()).jointMetrics).toEqual(['steps', 'intake', 'water', 'weight']);
    await store.setSettings({ jointMetrics: ['weight', 'distance', 'salt', 'steps', 'fiber'] });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.wipe();
    expect((await store.getSettings()).jointMetrics).toEqual(['steps', 'intake', 'water', 'weight']);
    await store.importAll(backup, 'replace');
    expect((await store.getSettings()).jointMetrics).toEqual(['weight', 'distance', 'salt', 'steps', 'fiber']);
    await store.setSettings({ jointMetrics: [] });
    expect((await store.getSettings()).jointMetrics).toEqual([]); // ninguno es válido
    await store.setSettings({ jointMetrics: ['steps', 'inventado', 'steps', 'water'] as never });
    expect((await store.getSettings()).jointMetrics).toEqual(['steps', 'water']);
  });

  it('los indicadores del panel de Nutrición: empiezan con los cuatro de siempre, se guardan en el orden elegido, viajan en la copia y lo desconocido o de más se limpia al leer', async () => {
    expect((await store.getSettings()).nutritionPanel).toEqual(['protein', 'carbs', 'fat', 'salt']);
    await store.setSettings({ nutritionPanel: ['water', 'fiber', 'protein', 'sugars', 'salt', 'fat', 'carbs'] });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.wipe();
    expect((await store.getSettings()).nutritionPanel).toEqual(['protein', 'carbs', 'fat', 'salt']);
    await store.importAll(backup, 'replace');
    expect((await store.getSettings()).nutritionPanel).toEqual(['water', 'fiber', 'protein', 'sugars', 'salt', 'fat', 'carbs']);
    await store.setSettings({ nutritionPanel: [] });
    expect((await store.getSettings()).nutritionPanel).toEqual([]); // ninguno es válido
    await store.setSettings({ nutritionPanel: ['protein', 'inventado', 'protein', 'water'] as never });
    expect((await store.getSettings()).nutritionPanel).toEqual(['protein', 'water']);
  });

  it('un peso objetivo que no es un peso (un valor raro guardado) se lee como «sin peso objetivo»', async () => {
    for (const bad of [1e9, 0, -70, Number.NaN, 12]) {
      await store.setSettings({ targetWeightKg: bad });
      expect((await store.getSettings()).targetWeightKg, String(bad)).toBeNull();
    }
    await store.setSettings({ targetWeightKg: 72.5 });
    expect((await store.getSettings()).targetWeightKg).toBe(72.5);
  });
});

describe('el día al que cuenta una comida (se pasa al día anterior o al siguiente)', () => {
  const meal = (id: string, tsMs: number, patch: Partial<MealEntry> = {}): MealEntry => ({ id, tsMs, name: `Comida ${id}`, kcal: 500, source: 'manual', ...patch });
  const workout = (id: string, startMs: number, patch: Partial<WorkoutRecord> = {}): WorkoutRecord => ({ id, sport: 'run', startMs, endMs: startMs + 3_600_000, pausedMs: 0, source: 'manual', ...patch });

  it('una cena de después de medianoche pasada al día anterior sale en ese día y no en el que se comió', async () => {
    await store.putMeal(meal('cena', at(10, 0, 40), { day: key(9) }));
    await store.putMeal(meal('desayuno', at(10, 9)));
    expect((await store.listMealsByDay(key(9), key(9))).map((m) => m.id)).toEqual(['cena']);
    expect((await store.listMealsByDay(key(10), key(10))).map((m) => m.id)).toEqual(['desayuno']);
    expect((await store.listMealsByDay(key(9), key(10))).map((m) => m.id)).toEqual(['cena', 'desayuno']);
    // El instante no cambia: sigue en el grupo de su día real y se borra con su hora.
    expect((await store.listMeals(at(10, 0), at(11, 0))).map((m) => m.id)).toEqual(['cena', 'desayuno']);
    await store.deleteMeal({ id: 'cena', tsMs: at(10, 0, 40) });
    expect(await store.listMealsByDay(key(9), key(9))).toEqual([]);
  });

  it('volver a guardar la comida sin `day` la devuelve a su día', async () => {
    await store.putMeal(meal('cena', at(10, 0, 40), { day: key(9) }));
    await store.putMeal(meal('cena', at(10, 0, 40)));
    expect(await store.listMealsByDay(key(9), key(9))).toEqual([]);
    expect((await store.listMealsByDay(key(10), key(10))).map((m) => m.id)).toEqual(['cena']);
  });

  it('el resumen de un día (`loadWindow`) trae las comidas que cuentan para él, también las que se comieron otro día', async () => {
    await store.putMeal(meal('tarde', at(9, 23, 50), { day: key(10) })); // pasada al día siguiente
    await store.putMeal(meal('cena', at(10, 0, 40), { day: key(9) })); // pasada al anterior
    await store.putMeal(meal('normal', at(9, 13)));
    expect((await store.loadWindow(at(9, 0), at(10, 0))).meals?.map((m) => m.id)).toEqual(['normal', 'cena']);
    expect((await store.loadWindow(at(10, 0), at(11, 0))).meals?.map((m) => m.id)).toEqual(['tarde']);
  });

  it('un entreno ya no se pasa de día: el `day` que dejó una versión anterior no se guarda y cuenta el día en que ocurrió', async () => {
    await store.putWorkout({ ...workout('gimnasio', at(10, 0, 20)), day: key(9) } as WorkoutRecord);
    expect(await store.getWorkout('gimnasio')).not.toHaveProperty('day');
    expect((await store.loadWindow(at(10, 0), at(11, 0))).workouts.map((w) => w.id)).toEqual(['gimnasio']);
    expect((await store.loadWindow(at(9, 0), at(10, 0))).workouts).toEqual([]);
  });

  it('la copia de seguridad conserva el día al que cuenta una comida', async () => {
    await store.putMeal(meal('cena', at(10, 0, 40), { day: key(9) }));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    const other = await openIdbStore(`test-copia-${counter}`);
    await other.importAll(copy, 'replace');
    expect((await other.listMealsByDay(key(9), key(9))).map((m) => m.id)).toEqual(['cena']);
  });
});

describe('agua', () => {
  const sip = (id: string, tsMs: number, ml = 250): { id: string; tsMs: number; ml: number } => ({ id, tsMs, ml });

  it('alta, lectura por rango (de la más antigua a la más reciente), corrección y baja', async () => {
    await store.putWater(sip('b', at(9, 14)));
    await store.putWater(sip('a', at(9, 9), 500));
    await store.putWater(sip('c', at(10, 9)));
    expect((await store.listWater(at(9, 0), at(10, 0))).map((w) => w.id)).toEqual(['a', 'b']);
    // Volver a guardar la misma id la sustituye, no la duplica.
    await store.putWater(sip('a', at(9, 9), 300));
    expect((await store.listWater(at(9, 0), at(10, 0))).find((w) => w.id === 'a')?.ml).toBe(300);
    await store.deleteWater({ id: 'b', tsMs: at(9, 14) });
    expect((await store.listWater(at(9, 0), at(10, 0))).map((w) => w.id)).toEqual(['a']);
    await store.deleteWater({ id: 'no-existe', tsMs: at(9, 9) }); // borrar lo que no hay no falla
    await store.deleteWater({ id: 'a', tsMs: at(9, 9) });
    expect(await store.listWater(at(9, 0), at(10, 0))).toEqual([]);
  });

  it('el resumen de un día (`loadWindow`) trae su agua, y las estadísticas la cuentan', async () => {
    await store.putWater(sip('hoy', at(9, 12)));
    await store.putWater(sip('ayer', at(8, 12)));
    expect((await store.loadWindow(at(9, 0), at(10, 0))).water?.map((w) => w.id)).toEqual(['hoy']);
    expect((await store.stats()).counts.water).toBe(2);
  });

  it('la copia de seguridad la conserva, el combinar no la duplica y borrar todo la quita', async () => {
    await store.putWater(sip('a', at(9, 9), 330));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(copy.data.water).toEqual([sip('a', at(9, 9), 330)]);
    const other = await openIdbStore(`test-agua-${counter}`);
    await other.importAll(copy, 'replace');
    await other.importAll(copy, 'merge');
    expect(await other.listWater(at(9, 0), at(10, 0))).toEqual([sip('a', at(9, 9), 330)]);
    await other.wipe();
    expect(await other.listWater(at(1, 0), at(30, 0))).toEqual([]);
  });

  it('el agua no estropea las comidas ni el resto de lo guardado en `kv` (prefijos distintos)', async () => {
    await store.putMeal({ id: 'm', tsMs: at(9, 13), name: 'Comida', kcal: 500, source: 'manual' });
    await store.putWater(sip('w', at(9, 13)));
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['m']);
    expect((await store.listWater(at(9, 0), at(10, 0))).map((w) => w.id)).toEqual(['w']);
    expect((await store.stats()).counts).toMatchObject({ meals: 1, water: 1 });
  });
});

describe('platos guardados', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const dish = (id: string, over: Partial<SavedDish> = {}): SavedDish => ({
    id,
    name: `Plato ${id}`,
    createdMs: at(9, 10),
    updatedMs: at(9, 10),
    ingredients: [{ name: 'Arroz', kcal: 400, carbsG: 80, grams: 200 }],
    ...over,
  });

  it('alta, lectura (el último que se anotó primero), corrección y baja', async () => {
    await store.putDish(dish('a'));
    await store.putDish(dish('b', { createdMs: at(10, 10), photo: PHOTO }));
    await store.putDish(dish('c', { createdMs: at(8, 10), lastUsedMs: at(11, 10) }));
    expect((await store.listDishes()).map((d) => d.id)).toEqual(['c', 'b', 'a']);
    expect((await store.listDishes()).find((d) => d.id === 'b')?.photo).toBe(PHOTO);
    // Volver a guardar la misma id la sustituye, no la duplica.
    await store.putDish(dish('a', { name: 'Arroz con tomate' }));
    expect((await store.listDishes()).filter((d) => d.id === 'a')).toHaveLength(1);
    expect((await store.listDishes()).find((d) => d.id === 'a')?.name).toBe('Arroz con tomate');
    await store.deleteDish('b');
    await store.deleteDish('no-existe'); // borrar lo que no hay no falla
    expect((await store.listDishes()).map((d) => d.id)).toEqual(['c', 'a']);
  });

  it('la copia de seguridad los conserva con su foto, el combinar no los duplica y borrar todo los quita', async () => {
    await store.putDish(dish('a', { photo: PHOTO }));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(copy.data.dishes).toHaveLength(1);
    const other = await openIdbStore(`test-platos-${counter}`);
    await other.importAll(copy, 'replace');
    await other.importAll(copy, 'merge');
    expect(await other.listDishes()).toEqual([dish('a', { photo: PHOTO })]);
    expect((await other.stats()).counts.dishes).toBe(1);
    await other.wipe();
    expect(await other.listDishes()).toEqual([]);
  });

  it('un plato guardado con raciones (la versión anterior) se lee como una ración, en el almacén y en una copia', async () => {
    // Escrito como lo hacía la versión con raciones: los ingredientes sumaban para 2.
    await (store as unknown as { db: { put: (store: string, value: unknown, key: string) => Promise<unknown> } }).db.put('kv', { ...dish('viejo'), servings: 2 }, 'dish:viejo');
    expect((await store.listDishes())[0]).toEqual(dish('viejo', { ingredients: [{ name: 'Arroz', kcal: 200, carbsG: 40, grams: 100 }] }));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(copy.data.dishes[0]).not.toHaveProperty('servings');
    // Y una copia hecha entonces (con `servings`) se importa igual.
    const old = JSON.parse(JSON.stringify(copy));
    old.data.dishes = [{ ...dish('copia'), servings: 4 }];
    const other = await openIdbStore(`test-platos-viejos-${counter}`);
    await other.importAll(old, 'replace');
    expect((await other.listDishes())[0]).toEqual(dish('copia', { ingredients: [{ name: 'Arroz', kcal: 100, carbsG: 20, grams: 50 }] }));
  });

  it('una copia anterior a los platos (sin el apartado) se importa sin tocar los platos que ya hay al combinar', async () => {
    await store.putDish(dish('a'));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    delete copy.data.dishes;
    await store.importAll(copy, 'merge');
    expect((await store.listDishes()).map((d) => d.id)).toEqual(['a']);
  });

  it('los platos no estropean las comidas, el agua ni el resto de `kv` (prefijos distintos)', async () => {
    await store.putMeal({ id: 'm', tsMs: at(9, 13), name: 'Comida', kcal: 500, source: 'manual' });
    await store.putWater({ id: 'w', tsMs: at(9, 13), ml: 250 });
    await store.putDish(dish('a'));
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['m']);
    expect((await store.listWater(at(9, 0), at(10, 0))).map((w) => w.id)).toEqual(['w']);
    expect((await store.listDishes()).map((d) => d.id)).toEqual(['a']);
    expect((await store.stats()).counts).toMatchObject({ meals: 1, water: 1, dishes: 1 });
  });
});

describe('mis productos (los que la persona enseña con su etiqueta)', () => {
  const product = (barcode: string, over: Partial<UserProduct> = {}): UserProduct => ({
    barcode,
    name: `Producto ${barcode}`,
    per100g: { kcal: 400, proteinG: 8, carbsG: 60, fatG: 14, fiberG: 3, sugarsG: 20, saltG: 0.5 },
    servingG: 30,
    createdMs: at(9, 10),
    updatedMs: at(9, 10),
    ...over,
  });

  it('alta, lectura por código, corrección y baja; el último que se tocó va primero', async () => {
    await store.putProduct(product('8410000000016'));
    await store.putProduct(product('96385074', { updatedMs: at(10, 10) }));
    expect((await store.listProducts()).map((p) => p.barcode)).toEqual(['96385074', '8410000000016']);
    expect((await store.getProduct('8410000000016'))?.name).toBe('Producto 8410000000016');
    expect(await store.getProduct('5449000000996')).toBeNull();
    expect(await store.getProduct('hola')).toBeNull();
    await store.putProduct(product('8410000000016', { name: 'Galletas de la abuela', updatedMs: at(11, 10) }));
    expect((await store.listProducts()).filter((p) => p.barcode === '8410000000016')).toHaveLength(1);
    expect((await store.listProducts())[0]?.name).toBe('Galletas de la abuela');
    await store.deleteProduct('96385074');
    await store.deleteProduct('5449000000996'); // borrar lo que no hay no falla
    expect((await store.listProducts()).map((p) => p.barcode)).toEqual(['8410000000016']);
  });

  it('un UPC-A de 12 cifras y su EAN-13 con un cero delante son el mismo producto', async () => {
    await store.putProduct(product('036000291452'));
    expect((await store.getProduct('0036000291452'))?.barcode).toBe('036000291452');
    await store.putProduct(product('0036000291452', { name: 'Corregido' }));
    expect(await store.listProducts()).toHaveLength(1);
    expect((await store.getProduct('036000291452'))?.name).toBe('Corregido');
    await store.deleteProduct('0036000291452');
    expect(await store.listProducts()).toEqual([]);
  });

  it('la copia de seguridad los conserva, el combinar no los duplica y borrar todo los quita', async () => {
    await store.putProduct(product('8410000000016'));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(copy.data.products).toHaveLength(1);
    const other = await openIdbStore(`test-productos-${counter}`);
    await other.importAll(copy, 'replace');
    await other.importAll(copy, 'merge');
    expect(await other.listProducts()).toEqual([product('8410000000016')]);
    expect((await other.stats()).counts.products).toBe(1);
    await other.wipe();
    expect(await other.listProducts()).toEqual([]);
  });

  it('una copia anterior (sin el apartado) se importa sin tocar los productos que ya hay al combinar', async () => {
    await store.putProduct(product('8410000000016'));
    const copy = JSON.parse(JSON.stringify(await store.exportAll()));
    delete copy.data.products;
    await store.importAll(copy, 'merge');
    expect((await store.listProducts()).map((p) => p.barcode)).toEqual(['8410000000016']);
  });

  it('una copia con un producto imposible se rechaza entera (código malo, cifras fuera de rango o nombre vacío)', async () => {
    const base = JSON.parse(JSON.stringify(await store.exportAll()));
    for (const bad of [
      product('8410000000019'), // cifra de control mala
      product('8410000000016', { per100g: { kcal: 5000, proteinG: 1, carbsG: 1, fatG: 1 } }),
      product('8410000000016', { per100g: { kcal: 100, proteinG: 1, carbsG: 1, fatG: 1, saltG: 80 } }),
      product('8410000000016', { name: '   ' }),
      product('8410000000016', { servingG: 0 }),
    ]) {
      await expect(store.importAll({ ...base, data: { ...base.data, products: [bad] } }, 'merge')).rejects.toBeInstanceOf(BackupError);
    }
    expect(await store.listProducts()).toEqual([]);
  });

  it('una copia con campos de más los deja fuera y con una fecha imposible se salta ese producto', async () => {
    const base = JSON.parse(JSON.stringify(await store.exportAll()));
    const odd = { ...product('8410000000016'), extra: 'x', per100g: { ...product('8410000000016').per100g, otro: 1 } };
    const old = product('96385074', { createdMs: 5 });
    await store.importAll({ ...base, data: { ...base.data, products: [odd, old] } }, 'merge');
    expect(await store.listProducts()).toEqual([product('8410000000016')]);
  });

  it('los productos no estropean las comidas, los platos ni el resto de `kv` (prefijos distintos)', async () => {
    await store.putMeal({ id: 'm', tsMs: at(9, 13), name: 'Comida', kcal: 500, source: 'manual' });
    await store.putProduct(product('8410000000016'));
    expect((await store.listMeals(at(9, 0), at(10, 0))).map((m) => m.id)).toEqual(['m']);
    expect((await store.listProducts()).map((p) => p.barcode)).toEqual(['8410000000016']);
    expect((await store.stats()).counts).toMatchObject({ meals: 1, products: 1 });
  });
});

describe('la clave de una IA externa de una versión anterior', () => {
  it('se borra al abrir la base: la app ya no usa ninguna y es un secreto sin uso', async () => {
    const { openDB } = await import('idb');
    const name = `clave-vieja-${++counter}`;
    const first = await openIdbStore(name);
    first.close();
    const raw = await openDB(name, 1);
    await raw.put('kv', 'sk-ant-secreta-secreta-secreta-1', 'aiKey');
    await raw.put('kv', { stepGoal: 9_000 }, 'settings');
    raw.close();

    const reopened = await openIdbStore(name);
    expect((await reopened.getSettings()).stepGoal).toBe(9_000);
    reopened.close();
    const check = await openDB(name, 1);
    expect(await check.get('kv', 'aiKey')).toBeUndefined();
    expect(await check.get('kv', 'settings')).toMatchObject({ stepGoal: 9_000 });
    check.close();
  });
});

describe('la app base y la que lleva la dieta comparten la misma base de datos', () => {
  it('la versión de la base de datos sigue en 1 y no tiene almacenes nuevos: la app base la abre sin fallar (con las comidas dentro, sin verlas)', async () => {
    const name = `compartida-${++counter}`;
    const withDiet = await openIdbStore(name);
    await withDiet.putMeal({ id: 'x', tsMs: at(9, 13), name: 'Comida', kcal: 400, source: 'manual' });
    await withDiet.setSettings({ stepGoal: 11_000, healthGoal: 'gain' });
    withDiet.close();

    // Lo que hace la app base: abrir la base en la versión 1 (con otra más alta guardada fallaría con `VersionError`).
    const { openDB } = await import('idb');
    const asBase = await openDB(name, 1);
    expect(asBase.version).toBe(1);
    expect([...asBase.objectStoreNames].sort()).toEqual(['buckets', 'counters', 'heart', 'kv', 'profile', 'sleep', 'spo2', 'syncs', 'workouts']);
    expect(await asBase.get('kv', 'settings')).toMatchObject({ stepGoal: 11_000 });
    asBase.close();

    // Y la que lleva la dieta vuelve a encontrar sus comidas.
    const again = await openIdbStore(name);
    expect(await again.listMeals(at(9, 0), at(10, 0))).toHaveLength(1);
  });

  it('una copia o un valor raro guardados donde van las comidas no rompen la lectura', async () => {
    const { openDB } = await import('idb');
    const name = `raro-${++counter}`;
    const first = await openIdbStore(name);
    first.close();
    const raw = await openDB(name, 1);
    await raw.put('kv', 'no soy una lista', 'meals:2026-07-09');
    raw.close();
    const reopened = await openIdbStore(name);
    expect(await reopened.listMeals(at(9, 0), at(10, 0))).toEqual([]);
  });
});

describe('IdbStore: la báscula de cocina', () => {
  it('guarda y devuelve la báscula emparejada con su decodificador, y se puede quitar', async () => {
    const store = await openIdbStore(`scale-store-${Math.random()}`);
    expect(await store.getScale()).toBeNull();
    const scale = {
      id: 'AA:BB',
      name: 'RENPHO-SCALE',
      pairedMs: 1_700_000_000_000,
      decoder: { v: 1 as const, source: 'n:ffe0/ffe1', length: 7, kind: 'uint' as const, offset: 3, width: 2 as const, little: false, divisor: 1 as const, guard: [[0, 0xa5]] as Array<[number, number]>, index: 0 },
    };
    await store.setScale(scale);
    expect(await store.getScale()).toEqual(scale);
    await store.setScale(null);
    expect(await store.getScale()).toBeNull();
  });

  it('una báscula guardada que no vale (otra versión, estropeada) se lee como «ninguna» y no se guarda', async () => {
    const store = await openIdbStore(`scale-store-${Math.random()}`);
    await store.setScale({ id: 'x', name: 'y', pairedMs: 1, decoder: { v: 2 } } as never);
    expect(await store.getScale()).toBeNull();
  });

  it('la báscula no va en la copia de seguridad (se vuelve a emparejar) y «Borrar todo» la quita', async () => {
    const store = await openIdbStore(`scale-store-${Math.random()}`);
    await store.setScale({ id: 'AA', name: 'B', pairedMs: 1, decoder: { v: 1, source: 'n:a/b', length: 4, kind: 'uint', offset: 1, width: 2, little: false, divisor: 1, guard: [], index: 0 } });
    expect(JSON.stringify(await store.exportAll())).not.toContain('"scale"');
    await store.wipe();
    expect(await store.getScale()).toBeNull();
  });
});

describe('el perfil social', () => {
  const profile = (username: string, byte: number): SocialProfile => ({ ...newSocialProfile(1_000, () => new Uint8Array(16).fill(byte)), username, status: username === '' ? '' : 'hola', updatedMs: 2_000 });

  it('el perfil se guarda tal cual y se lee igual; un valor roto en el almacén se ignora', async () => {
    expect(await store.getSocial()).toBeNull();
    await store.setSocial(profile('ana', 5));
    expect(await store.getSocial()).toMatchObject({ username: 'ana', status: 'hola' });
    await expect(store.setSocial({ ...profile('ana', 5), username: 'a' })).rejects.toThrow();
    // Algo que no es un perfil guardado a mano en la base no se lee como tal.
    await (store as unknown as { db: { put(name: string, value: unknown, key: string): Promise<unknown> } }).db.put('kv', { uid: 'x' }, 'social');
    expect(await store.getSocial()).toBeNull();
  });

  it('la copia de seguridad lleva el perfil y lo restituye al reemplazar', async () => {
    await store.setSocial(profile('ana', 5));
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    expect(backup.data.social.username).toBe('ana');
    await store.wipe();
    expect(await store.getSocial()).toBeNull();
    const { imported } = await store.importAll(backup, 'replace');
    expect(imported.social).toBe(1);
    expect((await store.getSocial())?.uid).toBe(profile('ana', 5).uid);
  });

  it('reemplazar con una copia que no trae perfil no borra el de este móvil', async () => {
    await store.setSocial(profile('ana', 5));
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    delete backup.data.social;
    await store.importAll(backup, 'replace');
    expect((await store.getSocial())?.username).toBe('ana');
  });

  it('al combinar, el perfil en uso de este móvil manda; uno recién creado se cambia por el de la copia', async () => {
    const other = profile('berta', 9);
    await store.setSocial(other);
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.setSocial(profile('ana', 5));
    await store.importAll(backup, 'merge');
    expect((await store.getSocial())?.username).toBe('ana');
    await store.setSocial(profile('', 7)); // recién creado, sin tocar
    await store.importAll(backup, 'merge');
    expect((await store.getSocial())?.username).toBe('berta');
  });

  it('una copia con un perfil roto se rechaza entera, sin tocar nada', async () => {
    await store.setSocial(profile('ana', 5));
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    backup.data.social = { uid: 'no', username: 'x' };
    await expect(store.importAll(backup, 'replace')).rejects.toBeInstanceOf(BackupError);
    expect((await store.getSocial())?.username).toBe('ana');
  });

});

describe('putMany: lo mismo que guardar uno a uno, en una sola transacción', () => {
  const meal = (id: string, tsMs: number, kcal = 100): MealEntry => ({ id, tsMs, name: id, kcal, source: 'manual' });
  const workout = (id: string, startMs: number): WorkoutRecord => ({ id, sport: 'walk', startMs, endMs: startMs + 3_600_000, pausedMs: 0, source: 'manual' });

  it('guarda perfil, entrenos, comidas y agua; las comidas de un mismo día quedan juntas y ordenadas', async () => {
    await store.putMeal(meal('previa', at(9, 8)));
    await store.putMany({
      profile: [{ date: key(9), heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' }],
      workouts: [workout('w1', at(9, 18))],
      meals: [meal('cena', at(9, 21)), meal('comida', at(9, 14)), meal('otro-dia', at(10, 9))],
      water: [{ id: 'a1', tsMs: at(9, 10), ml: 250 }, { id: 'a2', tsMs: at(9, 12), ml: 300 }],
    });
    expect((await store.listMeals(at(9, 0), at(11, 0))).map((m) => m.id)).toEqual(['previa', 'comida', 'cena', 'otro-dia']);
    expect((await store.listWater(at(9, 0), at(10, 0))).map((w) => w.ml)).toEqual([250, 300]);
    expect((await store.getWorkout('w1'))?.sport).toBe('walk');
    expect((await store.getProfileHistory()).map((p) => p.weightKg)).toEqual([80]);
  });

  it('una comida con el mismo id sustituye a la que había (como putMeal)', async () => {
    await store.putMeal(meal('x', at(9, 8), 100));
    await store.putMany({ meals: [meal('x', at(9, 8), 555)] });
    const day = await store.listMeals(at(9, 0), at(10, 0));
    expect(day).toHaveLength(1);
    expect(day[0]?.kcal).toBe(555);
  });

  it('sin nada que guardar no hace nada, y un entreno con un `day` heredado no lo arrastra', async () => {
    await store.putMany({});
    await store.putMany({ workouts: [{ ...workout('w2', at(9, 18)), day: '2026-07-01' } as WorkoutRecord] });
    expect(((await store.getWorkout('w2')) as WorkoutRecord & { day?: unknown }).day).toBeUndefined();
  });
});

describe('uso del móvil (solo horas, para estimar el sueño)', () => {
  const MIN = 60_000;

  it('guarda los tramos de uso y los leídos, y los devuelve unidos; lo que cruza la medianoche vuelve entero', async () => {
    await store.addPhoneActivity({
      uses: [{ startMs: at(9, 23, 50), endMs: at(10, 0, 20) }, { startMs: at(10, 7, 30), endMs: at(10, 7, 40) }],
      coverage: [{ startMs: at(9, 12), endMs: at(10, 9) }],
    });
    const loaded = await store.loadPhoneActivity(at(9, 0), at(11, 0));
    expect(loaded.uses).toEqual([{ startMs: at(9, 23, 50), endMs: at(10, 0, 20) }, { startMs: at(10, 7, 30), endMs: at(10, 7, 40) }]);
    expect(loaded.coverage).toEqual([{ startMs: at(9, 12), endMs: at(10, 9) }]);
    expect(await store.lastPhoneRead()).toBe(at(10, 9));
  });

  it('una lectura nueva se une a lo que ya había (sin duplicar) y tramos casi pegados forman uno', async () => {
    await store.addPhoneActivity({ uses: [{ startMs: at(9, 10, 0), endMs: at(9, 10, 5) }], coverage: [{ startMs: at(9, 8), endMs: at(9, 12) }] });
    await store.addPhoneActivity({ uses: [{ startMs: at(9, 10, 4), endMs: at(9, 10, 9) }, { startMs: at(9, 11), endMs: at(9, 11, 2) }], coverage: [{ startMs: at(9, 11, 45), endMs: at(9, 15) }] });
    const loaded = await store.loadPhoneActivity(at(9, 0), at(10, 0));
    expect(loaded.uses).toEqual([{ startMs: at(9, 10, 0), endMs: at(9, 10, 9) }, { startMs: at(9, 11), endMs: at(9, 11, 2) }]);
    // 08:00–12:00 y 11:45–15:00 se solapan: un solo tramo leído de 08:00 a 15:00.
    expect(loaded.coverage).toEqual([{ startMs: at(9, 8), endMs: at(9, 15) }]);
  });

  it('solo devuelve lo cercano al rango pedido y nunca lo que no se guardó; sin nada leído, no hay última lectura', async () => {
    expect(await store.lastPhoneRead()).toBeNull();
    await store.addPhoneActivity({ uses: [{ startMs: at(1, 10), endMs: at(1, 10, 3) }], coverage: [{ startMs: at(1, 8), endMs: at(1, 12) }] });
    expect((await store.loadPhoneActivity(at(20, 0), at(21, 0))).uses).toEqual([]);
    expect((await store.loadPhoneActivity(at(1, 0), at(2, 0))).uses).toHaveLength(1);
  });

  it('ignora lo roto que pudiera haber guardado y no tumba la carga', async () => {
    await store.addPhoneActivity({ uses: [{ startMs: at(9, 10), endMs: at(9, 10, 3) }], coverage: [] });
    expect((await store.loadPhoneActivity(at(9, 0), at(10, 0))).coverage).toEqual([]);
    expect(MIN).toBe(60_000);
  });

  it('el borrado de todos los datos también borra el uso del móvil', async () => {
    await store.addPhoneActivity({ uses: [{ startMs: at(9, 10), endMs: at(9, 10, 3) }], coverage: [{ startMs: at(9, 8), endMs: at(9, 12) }] });
    await store.wipe();
    expect(await store.loadPhoneActivity(at(9, 0), at(10, 0))).toEqual({ uses: [], coverage: [] });
  });
});
