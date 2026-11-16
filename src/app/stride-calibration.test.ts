import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileEntry } from '../domain/profile';
import type { WorkoutRecord } from '../domain/workout';
import type { RecorderSnapshot } from '../sync/workout-recorder';
import type { LiveWorkoutState } from './workout-controller';

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();

const mocks = vi.hoisted(() => ({
  beginWorkout: vi.fn(),
  finishWorkout: vi.fn(),
  discardWorkout: vi.fn(),
  isWorkoutActive: vi.fn(() => false),
  saveProfileEntry: vi.fn(async (_entry: ProfileEntry): Promise<void> => undefined),
}));
vi.mock('./workout-actions', () => ({
  beginWorkout: mocks.beginWorkout,
  finishWorkout: mocks.finishWorkout,
  discardWorkout: mocks.discardWorkout,
  isWorkoutActive: mocks.isWorkoutActive,
}));
vi.mock('./actions', () => ({ saveProfileEntry: mocks.saveProfileEntry }));
vi.mock('./services', () => ({ svc: () => ({ now: () => NOW }) }));

import { activeWorkout, liveWorkout, nowMs, profileHistory, strideWalk } from './state';
import {
  cancelStrideCalibration,
  closeStrideCalibration,
  finishStrideCalibration,
  reachedTarget,
  startStrideCalibration,
  strideActive,
  strideBlocked,
  strideOutcome,
  useMeasuredStride,
} from './stride-calibration';

const PROFILE: ProfileEntry = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' };

function snapshot(o: Partial<RecorderSnapshot> = {}): RecorderSnapshot {
  return {
    status: 'running',
    startedMs: NOW,
    activeMs: 200_000,
    pausedMs: 0,
    bpm: null,
    lastPulse: null,
    avgBpm: null,
    maxBpm: null,
    zone: null,
    hrMax: 180,
    steps: 0,
    distanceM: 0,
    distanceSource: 'gps',
    kcal: 0,
    kcalMethod: 'met',
    gps: 'good',
    ringConnected: true,
    ...o,
  };
}

const live = (snap: RecorderSnapshot | null, purpose: 'stride' | 'workout' = 'stride'): LiveWorkoutState => ({
  phase: snap ? 'live' : 'connecting',
  ...(purpose === 'stride' ? { purpose } : {}),
  sport: 'walk',
  useGps: true,
  snapshot: snap,
  warnings: [],
  ringLost: false,
  features: { heartRate: false, steps: true },
});

/** Un paseo de calibración de 300 m y 420 pasos en 4 minutos (71 cm de zancada). */
const record = (o: Partial<WorkoutRecord> = {}): WorkoutRecord => ({
  id: 'w',
  sport: 'walk',
  startMs: NOW - 240_000,
  endMs: NOW,
  pausedMs: 0,
  source: 'live',
  steps: 420,
  distanceM: 300,
  distanceSource: 'gps',
  splitsM: [75, 75, 75, 75],
  ...o,
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isWorkoutActive.mockReturnValue(false);
  profileHistory.value = [PROFILE];
  nowMs.value = NOW;
  liveWorkout.value = null;
  activeWorkout.value = null;
  strideWalk.value = null;
  // Si una prueba dejó una calibración a medias, se cierra antes de la siguiente.
  mocks.discardWorkout.mockResolvedValue(undefined);
  await closeStrideCalibration();
  vi.clearAllMocks();
});
afterEach(() => {
  liveWorkout.value = null;
});

describe('reachedTarget', () => {
  it('pide los 300 m medidos por GPS y los pasos suficientes', () => {
    expect(reachedTarget({ distanceM: 300, distanceSource: 'gps', steps: 420 })).toBe(true);
    expect(reachedTarget({ distanceM: 299, distanceSource: 'gps', steps: 420 })).toBe(false);
    expect(reachedTarget({ distanceM: 400, distanceSource: 'steps', steps: 560 })).toBe(false); // distancia que sale de los pasos: no mide nada
    expect(reachedTarget({ distanceM: 400, distanceSource: 'gps', steps: 20 })).toBe(false); // el anillo no cuenta
    expect(reachedTarget({ distanceM: 400, distanceSource: 'gps', steps: null })).toBe(false);
    expect(reachedTarget({ distanceM: null, distanceSource: null, steps: null })).toBe(false);
  });
});

