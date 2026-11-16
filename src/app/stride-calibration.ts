// Calibrar la zancada caminando: un paseo con GPS y con los pasos del anillo, guiado desde una hoja, que acaba fijando la zancada sin escribir nada.
//
// Reutiliza el entreno en directo (`WorkoutController`) con el propósito `stride`: mismo GPS (el servicio nativo que graba con la pantalla apagada), mismo contador de pasos del
// anillo y mismos permisos, pero el paseo no se guarda como entreno, no deja borrador y no abre la pantalla de seguimiento. Termina solo al llegar a los metros objetivo.

import { effect, signal } from '@preact/signals';
import { dayKeyOf } from '../domain/dates';
import { baseStride } from '../domain/estimation';
import { profileAt, type ProfileEntry } from '../domain/profile';
import { CALIBRATION_TARGET_M, measureCalibrationWalk, type StrideOutcome } from '../domain/stride';
import type { RecorderSnapshot } from '../sync/workout-recorder';
import { saveProfileEntry } from './actions';
import { svc } from './services';
import { activeWorkout, liveWorkout, nowMs, profileHistory, strideWalk } from './state';
import { beginWorkout, discardWorkout, finishWorkout, isWorkoutActive } from './workout-actions';

/** Hay una calibración en marcha (desde «Empezar» hasta que se cierra o termina). */
export const strideActive = signal(false);
/** Cómo salió el último paseo; `null` mientras se camina o antes de empezar. */
export const strideOutcome = signal<StrideOutcome | null>(null);
/** Por qué no se pudo empezar (otro entrenamiento en marcha), para decirlo en la hoja. */
export const strideBlocked = signal<string | null>(null);

/** Pasos mínimos para terminar solo: sin ellos el anillo no está contando y seguir caminando no arregla nada. */
const AUTO_FINISH_MIN_STEPS = 150;

let stopWatch: (() => void) | null = null;
let finishing = false;

/** ¿Lleva ya el paseo los metros objetivo, medidos por GPS, y los pasos que hacen falta? */
export function reachedTarget(snapshot: Pick<RecorderSnapshot, 'distanceM' | 'distanceSource' | 'steps'>): boolean {
  return snapshot.distanceSource === 'gps' && (snapshot.distanceM ?? 0) >= CALIBRATION_TARGET_M && (snapshot.steps ?? 0) >= AUTO_FINISH_MIN_STEPS;
}

function stopWatching(): void {
  stopWatch?.();
  stopWatch = null;
}

/** Empieza el paseo. Debe llamarse desde un gesto de la persona (selector de Bluetooth y permiso de ubicación). */
export async function startStrideCalibration(): Promise<void> {
  if (strideActive.peek()) return;
  if (isWorkoutActive() || activeWorkout.peek() !== null) {
    strideBlocked.value = 'Hay un entrenamiento en curso. Termínalo antes de calibrar la zancada.';
    return;
  }
  strideBlocked.value = null;
  strideOutcome.value = null;
  strideWalk.value = null;
  finishing = false;
  strideActive.value = true;
  // Al llegar a los metros objetivo el paseo termina solo: la persona solo camina.
  stopWatch = effect(() => {
    const live = liveWorkout.value;
    if (live?.purpose === 'stride' && live.snapshot && reachedTarget(live.snapshot) && !finishing) void finishStrideCalibration();
  });
  await beginWorkout('walk', false, 'stride');
  // Sin paseo en marcha tras el arranque (se denegó un permiso, se canceló el selector…): se vuelve al principio.
  if (liveWorkout.peek()?.purpose !== 'stride' && strideOutcome.peek() === null && !finishing) {
    stopWatching();
    strideActive.value = false;
  }
}

/** Termina el paseo y mide la zancada. Lo llama el efecto al llegar a la meta, o la persona antes (a partir de `CALIBRATION_MIN_M`). */
export async function finishStrideCalibration(): Promise<void> {
  if (finishing) return;
  finishing = true;
  try {
    strideWalk.value = null;
    await finishWorkout();
    const walk = strideWalk.peek();
    strideWalk.value = null;
    stopWatching();
    const today = dayKeyOf(svc().now());
    const current = profileAt(profileHistory.peek(), today);
    const heightStrideM = current ? baseStride({ heightCm: current.heightCm, sex: current.sex }).meters : 0;
    strideOutcome.value = walk ? measureCalibrationWalk(walk, heightStrideM) : { ok: false, reason: 'no-gps' };
    try {
      navigator.vibrate?.([60, 80, 60]);
    } catch {
      /* sin vibración */
    }
  } finally {
    finishing = false;
  }
}

/** Deja el paseo sin medir nada (cancelar mientras se conecta o se camina). */
export async function cancelStrideCalibration(): Promise<void> {
  stopWatching();
  strideWalk.value = null;
  strideOutcome.value = null;
  strideActive.value = false;
  if (liveWorkout.peek()?.purpose === 'stride') await discardWorkout();
}

/** Cierra la hoja: cancela lo que esté en marcha y vuelve al principio. */
export async function closeStrideCalibration(): Promise<void> {
  await cancelStrideCalibration();
  strideBlocked.value = null;
}

/** Fija la zancada medida desde hoy. Una calibración manda sobre la que ajustó la app sola: la marca de «automática» no pasa a la entrada nueva. */
export async function useMeasuredStride(cm: number): Promise<void> {
  const today = dayKeyOf(nowMs.peek());
  const history = profileHistory.peek();
  const current = profileAt(history, today);
  if (!current) throw new Error('Primero introduce tus datos personales.');
  const todays = history.find((entry) => entry.date === today);
  const { extrapolated: _extrapolated, strideAuto: _auto, ...base } = current;
  // Si hoy ya hay una entrada se actualiza su zancada; si no, se crea una que SOLO fija la zancada (arrastra el peso vigente sin ser una pesada).
  const entry: ProfileEntry = todays
    ? (({ strideAuto: _a, ...rest }: ProfileEntry): ProfileEntry => rest)({ ...todays, strideCm: cm })
    : { ...base, date: today, strideCm: cm, strideOnly: true };
  await saveProfileEntry(entry);
}
