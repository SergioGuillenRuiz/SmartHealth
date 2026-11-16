import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { parseBackup, requireCompleteBackup } from './backup';
import fixture from './fixtures/backup-apk26.json';
import { openIdbStore } from './idb-store';

/**
 * Compatibilidad hacia atrás de las copias de seguridad. `fixtures/backup-apk26.json` es una copia EXPORTADA por la versión
 * anterior a la importación estricta (recortada a unos pocos registros de cada apartado, más los campos opcionales que el modo
 * demostración no genera: tramos por minuto, calorías fijadas, nota, zancada calibrada y una siesta).
 *
 * Las copias son la red de seguridad de los datos de la persona: si un cambio en el validador dejara fuera un campo o rechazara
 * lo que la propia app exportó, se perdería justo cuando hace falta (al reinstalar o cambiar de móvil). Esta prueba lo vigila.
 */
const by = <T>(rows: readonly T[], key: (row: T) => string | number): T[] => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

const sections = (data: {
  profile: Array<{ date: string }>;
  workouts: Array<{ id: string }>;
  buckets: Array<{ startMs: number }>;
  counters: Array<{ tsMs: number }>;
  heart: Array<{ tsMs: number }>;
  spo2: Array<{ tsMs: number }>;
  sleep: Array<{ startMs: number }>;
  syncs: Array<{ tsMs: number }>;
}): unknown => ({
  profile: by(data.profile, (r) => r.date),
  workouts: by(data.workouts, (r) => r.id),
  buckets: by(data.buckets, (r) => r.startMs),
  counters: by(data.counters, (r) => r.tsMs),
  heart: by(data.heart, (r) => r.tsMs),
  spo2: by(data.spo2, (r) => r.tsMs),
  sleep: by(data.sleep, (r) => r.startMs),
  syncs: by(data.syncs, (r) => r.tsMs),
});

describe('una copia exportada por la versión anterior se restaura entera', () => {
  it('el validador la acepta sin dejar nada fuera ni quitar ningún campo', () => {
    const parsed = parseBackup(fixture);
    requireCompleteBackup(parsed);
    expect(parsed.skipped).toBe(0);
    expect(sections(parsed)).toEqual(sections(fixture.data as Parameters<typeof sections>[0]));
    expect(parsed.settings).toEqual(fixture.data.settings);
  });

  it('los campos opcionales y todas las fases del sueño sobreviven', () => {
    const parsed = parseBackup(fixture);
    const live = parsed.workouts.find((w) => w.source === 'live' && w.splitsM !== undefined);
    expect(live).toMatchObject({ splitsM: [412, 405, -1, 398], kcalManual: 640, note: 'Ruta del río, con viento de cara', distanceSource: 'gps' });
    expect(live?.hr).toHaveLength(4);
    expect(parsed.workouts.some((w) => w.source === 'manual' && w.distanceSource === 'manual')).toBe(true);
    expect(parsed.profile.find((p) => p.strideOnly === true)).toMatchObject({ strideCm: 76 });
    expect(new Set(parsed.sleep[0]?.segments.map((s) => s.stage))).toEqual(new Set(['deep', 'light', 'rem', 'awake', 'nap']));
    expect(new Set(parsed.heart.map((h) => h.source))).toEqual(new Set(['ring-auto', 'ring-spot', 'workout']));
  });

  it('importarla de verdad y volver a exportar devuelve lo mismo', async () => {
    const store = await openIdbStore('compat-apk26');
    await store.importAll(fixture, 'replace');
    const again = await store.exportAll();
    expect(sections(again.data as Parameters<typeof sections>[0])).toEqual(sections(fixture.data as Parameters<typeof sections>[0]));
    // Lo que la copia trae se conserva tal cual; un ajuste que la copia (de una versión anterior) no conocía queda con su valor de serie.
    expect(again.data.settings).toEqual({ ...fixture.data.settings, autoSync: true, healthGoal: 'maintain', targetWeightKg: null, jointMetrics: ['steps', 'intake', 'water', 'weight'], nutritionPanel: ['protein', 'carbs', 'fat', 'salt'], mealSuggestions: true, hasRing: true, hasScale: true });
    expect(again.data.meals).toEqual([]);
  });
});