describe('startStrideCalibration', () => {
  it('no empieza si hay un entrenamiento en curso y lo dice', async () => {
    mocks.isWorkoutActive.mockReturnValue(true);
    await startStrideCalibration();
    expect(mocks.beginWorkout).not.toHaveBeenCalled();
    expect(strideActive.value).toBe(false);
    expect(strideBlocked.value).toMatch(/entrenamiento en curso/);
  });

  it('empieza un paseo a pie con GPS y propósito de calibrar', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot())));
    await startStrideCalibration();
    expect(mocks.beginWorkout).toHaveBeenCalledWith('walk', false, 'stride');
    expect(strideActive.value).toBe(true);
    expect(strideOutcome.value).toBeNull();
  });

  it('si el arranque no llega a ponerse en marcha (permiso denegado, selector cancelado) vuelve al principio', async () => {
    mocks.beginWorkout.mockResolvedValue(undefined); // sin paseo en marcha
    await startStrideCalibration();
    expect(strideActive.value).toBe(false);
  });

  it('termina SOLA al llegar a los 300 m y mide la zancada', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot({ distanceM: 120, steps: 170 }))));
    mocks.finishWorkout.mockImplementation(async () => {
      strideWalk.value = record();
      liveWorkout.value = null;
    });
    await startStrideCalibration();
    expect(mocks.finishWorkout).not.toHaveBeenCalled();

    liveWorkout.value = live(snapshot({ distanceM: 310, steps: 437 }));
    await vi.waitFor(() => expect(strideOutcome.value).not.toBeNull());
    expect(mocks.finishWorkout).toHaveBeenCalledTimes(1);
    const outcome = strideOutcome.value;
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.measurement.cm).toBeCloseTo(71.4, 0);
      expect(outcome.measurement.verdict).toBe('good');
    }
    expect(strideWalk.value).toBeNull();
  });

  it('un paseo que se queda corto no termina solo, aunque lleve pasos de sobra', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot({ distanceM: 250, steps: 600 }))));
    await startStrideCalibration();
    liveWorkout.value = live(snapshot({ distanceM: 280, steps: 700 }));
    await Promise.resolve();
    expect(mocks.finishWorkout).not.toHaveBeenCalled();
  });

  it('un entrenamiento normal con 300 m no dispara nada', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot())));
    await startStrideCalibration();
    liveWorkout.value = live(snapshot({ distanceM: 400, steps: 560 }), 'workout');
    await Promise.resolve();
    expect(mocks.finishWorkout).not.toHaveBeenCalled();
  });
});

describe('finishStrideCalibration', () => {
  beforeEach(() => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot({ distanceM: 200, steps: 280 }))));
  });

  it('terminar a mano a mitad de camino mide, pero la medida es aproximada', async () => {
    mocks.finishWorkout.mockImplementation(async () => {
      strideWalk.value = record({ distanceM: 200, steps: 280, splitsM: [75, 75, 50] });
      liveWorkout.value = null;
    });
    await startStrideCalibration();
    await finishStrideCalibration();
    const outcome = strideOutcome.value;
    expect(outcome?.ok && outcome.measurement.verdict).toBe('fair');
  });

  it('si no llega ningún registro dice que faltan datos del GPS', async () => {
    mocks.finishWorkout.mockResolvedValue(undefined);
    await startStrideCalibration();
    await finishStrideCalibration();
    expect(strideOutcome.value).toEqual({ ok: false, reason: 'no-gps' });
  });

  it('dos peticiones de terminar a la vez solo terminan una vez', async () => {
    mocks.finishWorkout.mockImplementation(async () => {
      await Promise.resolve();
      strideWalk.value = record();
    });
    await startStrideCalibration();
    await Promise.all([finishStrideCalibration(), finishStrideCalibration()]);
    expect(mocks.finishWorkout).toHaveBeenCalledTimes(1);
  });
});

describe('cancelar y cerrar', () => {
  it('cancelar descarta el paseo en marcha y vuelve al principio', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot({ distanceM: 90, steps: 120 }))));
    await startStrideCalibration();
    await cancelStrideCalibration();
    expect(mocks.discardWorkout).toHaveBeenCalledTimes(1);
    expect(strideActive.value).toBe(false);
    expect(strideOutcome.value).toBeNull();
  });

  it('cancelar sin paseo en marcha no toca un entrenamiento normal', async () => {
    liveWorkout.value = live(snapshot(), 'workout');
    await cancelStrideCalibration();
    expect(mocks.discardWorkout).not.toHaveBeenCalled();
  });

  it('tras cancelar, el paseo ya no termina solo', async () => {
    mocks.beginWorkout.mockImplementation(async () => void (liveWorkout.value = live(snapshot())));
    await startStrideCalibration();
    await cancelStrideCalibration();
    liveWorkout.value = live(snapshot({ distanceM: 320, steps: 450 }));
    await Promise.resolve();
    expect(mocks.finishWorkout).not.toHaveBeenCalled();
  });
});

describe('useMeasuredStride', () => {
  it('sin entrada de hoy crea una que SOLO fija la zancada', async () => {
    await useMeasuredStride(71.4);
    expect(mocks.saveProfileEntry).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-10-10', strideCm: 71.4, strideOnly: true, heightCm: 178, weightKg: 80 }));
  });

  it('con entrada de hoy actualiza su zancada y quita la marca de «automática»', async () => {
    profileHistory.value = [PROFILE, { ...PROFILE, date: '2026-10-10', strideCm: 66, strideAuto: true }];
    await useMeasuredStride(71.4);
    const saved = mocks.saveProfileEntry.mock.calls[0]?.[0] as ProfileEntry;
    expect(saved).toMatchObject({ date: '2026-10-10', strideCm: 71.4 });
    expect(saved.strideAuto).toBeUndefined();
    expect(saved.strideOnly).toBeUndefined();
  });

  it('la zancada fijada a mano deja de ser la «aprendida» aunque la entrada vigente lo fuera', async () => {
    profileHistory.value = [{ ...PROFILE, strideCm: 66, strideAuto: true }];
    await useMeasuredStride(71.4);
    const saved = mocks.saveProfileEntry.mock.calls[0]?.[0] as ProfileEntry;
    expect(saved.strideAuto).toBeUndefined();
  });

  it('sin datos personales no guarda nada', async () => {
    profileHistory.value = [];
    await expect(useMeasuredStride(71.4)).rejects.toThrow();
    expect(mocks.saveProfileEntry).not.toHaveBeenCalled();
  });
});
