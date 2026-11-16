import { daysBetween, dayKeyOf, parseDayKey, type DayKey } from '../domain/dates';
import { periodRange, type HistoryPeriod } from '../domain/periods';

// Formato en castellano. Los números usan la coma decimal; la hora, formato 24 h.

const int = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const two = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const upToOne = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => int.format(Math.round(n));

/** «1 lectura» / «3 lecturas»: el número va con su sustantivo en singular o plural. */
export const plural = (n: number, singular: string, pluralForm: string): string => `${fmtInt(n)} ${Math.round(n) === 1 ? singular : pluralForm}`;

/** Espacio duro: el número y su unidad (%, °) no se separan en dos líneas. */
export const NBSP = '\u00a0';
export const fmt1 = (n: number): string => one.format(n);
export const fmt2 = (n: number): string => two.format(n);
/** Un decimal solo si hace falta: «162 cm», «81,5 kg» (con `fmt1` saldría «162,0 cm»). */
export const fmtUpTo1 = (n: number): string => upToOne.format(n);
const upToTwo = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
/** Hasta dos decimales, solo los que hagan falta: «0,44», «0,4», «1». Para un ritmo en kg por semana, que con un solo decimal no deja comprobar las semanas que salen. */
export const fmtUpTo2 = (n: number): string => upToTwo.format(n);

const km2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Kilómetros con 2 decimales, también por debajo de 1 km: «0,93». */
export const fmtKm = (meters: number): string => km2.format(meters / 1000);

/** Distancia en km con 1 decimal (por debajo de 1 km, en metros). */
export function fmtDistance(meters: number): { value: string; unit: string } {
  if (meters < 1000) return { value: fmtInt(meters), unit: 'm' };
  return { value: fmt1(meters / 1000), unit: 'km' };
}

/** "7 h 42 min", "45 min", "1 h". */
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** "42:07" o "1:02:07" para cronómetros. */
export function fmtTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const fmtClock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const fmtMinutesOfDay = (minutes: number): string => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const dayLong = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const dayShort = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const dayWeekday = new Intl.DateTimeFormat('es-ES', { weekday: 'short' });
const monthShort = new Intl.DateTimeFormat('es-ES', { month: 'short' });
const monthYear = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const monthName = new Intl.DateTimeFormat('es-ES', { month: 'long' });
const dateFull = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

const toDate = (key: DayKey): Date => {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day);
};

export const fmtDayLong = (key: DayKey): string => dayLong.format(toDate(key));
export const fmtDayShort = (key: DayKey): string => dayShort.format(toDate(key)).replace('.', '');
export const fmtWeekday = (key: DayKey): string => dayWeekday.format(toDate(key)).replace('.', '');
/** «11 oct», y «11 oct 2025» si no es del año de `todayKey`: pasado un año, el día y el mes solos son ambiguos. */
export function fmtDayShortYear(key: DayKey, todayKey: DayKey): string {
  const { year } = parseDayKey(key);
  return year === parseDayKey(todayKey).year ? fmtDayShort(key) : `${fmtDayShort(key)} ${year}`;
}
export const fmtMonthShort = (key: DayKey): string => monthShort.format(toDate(key)).replace('.', '');
export const fmtMonthYear = (key: DayKey): string => monthYear.format(toDate(key));
/** «febrero», y «febrero de 2027» si no es del año de `todayKey` (para una fecha aproximada: «hacia febrero»). */
export function fmtMonthLong(key: DayKey, todayKey: DayKey): string {
  const name = monthName.format(toDate(key));
  const { year } = parseDayKey(key);
  return year === parseDayKey(todayKey).year ? name : `${name} de ${year}`;
}
export const fmtDateFull = (key: DayKey): string => dateFull.format(toDate(key));

/** A qué día cuenta algo que se pasó de día, dicho para una frase («cuenta para …»): «hoy», «ayer» o «el miércoles, 9 de octubre». */
export function fmtCreditedDay(key: DayKey, todayKey: DayKey): string {
  const diff = Math.round((toDate(todayKey).getTime() - toDate(key).getTime()) / 86_400_000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'ayer';
  return `el ${fmtDayLong(key)}`;
}

/** "Hoy", "Ayer" o el día en largo. */
export function fmtDayTitle(key: DayKey, todayKey: DayKey): string {
  const diff = Math.round((toDate(todayKey).getTime() - toDate(key).getTime()) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return fmtDayLong(key);
}

/**
 * "hace 5 min", "hace 2 h", "ayer a las 22:10", "hace 3 días". Lo de «ayer» y los días se cuentan por días del calendario,
 * no por bloques de 24 h: del sábado a las 23:30 al lunes a las 00:30 solo han pasado 25 h, pero no es «ayer».
 */
/** «3 nov 2026 · 18:05»: el día y la hora de algo que ocurrió una vez (una copia de seguridad). */
export const fmtDateTime = (ms: number): string => `${fmtDayShort(dayKeyOf(ms))} ${new Date(ms).getFullYear()} · ${fmtClock(ms)}`;

export function fmtAgo(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = daysBetween(dayKeyOf(ms), dayKeyOf(nowMs));
  if (days <= 1) return `ayer a las ${fmtClock(ms)}`;
  return `hace ${days} días`;
}

export const todayKey = (nowMs: number): DayKey => dayKeyOf(nowMs);

const upFirst = (text: string): string => text.replace(/^./, (c) => c.toUpperCase());

/**
 * Rótulo de un periodo del historial, en dos líneas como el selector de día: «Hoy» / «mar 13 oct», «Esta semana» /
 * «12 oct – 18 oct», «Septiembre» / «septiembre de 2026».
 */
export function fmtPeriod(period: Exclude<HistoryPeriod, 'all'>, anchor: DayKey, today: DayKey): { title: string; subtitle: string } {
  const range = periodRange(period, anchor);
  const current = range !== null && range.from <= today && today <= range.to;
  switch (period) {
    case 'day':
      return { title: upFirst(fmtDayTitle(anchor, today).split(',')[0] ?? ''), subtitle: `${fmtWeekday(anchor)} ${fmtDayShortYear(anchor, today)}` };
    case 'week': {
      if (!range) return { title: 'Semana', subtitle: '' };
      // Una semana que cruza de año lleva el año en los dos extremos (si no, «29 dic 2025 – 4 ene» se lee mal).
      const crosses = parseDayKey(range.from).year !== parseDayKey(range.to).year;
      const end = crosses ? `${fmtDayShort(range.to)} ${parseDayKey(range.to).year}` : fmtDayShortYear(range.to, today);
      return { title: current ? 'Esta semana' : 'Semana', subtitle: `${fmtDayShortYear(range.from, today)} – ${end}` };
    }
    case 'month':
      return { title: current ? 'Este mes' : upFirst(monthName.format(toDate(anchor))), subtitle: fmtMonthYear(anchor) };
  }
}
