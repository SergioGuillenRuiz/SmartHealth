import { addDays, parseDayKey, startOfMonth, startOfWeek, type DayKey } from './dates';
import type { DayRange } from './evolution';

/** Lo que abarca el filtro del historial de entrenamientos. */
export type HistoryPeriod = 'day' | 'week' | 'month' | 'all';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Días del mes de `key`, con el 29 de febrero de los años bisiestos. */
function lastDayOfMonth(key: DayKey): DayKey {
  const { year, month } = parseDayKey(key);
  const last = new Date(year, month, 0).getDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

/** Los días que cubre el periodo que contiene a `anchor`: el día, su semana (de lunes a domingo) o su mes. `null` para «todos». */
export function periodRange(period: HistoryPeriod, anchor: DayKey): DayRange | null {
  switch (period) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    case 'month':
      return { from: startOfMonth(anchor), to: lastDayOfMonth(anchor) };
    case 'all':
      return null;
  }
}

/** El día de referencia del periodo anterior (`-1`) o siguiente (`+1`): un día, una semana o un mes entero más allá. */
export function shiftPeriod(period: HistoryPeriod, anchor: DayKey, direction: -1 | 1): DayKey {
  switch (period) {
    case 'day':
      return addDays(anchor, direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'month': {
      // Siempre al día 1: «un mes más» desde el 31 no existe en los meses cortos.
      const { year, month } = parseDayKey(anchor);
      const first = new Date(year, month - 1 + direction, 1);
      return `${first.getFullYear()}-${pad2(first.getMonth() + 1)}-01`;
    }
    case 'all':
      return anchor;
  }
}

/** ¿El periodo que contiene a `anchor` llega a `today` (o más allá)? Entonces no hay «siguiente» al que ir. */
export function reachesToday(period: HistoryPeriod, anchor: DayKey, today: DayKey): boolean {
  const range = periodRange(period, anchor);
  return range === null || range.to >= today;
}
