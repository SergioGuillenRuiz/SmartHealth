import { RingError } from '../ble/errors';
import { dayKeyOf } from '../domain/dates';
import type { SportId } from '../domain/sports';
import type { WorkoutRecord } from '../domain/workout';
import { resolveProfile } from '../domain/summary';
import { svc } from './services';
import { activeWorkout, autoHoldsRing, bumpData, claimRing, detailWorkoutId, liveFix, liveWorkout, pendingRecovered, pendingWorkout, profileHistory, recoveredCause, showToast, strideWalk, yieldRingToUser } from './state';
import { saveProfileEntry } from './actions';
import { hrProfile } from './personal';
import { autoStrideEntry } from '../domain/stride';
import { settleOrphanTrack } from './track-recovery';
import { nativeTracker } from './tracker';
import { navState } from './nav/navigator';
import { isDetailUpgrading } from './nav/zone-manager';
import { recoveryCause } from './screen-off-report';
import { browserPlatform, WorkoutController, type LivePurpose } from './workout-controller';

/** Qué trabajo del mapa hay en marcha ahora (lo más pesado que hace la app), para el informe de lo que pasó con la pantalla apagada. */
function mapBusyNow(): string | null {
  const phase = navState.peek().phase;
  if (phase === 'downloading') return 'bajando el mapa';
  if (phase === 'loading' || phase === 'locating') return 'cargando el mapa';
  return isDetailUpgrading() ? 'completando el mapa con los edificios y comercios' : null;
}

let controller: WorkoutController | null = null;

function ctl(): WorkoutController {
  if (!controller) {
    const { transport, store, now, hrTiming } = svc();
    controller = new WorkoutController({
      ...hrTiming,
      transport,
      store,
      now,
      platform: browserPlatform(),
      claimRing: () => claimRing('workout'),
      getProfile: () => resolveProfile(profileHistory.value, dayKeyOf(now())).profile,
      getHrProfile: () => hrProfile.peek(),
      mapBusy: mapBusyNow,
      onState: (state) => {
        liveWorkout.value = state;
        if (!state) liveFix.value = null;
        activeWorkout.value = state ? { sport: state.sport, startedMs: state.snapshot?.startedMs ?? now() } : null;
      },
      onGpsFix: (fix) => {
        liveFix.value = { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, speedMs: fix.speedMs ?? null, tsMs: fix.tsMs, receivedMs: now() };
      },
      onFinished: (record, purpose, meta) => {
        // Un paseo de calibración no se revisa ni se guarda: lo recoge la calibración de la zancada.
        if (purpose === 'stride') strideWalk.value = record;
        // Parado desde el botón de la notificación: no se revisa, se guarda y se enseña ya guardado.
        else if (meta?.fromNotification) void saveFromNotification(record);
        else pendingWorkout.value = record;
      },
    });
  }
  return controller;
}

/** Tiene el anillo en uso un entrenamiento (para no mezclarlo con una sincronización). */
export const isWorkoutActive = (): boolean => controller?.isActive ?? false;

/** Empieza el entrenamiento. Debe llamarse desde un gesto del usuario. */
/**
 * Empieza un entreno. El GPS va siempre puesto donde sirve (andar, correr, senderismo y bici): si no está o no es fiable, la distancia sale de los pasos del anillo o se escribe al terminar.
 * `guided` pide la navegación guiada (el menú de dos pestañas con el mapa); apagado, es el entreno de siempre.
 */
export async function beginWorkout(sport: SportId, guided: boolean, purpose: LivePurpose = 'workout', ring = true): Promise<void> {
  try {
    // Si la actualización automática tiene el anillo, el entreno va antes: se le hace soltarlo (sin anillo no hay nada que soltar).
    if (ring && autoHoldsRing()) await yieldRingToUser();
    await ctl().start(sport, { gps: true, ...(guided ? { guided } : {}), ...(purpose === 'workout' ? {} : { purpose }), ...(ring ? {} : { ring: false }) });
  } catch (error) {
    if (error instanceof RingError && error.code === 'no-device') return;
    showToast(error instanceof Error ? error.message : 'No se pudo empezar el entrenamiento.', 'error');
  }
}

export const pauseWorkout = (): void => ctl().pause();
export const resumeWorkout = (): void => ctl().resume();
export const finishWorkout = (): Promise<void> => ctl().finish();
export const discardWorkout = (): Promise<void> => ctl().discard();

export async function reconnectWorkoutRing(): Promise<void> {
  try {
    await ctl().reconnect();
  } catch (error) {
    if (error instanceof RingError && error.code === 'no-device') return;
    showToast(error instanceof Error ? error.message : 'No se pudo reconectar el anillo.', 'error');
  }
}

let saving = false;

/** Corrige un entrenamiento ya guardado. Devuelve `false` si no se pudo (y avisa). */
export async function updateWorkout(record: WorkoutRecord): Promise<boolean> {
  try {
    await svc().store.putWorkout(record);
  } catch (error) {
    showToast(`No se pudieron guardar los cambios${reason(error)}.`, 'error');
    return false;
  }
  bumpData();
  showToast('Cambios guardados');
  return true;
}

/** Mensaje de un fallo del almacén, sin tecnicismos de más. */
const reason = (error: unknown): string => (error instanceof Error && error.message ? `: ${error.message}` : '');

