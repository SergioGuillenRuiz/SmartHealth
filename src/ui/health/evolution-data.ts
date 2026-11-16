import { parseDayKey, startOfDayMs, type DayKey } from '../../domain/dates';
import type { AggregatePoint, Granularity } from '../../domain/summary';
import type { XTick } from '../charts/LineChart';
import { fmtDayShort, fmtMonthShort, fmtMonthYear, fmtWeekday } from '../format';

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Etiqueta corta del eje X de un periodo. */
export function xLabel(point: Pick<AggregatePoint, 'start'>, granularity: Granularity, count: number): string {
  // Con más de doce meses el mismo mes saldría dos veces: lleva el año.
  if (granularity === 'month') return count > 12 ? `${cap(fmtMonthShort(point.start))} ${String(parseDayKey(point.start).year).slice(2)}` : cap(fmtMonthShort(point.start));
  if (granularity === 'week') return fmtDayShort(point.start);
  return count <= 8 ? `${fmtWeekday(point.start)} ${parseDayKey(point.start).day}` : fmtDayShort(point.start);
}

/** Cabecera del tooltip de un periodo. */
export function periodTitle(point: Pick<AggregatePoint, 'start' | 'end'>, granularity: Granularity): string {
  if (granularity === 'month') return cap(fmtMonthYear(point.start));
  if (granularity === 'week') return `Semana del ${fmtDayShort(point.start)} al ${fmtDayShort(point.end)}`;
  return `${cap(fmtWeekday(point.start))} ${fmtDayShort(point.start)}`;
}

/** Marcas del eje X repartidas por igual en un eje temporal. */
export function timeTicks(fromMs: number, toMs: number, count = 4): XTick[] {
  if (toMs <= fromMs) return [];
  const spanDays = (toMs - fromMs) / 86_400_000;
  const out: XTick[] = [];
  for (let i = 0; i < count; i++) {
    const x = fromMs + ((toMs - fromMs) * i) / (count - 1);
    const key = dayOf(x);
    out.push({ x, label: spanDays > 150 ? `${cap(fmtMonthShort(key))} ${String(parseDayKey(key).year).slice(2)}` : fmtDayShort(key) });
  }
  return out;
}

function dayOf(ms: number): DayKey {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Posición en el eje X de un periodo. Una semana (o un mes) cuyo primer día cae antes del rango empieza en el primer día
 * del rango: si no, su punto quedaría fuera del eje, hasta 6 días a la izquierda del dibujo.
 */
export const pointX = (point: Pick<AggregatePoint, 'start'>, rangeFromMs = Number.NEGATIVE_INFINITY): number => Math.max(startOfDayMs(point.start), rangeFromMs);
