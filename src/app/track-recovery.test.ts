import { describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import { WorkoutRecorder } from '../sync/workout-recorder';
import { extendWithTrack, settleOrphanTrack } from './track-recovery';
import type { TrackFix } from './tracker';
import { fakeTracker } from './tracker.test-support';

const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };
const T0 = Date.UTC(2026, 5, 1, 8, 0, 0);
const M_PER_DEG = 111_195;

/** Una posición cada segundo, andando hacia el norte a `speed` m/s desde el segundo `fromS` hasta `toS` (con la velocidad del GPS). */
function walk(fromS: number, toS: number, speed = 1.4, seqFrom = 1): TrackFix[] {
  const fixes: TrackFix[] = [];
  for (let s = fromS; s < toS; s++) {
    fixes.push({ seq: seqFrom + fixes.length, tsMs: T0 + s * 1000, lat: 40 + (s * speed) / M_PER_DEG, lon: -3, accuracyM: 5, speedMs: speed, altM: null, vAccM: null, pressureHpa: null });
  }
  return fixes;
}

/** Lo que grabó el móvil con la app abierta: el borrador es el registro en el segundo `untilS`. */
function draftUntil(untilS: number, fixes: readonly TrackFix[], consumed = Number.POSITIVE_INFINITY): WorkoutRecord {
  let clock = T0;
  const recorder = new WorkoutRecorder({ sport: 'walk', profile, now: () => clock, useGps: true, id: 'w1' });
  for (const fix of fixes) {
    if (fix.tsMs > T0 + untilS * 1000 || fix.seq > consumed) break;
    clock = fix.tsMs;
    recorder.onGps({ lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, tsMs: fix.tsMs, speedMs: fix.speedMs, pressureHpa: fix.pressureHpa }, { trustTime: true });
  }
  clock = T0 + untilS * 1000;
  return recorder.toRecord();
}

/** El registro que habría salido si la app hubiera seguido abierta hasta el segundo `untilS`: la verdad con la que comparar. */
const truthUntil = draftUntil;

/** Presión a `heightM` metros sobre 1013,25 hPa. */
const pressureAt = (heightM: number): number => 1013.25 * Math.pow(1 - heightM / 44_330, 5.255);

describe('extendWithTrack: cortar por número de posición y sumar el desnivel', () => {
  it('con el número de la última posición recogida no se pierde lo que el servicio ya tenía y la web aún no había pedido', () => {
    const all = walk(0, 900);
    // El borrador lleva hasta el segundo 600 de reloj, pero solo recogió hasta la posición 590: faltan 10 s de ruta ANTES de su hora final.
    const draft = { ...draftUntil(600, all, 590), trackSeq: 590 };
    const bySeq = extendWithTrack(draft, all, profile);
    const { trackSeq: _s, ...byTime } = draft;
    const lossy = extendWithTrack(byTime, all, profile);
    const truth = draftUntil(899, all);
    expect(Math.abs((bySeq.distanceM ?? 0) - (truth.distanceM ?? 0))).toBeLessThanOrEqual(3);
    expect((truth.distanceM ?? 0) - (lossy.distanceM ?? 0)).toBeGreaterThan(10); // por hora se pierden esos 10 s (≈ 14 m)
    expect('trackSeq' in bySeq).toBe(false); // lo recuperado es un registro normal
  });

  it('la hora final nunca retrocede aunque todas las posiciones pendientes sean de antes', () => {
    const all = walk(0, 620);
    const draft = { ...draftUntil(619, all, 600), trackSeq: 600 };
    const extended = extendWithTrack(draft, all, profile);
    expect(extended.endMs).toBeGreaterThanOrEqual(draft.endMs);
  });

  it('suma el desnivel que midió el barómetro en lo recuperado', () => {
    const climb = walk(0, 1500).map((fix) => ({ ...fix, pressureHpa: pressureAt(Math.min(40, Math.max(0, (((fix.tsMs - T0) / 1000 - 700) * 40) / 600))) }));
    const draft = draftUntil(600, climb);
    const extended = extendWithTrack(draft, climb, profile);
    expect(extended.ascentM ?? 0).toBeGreaterThanOrEqual(35);
    expect(extended.ascentM ?? 0).toBeLessThanOrEqual(41);
  });
});

