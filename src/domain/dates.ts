// Fechas de calendario locales. Toda la app trabaja con "días" locales ('YYYY-MM-DD'): el anillo sella
// sus registros en hora local, y los totales diarios (pasos, sueño) se entienden de medianoche a
// medianoche en la zona del usuario. La aritmética de días pasa por `new Date(y, m, d + n)` para que el
// cambio de hora (días de 23 o 25 h) no desplace nunca un día.

export type DayKey = string;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function dayKeyOf(ms: number): DayKey {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isValidDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
}

export function parseDayKey(key: DayKey): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}

export function startOfDayMs(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day).getTime();
}

/** Inicio del día siguiente (= fin exclusivo de `key`). */
export function endOfDayMs(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day + 1).getTime();
}

export function addDays(key: DayKey, days: number): DayKey {
  const { year, month, day } = parseDayKey(key);
  return dayKeyOf(new Date(year, month - 1, day + days).getTime());
}

/** Días de calendario entre dos claves (`b - a`). */
export function daysBetween(a: DayKey, b: DayKey): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

/** Rango inclusivo de días. */
export function rangeDays(from: DayKey, to: DayKey): DayKey[] {
  const out: DayKey[] = [];
  const total = daysBetween(from, to);
  for (let i = 0; i <= total; i++) out.push(addDays(from, i));
  return out;
}

/** 0 = lunes … 6 = domingo. */
export function weekdayOf(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return (new Date(year, month - 1, day).getDay() + 6) % 7;
}

/**
 * Instante de las `hour`:00 (hora local de pared) del día `key`. Se construye con el calendario, no sumando horas al
 * inicio del día: los días de 23 o 25 h (cambio de hora) harían que «las 6» cayera a las 5 o a las 7.
 */
export function atHourMs(key: DayKey, hour: number): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day, hour).getTime();
}

/**
 * Un «día» que no empieza a medianoche. El Resumen cuenta el día desde `startHour` (por omisión las 08:00) hasta esa misma hora del
 * siguiente: lo que se come, se entrena o se duerme de madrugada pertenece al día que empezó antes, no al que acaba de empezar a
 * las 00:00. Con `startHour` 0 es el día de calendario. Las gráficas largas (Salud) siguen contando días de calendario.
 */
export interface DayWindow {
  day: DayKey;
  startMs: number;
  /** Fin exclusivo: el inicio del día siguiente. */
  endMs: number;
}

export function dayWindow(day: DayKey, startHour = 0): DayWindow {
  return { day, startMs: atHourMs(day, startHour), endMs: atHourMs(addDays(day, 1), startHour) };
}

/** El día (que empieza a las `startHour`) al que pertenece un instante: antes de esa hora aún es el día anterior. */
export function dayOfMs(ms: number, startHour = 0): DayKey {
  const key = dayKeyOf(ms);
  return new Date(ms).getHours() < startHour ? addDays(key, -1) : key;
}

export function startOfWeek(key: DayKey): DayKey {
  return addDays(key, -weekdayOf(key));
}

export function startOfMonth(key: DayKey): DayKey {
  const { year, month } = parseDayKey(key);
  return `${year}-${pad2(month)}-01`;
}

/** Parte (0–1) del día `key` que ha transcurrido hasta `nowMs`; el día empieza a las `startHour`. */
export function elapsedFractionOfDay(key: DayKey, nowMs: number, startHour = 0): number {
  const { startMs, endMs } = dayWindow(key, startHour);
  return Math.max(0, Math.min(1, (nowMs - startMs) / (endMs - startMs)));
}

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
