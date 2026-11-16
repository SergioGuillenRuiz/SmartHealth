import { sportById, type SportId } from '../domain/sports';
import { activeMsOf, type WorkoutRecord } from '../domain/workout';
import { parseDecimal, parseWhole, UNITS } from './parse';

/** Topes de lo que se puede escribir a mano. Los mismos al añadir un entreno y al corregirlo, y por debajo de lo que admite una copia de seguridad al restaurarla (2000 km, 50 000 kcal): lo que la app deja guardar, la copia lo puede devolver. */
export const MAX_DISTANCE_KM = 500;
export const MAX_ENERGY_KCAL = 10_000;

/**
 * La velocidad media más alta que se da por posible, en km/h, según lo que se hace. Por encima es casi seguro un error al escribir los
 * kilómetros o los minutos («500» por «5,0», «5» minutos por «50»), y una cifra así falsearía los totales del día. Son cotas generosas:
 * un marchador de élite hace ~15 km/h, el mejor 10 km en pista, ~23, y un ciclista en un día de viento a favor, ~60.
 */
export function maxAverageKmh(sport: SportId): number {
  switch (sport) {
    case 'walk':
      return 15;
    case 'hike':
      return 10;
    case 'bicimad':
      return 35;
    default:
      return sportById(sport).kind === 'cycling' ? 70 : 25;
  }
}

/** Qué le pasa a cada campo escrito (`null`: nada, o está vacío, que vale: significa «sin corregir»). */
export interface CorrectionProblems {
  km: string | null;
  kcal: string | null;
}

interface Parsed {
  km: number | null;
  kcal: number | null;
  problems: CorrectionProblems;
}

/** Con qué se compara una distancia: el deporte y los minutos en marcha del entreno (sin los parones). `null`: no se sabe, no se compara. */
export interface WorkoutContext {
  sport: SportId;
  activeMinutes: number | null;
}

/** Interpreta lo escrito. Lo que no es un número en rango (ni posible en el tiempo que duró el entreno) se descarta (cuenta como vacío) y se avisa. */
function parse(kmText: string, kcalText: string, context?: WorkoutContext): Parsed {
  const problems: CorrectionProblems = { km: null, kcal: null };
  let km = parseDecimal(kmText, UNITS.km);
  if (kmText.trim() !== '') {
    if (km === null) problems.km = 'Escribe la distancia como un número, por ejemplo 5,2.';
    else if (km < 0 || km > MAX_DISTANCE_KM) problems.km = `La distancia debe estar entre 0 y ${MAX_DISTANCE_KM} km.`;
    else if (context && context.activeMinutes !== null && context.activeMinutes >= 1) {
      const speed = km / (context.activeMinutes / 60);
      if (speed > maxAverageKmh(context.sport)) {
        problems.km = `${km.toLocaleString('es-ES')} km en ${Math.round(context.activeMinutes)} min son ${Math.round(speed)} km/h de media: demasiado para ${sportById(context.sport).name.toLowerCase()}. Revisa los kilómetros o la duración.`;
      }
    }
    if (problems.km !== null) km = null;
  }
  let kcal = parseWhole(kcalText, UNITS.kcal);
  if (kcalText.trim() !== '') {
    if (kcal === null) problems.kcal = 'Escribe las calorías como un número, por ejemplo 350.';
    else if (kcal < 0 || kcal > MAX_ENERGY_KCAL) problems.kcal = 'Las calorías deben estar entre 0 y 10 000.';
    if (problems.kcal !== null) kcal = null;
  }
  return { km, kcal, problems };
}

/** El deporte y los minutos en marcha de un entreno (para comprobar que la distancia escrita es posible en ese tiempo). */
export function contextOf(record: Pick<WorkoutRecord, 'sport' | 'startMs' | 'endMs' | 'pausedMs'>): WorkoutContext {
  return { sport: record.sport as SportId, activeMinutes: activeMsOf(record) / 60_000 };
}

/** Lo escrito que no vale, en frases para mostrar. Con los dos en `null` se puede guardar. */
export function correctionProblems(kmText: string, kcalText: string, context?: WorkoutContext): CorrectionProblems {
  return parse(kmText, kcalText, context).problems;
}

/**
 * Aplica las correcciones manuales de distancia y calorías a un entrenamiento.
 *
 * `original` es el registro tal como estaba al abrir el editor; `current` es el que lleva las ediciones hechas hasta
 * ahora. Una distancia escrita sustituye a la medida (GPS); si se vacía el campo, vuelve LO QUE HABÍA al abrir —la
 * distancia del GPS, por ejemplo— y no se pierde por haber tecleado y borrado. Las calorías vacías vuelven a la
 * estimación. Un valor que no es un número en rango (ver `correctionProblems`) cuenta como vacío: el registro nunca
 * lleva una cifra imposible.
 */
export function applyCorrections(original: WorkoutRecord, current: WorkoutRecord, kmText: string, kcalText: string): WorkoutRecord {
  const next: WorkoutRecord = { ...current };
  const { km: distance, kcal: energy } = parse(kmText, kcalText, contextOf(current));

  if (distance !== null && distance > 0) {
    next.distanceM = Math.round(distance * 1000);
    next.distanceSource = 'manual';
  } else if (original.distanceM !== undefined && original.distanceSource !== 'manual') {
    // Había una distancia medida (GPS): se recupera.
    next.distanceM = original.distanceM;
    if (original.distanceSource !== undefined) next.distanceSource = original.distanceSource;
    else delete next.distanceSource;
  } else {
    // No había nada medido que recuperar (o la anterior era una corrección manual que ahora se quita).
    delete next.distanceM;
    delete next.distanceSource;
  }

  if (energy !== null) next.kcalManual = Math.round(energy);
  else delete next.kcalManual;

  return next;
}