/**
 * Guarda un entrenamiento terminado. Devuelve `false` si no se pudo: el entreno NO se pierde —sigue en pantalla para
 * reintentar— y se avisa (antes un fallo del almacén se tragaba en silencio y la única salida era descartar).
 */
export async function saveWorkout(record: WorkoutRecord): Promise<boolean> {
  if (saving) return false; // un doble toque en «Guardar» no lo guarda dos veces
  saving = true;
  try {
    await svc().store.putWorkout(record);
  } catch (error) {
    showToast(`No se pudo guardar el entrenamiento${reason(error)}. Inténtalo de nuevo.`, 'error');
    return false;
  } finally {
    saving = false;
  }
  // Ya está guardado: el borrador sobra (si esto fallara, el aviso de recuperación saldría de más, no se pierde nada).
  await svc().store.setWorkoutDraft(null).catch(() => undefined);
  pendingWorkout.value = null;
  pendingRecovered.value = false;
  recoveredCause.value = null;
  bumpData();
  const strideCm = await refreshLearnedStride();
  showToast(strideCm === null ? 'Entrenamiento guardado' : `Entrenamiento guardado. Zancada ajustada a ${strideCm}\u00a0cm con tus paseos con GPS.`);
  return true;
}

/**
 * Tras guardar un entrenamiento, la zancada se reajusta con los últimos paseos con GPS (ver `autoStrideEntry`). Devuelve la nueva
 * (cm), o `null` si no cambia. Nunca estropea el guardado: ante un fallo, la zancada se queda como estaba.
 */
async function refreshLearnedStride(): Promise<number | null> {
  try {
    const { store, now } = svc();
    const entry = autoStrideEntry(profileHistory.value, dayKeyOf(now()), await store.recentWorkouts(40));
    if (!entry || entry.strideCm === undefined) return null;
    await saveProfileEntry(entry);
    return Math.round(entry.strideCm);
  } catch {
    return null;
  }
}

/**
 * Se paró el entreno desde el botón de la notificación: se guarda tal cual, como si se hubiera pulsado «Terminar» y «Guardar», y se abre su detalle (las cifras, el recorrido en el mapa y la
 * gráfica de pulso), que es lo que se ve al volver a la app. Si no se pudo guardar, queda en la revisión de siempre para reintentarlo: el entreno no se pierde.
 */
export async function saveFromNotification(record: WorkoutRecord): Promise<void> {
  if (await saveWorkout(record)) detailWorkoutId.value = record.id;
  else pendingWorkout.value = record;
}

/** Descarta el entrenamiento terminado que se estaba revisando (y su borrador). */
export async function discardPendingWorkout(): Promise<void> {
  await svc().store.setWorkoutDraft(null).catch(() => undefined);
  pendingWorkout.value = null;
  pendingRecovered.value = false;
  recoveredCause.value = null;
  showToast('Entrenamiento descartado');
}

/**
 * Al arrancar: si la app se cerró en mitad de un entrenamiento (o antes de revisarlo), vuelve a ofrecerlo para revisarlo y
 * guardarlo. El registro llega hasta el último borrador: se guarda cada 15 s y al ocultarse la página; si el sistema la
 * cierra sin avisar, puede faltar lo último (el aviso de recuperación dice hasta qué hora llega).
 */
export async function recoverWorkoutDraft(): Promise<void> {
  if (pendingWorkout.value) return;
  const { store, now } = svc();
  let draft = await store.getWorkoutDraft().catch(() => null);
  const tracker = nativeTracker();
  // Si se tocó «Parar» en la notificación con la app cerrada, la parada está anotada: el entreno se guarda solo en lugar de ofrecerse a revisar.
  const stopped = tracker ? (await tracker.takeActions().catch(() => [])).some((a) => a.action === 'stop') : false;
  // En la app de Android, el servicio del GPS puede seguir grabando la ruta de un entreno cuya app se cerró: se continúa el borrador
  // con lo que grabó y se detiene el servicio (si no, se quedaría con el GPS encendido).
  const settled = await settleOrphanTrack(tracker, draft, resolveProfile(profileHistory.value, dayKeyOf(now())).profile);
  if (settled && settled !== draft) await store.setWorkoutDraft(settled).catch(() => undefined);
  if (!settled) return;
  // La anotación de hasta qué posición llevaba el borrador solo sirve para continuarlo: lo que se ofrece es un registro normal.
  const { trackSeq: _consumed, ...recovered } = settled;
  draft = recovered;
  // Si el motor web (el WebView) murió durante el entreno, el sistema cerró la app entera: se dice (lo anotó el lado nativo antes de que muriera).
  recoveredCause.value = tracker ? recoveryCause(await tracker.status().catch(() => ({})), recovered.startMs) : null;
  pendingRecovered.value = true;
  pendingWorkout.value = draft;
  if (stopped) await saveFromNotification(draft);
}

export async function removeWorkout(id: string): Promise<boolean> {
  try {
    await svc().store.deleteWorkout(id);
  } catch (error) {
    showToast(`No se pudo eliminar el entrenamiento${reason(error)}.`, 'error');
    return false;
  }
  bumpData();
  showToast('Entrenamiento eliminado');
  return true;
}