describe('extendWithTrack: el recorrido', () => {
  it('une el recorrido del borrador con el de lo recuperado, de la salida hasta lo último', () => {
    const all = walk(0, 1500);
    const draft = draftUntil(600, all);
    expect(draft.route).toBeDefined();
    const extended = extendWithTrack(draft, all, profile);
    expect(extended.route).toBeDefined();
    const route = extended.route!;
    expect(route[0]).toEqual(draft.route![0]);
    // Camina hacia el norte: lo recuperado alarga el recorrido más allá de donde acababa el borrador.
    expect(route[route.length - 1]![0]).toBeGreaterThan(draft.route![draft.route!.length - 1]![0] + 0.003);
    expect(route.length).toBeLessThanOrEqual(600);
  });

  it('un borrador de antes de existir el recorrido se continúa igual y el recorrido sale solo de lo recuperado', () => {
    const all = walk(0, 1500);
    const { route: _gone, ...old } = draftUntil(600, all);
    const extended = extendWithTrack(old, all, profile);
    expect(extended.route!.length).toBeGreaterThanOrEqual(2);
    expect(extended.distanceM).toBeGreaterThan(old.distanceM ?? 0);
  });
});

describe('extendWithTrack: continuar un borrador con lo que grabó el servicio tras cerrarse la app', () => {
  it('suma la distancia y los minutos de lo grabado después, y coincide con el entreno sin interrupción', () => {
    const all = walk(0, 1500); // 25 min andando
    const draft = draftUntil(600, all);
    const extended = extendWithTrack(draft, all, profile);
    const truth = truthUntil(1499, all);
    expect(draft.distanceM).toBeGreaterThan(780);
    expect(extended.endMs).toBe(T0 + 1499 * 1000);
    expect(extended.pausedMs).toBe(draft.pausedMs);
    expect(extended.distanceSource).toBe('gps');
    // La distancia continuada es la del entreno entero, salvo el segundo entre el último guardado y la primera posición nueva.
    expect(Math.abs((extended.distanceM ?? 0) - (truth.distanceM ?? 0))).toBeLessThanOrEqual(3);
    expect(extended.splitsM).toHaveLength(truth.splitsM?.length ?? -1);
    // Los minutos que ya tenía el borrador no cambian y los nuevos llevan lo andado en cada uno (84 m a 1,4 m/s).
    expect(extended.splitsM?.slice(0, 9)).toEqual(draft.splitsM?.slice(0, 9));
    for (const m of extended.splitsM?.slice(11, 24) ?? []) expect(Math.abs(m - 84)).toBeLessThanOrEqual(2);
  });

  it('recorta el final en que ya no se avanzaba (el móvil en el bolsillo, sin reabrir la app)', () => {
    const moving = walk(0, 900);
    const idle: TrackFix[] = [];
    for (let s = 900; s < 900 + 3 * 3600; s += 5) {
      idle.push({ seq: moving.length + idle.length + 1, tsMs: T0 + s * 1000, lat: 40 + (899 * 1.4) / M_PER_DEG, lon: -3, accuracyM: 6, speedMs: 0, altM: null, vAccM: null, pressureHpa: null });
    }
    const draft = draftUntil(600, moving);
    const extended = extendWithTrack(draft, [...moving, ...idle], profile);
    expect(extended.endMs).toBe(T0 + 899 * 1000);
    expect(extended.endMs).toBeLessThan(T0 + 910 * 1000);
    expect((extended.distanceM ?? 0) - (draft.distanceM ?? 0)).toBeGreaterThan(400);
  });

  it('si la velocidad no viene, se avanza lo que dicen las posiciones', () => {
    const noSpeed = walk(0, 1000).map((fix) => ({ ...fix, speedMs: null }));
    const draft = draftUntil(500, noSpeed);
    const extended = extendWithTrack(draft, noSpeed, profile);
    expect(extended.endMs).toBe(T0 + 999 * 1000);
    expect(extended.distanceM ?? 0).toBeGreaterThan((draft.distanceM ?? 0) + 500);
  });

  it('sin nada nuevo o sin avanzar, deja el borrador tal cual', () => {
    const all = walk(0, 600);
    const draft = draftUntil(599, all);
    expect(extendWithTrack(draft, all, profile)).toBe(draft); // todo anterior al final del borrador
    const standing = walk(600, 700, 0).map((fix) => ({ ...fix, lat: 40.01, speedMs: 0 }));
    expect(extendWithTrack(draft, [...all, ...standing], profile)).toBe(draft);
    // Menos de diez metros no es un tramo.
    const barely = walk(600, 606, 1.4);
    expect(extendWithTrack(draft, [...all, ...barely], profile)).toBe(draft);
  });

  it('no toca un registro manual', () => {
    const manual: WorkoutRecord = { id: 'm1', sport: 'walk', startMs: T0, endMs: T0 + 600_000, pausedMs: 0, source: 'manual' };
    expect(extendWithTrack(manual, walk(700, 900), profile)).toBe(manual);
  });

  it('sin distancia previa (el GPS no llegó a fijarse) también continúa', () => {
    const draft: WorkoutRecord = { id: 'w1', sport: 'walk', startMs: T0, endMs: T0 + 120_000, pausedMs: 0, source: 'live' };
    const extended = extendWithTrack(draft, walk(0, 800), profile);
    expect(extended.distanceM ?? 0).toBeGreaterThan(800);
    expect(extended.splitsM?.slice(0, 2)).toEqual([-1, -1]);
    expect(extended.splitsM?.length).toBeGreaterThanOrEqual(13);
  });

  it('las pausas del borrador desplazan el cronómetro: los minutos nuevos caen en el minuto activo que les toca', () => {
    // 10 min andando con 4 min de pausa dentro: a los 10 min de reloj, el borrador lleva 6 de tiempo activo.
    const all = walk(0, 1200);
    const draft = { ...draftUntil(600, all), pausedMs: 240_000 };
    const extended = extendWithTrack(draft, all, profile);
    // 6 min activos de borrador y 10 más de continuación: 16 minutos.
    expect(extended.splitsM).toHaveLength(16);
  });
});

