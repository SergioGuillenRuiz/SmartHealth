import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTransport } from '../ble/sim/ring';
import { buildDemoDataset } from '../ble/sim/dataset';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import type { WorkoutRecord } from '../domain/workout';
import { installServices } from './services';
import { detailWorkoutId, pendingRecovered, pendingWorkout, profileHistory, recoveredCause, toast } from './state';
import { nativeTracker } from './tracker';
import { fakeTracker } from './tracker.test-support';
import { discardPendingWorkout, recoverWorkoutDraft, removeWorkout, saveFromNotification, saveWorkout, updateWorkout } from './workout-actions';

// El grabador nativo solo existe en la app de Android: aquí es nulo salvo que una prueba ponga el falso.
vi.mock('./tracker', async (original) => ({ ...(await original<typeof import('./tracker')>()), nativeTracker: vi.fn(() => null) }));

const NOW = new Date(2026, 6, 10, 19, 0, 0).getTime();
const record: WorkoutRecord = { id: 'w1', sport: 'walk', startMs: NOW - 3_600_000, endMs: NOW, pausedMs: 0, source: 'live', steps: 4000 };

let counter = 0;
let store: IdbStore;
beforeEach(async () => {
  store = await openIdbStore(`wa-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 1 })), now: () => NOW, demo: false });
  pendingWorkout.value = null;
  pendingRecovered.value = false;
  recoveredCause.value = null;
  detailWorkoutId.value = null;
  toast.value = null;
});
afterEach(() => vi.restoreAllMocks());

describe('guardar un entrenamiento terminado', () => {
  it('lo guarda, borra el borrador y cierra la revisión', async () => {
    await store.setWorkoutDraft(record);
    pendingWorkout.value = record;
    expect(await saveWorkout(record)).toBe(true);
    expect((await store.getWorkout('w1'))?.steps).toBe(4000);
    expect(await store.getWorkoutDraft()).toBeNull();
    expect(pendingWorkout.value).toBeNull();
    expect(toast.value?.message).toBe('Entrenamiento guardado');
  });

  it('si el almacén falla NO se pierde: sigue pendiente de revisar, con el borrador, y se avisa', async () => {
    await store.setWorkoutDraft(record);
    pendingWorkout.value = record;
    vi.spyOn(store, 'putWorkout').mockRejectedValue(new Error('cuota agotada'));
    expect(await saveWorkout(record)).toBe(false);
    expect(pendingWorkout.value).toEqual(record);
    expect(await store.getWorkoutDraft()).toEqual(record);
    expect(toast.value).toMatchObject({ tone: 'error' });
    expect(toast.value?.message).toMatch(/No se pudo guardar el entrenamiento: cuota agotada/);
  });

  it('un doble toque en «Guardar» lo guarda una sola vez', async () => {
    const put = vi.spyOn(store, 'putWorkout');
    const [a, b] = await Promise.all([saveWorkout(record), saveWorkout(record)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('descartar lo borra todo, también el borrador', async () => {
    await store.setWorkoutDraft(record);
    pendingWorkout.value = record;
    await discardPendingWorkout();
    expect(pendingWorkout.value).toBeNull();
    expect(await store.getWorkoutDraft()).toBeNull();
    expect(await store.getWorkout('w1')).toBeNull();
  });
});

describe('la zancada se ajusta con los paseos con GPS', () => {
  const gpsWalk = (n: number, stride: number): WorkoutRecord => ({
    id: `gw${n}`,
    sport: 'walk',
    startMs: NOW - n * 86_400_000,
    endMs: NOW - n * 86_400_000 + 20 * 60_000,
    pausedMs: 0,
    source: 'live',
    steps: 2200,
    distanceM: Math.round(2200 * stride),
    distanceSource: 'gps',
  });

  it('al guardar el tercer paseo ajusta la zancada, lo dice, y la entrada queda en el perfil', async () => {
    profileHistory.value = [{ date: '2026-01-01', heightCm: 175, weightKg: 75, sex: 'male', birthDate: '1990-05-05' }];
    await store.putWorkout(gpsWalk(1, 0.66));
    await store.putWorkout(gpsWalk(2, 0.66));
    expect(await saveWorkout(gpsWalk(3, 0.66))).toBe(true);
    expect(toast.value?.message).toBe('Entrenamiento guardado. Zancada ajustada a 66\u00a0cm con tus paseos con GPS.');
    const saved = (await store.getProfileHistory()).find((e) => e.strideAuto);
    expect(saved).toMatchObject({ strideCm: 66, strideAuto: true, strideOnly: true });
    expect(profileHistory.value.find((e) => e.strideAuto)?.strideCm).toBe(66);
  });

  it('con menos de tres paseos, o con la zancada fijada por la persona, no toca nada', async () => {
    profileHistory.value = [{ date: '2026-01-01', heightCm: 175, weightKg: 75, sex: 'male', birthDate: '1990-05-05' }];
    await store.putWorkout(gpsWalk(1, 0.66));
    expect(await saveWorkout(gpsWalk(2, 0.66))).toBe(true);
    expect(toast.value?.message).toBe('Entrenamiento guardado');
    expect(await store.getProfileHistory()).toEqual([]);
    profileHistory.value = [{ date: '2026-01-01', heightCm: 175, weightKg: 75, sex: 'male', birthDate: '1990-05-05', strideCm: 70 }];
    await store.putWorkout(gpsWalk(4, 0.66));
    expect(await saveWorkout(gpsWalk(3, 0.66))).toBe(true);
    expect(toast.value?.message).toBe('Entrenamiento guardado');
  });

  it('un fallo al ajustarla no impide guardar el entrenamiento', async () => {
    profileHistory.value = [{ date: '2026-01-01', heightCm: 175, weightKg: 75, sex: 'male', birthDate: '1990-05-05' }];
    await store.putWorkout(gpsWalk(1, 0.66));
    await store.putWorkout(gpsWalk(2, 0.66));
    vi.spyOn(store, 'putProfileEntry').mockRejectedValue(new Error('disco lleno'));
    expect(await saveWorkout(gpsWalk(3, 0.66))).toBe(true);
    expect(toast.value?.message).toBe('Entrenamiento guardado');
  });
});

describe('recuperar un entrenamiento tras cerrarse la app', () => {
  it('si quedó un borrador, se ofrece para revisarlo y se marca como recuperado', async () => {
    await store.setWorkoutDraft(record);
    await recoverWorkoutDraft();
    expect(pendingWorkout.value).toEqual(record);
    expect(pendingRecovered.value).toBe(true);
  });

  it('sin borrador no pasa nada', async () => {
    await recoverWorkoutDraft();
    expect(pendingWorkout.value).toBeNull();
    expect(pendingRecovered.value).toBe(false);
  });

  it('si el motor web murió durante el entreno, el aviso dice la causa (la anotó el lado nativo); si murió antes del entreno, no; y descartar la quita', async () => {
    const t = fakeTracker({ phone: { renderGoneAt: NOW - 600_000, renderGoneCrashed: false } });
    vi.mocked(nativeTracker).mockReturnValue(t.tracker);
    await store.setWorkoutDraft(record); // empezó una hora antes de que muriera
    await recoverWorkoutDraft();
    expect(recoveredCause.value).toMatch(/Android cerró el motor web de la app/);
    expect(recoveredCause.value).toMatch(/falta de memoria/);
    await discardPendingWorkout();
    expect(recoveredCause.value).toBeNull();

    const crashed = fakeTracker({ phone: { renderGoneAt: NOW - 600_000, renderGoneCrashed: true } });
    vi.mocked(nativeTracker).mockReturnValue(crashed.tracker);
    await store.setWorkoutDraft(record);
    await recoverWorkoutDraft();
    expect(recoveredCause.value).toMatch(/se cayó el motor web/);
    await discardPendingWorkout();

    // Murió antes de empezar este entreno (de otro, ya pasado): no es la causa de este.
    const old = fakeTracker({ phone: { renderGoneAt: record.startMs - 1000, renderGoneCrashed: false } });
    vi.mocked(nativeTracker).mockReturnValue(old.tracker);
    await store.setWorkoutDraft(record);
    await recoverWorkoutDraft();
    expect(recoveredCause.value).toBeNull();
    expect(pendingRecovered.value).toBe(true);
  });

  it('guardar el recuperado quita la marca de recuperado', async () => {
    await store.setWorkoutDraft(record);
    await recoverWorkoutDraft();
    expect(await saveWorkout(record)).toBe(true);
    expect(pendingRecovered.value).toBe(false);
    expect(await store.getWorkoutDraft()).toBeNull();
  });
});

describe('corregir y eliminar entrenamientos guardados', () => {
  it('un fallo del almacén se avisa en vez de quedar sin respuesta', async () => {
    await store.putWorkout(record);
    vi.spyOn(store, 'putWorkout').mockRejectedValue(new Error('disco lleno'));
    expect(await updateWorkout({ ...record, kcalManual: 300 })).toBe(false);
    expect(toast.value).toMatchObject({ tone: 'error' });
    vi.spyOn(store, 'deleteWorkout').mockRejectedValue(new Error('disco lleno'));
    expect(await removeWorkout('w1')).toBe(false);
    expect(toast.value?.message).toMatch(/No se pudo eliminar/);
    expect((await store.getWorkout('w1'))?.kcalManual).toBeUndefined();
  });
});

describe('parar desde el botón de la notificación', () => {
  it('lo guarda tal cual, sin pasar por la revisión, y abre su detalle (con el recorrido y la gráfica de pulso)', async () => {
    await store.setWorkoutDraft(record);
    await saveFromNotification(record);
    expect((await store.getWorkout('w1'))?.steps).toBe(4000);
    expect(await store.getWorkoutDraft()).toBeNull();
    expect(pendingWorkout.value).toBeNull();
    expect(detailWorkoutId.value).toBe('w1');
    expect(toast.value?.message).toBe('Entrenamiento guardado');
  });

  it('si no se pudo guardar, no se pierde: queda en la revisión de siempre para reintentarlo y el detalle no se abre', async () => {
    await store.setWorkoutDraft(record);
    vi.spyOn(store, 'putWorkout').mockRejectedValue(new Error('cuota agotada'));
    await saveFromNotification(record);
    expect(pendingWorkout.value).toEqual(record);
    expect(await store.getWorkoutDraft()).toEqual(record);
    expect(detailWorkoutId.value).toBeNull();
    expect(toast.value).toMatchObject({ tone: 'error' });
  });

  describe('con la app cerrada', () => {
    it('la parada quedó anotada: al abrir la app, el entreno recuperado se guarda solo y se enseña guardado', async () => {
      const t = fakeTracker();
      vi.mocked(nativeTracker).mockReturnValue(t.tracker);
      await store.setWorkoutDraft(record);
      t.press('stop', NOW - 1000, false);
      await recoverWorkoutDraft();
      expect((await store.getWorkout('w1'))?.id).toBe('w1');
      expect(pendingWorkout.value).toBeNull();
      expect(pendingRecovered.value).toBe(false);
      expect(detailWorkoutId.value).toBe('w1');
      expect(t.pendingActions()).toBe(0);
    });

    it('si solo se había pausado, no se guarda nada: se ofrece a revisar como siempre (y la cola queda limpia)', async () => {
      const t = fakeTracker();
      vi.mocked(nativeTracker).mockReturnValue(t.tracker);
      await store.setWorkoutDraft(record);
      t.press('pause', NOW - 1000, false);
      await recoverWorkoutDraft();
      expect(await store.getWorkout('w1')).toBeNull();
      expect(pendingWorkout.value).toMatchObject({ id: 'w1' });
      expect(pendingRecovered.value).toBe(true);
      expect(detailWorkoutId.value).toBeNull();
      expect(t.pendingActions()).toBe(0);
    });

    it('una parada sin ningún borrador que guardar no inventa nada', async () => {
      const t = fakeTracker();
      vi.mocked(nativeTracker).mockReturnValue(t.tracker);
      t.press('stop', NOW - 1000, false);
      await recoverWorkoutDraft();
      expect(pendingWorkout.value).toBeNull();
      expect(detailWorkoutId.value).toBeNull();
      expect(t.pendingActions()).toBe(0);
    });
  });
});
