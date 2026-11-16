import { addDays, dayKeyOf, daysBetween, isValidDayKey, type DayKey } from './dates';
import type { MealEntry } from './nutrition';

// A qué día cuenta cada comida. Por omisión, al día en que se comió (con la hora de siempre: el día empieza a las 00:00); pero lo de madrugada puede
// pertenecer mejor al día anterior (la cena tardía), y la persona lo pasa de un día a otro con los botones de la lista. La comida guarda el día al que
// cuenta (`day`) sin tocar la hora real, que sigue siendo la de siempre. (Los entrenos no se pasan de día: cuentan siempre en el que ocurrieron.)

/** Cuántos días se puede apartar una comida del día en que se comió (hacia atrás o hacia delante). */
export const MAX_DAY_SHIFT = 3;

/** El día al que cuenta una comida. */
export const mealDay = (meal: Pick<MealEntry, 'tsMs' | 'day'>): DayKey => meal.day ?? dayKeyOf(meal.tsMs);

/** El día guardado de una comida que se comió en `real`, si es uno que se admite (un día válido, distinto del real y a no más de `MAX_DAY_SHIFT`): lo demás se descarta. */
export function validCreditDay(real: DayKey, day: unknown): DayKey | undefined {
  if (typeof day !== 'string' || !isValidDayKey(day) || day === real) return undefined;
  return Math.abs(daysBetween(real, day)) <= MAX_DAY_SHIFT ? day : undefined;
}

/**
 * El día al que pasaría algo que cuenta ahora para `current` si se mueve un día (`-1` el anterior, `1` el siguiente); `null` si no se puede:
 * no se pasa a un día futuro ni a más de `MAX_DAY_SHIFT` del día en que se comió.
 */
export function movedDay(real: DayKey, current: DayKey, direction: -1 | 1, today: DayKey): DayKey | null {
  const next = addDays(current, direction);
  if (next > today || Math.abs(daysBetween(real, next)) > MAX_DAY_SHIFT) return null;
  return next;
}

/** Lo que se guarda en una comida para que cuente para `credited`: nada si es el día en que se comió. */
export const creditField = (real: DayKey, credited: DayKey): { day?: DayKey } => (credited === real ? {} : { day: credited });
