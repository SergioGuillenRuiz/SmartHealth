import type { DayActivity } from './activity';
import { sportById, type SportId } from './sports';

/**
 * Una parte del total de la tarjeta de actividad: andar fuera de los entrenos, o todo lo hecho en un deporte (varias sesiones
 * del mismo deporte se juntan). Sus calorías y sus kilómetros suman los totales del día; donde no hay distancia (yoga,
 * gimnasio…) es `null`.
 */
export interface ActivityPart {
  /** `walking` (andar fuera de entrenos) o el id del deporte. */
  key: string;
  sport: SportId | 'walking';
  name: string;
  distanceM: number | null;
  kcal: number;
}

export const WALKING_KEY = 'walking';

/** De dónde sale el total del día, parte por parte: andar fuera de entrenos y cada deporte entrenado. */
export function activityParts(a: DayActivity): ActivityPart[] {
  const parts: ActivityPart[] = [];
  // Andar es lo que queda de los pasos del día tras los de los entrenos (sin pasos, ni distancia ni calorías de andar, no hay fila).
  const inWorkouts = Object.values(a.workoutSteps).reduce((sum, steps) => sum + steps, 0);
  const walkingSteps = Math.max(0, (a.steps ?? 0) - inWorkouts);
  if (walkingSteps > 0 || a.walking.distanceM > 0 || a.walking.kcal > 0) {
    parts.push({ key: WALKING_KEY, sport: WALKING_KEY, name: 'Andar', distanceM: a.walking.distanceM > 0 ? a.walking.distanceM : null, kcal: a.walking.kcal });
  }

  const bySport = new Map<SportId, ActivityPart>();
  for (const w of a.workouts) {
    let part = bySport.get(w.sport);
    if (!part) {
      part = { key: w.sport, sport: w.sport, name: sportById(w.sport).name, distanceM: null, kcal: 0 };
      bySport.set(w.sport, part);
      parts.push(part);
    }
    part.kcal += w.kcal;
    if (w.distanceM !== null && w.distanceM > 0) part.distanceM = (part.distanceM ?? 0) + w.distanceM;
  }
  return mergeWalking(parts);
}

/**
 * «Andar» (lo que se anda fuera de los entrenos) y «Caminar» (el deporte, andar con entreno) son lo mismo para quien mira el día: se juntan en una sola fila, «Andar», con sus calorías
 * y su distancia sumadas. Los pasos de un entreno de Caminar no se cuentan dos veces (andar fuera ya los resta), así que sumar no duplica nada.
 */
function mergeWalking(parts: ActivityPart[]): ActivityPart[] {
  const free = parts.find((p) => p.key === WALKING_KEY);
  const sport = parts.find((p) => p.key === 'walk');
  if (!sport) return parts;
  if (!free) {
    sport.name = 'Andar';
    return parts;
  }
  free.kcal += sport.kcal;
  if (sport.distanceM !== null) free.distanceM = (free.distanceM ?? 0) + sport.distanceM;
  return parts.filter((p) => p !== sport);
}
