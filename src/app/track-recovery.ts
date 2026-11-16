import { haversineM } from '../domain/gps';
import type { ResolvedProfile } from '../domain/profile';
import { mergeRoutes } from '../domain/route-trace';
import type { WorkoutDraft } from '../domain/workout';
import { MAX_SPLIT_M, MAX_SPLITS, WorkoutRecorder } from '../sync/workout-recorder';
import type { NativeTracker, TrackFix } from './tracker';

/** Posiciones que se piden por llamada al leer la pista entera. */
const BATCH = 5000;
/** Tope de posiciones leídas (unas 28 h a una por segundo): una pista más larga no es un entreno. */
const MAX_FIXES = 100_000;
/** Por debajo de esta velocidad (m/s) se está parado: un resto de pista sin moverse no es entreno. */
const MOVING_SPEED_MS = 0.8;

/** Cada posición con la velocidad a la que se iba en ella (la que midió el GPS, o la que sale de la anterior si no la dio). */
function movingFlags(fixes: readonly TrackFix[]): boolean[] {
  return fixes.map((fix, i) => {
    if (fix.speedMs !== null) return fix.speedMs >= MOVING_SPEED_MS;
    const before = fixes[i - 1];
    if (!before || fix.tsMs <= before.tsMs) return false;
    return haversineM(before, fix) / ((fix.tsMs - before.tsMs) / 1000) >= MOVING_SPEED_MS;
  });
}

/** Suma, minuto a minuto, los metros de dos listas de minutos activos (`-1`: ese minuto no tuvo señal del GPS). */
function mergeSplits(a: readonly number[] | undefined, b: readonly number[] | undefined): number[] {
  const length = Math.min(MAX_SPLITS, Math.max(a?.length ?? 0, b?.length ?? 0));
  const merged: number[] = [];
  for (let i = 0; i < length; i++) {
    const x = a?.[i];
    const y = b?.[i];
    const hasX = x !== undefined && x >= 0;
    const hasY = y !== undefined && y >= 0;
    merged.push(hasX || hasY ? Math.min(MAX_SPLIT_M, Math.round((hasX ? x : 0) + (hasY ? y : 0))) : -1);
  }
  return merged;
}

/**
 * Continúa un borrador con lo que grabó el servicio nativo del GPS DESPUÉS de su último guardado: la app se cerró a mitad del
 * entreno (el sistema, o la persona al quitarla de las apps recientes) pero el servicio siguió recogiendo la ruta. Las posiciones
 * posteriores al final del borrador se pasan por un grabador nuevo, cuyo cronómetro empieza donde estaba el tiempo activo del
 * borrador (sin pausas: lo que pasó con la app cerrada se da por entreno mientras se avanzaba), y se SUMAN a su distancia y a sus
 * minutos. El resto de la pista en que ya no se avanzaba (el móvil en un bolsillo, la persona en casa, sin reabrir la app) se recorta.
 * Pulso y pasos no se recuperan: los daba el anillo, y la conexión murió con la app.
 *
 * Devuelve el mismo borrador si no hay nada que continuar.
 */
