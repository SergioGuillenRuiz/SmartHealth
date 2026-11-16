// Corregir a mano una noche estimada (ronda 58): la persona pone la hora a la que se acostó y a la que se levantó y la app la guarda como una noche normal.

const HOUR = 3_600_000;

/** «HH:MM» (24 h) → minutos desde medianoche, o `null` si no es una hora. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** «HH:MM» local de un instante, para rellenar el campo. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Las horas nuevas de una noche. La noche se asigna al día en que se levanta: `wakeDayMs` es cualquier instante de ese día (el final de la noche que se corrige). Se levanta ese día a `wake`
 * y se acostó a `bed` ese mismo día si es más temprano que `wake` (una noche que empieza de madrugada o una de día) y, si no, la tarde-noche anterior. `null` si alguna hora no vale o la noche
 * saldría de menos de 30 minutos o de más de 20 horas.
 */
export function correctedNight(wakeDayMs: number, bed: string, wake: string): { startMs: number; endMs: number } | null {
  const bedMin = parseClock(bed);
  const wakeMin = parseClock(wake);
  if (bedMin === null || wakeMin === null) return null;
  const day = new Date(wakeDayMs);
  const at = (minutes: number, dayShift: number): number => new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayShift, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
  const endMs = at(wakeMin, 0);
  const startMs = bedMin < wakeMin ? at(bedMin, 0) : at(bedMin, -1);
  const length = endMs - startMs;
  return length >= HOUR / 2 && length <= 20 * HOUR ? { startMs, endMs } : null;
}