describe('settleOrphanTrack: el servicio del GPS que sigue grabando tras cerrarse la app', () => {
  async function orphan(sessionId = 'w1') {
    const fake = fakeTracker();
    await fake.tracker.start({ sessionId, startedAtMs: T0 });
    for (const fix of walk(0, 900)) fake.record(fix.lat, fix.tsMs, fix.speedMs);
    fake.calls.length = 0;
    return fake;
  }

  it('continúa el borrador del mismo entreno, para el servicio y borra la pista', async () => {
    const fake = await orphan();
    const draft = draftUntil(300, walk(0, 900));
    const settled = await settleOrphanTrack(fake.tracker, draft, profile);
    expect(settled?.endMs).toBe(T0 + 899 * 1000);
    expect(settled?.distanceM ?? 0).toBeGreaterThan(1200);
    expect(fake.calls).toContain('stop');
    expect(fake.calls).toContain('clear:w1');
    expect(fake.server.active).toBe(false);
    expect(fake.track).toHaveLength(0);
  });

  it('también si el servicio ya se había parado solo (tope de tiempo sin moverse, permiso retirado): su pista sigue ahí', async () => {
    const fake = await orphan();
    await fake.tracker.stop(); // activo = false, pero la pista queda
    const draft = draftUntil(300, walk(0, 900));
    const settled = await settleOrphanTrack(fake.tracker, draft, profile);
    expect(settled?.endMs).toBe(T0 + 899 * 1000);
    expect(fake.track).toHaveLength(0);
  });

  it('con el borrador de OTRO entreno no lo toca, pero igualmente para el servicio y borra la pista', async () => {
    const fake = await orphan('w-otro');
    const draft = draftUntil(300, walk(0, 900));
    expect(await settleOrphanTrack(fake.tracker, draft, profile)).toBe(draft);
    expect(fake.calls).toEqual(expect.arrayContaining(['stop', 'clear:w-otro']));
  });

  it('sin borrador, para el servicio y borra la pista', async () => {
    const fake = await orphan();
    expect(await settleOrphanTrack(fake.tracker, null, profile)).toBeNull();
    expect(fake.server.active).toBe(false);
    expect(fake.track).toHaveLength(0);
  });

  it('si no hay nada grabándose, no hace nada', async () => {
    const fake = fakeTracker();
    const draft = draftUntil(300, walk(0, 900));
    expect(await settleOrphanTrack(fake.tracker, draft, profile)).toBe(draft);
    expect(fake.calls).toEqual(['status']);
  });

  it('fuera de la app de Android (sin grabador) devuelve el borrador', async () => {
    const draft = draftUntil(300, walk(0, 900));
    expect(await settleOrphanTrack(null, draft, profile)).toBe(draft);
    expect(await settleOrphanTrack(null, null, profile)).toBeNull();
  });

  it('un fallo del plugin no impide recuperar el borrador', async () => {
    const fake = await orphan();
    fake.tracker.status = () => Promise.reject(new Error('sin plugin'));
    const draft = draftUntil(300, walk(0, 900));
    expect(await settleOrphanTrack(fake.tracker, draft, profile)).toBe(draft);
    const second = await orphan();
    second.tracker.fixes = () => Promise.reject(new Error('el servicio no contesta'));
    expect(await settleOrphanTrack(second.tracker, draft, profile)).toBe(draft);
  });

  it('una pista más larga que un lote se lee entera', async () => {
    const fake = fakeTracker();
    await fake.tracker.start({ sessionId: 'w1', startedAtMs: T0 });
    for (const fix of walk(0, 12_000)) fake.record(fix.lat, fix.tsMs, fix.speedMs);
    const draft = draftUntil(300, walk(0, 400));
    const settled = await settleOrphanTrack(fake.tracker, draft, profile);
    expect(settled?.endMs).toBe(T0 + 11_999 * 1000);
    expect(settled?.distanceM ?? 0).toBeGreaterThan(16_000);
  });
});