export function extendWithTrack(draft: WorkoutDraft, fixes: readonly TrackFix[], profile: ResolvedProfile): WorkoutDraft {
  if (draft.source !== 'live') return draft;
  // Lo que el borrador aún no lleva: las posiciones posteriores a la última que recogió (el borrador lo anota), o, si no lo anota,
  // las posteriores a su hora final. Por número no se pierde lo que el servicio ya tenía y la web aún no había recogido.
  const tail = draft.trackSeq !== undefined ? fixes.filter((fix) => fix.seq > (draft.trackSeq as number)) : fixes.filter((fix) => fix.tsMs > draft.endMs);
  const moving = movingFlags(tail);
  const lastMoving = moving.lastIndexOf(true);
  if (lastMoving < 0) return draft;
  const used = tail.slice(0, lastMoving + 1);

  // El cronómetro del grabador de la continuación: con el inicio desplazado por las pausas del borrador, el tiempo activo en el
  // instante del último guardado coincide con el del borrador y cada minuto nuevo cae donde le toca en su lista de minutos.
  let clock = draft.startMs + draft.pausedMs;
  const replay = new WorkoutRecorder({ sport: draft.sport, profile, now: () => clock, useGps: true, id: draft.id });
  for (const fix of used) {
    clock = fix.tsMs;
    replay.onGps({ lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, tsMs: fix.tsMs, speedMs: fix.speedMs, pressureHpa: fix.pressureHpa }, { trustTime: true });
  }
  const tailRecord = replay.finish();
  if (!((tailRecord.distanceM ?? 0) > 0)) return draft; // ni diez metros (o «no se movió»): no merece cambiar el borrador

  const splits = mergeSplits(draft.splitsM, tailRecord.splitsM);
  const ascentM = (draft.ascentM ?? 0) + (tailRecord.ascentM ?? 0);
  const route = mergeRoutes(draft.route, tailRecord.route);
  // Ya no lleva `trackSeq`: la pista se borra y lo recuperado es un registro como cualquier otro.
  const { trackSeq: _consumed, ...record } = draft;
  return {
    ...record,
    endMs: Math.max(draft.endMs, clock),
    distanceM: Math.round((draft.distanceM ?? 0) + (tailRecord.distanceM ?? 0)),
    distanceSource: 'gps',
    ...(splits.length > 0 ? { splitsM: splits } : {}),
    ...(route.length >= 2 ? { route } : {}),
    ...(ascentM > 0 ? { ascentM } : {}),
  };
}

/** La pista entera del entreno `sessionId`, leída por tandas (más allá de `MAX_FIXES` no se sigue). */
async function readTrack(tracker: NativeTracker, sessionId: string): Promise<TrackFix[]> {
  const track: TrackFix[] = [];
  let since = 0;
  while (track.length < MAX_FIXES) {
    const { fixes } = await tracker.fixes({ sessionId, sinceSeq: since, limit: BATCH });
    for (const fix of fixes) {
      if (fix.seq <= since) continue;
      since = fix.seq;
      track.push(fix);
    }
    if (fixes.length < BATCH) break;
  }
  return track;
}

/**
 * Al arrancar la app no hay ningún entreno en curso en ella: si el servicio del GPS sigue grabando (o dejó una pista sin recoger), es
 * de un entreno cuya app se cerró. Si el borrador recuperado es de ese mismo entreno, se continúa con lo grabado (ver
 * `extendWithTrack`); en todo caso el servicio se detiene y la pista se borra: no puede quedarse el GPS encendido ni el aviso fijo.
 *
 * Devuelve el borrador (continuado, si procede). Un fallo del plugin nunca impide recuperar el borrador tal cual.
 */
export async function settleOrphanTrack(tracker: NativeTracker | null, draft: WorkoutDraft | null, profile: ResolvedProfile): Promise<WorkoutDraft | null> {
  if (!tracker) return draft;
  let result = draft;
  try {
    const state = await tracker.status();
    const sessionId = state.sessionId;
    if (!sessionId || (!state.running && !state.active && state.lastSeq === 0)) return draft;
    // También con el servicio ya parado: pudo detenerse solo (el tope de tiempo sin moverse, un permiso retirado) y su pista, con lo
    // grabado hasta entonces, sigue ahí. Lo posterior al final del borrador es lo único que se suma, así que continuar es idempotente.
    if (draft && draft.id === sessionId && state.lastSeq > 0) {
      const track = await readTrack(tracker, sessionId);
      result = extendWithTrack(draft, track, profile);
    }
    await tracker.stop();
    await tracker.clear({ sessionId });
  } catch {
    /* sin plugin o sin respuesta: se queda el borrador como estaba */
  }
  return result;
}
